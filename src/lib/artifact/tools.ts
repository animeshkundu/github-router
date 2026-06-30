import type { McpGroup, NonPersonaMcpTool } from "../peer-mcp-personas"

import consola from "consola"

import { ArtifactClient, ArtifactError, type ArtifactPollResponse } from "./client"

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
    "Open a workspace file in ai-or-die's Artifact review panel for human review. Only works inside an ai-or-die tab-backed Claude session.",
    objectSchema({
      file: stringProp("Workspace-relative or absolute file path to show in the Artifact panel."),
    }, ["file"]),
    async (args, signal) => {
      const env = readArtifactEnv()
      if (!env) return missingEnvResult()
      const file = requiredString(args, "file")
      const response = await clientFromEnv(env).open(file, signal)
      return ok({
        viewUrl: response.viewUrl,
        next_step: "Tell the user to review at the Artifact panel, then call artifact_poll.",
      })
    },
  ),
  tool(
    "artifact_poll",
    "Wait for human Artifact review feedback from ai-or-die and return the prompts/layout warnings/DOM snapshot for the agent to act on. Only works inside an ai-or-die tab-backed Claude session.",
    objectSchema({}, []),
    async (_args, signal) => {
      const env = readArtifactEnv()
      if (!env) return missingEnvResult()
      const response = await pollUntilReady(clientFromEnv(env), signal)
      return ok(formatPollResponse(response))
    },
  ),
  tool(
    "artifact_reply",
    "Send the agent's reply back to the ai-or-die Artifact review panel after applying or responding to human feedback. Only works inside an ai-or-die tab-backed Claude session.",
    objectSchema({
      text: stringProp("Agent reply text to deliver to the human Artifact review panel."),
    }, ["text"]),
    async (args, signal) => {
      const env = readArtifactEnv()
      if (!env) return missingEnvResult()
      const text = requiredString(args, "text")
      const response = await clientFromEnv(env).agentReply(text, signal)
      return ok({
        ok: true,
        ...response,
        next_step: "Wait for further human review, or continue if the review loop is complete.",
      })
    },
  ),
  tool(
    "artifact_end",
    "End/close the ai-or-die Artifact review panel when the review loop is complete. Only works inside an ai-or-die tab-backed Claude session.",
    objectSchema({}, []),
    async (_args, signal) => {
      const env = readArtifactEnv()
      if (!env) return missingEnvResult()
      const response = await clientFromEnv(env).end(signal)
      return ok({
        ok: true,
        ...response,
        next_step: "Artifact review loop ended.",
      })
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
