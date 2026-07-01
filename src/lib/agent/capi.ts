import consola from "consola"

import { state } from "~/lib/state"
import { fetchWithTransientRetry } from "~/lib/upstream-retry"
import { isAllowedCopilotHost } from "~/services/github/get-copilot-token"

import { ghGraphQL } from "./graphql"

// ---------------------------------------------------------------------------
// Copilot-host (CAPI) session-log client.
//
// The cloud coding agent's PLAN, reasoning, progress, and any question it asks
// live in its *session log*, which is served from the Copilot host
// (`api.enterprise.githubcopilot.com`) — NOT from `api.github.com`. Two facts
// were established empirically and are load-bearing here:
//
//   1. Auth is the RAW `gho_` device-flow OAuth token (our
//      `state.githubAgentToken`) sent as `Bearer`. The structured
//      `/copilot_internal/v2/token` output (`tid=…;exp=…:sig`) is REJECTED by
//      this host with "invalid authorization header format".
//   2. The host is not fixed — it is discovered per-viewer via the GraphQL
//      `viewer.copilotEndpoints.api` field, and validated against the shared
//      Copilot host allowlist before we ever send the Bearer token to it.
//
// Required CAPI headers: `Copilot-Integration-Id: copilot-4-cli` and
// `X-GitHub-Api-Version: 2026-01-09`. The logs endpoint
// (`GET {host}/agents/sessions/{sessionId}/logs`) returns SSE `data:`-framed
// `chat.completion.chunk` objects; there are no follow-up/steer/cancel
// endpoints (steering is via PR comments).
// ---------------------------------------------------------------------------

const CAPI_INTEGRATION_ID = "copilot-4-cli"
const CAPI_API_VERSION = "2026-01-09"
const HOST_CACHE_TTL_MS = 10 * 60 * 1000
const LOG_EXCERPT_LIMIT = 4000
const TRUNCATED_MARKER = "…[truncated]…"
// Hard cap on the raw SSE body we read/parse. The log is untrusted
// agent-authored text; a runaway session must not exhaust memory/CPU. The
// distilled excerpt is only ~4KB, so 4 MiB of source is generous headroom.
const MAX_LOG_BYTES = 4 * 1024 * 1024
// Per-field accumulation cap so a single giant content/reasoning/tool-arg
// stream can't grow unbounded even within the byte cap.
const MAX_FIELD_CHARS = 256 * 1024

let hostCache: { host: string; at: number } | null = null

interface CopilotEndpointsData {
  viewer?: { copilotEndpoints?: { api?: string } }
}

async function discoverCapiHost(signal?: AbortSignal): Promise<string | null> {
  const now = Date.now()
  if (hostCache && now - hostCache.at < HOST_CACHE_TTL_MS) return hostCache.host

  try {
    const data = await ghGraphQL<CopilotEndpointsData>(
      "query CopilotEndpoints { viewer { copilotEndpoints { api } } }",
      {},
      { signal },
    )
    const host = data.viewer?.copilotEndpoints?.api
    if (typeof host === "string" && host.length > 0) {
      const normalized = host.replace(/\/+$/, "")
      // Never send the OAuth token to a host GitHub didn't vouch for as a
      // Copilot API host (defense-in-depth against a tampered discovery reply).
      if (!isAllowedCopilotHost(normalized)) {
        consola.debug(`first-mate capi: discovered host not allowlisted: ${normalized}`)
        return null
      }
      hostCache = { host: normalized, at: now }
      return hostCache.host
    }
    consola.debug("first-mate capi: discovery returned no host")
  } catch (err) {
    consola.debug("first-mate capi: host discovery failed:", err)
  }
  return null
}

function capiHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${state.githubAgentToken ?? ""}`,
    "copilot-integration-id": CAPI_INTEGRATION_ID,
    "x-github-api-version": CAPI_API_VERSION,
    "user-agent": "github-router-first-mate",
  }
}

export interface SessionLogExcerpt {
  /** Distilled, hard-truncated plan + reasoning + progress + tool names. */
  excerpt: string
  /** True once a chunk reported `finish_reason: "stop"`. */
  finished: boolean
  /** Distinct tool names the agent invoked, in first-seen order. */
  tools: string[]
}

interface ToolCallAccum {
  name?: string
  args: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function truncateHead(text: string): string {
  if (text.length <= LOG_EXCERPT_LIMIT) return text
  return `${text.slice(0, LOG_EXCERPT_LIMIT - TRUNCATED_MARKER.length)}${TRUNCATED_MARKER}`
}

// Per-section budgets. The distilled plan reads top-down (head-kept); progress
// and reasoning are most useful at their tail (the recent state / conclusion).
const PLAN_LIMIT = 2800
const PROGRESS_LIMIT = 900

function headTruncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - TRUNCATED_MARKER.length)}${TRUNCATED_MARKER}`
}

function tailTruncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${TRUNCATED_MARKER}${text.slice(-(limit - TRUNCATED_MARKER.length))}`
}

/** Extract a `<plan>…</plan>` block (the plan-mode agent wraps its plan in it). */
function extractPlanBlock(text: string): string | null {
  const match = /<plan>([\s\S]*?)<\/plan>/i.exec(text)
  const inner = match?.[1]?.trim()
  return inner && inner.length > 0 ? inner : null
}

/**
 * Drop the agent's MCP-server registration preamble. Every cloud-agent session
 * emits a large, signal-free tool-registration dump ("MCP server started
 * successfully with N tools", "- github-mcp-server/actions_get", …) at the
 * START, which would otherwise dominate a head-truncated excerpt and bury the
 * actual plan/progress that lands at the tail.
 */
function stripMcpBoilerplate(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const l = line.trim()
      if (/^MCP server started successfully/i.test(l)) return false
      if (/^-\s+(runtime-tools|github-mcp-server)\//i.test(l)) return false
      return true
    })
    .join("\n")
}

/** Append with a per-field cap; once at the cap, further growth is dropped. */
function capped(current: string, addition: string): string {
  if (current.length >= MAX_FIELD_CHARS) return current
  const room = MAX_FIELD_CHARS - current.length
  return current + (addition.length > room ? addition.slice(0, room) : addition)
}

/**
 * Read a response body as text, capped at `MAX_LOG_BYTES`. Stops pulling once
 * the cap is reached (a runaway/untrusted stream must not exhaust memory).
 */
async function readCappedText(response: Response): Promise<string> {
  const body = response.body
  if (!body) return response.text()

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.length >= MAX_LOG_BYTES) {
        void reader.cancel().catch(() => {})
        break
      }
    }
    text += decoder.decode()
  } catch (err) {
    consola.debug("first-mate capi: capped read interrupted:", err)
  }
  return text.length > MAX_LOG_BYTES ? text.slice(0, MAX_LOG_BYTES) : text
}

/**
 * Parse the SSE body of a session-log stream into a compact excerpt. Tolerant
 * of partial/incomplete streams (an in-progress agent) and SSE-compliant for
 * multi-line `data:` events (a single event's `data:` lines are joined with
 * `\n` before parsing). `finished` reflects whether a terminal chunk was seen.
 * All log content is UNTRUSTED agent text.
 */
export function parseSessionLog(body: string): SessionLogExcerpt {
  let content = ""
  let reasoning = ""
  let finished = false
  const toolNames: string[] = []
  const toolCalls = new Map<number, ToolCallAccum>()

  // SSE events are separated by a blank line; within one event, multiple
  // `data:` lines are concatenated with `\n`. Normalise CRLF, split on blank
  // lines, and reduce each event to its joined data payload.
  const events = body.replace(/\r\n/g, "\n").split(/\n\n+/)
  for (const event of events) {
    const dataLines: string[] = []
    for (const rawLine of event.split("\n")) {
      const line = rawLine.trimEnd()
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
    }
    if (dataLines.length === 0) continue
    const payload = dataLines.join("\n").trim()
    if (!payload || payload === "[DONE]") continue

    let chunk: Record<string, unknown> | undefined
    try {
      chunk = asRecord(JSON.parse(payload))
    } catch {
      continue
    }
    if (!chunk || chunk.object !== "chat.completion.chunk") continue

    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    for (const choiceValue of choices) {
      const choice = asRecord(choiceValue)
      if (!choice) continue
      const delta = asRecord(choice.delta) ?? {}

      if (typeof delta.content === "string") content = capped(content, delta.content)
      if (typeof delta.reasoning_text === "string") {
        reasoning = capped(reasoning, delta.reasoning_text)
      }
      if (choice.finish_reason === "stop") finished = true

      const toolCallDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
      for (const tcValue of toolCallDeltas) {
        const call = asRecord(tcValue)
        if (!call) continue
        const index = typeof call.index === "number" ? call.index : toolCalls.size
        const fn = asRecord(call.function) ?? {}
        const existing = toolCalls.get(index) ?? { args: "" }
        if (typeof fn.name === "string" && fn.name.length > 0) {
          existing.name = fn.name
          toolNames.push(fn.name)
        }
        if (typeof fn.arguments === "string") existing.args = capped(existing.args, fn.arguments)
        toolCalls.set(index, existing)
      }
    }
  }

  // The `report_progress` tool call carries the distilled plan in its
  // `prDescription` argument — the single most useful field for plan review.
  let planDescription = ""
  for (const call of toolCalls.values()) {
    if (call.name !== "report_progress") continue
    try {
      const parsed = asRecord(JSON.parse(call.args))
      const desc = parsed?.prDescription ?? parsed?.pr_description
      if (typeof desc === "string" && desc.length > planDescription.length) {
        planDescription = desc
      }
    } catch {
      // Streamed arguments may be incomplete for an in-flight call; ignore.
    }
  }

  const uniqueTools = [...new Set(toolNames)]

  // Plan sources, best first: the report_progress.prDescription (build tasks),
  // then a <plan>…</plan> block the agent emits in its content (plan tasks).
  const planBlock = extractPlanBlock(content)
  const plan = planDescription.trim() || planBlock || ""

  // Progress = content minus the plan block minus the MCP boilerplate, TAIL-kept
  // (the recent state / conclusion is at the end, not the head).
  const progressSource = planBlock
    ? content.replace(/<plan>[\s\S]*?<\/plan>/i, "")
    : content
  const progress = stripMcpBoilerplate(progressSource).trim()

  const parts: string[] = []
  if (plan) parts.push(`Plan:\n${headTruncate(plan, PLAN_LIMIT)}`)
  if (reasoning.trim()) parts.push(`Reasoning:\n${tailTruncate(reasoning.trim(), PROGRESS_LIMIT)}`)
  if (progress) parts.push(`Progress:\n${tailTruncate(progress, PROGRESS_LIMIT)}`)
  if (uniqueTools.length > 0) parts.push(`Tools: ${uniqueTools.join(", ")}`)

  return { excerpt: truncateHead(parts.join("\n\n")), finished, tools: uniqueTools }
}

/**
 * Fetch and distil a cloud-agent session log. Best-effort: returns `null`
 * (never throws) when the agent token is absent, the host can't be discovered
 * or validated, or the request fails — callers fall back to the
 * `api.github.com` task text.
 */
export async function getSessionLog(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionLogExcerpt | null> {
  if (!state.githubAgentToken || !sessionId) return null

  const host = await discoverCapiHost(signal)
  if (!host) return null

  const url = `${host}/agents/sessions/${encodeURIComponent(sessionId)}/logs`
  let response: Response
  try {
    response = await fetchWithTransientRetry(
      () => fetch(url, { headers: capiHeaders(), signal, redirect: "error" }),
      { label: `capi session-log ${sessionId}`, signal },
    )
  } catch (err) {
    consola.debug("first-mate capi: session-log fetch failed:", err)
    return null
  }

  if (!response.ok) {
    consola.debug(`first-mate capi: session-log ${sessionId} → HTTP ${response.status}`)
    return null
  }

  try {
    return parseSessionLog(await readCappedText(response))
  } catch (err) {
    consola.debug("first-mate capi: session-log parse failed:", err)
    return null
  }
}

/** Test-only: reset the memoised host so a fresh discovery runs. */
export function resetCapiHostCacheForTest(): void {
  hostCache = null
}
