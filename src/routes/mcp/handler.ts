import { timingSafeEqual } from "node:crypto"

import consola from "consola"
import type { Context } from "hono"

import { state } from "~/lib/state"
import { resolveModel } from "~/lib/utils"
import {
  PERSONAS_READ,
  type PersonaSpec,
} from "~/lib/peer-mcp-personas"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type ResponsesApiResponse,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

const MCP_PROTOCOL_VERSION = "2025-06-18"
const SERVER_NAME = "github-router-peers"
const SERVER_VERSION = "1"

/** Bounded concurrency. Reviewers flagged Opus's natural pattern with three
 *  critics is parallel invocation — without a cap that's 3× upstream Copilot
 *  QPS per delegation. Cap at 2 in-flight tools/call across the whole proxy
 *  and surface overflow as `isError: "queue full"` instead of silent
 *  serialization. */
const MAX_INFLIGHT_TOOLS_CALL = 2
let inFlightToolsCall = 0

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

interface ToolEntry {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const RPC_PARSE_ERROR = -32700
const RPC_INVALID_REQUEST = -32600
const RPC_METHOD_NOT_FOUND = -32601
const RPC_INVALID_PARAMS = -32602
const RPC_INTERNAL_ERROR = -32603

function rpcError(
  id: JsonRpcRequest["id"] | undefined,
  code: number,
  message: string,
  data?: unknown,
): { jsonrpc: "2.0"; id: JsonRpcRequest["id"] | null; error: object } {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  }
}

function rpcResult<T>(
  id: JsonRpcRequest["id"] | undefined,
  result: T,
): { jsonrpc: "2.0"; id: JsonRpcRequest["id"] | null; result: T } {
  return { jsonrpc: "2.0", id: id ?? null, result }
}

function isLoopbackHost(host: string | undefined | null): boolean {
  if (!host) return false
  // Strip port. IPv6-bracketed hosts (e.g. "[::1]:8080") aren't a concern
  // here — we bind to 127.0.0.1 only.
  const idx = host.lastIndexOf(":")
  const hostname = idx >= 0 ? host.slice(0, idx) : host
  return hostname === "127.0.0.1" || hostname === "localhost"
}

/**
 * Constant-time bearer compare. Random per-launch nonces aren't really
 * timing-attackable in practice, but this costs nothing.
 */
function nonceMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function checkAuth(c: Context): { ok: true } | { ok: false; status: 401 | 403; reason: string } {
  // Host validation defeats DNS-rebinding attacks. An attacker who tricks
  // the browser into resolving evil.com → 127.0.0.1 still sends
  // Host: evil.com, which we reject here.
  if (!isLoopbackHost(c.req.header("host"))) {
    return { ok: false, status: 403, reason: "non-loopback Host header rejected" }
  }
  // Per-launch nonce. State is set by the `claude` subcommand after
  // setupAndServe. When unset (proxy started standalone, e.g. via
  // `github-router start`), `/mcp` rejects all requests.
  const expected = state.peerMcpNonce
  if (!expected) {
    return { ok: false, status: 401, reason: "/mcp not enabled in this proxy session" }
  }
  const auth = c.req.header("authorization") ?? ""
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (!m || !nonceMatches(m[1], expected)) {
    return { ok: false, status: 401, reason: "missing or invalid Authorization bearer" }
  }
  return { ok: true }
}

function geminiAvailable(): boolean {
  const models = state.models?.data
  if (!models) return false
  return models.some((m) => /^gemini-3\..*pro/i.test(m.id))
}

function activePersonas(): Array<PersonaSpec> {
  return PERSONAS_READ.filter((p) => !p.requiresHttp || geminiAvailable())
}

function toolEntries(): Array<ToolEntry> {
  return activePersonas().map((p) => ({
    name: p.toolNameHttp,
    description: p.description,
    inputSchema: {
      type: "object",
      required: ["prompt"],
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          description: "The lead's brief — the artifact under review plus constraints.",
        },
        context: {
          type: "string",
          description:
            "Optional additional context (extra file content, prior decisions). Concatenated to the brief before sending.",
        },
      },
    },
  }))
}

function buildUserText(prompt: string, context?: string): string {
  if (!context) return prompt
  return `${prompt}\n\n---\n\nAdditional context:\n${context}`
}

function extractResponsesText(response: ResponsesApiResponse): string {
  const out: Array<string> = []
  for (const item of response.output) {
    if (typeof item !== "object" || item === null) continue
    const obj = item as Record<string, unknown>
    if (obj.type !== "message" || obj.role !== "assistant") continue
    const content = obj.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue
      const p = part as Record<string, unknown>
      if (
        (p.type === "output_text" || p.type === "text")
        && typeof p.text === "string"
      ) {
        out.push(p.text)
      }
    }
  }
  return out.join("")
}

function extractChatCompletionText(response: ChatCompletionResponse): string {
  const choice = response.choices?.[0]
  if (!choice) return ""
  const c = choice.message?.content
  return typeof c === "string" ? c : ""
}

interface ToolErrorContent {
  content: Array<{ type: "text"; text: string }>
  isError: true
}

function toolError(message: string): ToolErrorContent {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  }
}

async function callPersona(
  persona: PersonaSpec,
  prompt: string,
  context: string | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  // Resolve the model id against the live catalog so a slug rename
  // (e.g., gemini-3.1-pro-preview → gemini-3.1-pro at GA) auto-resolves
  // through the existing fuzzy matcher rather than 404'ing.
  const resolvedModel = resolveModel(persona.model)
  const userText = buildUserText(prompt, context)

  // NOTE on consumer-cancel signal: we deliberately do NOT pass
  // c.req.raw.signal into the upstream fetch. Bun/srvx aborts the
  // request signal as soon as the request body is fully consumed
  // (after `await c.req.json()`), which would make every persona call
  // fail immediately with "This operation was aborted". The existing
  // /v1/responses handler also doesn't propagate consumer signal —
  // it relies on the manual ReadableStream.cancel() callback for
  // streaming, which v1 tools/call doesn't use. If we add streaming
  // tools/call results in the future, revisit with a Bun-aware
  // approach (see CLAUDE.md "Spec ≠ runtime").
  if (persona.endpoint === "/v1/responses") {
    const payload: ResponsesPayload = {
      model: resolvedModel,
      instructions: persona.baseInstructions,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: userText }],
        },
      ],
      stream: false,
    }
    const response = (await createResponses(
      payload,
    )) as ResponsesApiResponse
    const text = extractResponsesText(response)
    if (!text) {
      return toolError(`persona ${persona.agentName}: empty assistant output`)
    }
    return { content: [{ type: "text", text }] }
  }

  // /v1/chat/completions (Gemini)
  const payload: ChatCompletionsPayload = {
    model: resolvedModel,
    messages: [
      { role: "system", content: persona.baseInstructions },
      { role: "user", content: userText },
    ],
    stream: false,
  }
  const response = (await createChatCompletions(
    payload,
  )) as ChatCompletionResponse
  const text = extractChatCompletionText(response)
  if (!text) {
    return toolError(`persona ${persona.agentName}: empty assistant output`)
  }
  return { content: [{ type: "text", text }] }
}

interface PersonaTelemetry {
  name: string
  model: string
  durationMs: number
  result: "ok" | "isError" | "exception"
  errorMessage?: string
}

function logTelemetry(t: PersonaTelemetry): void {
  // Single-line stderr log so users can grep across sessions to see
  // which personas earn their keep. Honors the minimalist reviewer's
  // "earn your keep" critique — personas with near-zero use after
  // ~2 weeks are removal candidates.
  const parts = [
    `[peer-mcp]`,
    `name=${t.name}`,
    `model=${t.model}`,
    `duration_ms=${t.durationMs}`,
    `result=${t.result}`,
  ]
  if (t.errorMessage) parts.push(`error=${JSON.stringify(t.errorMessage)}`)
  // Use stderr directly so this is visible regardless of consola level.
  process.stderr.write(parts.join(" ") + "\n")
}

async function handleToolsCall(
  body: JsonRpcRequest,
): Promise<object> {
  const params = body.params ?? {}
  const name = typeof params.name === "string" ? params.name : ""
  const args = (params.arguments ?? {}) as Record<string, unknown>
  const prompt = typeof args.prompt === "string" ? args.prompt : ""
  const context = typeof args.context === "string" ? args.context : undefined

  if (!name) {
    return rpcError(body.id, RPC_INVALID_PARAMS, "tools/call missing name")
  }
  const persona = activePersonas().find((p) => p.toolNameHttp === name)
  if (!persona) {
    return rpcError(
      body.id,
      RPC_METHOD_NOT_FOUND,
      `tools/call: unknown tool "${name}"`,
    )
  }
  if (!prompt) {
    return rpcError(
      body.id,
      RPC_INVALID_PARAMS,
      `tools/call: arguments.prompt is required`,
    )
  }

  if (inFlightToolsCall >= MAX_INFLIGHT_TOOLS_CALL) {
    // Documented per-call cap. NOT silent serialization — surface the
    // backpressure so Opus knows to retry shortly.
    return rpcResult(body.id, {
      content: [
        {
          type: "text",
          text: `Peer MCP queue full (${MAX_INFLIGHT_TOOLS_CALL} in-flight). Retry shortly, or wait for the current persona calls to complete.`,
        },
      ],
      isError: true,
    })
  }

  inFlightToolsCall++
  const startedAt = Date.now()
  try {
    const result = await callPersona(persona, prompt, context)
    logTelemetry({
      name: persona.agentName,
      model: persona.model,
      durationMs: Date.now() - startedAt,
      result: result.isError ? "isError" : "ok",
    })
    return rpcResult(body.id, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logTelemetry({
      name: persona.agentName,
      model: persona.model,
      durationMs: Date.now() - startedAt,
      result: "exception",
      errorMessage: message,
    })
    // Tool error vs JSON-RPC error: per MCP spec, runtime errors that
    // correspond to "the tool ran but failed" should surface as
    // result.isError=true (not as JSON-RPC errors). Catalog/auth/etc.
    // 404s from the upstream all go here.
    return rpcResult(body.id, {
      content: [
        {
          type: "text",
          text: `persona ${persona.agentName} failed: ${message}`,
        },
      ],
      isError: true,
    })
  } finally {
    inFlightToolsCall--
  }
}

async function handleRpc(
  _c: Context,
  body: JsonRpcRequest,
): Promise<{ status: number; body: object | null }> {
  // Reject non-object envelopes (null, arrays, primitives) BEFORE we
  // dereference body.jsonrpc / body.method — without this guard a `null`
  // body throws TypeError on the property access, falls into the outer
  // catch in handleMcpPost, and returns RPC_INTERNAL_ERROR (-32603) when
  // the JSON-RPC spec wants RPC_INVALID_REQUEST (-32600) for shape errors.
  if (
    body === null
    || typeof body !== "object"
    || Array.isArray(body)
  ) {
    return {
      status: 200,
      body: rpcError(null, RPC_INVALID_REQUEST, "jsonrpc 2.0 envelope required"),
    }
  }
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return {
      status: 200,
      body: rpcError(body.id ?? null, RPC_INVALID_REQUEST, "jsonrpc 2.0 envelope required"),
    }
  }

  // Per JSON-RPC 2.0: requests without an `id` field are notifications
  // and MUST NOT receive a response body. The runtime must treat them
  // as fire-and-forget. We dispatch the method (so e.g. notifications/
  // initialized still gets observed), then return 202 + empty body
  // regardless of what the dispatched method returned.
  const isNotification = body.id === undefined

  switch (body.method) {
    case "initialize":
      if (isNotification) return { status: 202, body: null }
      return {
        status: 200,
        body: rpcResult(body.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      }

    case "notifications/initialized":
      // Notifications have no id and expect no response body.
      // Return 202 Accepted with an empty body (Hono accepts null).
      return { status: 202, body: null }

    case "tools/list":
      if (isNotification) return { status: 202, body: null }
      return {
        status: 200,
        body: rpcResult(body.id, { tools: toolEntries() }),
      }

    case "tools/call":
      if (isNotification) return { status: 202, body: null }
      return {
        status: 200,
        body: await handleToolsCall(body),
      }

    case "ping":
      if (isNotification) return { status: 202, body: null }
      // MCP heartbeat — return empty result.
      return { status: 200, body: rpcResult(body.id, {}) }

    default:
      if (isNotification) return { status: 202, body: null }
      return {
        status: 200,
        body: rpcError(
          body.id,
          RPC_METHOD_NOT_FOUND,
          `unknown method: ${body.method}`,
        ),
      }
  }
}

export async function handleMcpPost(c: Context): Promise<Response> {
  const auth = checkAuth(c)
  if (!auth.ok) {
    return c.json(
      rpcError(null, RPC_INVALID_REQUEST, auth.reason),
      auth.status,
    )
  }

  let body: JsonRpcRequest
  try {
    body = (await c.req.json()) as JsonRpcRequest
  } catch (err) {
    consola.debug("/mcp parse error:", err)
    return c.json(
      rpcError(null, RPC_PARSE_ERROR, "request body is not valid JSON"),
      200,
    )
  }

  try {
    const { status, body: respBody } = await handleRpc(c, body)
    if (respBody === null) return c.body(null, status as 202)
    return c.json(respBody, status as 200)
  } catch (err) {
    consola.error("/mcp handler error:", err)
    // Be defensive about `body.id` — body could be null or a non-object
    // primitive that slipped past the JSON parse (rare but possible).
    const echoId =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as JsonRpcRequest).id ?? null
        : null
    return c.json(
      rpcError(
        echoId,
        RPC_INTERNAL_ERROR,
        err instanceof Error ? err.message : String(err),
      ),
      200,
    )
  }
}

export function handleMcpDelete(c: Context): Response {
  // MCP DELETE is for session teardown. v1 is session-less, so this
  // is a 200 ack regardless of body. Body is intentionally NOT
  // parsed — there's no schema to validate against, and parsing an
  // attacker-controlled body adds attack surface.
  const auth = checkAuth(c)
  if (!auth.ok) {
    return c.json(
      rpcError(null, RPC_INVALID_REQUEST, auth.reason),
      auth.status,
    )
  }
  return c.body(null, 200)
}

/** Test helper: reset in-flight counter between tests. */
export function __resetInFlightForTests(): void {
  inFlightToolsCall = 0
}

/** Test helper: peek the in-flight counter. */
export function __getInFlightForTests(): number {
  return inFlightToolsCall
}
