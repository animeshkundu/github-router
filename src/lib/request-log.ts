import consola from "consola"

import type { Model } from "~/services/copilot/get-models"

export interface RequestLogInfo {
  method: string
  path: string
  model?: string
  resolvedModel?: string
  inputTokens?: number
  outputTokens?: number
  status?: number
  streaming?: boolean
  errorBody?: string
}

/**
 * Format a number with K/M suffix for compact display.
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/**
 * Build a context window summary: "in:1.2K out:50 ctx:1.2K/1M (0.1%)"
 */
function formatTokenInfo(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  model: Model | undefined,
): string | undefined {
  if (inputTokens === undefined) return undefined

  const parts: Array<string> = []
  const maxPrompt = model?.capabilities?.limits?.max_prompt_tokens

  if (maxPrompt) {
    const pct = ((inputTokens / maxPrompt) * 100).toFixed(1)
    parts.push(`in:${formatTokens(inputTokens)}/${formatTokens(maxPrompt)} (${pct}%)`)
  } else {
    parts.push(`in:${formatTokens(inputTokens)}`)
  }

  if (outputTokens !== undefined) {
    parts.push(`out:${formatTokens(outputTokens)}`)
  }

  return parts.join(" ")
}

/**
 * Print a single summary line for a completed request.
 *
 * Examples:
 *   POST /v1/messages  claude-opus-4.6-1m  in:1.2K/1M (0.1%) out:50  200  2.3s
 *   POST /v1/messages  claude-opus-4-6→claude-opus-4.6-1m  in:743/1M (0.1%)  200  198ms
 *   POST /v1/chat/completions  claude-sonnet-4  in:15 out:16  200  2.1s stream
 */
export function logRequest(
  info: RequestLogInfo,
  model: Model | undefined,
  startTime: number,
): void {
  const parts: Array<string> = []

  parts.push(`${info.method} ${info.path}`)

  // Model (show resolution arrow if remapped)
  if (info.resolvedModel && info.resolvedModel !== info.model) {
    parts.push(`${info.model}→${info.resolvedModel}`)
  } else if (info.resolvedModel ?? info.model) {
    parts.push((info.resolvedModel ?? info.model)!)
  }

  // Token info with context window fill
  const tokenInfo = formatTokenInfo(info.inputTokens, info.outputTokens, model)
  if (tokenInfo) {
    parts.push(tokenInfo)
  }

  // Status
  if (info.status !== undefined) {
    parts.push(String(info.status))
  }

  // Duration + streaming flag
  const elapsed = Date.now() - startTime
  const duration =
    elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`
  parts.push(info.streaming ? `${duration} stream` : duration)

  const line = parts.join("  ")

  if (detectCapabilityMismatch(info, model)) {
    consola.error(`[MISMATCH] ${line}`)
  } else {
    consola.info(line)
  }
}

/**
 * Detect when the API rejects a request for token/context reasons
 * that contradict what the /models endpoint reported.
 */
function detectCapabilityMismatch(
  info: RequestLogInfo,
  model: Model | undefined,
): boolean {
  if (!info.errorBody || !model) return false
  if (!info.status || info.status < 400) return false

  const err = info.errorBody.toLowerCase()
  return (
    err.includes("token") ||
    err.includes("context") ||
    err.includes("too long") ||
    err.includes("max_tokens") ||
    err.includes("prompt is too long")
  )
}

/**
 * Opt-in instrumentation for the discovery loop (Phase 0.5 of the
 * long-horizon plan). When `GH_ROUTER_LOG_FIELDS=1` is set in the
 * environment, emits a single structured `[fields]` log line per request
 * recording the top-level body keys, per-tool field keys, and
 * anthropic-beta header values seen.
 *
 * Default-off (zero overhead). The companion
 * `scripts/discover-new-fields.sh` greps these lines, aggregates unique
 * field names per request shape, and diffs against the known-fields
 * list in `docs/copilot-compat-matrix.md` — surfacing anything new
 * that should get a probe row added.
 *
 * Format (single line, deterministic-ish key order):
 *   [fields] path=<P> body_keys=<csv> tool_field_keys=<csv> beta_values=<csv>
 *
 * Where:
 *   - `body_keys` is the alphabetical union of top-level keys in the
 *     request body
 *   - `tool_field_keys` is the alphabetical union of all keys appearing
 *     across every entry of `body.tools[]` (or empty)
 *   - `beta_values` is the comma-split anthropic-beta header value as
 *     received (NOT filtered) — captures what the client sends, not
 *     what we forward
 */
export function logRequestFields(opts: {
  path: string
  body: unknown
  betaHeader?: string
}): void {
  if (process.env.GH_ROUTER_LOG_FIELDS !== "1") return
  const bodyKeys = collectTopLevelKeys(opts.body)
  const toolFieldKeys = collectToolFieldKeys(opts.body)
  const betaValues = (opts.betaHeader ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
  consola.info(
    `[fields] path=${opts.path}`
    + ` body_keys=${bodyKeys.join(",")}`
    + ` tool_field_keys=${toolFieldKeys.join(",")}`
    + ` beta_values=${betaValues.join(",")}`,
  )
}

function collectTopLevelKeys(body: unknown): Array<string> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return []
  return Object.keys(body as Record<string, unknown>).sort()
}

function collectToolFieldKeys(body: unknown): Array<string> {
  if (!body || typeof body !== "object") return []
  const tools = (body as Record<string, unknown>).tools
  if (!Array.isArray(tools)) return []
  const seen = new Set<string>()
  for (const tool of tools) {
    if (tool && typeof tool === "object" && !Array.isArray(tool)) {
      for (const k of Object.keys(tool as Record<string, unknown>)) {
        seen.add(k)
      }
    }
  }
  return [...seen].sort()
}
