import { timingSafeEqual } from "node:crypto"

import consola from "consola"
import type { Context } from "hono"

import { state } from "~/lib/state"
import { resolveModel } from "~/lib/utils"
import {
  PERSONAS_READ,
  type PersonaSpec,
  EFFORT_LEVELS,
  type Effort,
  isEffort,
} from "~/lib/peer-mcp-personas"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import {
  createResponses,
  type ResponsesApiResponse,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

const MCP_PROTOCOL_VERSION = "2025-06-18"
const SERVER_NAME = "github-router-peers"
const SERVER_VERSION = "1"

// Effort levels (EFFORT_LEVELS, Effort, isEffort) are imported from
// peer-mcp-personas.ts so PersonaSpec.allowedEfforts can reference the
// same type without a circular import. Per-persona defaultEffort is on
// the PersonaSpec; there is no module-level default here anymore.

/** Bounded concurrency. Originally capped at 2 (commit 4317a25) as a defensive
 *  pre-launch guess against Opus's natural pattern of fanning out to all three
 *  critics at once. Raised to 8 (Phase 2D of the peer-MCP plan) so the
 *  decomposition pattern Phase 2B teaches Opus — "split a >20 KB artifact
 *  into 2-4 batches and call in parallel" — can actually run in parallel
 *  without the (3+)th call returning isError "queue full". The persona
 *  handlers (`callPersona`) hold no shared mutable state — there's no race
 *  the cap is hiding; the upstream Copilot's own rate-limit (surfaced as a
 *  per-call 429 → tool isError) is the real backpressure mechanism. 8 covers
 *  a 7-fork wave with one slot of headroom and is still a hard upper bound
 *  against runaway clients. See docs/research/peer-mcp-investigation.md
 *  § "Concurrency cap investigation" for the full justification.  */
const MAX_INFLIGHT_TOOLS_CALL = 8
let inFlightToolsCall = 0

/**
 * Per-request AbortController registry for `notifications/cancelled`
 * (Phase D P1.5). When a client times out a tools/call before the
 * upstream Copilot fetch completes, the JSON-RPC notification:
 *   { jsonrpc:"2.0", method:"notifications/cancelled",
 *     params:{ requestId: "<id>", reason?: "..." } }
 * arrives. Without handling, the upstream fetch keeps running until
 * natural completion, leaking the inFlightToolsCall slot for tens of
 * minutes. Tracking the AbortController lets us abort the fetch and
 * free the slot immediately.
 *
 * Important: per CLAUDE.md "Bun request-signal quirk", we use OUR own
 * AbortController (NOT c.req.raw.signal which fires after request body
 * is consumed). The signal is threaded into createResponses /
 * createChatCompletions's `callerSignal` parameter.
 */
const inflightAborts = new Map<string | number, AbortController>()

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
  // Drop personas whose model family is missing from Copilot's live
  // catalog (currently only gemini-critic, gated by `requiresGeminiCatalog`).
  // Distinct from `requiresHttp` (codex-cli stdio routing constraint) —
  // see PersonaSpec field doc in peer-mcp-personas.ts.
  return PERSONAS_READ.filter((p) => !p.requiresGeminiCatalog || geminiAvailable())
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
        effort: {
          type: "string",
          // Per-persona allowedEfforts: schema only advertises tiers the
          // persona accepts. Empirical data (2026-05-14) drove which tiers
          // each persona exposes — see EFFORT_LEVELS doc in
          // src/lib/peer-mcp-personas.ts.
          enum: [...p.allowedEfforts],
          description:
            `Reasoning depth (${p.allowedEfforts.join(" | ")}). Default "${p.defaultEffort}". `
            + "Higher tiers cost more wall-clock; lower tiers are quicker sanity checks. "
            + (p.endpoint === "/v1/chat/completions"
              ? "Note: for gemini routed via /v1/chat/completions, the upstream may silently ignore this knob."
              : ""),
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

/**
 * Extract assistant text from an Anthropic /v1/messages response.
 * Mirrors `extractResponsesText` for the OpenAI /v1/responses shape.
 *
 * The Anthropic Messages API response has shape `{content: [{type, ...}, ...]}`.
 * Text blocks have `type: "text"` and `text: string`. Thinking blocks have
 * `type: "thinking"` (and live in the same array; we ignore them — they're
 * the model's reasoning trace, not the final answer for the lead).
 */
interface MessagesApiContentBlock {
  type: string
  text?: string
}
interface MessagesApiResponse {
  content?: ReadonlyArray<MessagesApiContentBlock>
}

function extractMessagesText(response: MessagesApiResponse): string {
  const out: Array<string> = []
  for (const block of response.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      out.push(block.text)
    }
  }
  return out.join("")
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

/**
 * Empirical pre-flight cap to convert "would-bust-the-60s-MCP-ceiling"
 * calls into fast actionable errors instead of slot-leaking timeouts.
 *
 * Probed live against Copilot 2026-05-14:
 *   gpt-5.5 high on a ~600B prompt = 23.8s → ~76s on 8KB (rough linear)
 *   gpt-5.3-codex high on ~600B = 16.0s → ~64s on 12KB
 *   claude-opus-4-7 medium (thinking=3000) on a trivial prompt = 22.5s
 *     but model self-paces budget → ~50s+ on a real ~6KB review
 *
 * Returns `{tooLong: true, capBytes}` when the (persona, effort, briefBytes)
 * tuple is empirically predicted to bust the 60s ceiling. Caller must
 * reject pre-flight before burning an inFlight slot. Thresholds are
 * deliberately conservative — better to surface as a fast error and let
 * the caller decompose than to silently time out.
 *
 * gemini_critic has no cap (long-context model + Copilot may auto-pace).
 */
const PRE_FLIGHT_CAPS: ReadonlyArray<{
  toolName: string
  effort: Effort
  maxBriefBytes: number
}> = [
  { toolName: "codex_critic", effort: "high", maxBriefBytes: 8 * 1024 },
  { toolName: "codex_reviewer", effort: "high", maxBriefBytes: 12 * 1024 },
  { toolName: "opus_critic", effort: "medium", maxBriefBytes: 6 * 1024 },
]

function predictedTooLong(
  persona: PersonaSpec,
  effort: Effort,
  briefBytes: number,
): { tooLong: true; capBytes: number } | { tooLong: false } {
  for (const cap of PRE_FLIGHT_CAPS) {
    if (
      cap.toolName === persona.toolNameHttp
      && cap.effort === effort
      && briefBytes > cap.maxBriefBytes
    ) {
      return { tooLong: true, capBytes: cap.maxBriefBytes }
    }
  }
  return { tooLong: false }
}

async function callPersona(
  persona: PersonaSpec,
  prompt: string,
  context: string | undefined,
  effort: Effort,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  // Resolve the model id against the live catalog so a slug rename
  // (e.g., gemini-3.1-pro-preview → gemini-3.1-pro at GA) auto-resolves
  // through the existing fuzzy matcher rather than 404'ing.
  const resolvedModel = resolveModel(persona.model)
  const userText = buildUserText(prompt, context)

  // NOTE: predictedTooLong pre-flight cap fires in handleToolsCall
  // BEFORE inFlightToolsCall++ — see the architectural invariant
  // documented in CLAUDE.md. Don't duplicate it here.

  // NOTE on consumer-cancel signal: we deliberately do NOT pass
  // c.req.raw.signal into the upstream fetch. Bun/srvx aborts the
  // request signal as soon as the request body is fully consumed
  // (after `await c.req.json()`), which would make every persona call
  // fail immediately with "This operation was aborted". Instead, the
  // caller (handleToolsCall) creates its own AbortController and
  // threads it through `signal`. This is the controller registered in
  // `inflightAborts` and aborted by `notifications/cancelled` (Phase D
  // P1.5). See CLAUDE.md "Bun request-signal quirk" for full context.
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
      // Reasoning effort — gpt-5.x adaptive-thinking reads this field
      // directly. Copilot's translator buckets to its own internal
      // levels (CLAUDE.md "Thinking-mode translation").
      reasoning: { effort },
    }
    const response = (await createResponses(
      payload,
      undefined,
      signal,
    )) as ResponsesApiResponse
    const text = extractResponsesText(response)
    if (!text) {
      return toolError(`persona ${persona.agentName}: empty assistant output`)
    }
    return { content: [{ type: "text", text }] }
  }

  if (persona.endpoint === "/v1/messages") {
    // claude-opus-4-7 path (Phase B). The persona-level allowedEfforts
    // gate (Phase A1) already rejected high/xhigh; this branch only
    // sees low or medium. Conservative thinking-budget bucketing to fit
    // within the 60s MCP ceiling at realistic claude-opus-4-7 reasoning
    // rates (~80-150 tps): low → 1024 tokens (~13s thinking); medium →
    // 3000 tokens (~38s thinking). Anthropic spec REQUIRES
    // max_tokens >= budget_tokens AND recommends extra room for the
    // actual response — set max_tokens = budget + 1500.
    const budgetTokens = effort === "low" ? 1024 : 3000
    const maxTokens = budgetTokens + 1500
    const body = JSON.stringify({
      model: resolvedModel,
      max_tokens: maxTokens,
      system: persona.baseInstructions,
      thinking: { type: "enabled", budget_tokens: budgetTokens },
      messages: [{ role: "user", content: userText }],
    })
    const response = await createMessages(body, undefined, signal)
    const json = (await response.json()) as MessagesApiResponse
    const text = extractMessagesText(json)
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
    // Forwarded as-is. Per gemini_critic's review (see
    // docs/research/peer-mcp-investigation.md): Copilot's gemini route
    // may silently ignore this knob or 400 if it strict-validates the
    // schema; the latter surfaces through the existing tool-error path.
    reasoning_effort: effort,
  }
  const response = (await createChatCompletions(
    payload,
    undefined,
    signal,
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
  // Validate effort shape against the global EFFORT_LEVELS allowlist
  // (rejects garbage like `effort: "extreme"`); the per-persona
  // allowedEfforts gate runs AFTER persona lookup below (rejects
  // valid-but-not-allowed-here tiers like `xhigh` on codex_critic).
  if (args.effort !== undefined && !isEffort(args.effort)) {
    return rpcError(
      body.id,
      RPC_INVALID_PARAMS,
      `tools/call: arguments.effort must be one of ${EFFORT_LEVELS.join("|")}; got ${JSON.stringify(args.effort)}`,
    )
  }
  const requestedEffort = args.effort as Effort | undefined

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

  // Per-persona effort gate. Empirical data (probed live 2026-05-14)
  // showed that gpt-5.5 at `xhigh` on a tiny prompt takes 56s — right
  // at the 60s MCP per-tool-call ceiling and guaranteed to bust it on
  // real review prompts. claude-opus-4-7 at `high`+ thinking budgets
  // also can't fit in 60s. Each persona declares which tiers it
  // accepts; rejected tiers return RPC_INVALID_PARAMS so the caller
  // can re-call at a permitted tier instead of waiting for a timeout.
  if (
    requestedEffort !== undefined
    && !persona.allowedEfforts.includes(requestedEffort)
  ) {
    return rpcError(
      body.id,
      RPC_INVALID_PARAMS,
      `tools/call: persona "${persona.toolNameHttp}" does not accept effort="${requestedEffort}". `
        + `Allowed: ${persona.allowedEfforts.join("|")}. `
        + `(Higher tiers were removed because they don't fit in Claude Code's ~60s MCP per-tool-call ceiling on this model.)`,
    )
  }
  const effort: Effort = requestedEffort ?? persona.defaultEffort

  // Pre-flight latency cap (Phase A2). Fires BEFORE inFlightToolsCall++
  // so a rejected pre-flight is free of concurrency-slot cost (the
  // documented invariant in CLAUDE.md "Peer-model MCP integration").
  // Convert would-be-timeouts into fast actionable errors before we
  // burn an inFlight slot or start a multi-tens-of-seconds upstream call.
  const userText = buildUserText(prompt, context)
  const briefBytes = Buffer.byteLength(userText, "utf8")
  const cap = predictedTooLong(persona, effort, briefBytes)
  if (cap.tooLong) {
    const briefKb = (briefBytes / 1024).toFixed(1)
    const capKb = (cap.capBytes / 1024).toFixed(0)
    return rpcResult(body.id, {
      content: [
        {
          type: "text",
          text:
            `${persona.toolNameHttp} at effort='${effort}' on a ${briefKb}KB brief is likely to exceed the ~60s MCP per-tool-call ceiling `
              + `(empirical cap for this persona+effort: ${capKb}KB). `
              + `Either drop to a lower effort tier, or split the brief into 2-4 parallel sub-calls per the decomposition guidance in the tool description.`,
        },
      ],
      isError: true,
    })
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
  // Phase D P1.5: register an AbortController so notifications/cancelled
  // can free the slot. Use the JSON-RPC request id as the key — clients
  // emit `params.requestId` matching it. If the client doesn't supply
  // an id (notification request), skip registration; nothing to cancel.
  const abortKey =
    body.id !== undefined && body.id !== null ? body.id : undefined
  let aborter: AbortController | undefined
  if (abortKey !== undefined) {
    aborter = new AbortController()
    inflightAborts.set(abortKey, aborter)
  }
  try {
    const result = await callPersona(
      persona,
      prompt,
      context,
      effort,
      aborter?.signal,
    )
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
    // 404s from the upstream all go here. Aborts (from
    // notifications/cancelled) also land here as `AbortError`; treat
    // identically — the cancel notification is fire-and-forget, but
    // the original tools/call still gets a response so the client
    // doesn't hang waiting for it.
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
    if (abortKey !== undefined) {
      inflightAborts.delete(abortKey)
    }
  }
}

/**
 * Handle `notifications/cancelled` per JSON-RPC 2.0 + MCP spec.
 * params.requestId is the id of an in-flight tools/call to abort.
 * Notifications return no body (handled by isNotification path in
 * handleRpc); this side-effect frees the in-flight slot.
 */
function handleCancelledNotification(body: JsonRpcRequest): void {
  const params = body.params ?? {}
  const requestId = (params as { requestId?: unknown }).requestId
  if (
    requestId === undefined
    || (typeof requestId !== "string" && typeof requestId !== "number")
  ) {
    consola.debug(
      `[mcp] notifications/cancelled missing or invalid requestId: ${JSON.stringify(requestId)}`,
    )
    return
  }
  const aborter = inflightAborts.get(requestId)
  if (!aborter) {
    // Already completed or never registered. No-op — common race when
    // cancel races with completion.
    return
  }
  aborter.abort(new Error("client requested cancellation"))
  // The finally block in handleToolsCall removes the entry on
  // completion; we don't delete here to avoid a TOCTOU race where the
  // upstream fetch is mid-completion when cancel arrives.
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
          // Capabilities advertised must match what we actually serve
          // (codex-critic Phase D requirement: "empty lists are not
          // sufficient unless the whole MCP handshake is coherent").
          // We expose tools (the personas), and stub resources/prompts
          // as empty lists so well-behaved clients don't error on
          // probing them. {} for resources/prompts means "supported
          // but no list-changed notifications, no subscribe semantics".
          capabilities: {
            tools: { listChanged: false },
            resources: {},
            prompts: {},
          },
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

    // --- Phase D: MCP method stubs with full handshake coherence ---
    // (codex-critic: "if advertising resources:{}, also handle
    // resources/templates/list with {resourceTemplates: []}")

    case "resources/list":
      if (isNotification) return { status: 202, body: null }
      return {
        status: 200,
        body: rpcResult(body.id, { resources: [] }),
      }

    case "resources/templates/list":
      if (isNotification) return { status: 202, body: null }
      return {
        status: 200,
        body: rpcResult(body.id, { resourceTemplates: [] }),
      }

    case "resources/read": {
      if (isNotification) return { status: 202, body: null }
      // Parametric — empty list isn't appropriate. Return proper
      // JSON-RPC -32602 invalid params per codex-critic Phase D.
      const uri = (body.params as { uri?: unknown } | undefined)?.uri
      return {
        status: 200,
        body: rpcError(
          body.id,
          RPC_INVALID_PARAMS,
          `resources/read: resource URI not found: ${
            typeof uri === "string" ? uri : "(missing/invalid uri)"
          }`,
        ),
      }
    }

    case "prompts/list":
      if (isNotification) return { status: 202, body: null }
      return {
        status: 200,
        body: rpcResult(body.id, { prompts: [] }),
      }

    case "prompts/get": {
      if (isNotification) return { status: 202, body: null }
      const name = (body.params as { name?: unknown } | undefined)?.name
      return {
        status: 200,
        body: rpcError(
          body.id,
          RPC_INVALID_PARAMS,
          `prompts/get: prompt name not found: ${
            typeof name === "string" ? name : "(missing/invalid name)"
          }`,
        ),
      }
    }

    // --- Phase D P1.5: cancellation handling ---
    case "notifications/cancelled":
      // Side-effect only (abort the in-flight call). MUST NOT return
      // a body per JSON-RPC 2.0 notifications. Returns 202 like other
      // notifications.
      handleCancelledNotification(body)
      return { status: 202, body: null }

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
