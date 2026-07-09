import type { McpGroup, NonPersonaMcpTool } from "../peer-mcp-personas"

import consola from "consola"

import {
  ArtifactClient,
  ArtifactError,
  type ArtifactAgentReplyResponse,
  type ArtifactAwaitResponse,
  type ArtifactEndResponse,
  type ArtifactEvent,
  type ArtifactPollResponse,
  type ArtifactSimpleResponse,
  type ArtifactUpdateResponse,
} from "./client"

const ARTIFACT_GROUP: McpGroup = "peers"
const ARTIFACT_POLL_TOOL_BUDGET_MS = 50_000
const ARTIFACT_SINGLE_POLL_TIMEOUT_MS = 25_000
const ARTIFACT_POLL_RETURN_MARGIN_MS = 1_000
const ARTIFACT_MAX_POLLS_PER_TOOL_CALL = 2

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

interface ArtifactEnv {
  baseUrl: string
  token: string
  sessionId: string
  insecureTLS: boolean
}

function tool(
  toolNameHttp: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpToolResult>,
): NonPersonaMcpTool {
  return {
    toolNameHttp,
    group: ARTIFACT_GROUP,
    capability: "artifact",
    description,
    inputSchema,
    async handler(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
      try {
        return await handler(args, signal)
      } catch (err) {
        return errorResult(err)
      }
    },
  }
}

export const ARTIFACT_TOOLS: ReadonlyArray<NonPersonaMcpTool> = Object.freeze([
  tool(
    "artifact_open",
    "Opens a workspace file in ai-or-die's Artifact review panel for human review, replacing the current review if one is already open. The caller provides a workspace-relative or absolute file path and can set mode:\"interactive\" when the HTML carries data-aod-* action controls. It returns the review URL/session identifiers plus next-step guidance for draining feedback. Use it when the user should review a durable artifact before work continues; it is not for one-line status updates or non-file content. Only works inside an ai-or-die tab-backed Claude session.",
    objectSchema({
      file: stringProp("Workspace-relative or absolute file path to show in the Artifact panel."),
      mode: enumProp(
        ["static", "interactive"],
        "Advisory. \"interactive\" signals the HTML contains data-aod-* action controls the panel should wire; \"static\" (default) is a read-and-annotate artifact.",
      ),
    }, ["file"]),
    async (args, signal) => {
      const env = readArtifactEnv()
      if (!env) return missingEnvResult()
      const file = requiredString(args, "file")
      const mode = optionalEnum(args, "mode", ["static", "interactive"])
      const response = await clientFromEnv(env).open(file, { mode, signal })
      return ok({
        viewUrl: response.viewUrl,
        sessionId: response.sessionId,
        key: response.key,
        next_step: "Tell the user to review at the Artifact panel, then call artifact_await to receive their feedback.",
      })
    },
  ),
  tool(
    "artifact_update",
    "Replaces the current Artifact review's content in place without opening a separate review. The caller provides exactly one of file, a workspace-relative or absolute file path, or html, raw HTML written into the existing review sandbox; html requires an already-open review, and idempotencyKey can make retries deduplicate on the server. It returns a minimal success signal plus next-step guidance for awaiting further feedback. Use it when revised content should replace what the human is already reviewing; use artifact_refresh instead when the existing on-disk artifact only needs to be reloaded. Only works inside an ai-or-die tab-backed Claude session.",
    objectSchema({
      file: stringProp("Workspace-relative or absolute file path to become the review's new content."),
      html: stringProp("Raw HTML to write into the review's existing sandboxed file, then reload."),
      idempotencyKey: stringProp("Optional stable key so a retried update is de-duplicated by the server."),
    }, []),
    async (args, signal) => {
      const env = readArtifactEnv()
      if (!env) return missingEnvResult()
      const file = optionalString(args, "file")
      const html = optionalString(args, "html")
      if ((file === undefined) === (html === undefined)) {
        throw new ArtifactToolInputError(
          "INVALID_ARGUMENT",
          "artifact_update requires EXACTLY ONE of arguments.file or arguments.html",
        )
      }
      const idempotencyKey = optionalString(args, "idempotencyKey")
      const response = await clientFromEnv(env).update({ file, html, idempotencyKey, signal })
      return ok(formatUpdateSuccess(response))
    },
  ),
  tool(
    "artifact_refresh",
    "Reloads the currently-open Artifact review from its existing on-disk file without changing the content source. The tool takes no inputs and returns a minimal success signal plus next-step guidance for awaiting feedback. Use it after an out-of-band edit changes the reviewed file on disk and the panel needs to pick up that version. Do not use it to replace the artifact with a new file or raw HTML; use artifact_update for that. Only works inside an ai-or-die tab-backed Claude session.",
    objectSchema({}, []),
    async (_args, signal) => {
      const env = readArtifactEnv()
      if (!env) return missingEnvResult()
      const response = await clientFromEnv(env).refresh(signal)
      return ok(formatRefreshSuccess(response))
    },
  ),
  tool(
    "artifact_await",
    "Waits for the human's next Artifact review events and returns a typed drain containing comments, structured action-button or checkbox events, status, cursor, and next-step guidance. The caller can pass the cursor from a previous response to receive only newer events and can provide timeoutMs as the server long-hold budget. It may return an empty events list on a quiet long-hold; callers should pass the returned cursor on the next artifact_await call. Use it as the primary review-feedback drain after artifact_open or artifact_update; it supersedes artifact_poll, which is legacy comments-only. Only works inside an ai-or-die tab-backed Claude session.",
    objectSchema({
      cursor: stringProp("High-water cursor from the previous artifact_await response. Omit on the first call."),
      timeoutMs: numberProp("Optional server long-hold budget in ms (default ~25000)."),
    }, []),
    async (args, signal) => {
      const env = readArtifactEnv()
      if (!env) return missingEnvResult()
      const cursor = optionalString(args, "cursor")
      const timeoutMs = optionalNumber(args, "timeoutMs")
      const response = await clientFromEnv(env).awaitEvents({ cursor, timeoutMs, signal })
      return ok(formatAwaitResponse(response))
    },
  ),
  tool(
    "artifact_dismiss",
    "Hides the ai-or-die Artifact panel UI while keeping the current review alive. The tool takes no inputs and returns a minimal success signal plus next-step guidance for reopening or awaiting later feedback. Use it when the panel should get out of the way but queued feedback should remain preserved, the channel should stay open, and the review should be re-openable. Do not use it when the review loop is finished; use artifact_end to close the review instead. Only works inside an ai-or-die tab-backed Claude session.",
    objectSchema({}, []),
    async (_args, signal) => {
      const env = readArtifactEnv()
      if (!env) return missingEnvResult()
      const response = await clientFromEnv(env).dismiss(signal)
      return ok(formatDismissSuccess(response))
    },
  ),
  tool(
    "artifact_reply",
    "Sends the agent's reply back to the ai-or-die Artifact review panel after applying or responding to human feedback. The caller provides the reply text, and the tool returns a minimal success signal plus next-step guidance for either continuing the review loop or moving on. Use it to acknowledge what changed, answer a reviewer question, or summarize how feedback was handled after artifact_await returns events. Do not use it to replace panel content, wait for more feedback, hide the UI, or close the review. Only works inside an ai-or-die tab-backed Claude session.",
    objectSchema({
      text: stringProp("Agent reply text to deliver to the human Artifact review panel."),
    }, ["text"]),
    async (args, signal) => {
      const env = readArtifactEnv()
      if (!env) return missingEnvResult()
      const text = requiredString(args, "text")
      const response = await clientFromEnv(env).agentReply(text, signal)
      return ok(formatReplySuccess(response))
    },
  ),
  tool(
    "artifact_end",
    "Ends and closes the ai-or-die Artifact review panel when the review loop is complete. The tool takes no inputs and returns a minimal success signal plus terminal next-step guidance. Use it after the human review is finished and no further feedback should arrive. Do not use it for a temporary hide or pause; use artifact_dismiss when the review should stay live. Only works inside an ai-or-die tab-backed Claude session.",
    objectSchema({}, []),
    async (_args, signal) => {
      const env = readArtifactEnv()
      if (!env) return missingEnvResult()
      const response = await clientFromEnv(env).end(signal)
      return ok(formatEndSuccess(response))
    },
  ),
  tool(
    "artifact_poll",
    "Provides the frozen legacy polling path for Artifact review feedback. The caller may provide timeoutMs as an advisory per-call budget, and the tool returns the old comments-only payload with status, prompts, and next-step guidance rather than typed action events or a cursor. Use it only for compatibility with older clients or flows that still require the old payload shape. New callers should use artifact_await instead because it returns typed comments and structured action-button or checkbox events. Only works inside an ai-or-die tab-backed Claude session.",
    objectSchema({
      timeoutMs: numberProp("Optional per-call budget hint in ms (advisory)."),
    }, []),
    async (_args, signal) => {
      const env = readArtifactEnv()
      if (!env) return missingEnvResult()
      const response = await pollUntilReady(clientFromEnv(env), signal)
      return ok(formatPollResponse(response))
    },
  ),
])

function readArtifactEnv(): ArtifactEnv | undefined {
  const baseUrl = process.env.AIORDIE_BASE_URL
  const token = process.env.AIORDIE_TOKEN
  const sessionId = process.env.AIORDIE_SESSION_ID
  if (!baseUrl || !token || !sessionId) return undefined
  return { baseUrl, token, sessionId, insecureTLS: shouldUseInsecureTls(baseUrl) }
}

// ai-or-die serves the artifact API over a self-signed cert on the literal
// loopback IP (https://127.0.0.1:<port>), so a plain fetch fails with "fetch
// failed". Relax verification ONLY for a literal loopback IP; FAIL CLOSED for any
// other host. `localhost` is excluded from auto-detect (it can be remapped to a
// non-loopback IP) — it requires an explicit AIORDIE_INSECURE_TLS=1; AIORDIE
// emits the explicit flag for the https case, so this stays belt-and-suspenders.
export function shouldUseInsecureTls(baseUrl: string): boolean {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  if (url.protocol !== "https:") return false
  const explicit = (process.env.AIORDIE_INSECURE_TLS ?? "").trim().toLowerCase()
  if (explicit === "0" || explicit === "false" || explicit === "off") return false
  if (isLoopbackIp(url.hostname)) return true
  // `localhost` only when explicitly opted in (resolver could point off-loopback).
  return url.hostname === "localhost" && (explicit === "1" || explicit === "true")
}

function isLoopbackIp(hostname: string): boolean {
  // new URL() wraps an IPv6 literal in brackets; strip for comparison.
  const host = hostname.replace(/^\[|\]$/g, "")
  return host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)
}

function clientFromEnv(env: ArtifactEnv): ArtifactClient {
  // Diagnostics only: token presence (bool, never the value) + TLS posture, so a
  // 401-vs-UNREACHABLE failure is distinguishable without leaking secrets.
  consola.debug(`ARTIFACT_ENV: token present=${env.token.length > 0}, insecureTLS=${env.insecureTLS}`)
  return new ArtifactClient(env)
}

async function pollUntilReady(
  client: Pick<ArtifactClient, "poll">,
  signal?: AbortSignal,
): Promise<ArtifactPollResponse> {
  const deadline = Date.now() + ARTIFACT_POLL_TOOL_BUDGET_MS
  let last: ArtifactPollResponse | undefined

  let attempts = 0
  while (!signal?.aborted && attempts < ARTIFACT_MAX_POLLS_PER_TOOL_CALL) {
    attempts += 1
    const remaining = deadline - Date.now()
    if (remaining <= ARTIFACT_POLL_RETURN_MARGIN_MS) break
    const timeoutMsHint = Math.min(
      ARTIFACT_SINGLE_POLL_TIMEOUT_MS,
      Math.max(1, remaining - ARTIFACT_POLL_RETURN_MARGIN_MS),
    )
    last = await client.poll(timeoutMsHint, signal)
    if (!isWaitingPoll(last)) return last
    if (deadline - Date.now() <= ARTIFACT_POLL_RETURN_MARGIN_MS) break
  }

  return {
    ...(last ?? { status: "waiting" }),
    status: "waiting",
    next_step: "No human feedback is ready yet. Call artifact_poll again.",
  }
}

function isWaitingPoll(response: ArtifactPollResponse): boolean {
  if (hasFeedback(response.prompts)) return false
  const status = response.status.toLowerCase()
  return status === "waiting"
    || status === "pending"
    || status === "open"
    || status === "idle"
    || status === "timeout"
    || status === "no_feedback"
}

function hasFeedback(prompts: unknown): boolean {
  if (Array.isArray(prompts)) return prompts.length > 0
  if (typeof prompts === "string") return prompts.trim() !== ""
  if (typeof prompts === "object" && prompts !== null) return Object.keys(prompts).length > 0
  return prompts !== undefined && prompts !== null
}

function formatPollResponse(response: ArtifactPollResponse): Record<string, unknown> {
  return definedObject({
    status: response.status,
    prompts: response.prompts,
    layout_warnings: response.layout_warnings,
    dom_snapshot: response.dom_snapshot,
    next_step: response.next_step ?? defaultPollNextStep(response.status),
  })
}

function formatUpdateSuccess(response: ArtifactUpdateResponse): Record<string, unknown> {
  return definedObject({
    ok: true,
    viewUrl: stringField(response, "viewUrl"),
    next_step: "The panel now shows the updated content. Call artifact_await for further feedback.",
  })
}

function formatRefreshSuccess(response: ArtifactSimpleResponse): Record<string, unknown> {
  return definedObject({
    ok: true,
    viewUrl: stringField(response, "viewUrl"),
    panelUrl: stringField(response, "panelUrl"),
    status: stringField(response, "status"),
    visibility: stringField(response, "visibility"),
    next_step: "The panel reloaded the artifact. Call artifact_await for feedback.",
  })
}

function formatDismissSuccess(response: ArtifactSimpleResponse): Record<string, unknown> {
  return definedObject({
    ok: true,
    viewUrl: stringField(response, "viewUrl"),
    panelUrl: stringField(response, "panelUrl"),
    status: stringField(response, "status"),
    visibility: stringField(response, "visibility"),
    next_step: "The panel is hidden but the review is still live. Re-open the artifact or call artifact_await when ready.",
  })
}

function formatReplySuccess(response: ArtifactAgentReplyResponse): Record<string, unknown> {
  return definedObject({
    ok: true,
    reply: response.reply,
    delivered: booleanField(response, "delivered"),
    confirmed: booleanField(response, "confirmed"),
    status: stringField(response, "status"),
    next_step: "Wait for further human review, or continue if the review loop is complete.",
  })
}

function formatEndSuccess(response: ArtifactEndResponse): Record<string, unknown> {
  return definedObject({
    ok: true,
    status: response.status,
    next_step: "Artifact review loop ended.",
  })
}

/**
 * Shape the typed drain for the model: pass events through verbatim (unknown
 * `kind`s preserved — the model ignores what it does not understand), echo the
 * cursor to thread into the next call, and pick a next_step from the events.
 */
function formatAwaitResponse(response: ArtifactAwaitResponse): Record<string, unknown> {
  const events = Array.isArray(response.events) ? response.events : []
  // `status` comes from JSON.parse, so a degraded/older server payload may omit
  // it — coerce so awaitNextStep never sees `undefined`.
  const status = typeof response.status === "string" ? response.status : undefined
  return definedObject({
    events,
    status,
    cursor: response.cursor,
    next_step: awaitNextStep(status ?? "", events),
  })
}

function awaitNextStep(status: string, events: ArtifactEvent[]): string {
  if ((status ?? "").toLowerCase() === "ended") {
    return "The review has ended. No further feedback will arrive."
  }
  if (events.length === 0) {
    return "No feedback yet. Call artifact_await again, passing the returned cursor."
  }
  const hasAction = events.some((e) => e.kind === "action")
  const hasComment = events.some((e) => e.kind === "comment")
  if (hasAction && hasComment) {
    return "Act on the action events (buttons/checkboxes) and the comments, reply with artifact_reply, then call artifact_await with the returned cursor."
  }
  if (hasAction) {
    return "The human triggered action controls. Act on them, optionally artifact_reply, then call artifact_await with the returned cursor."
  }
  return "Apply the human comments, call artifact_reply with a concise summary, then artifact_await with the returned cursor."
}

function defaultPollNextStep(status: string): string {
  return isWaitingStatus(status)
    ? "No human feedback is ready yet. Call artifact_poll again."
    : "Apply the human Artifact review feedback, then call artifact_reply with a concise summary."
}

function isWaitingStatus(status: string): boolean {
  const normalized = status.toLowerCase()
  return normalized === "waiting"
    || normalized === "pending"
    || normalized === "open"
    || normalized === "idle"
    || normalized === "timeout"
    || normalized === "no_feedback"
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || value.trim() === "") {
    throw new ArtifactToolInputError(
      "INVALID_ARGUMENT",
      `arguments.${key} is required and must be a non-empty string`,
    )
  }
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || value.trim() === "") {
    throw new ArtifactToolInputError(
      "INVALID_ARGUMENT",
      `arguments.${key} must be a non-empty string when provided`,
    )
  }
  return value
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ArtifactToolInputError(
      "INVALID_ARGUMENT",
      `arguments.${key} must be a positive number when provided`,
    )
  }
  return value
}

function optionalEnum(
  args: Record<string, unknown>,
  key: string,
  allowed: ReadonlyArray<string>,
): string | undefined {
  const value = optionalString(args, key)
  if (value === undefined) return undefined
  if (!allowed.includes(value)) {
    throw new ArtifactToolInputError(
      "INVALID_ARGUMENT",
      `arguments.${key} must be one of ${allowed.join(", ")}`,
    )
  }
  return value
}

class ArtifactToolInputError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "ArtifactToolInputError"
    this.code = code
  }
}

function missingEnvResult(): McpToolResult {
  return jsonResult({
    error: {
      code: "NOT_IN_AIORDIE_TAB",
      message:
        "artifact tools only work inside an ai-or-die tab-backed Claude session. Missing AIORDIE_BASE_URL, AIORDIE_TOKEN, or AIORDIE_SESSION_ID.",
    },
  }, true)
}

function ok(value: unknown): McpToolResult {
  return jsonResult(value, false)
}

function jsonResult(value: unknown, isError: boolean): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  }
}

function errorResult(err: unknown): McpToolResult {
  if (err instanceof ArtifactError) {
    return jsonResult({
      error: definedObject({
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        status: err.status,
      }),
    }, true)
  }
  const code = errorCode(err)
  const message = err instanceof Error ? err.message : String(err)
  return jsonResult({ error: { code, message } }, true)
}

function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === "string") return code
  }
  return "ARTIFACT_ERROR"
}

function definedObject(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === "string" ? value : undefined
}

function booleanField(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key]
  return typeof value === "boolean" ? value : undefined
}

function objectSchema(properties: Record<string, unknown>, required: Array<string>): Record<string, unknown> {
  return {
    type: "object",
    required,
    additionalProperties: false,
    properties,
  }
}

function stringProp(description: string): Record<string, unknown> {
  return { type: "string", description }
}

function numberProp(description: string): Record<string, unknown> {
  return { type: "number", description }
}

function enumProp(values: ReadonlyArray<string>, description: string): Record<string, unknown> {
  return { type: "string", enum: [...values], description }
}
