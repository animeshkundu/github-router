import { timingSafeEqual } from "node:crypto"

import consola from "consola"
import type { Context } from "hono"

import { state } from "~/lib/state"
import { getTextTokenCount, getTokenizerFromModel } from "~/lib/tokenizer"
import { resolveModel } from "~/lib/utils"
import {
  PERSONAS_READ,
  type PersonaSpec,
  EFFORT_LEVELS,
  type Effort,
  isEffort,
  NON_PERSONA_MCP_TOOLS,
  type NonPersonaMcpTool,
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
import { hasSupportedBrowserInstalled } from "~/lib/browser-mcp/browser-detect"
import {
  browserCompoundToolsEnabled,
  standInToolEnabled,
  workerToolsEnabled,
} from "~/lib/mcp-capabilities"
import {
  MAX_INFLIGHT_TOOLS_CALL,
  acquireInFlightSlot,
  currentInFlight,
  __resetInFlightForTests as __resetInFlightSharedForTests,
} from "~/lib/mcp-inflight"

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
 *  § "Concurrency cap investigation" for the full justification.
 *
 *  The counter itself lives in `src/lib/mcp-inflight.ts` so the
 *  worker-agent's nested `peer_review` / `advisor` tools share the
 *  same budget — otherwise a worker could fan out unboundedly to
 *  peers without showing up in the MCP-side cap. */

/**
 * Per-request cancellation registry for in-flight `tools/call`s. Used
 * by both `notifications/cancelled` (Phase D P1.5) AND the SSE
 * `ReadableStream.cancel()` callback (consumer disconnect) to tear
 * down the upstream Copilot fetch promptly and free the in-flight
 * slot — otherwise an SSE-path cancel leaks the slot until the
 * upstream call hits `UPSTREAM_FETCH_TIMEOUT_MS` (~5 min). Eight
 * consumer disconnects in 5 minutes fully stalls `/mcp` `tools/call`
 * for everyone since the shared cap is 8.
 *
 * Each entry carries (a) the AbortController whose signal threads
 * into createResponses / createChatCompletions / createMessages /
 * searchWeb via their `callerSignal` parameter, AND (b) a `release`
 * callback that frees the slot synchronously. Both are invoked by
 * `cancelInflight()`, which is called from BOTH cancel paths and is
 * idempotent — `acquireInFlightSlot()`'s release fn is itself
 * idempotent, and the entry is deleted on first cancel so a racing
 * cancel-after-natural-completion is a no-op lookup.
 *
 * The `finally` block in `handleToolsCall` only deletes the entry
 * when it still owns the same object (identity check via
 * `inflightAborts.get(key) === entry`) — protects against a stale
 * finally racing with a cancel that already cleaned up and a new
 * tools/call having registered a fresh entry under the same id.
 *
 * Per CLAUDE.md "Bun request-signal quirk", we use OUR own
 * AbortController (NOT c.req.raw.signal which fires after request body
 * is consumed).
 */
interface InflightEntry {
  aborter: AbortController
  release: () => void
}
const inflightAborts = new Map<string | number, InflightEntry>()

/**
 * Idempotent teardown for an in-flight tools/call. Aborts the upstream
 * fetch, frees the concurrency slot, and removes the registry entry.
 * Safe to call from both `notifications/cancelled` and the SSE
 * `ReadableStream.cancel()` callback, in either order, and any number
 * of times — the second call is a no-op.
 */
function cancelInflight(key: string | number, reason: string): void {
  const entry = inflightAborts.get(key)
  if (!entry) return
  // Delete before aborting so a re-entrant call from the abort handler
  // (or a racing cancel notification) can't double-process.
  inflightAborts.delete(key)
  try {
    entry.aborter.abort(new Error(reason))
  } catch {
    // ignore — abort never throws in practice, but be defensive.
  }
  try {
    entry.release()
  } catch {
    // release is idempotent; defensive catch.
  }
}

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

// `standInToolEnabled` and `workerToolsEnabled` were extracted to
// `src/lib/mcp-capabilities.ts` so CLI startup (`src/claude.ts`) can
// import the same predicates without dragging Hono route-handler
// transitive deps. They're re-imported at the top of this file and
// used unchanged in the gate code below.

/**
 * Gate for the browser-control MCP tools (`browser_*`).
 *
 * Returns true iff BOTH:
 *   1. The operator opted in via `--browse` (which sets
 *      `state.browseEnabled`) OR the equivalent env var
 *      `GH_ROUTER_ENABLE_BROWSE=1`. Default OFF — browser-control is
 *      side-effectful (mutates the user's browser session, downloads
 *      files, can navigate to phishing URLs the model was prompted with),
 *      so dormant-register is the safe default.
 *   2. At least one supported Chromium-family browser (Chrome or Edge)
 *      is detected on disk by `hasSupportedBrowserInstalled()`. No
 *      browser → nothing for the bridge to attach to → tools stay
 *      invisible rather than fail at call time. Detection is cached for
 *      the proxy lifetime; a fresh install requires a restart.
 *
 * Mirrors the defense-in-depth pattern of `workerToolsEnabled()` /
 * `standInToolEnabled()`: this same function gates BOTH the
 * `tools/list` filter in `toolEntries()` AND the call-time rejection in
 * `handleToolsCall` (returning -32601 for hard-coded tool-name
 * bypasses), so the two surfaces stay symmetric.
 *
 * The env-var check reads `process.env` directly instead of relying
 * solely on `state.browseEnabled` so a non-`setupAndServe` startup path
 * (tests, embedded use) can still flip the gate via env. The CLI flag
 * path is the canonical one for end users.
 */
function browserToolsEnabled(): boolean {
  const optedIn =
    state.browseEnabled || process.env.GH_ROUTER_ENABLE_BROWSE === "1"
  if (!optedIn) return false
  return hasSupportedBrowserInstalled()
}

/**
 * The 1M-context Opus variant (`claude-opus-4.7-1m-internal`,
 * `max_prompt_tokens` 936K), gated `restricted_to: ["enterprise"]`.
 * opus_critic prefers it so it can take large artifacts in one shot
 * (the whole point of pairing it with gpt-5.5 as the big-window peers);
 * falls back to the 200K `claude-opus-4-7` when the catalog (non-
 * enterprise) doesn't carry a 1M opus slug.
 */
const OPUS_1M_RE = /opus-4\.7.*1m/i
function resolveOpusCriticModel(): string {
  const oneM = state.models?.data?.find((m) => OPUS_1M_RE.test(m.id))
  return oneM ? oneM.id : "claude-opus-4-7"
}

function activePersonas(): Array<PersonaSpec> {
  // Drop personas whose model family is missing from Copilot's live
  // catalog (currently only gemini-critic, gated by `requiresGeminiCatalog`).
  // Distinct from `requiresHttp` (codex-cli stdio routing constraint) —
  // see PersonaSpec field doc in peer-mcp-personas.ts.
  //
  // opus_critic's model is resolved at call time: the 1M variant when the
  // (enterprise) catalog carries it, else the 200K fallback. Resolving here
  // — rather than baking a static slug into PERSONAS_READ — means the
  // downstream dispatch, telemetry, and the prompt-window guard all see the
  // SAME effective model with no extra threading.
  return PERSONAS_READ.filter(
    (p) => !p.requiresGeminiCatalog || geminiAvailable(),
  ).map((p) =>
    p.toolNameHttp === "opus_critic"
      ? { ...p, model: resolveOpusCriticModel() }
      : p,
  )
}

function toolEntries(): Array<ToolEntry> {
  const personaEntries: Array<ToolEntry> = activePersonas().map((p) => ({
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
  // Append non-persona utility tools (`web_search`, `code_search`, and
  // — when the runtime gate passes — `worker_explore`/`worker_implement`,
  // `stand_in`). They share the same `tools/list` surface but have
  // their own input schemas (no prompt/context/effort) and skip the
  // per-persona validation gates in handleToolsCall. Per-tool
  // `capability` tag drives the runtime gate (see `workerToolsEnabled()`
  // and `standInToolEnabled()`).
  const nonPersonaEntries: Array<ToolEntry> = NON_PERSONA_MCP_TOOLS.filter(
    (t) => {
      if (t.capability === "worker") return workerToolsEnabled()
      if (t.capability === "stand_in") return standInToolEnabled()
      if (t.capability === "browser") return browserToolsEnabled()
      if (t.capability === "browser_compound") return browserCompoundToolsEnabled()
      return true
    },
  ).map(
    (t) => ({
      name: t.toolNameHttp,
      description: t.description,
      inputSchema: t.inputSchema,
    }),
  )
  return [...personaEntries, ...nonPersonaEntries]
}

function buildUserText(prompt: string, context?: string): string {
  if (!context) return prompt
  return `${prompt}\n\n---\n\nAdditional context:\n${context}`
}

// Exported so `src/lib/worker-agent/tools.ts` (worker `advisor` tool)
// can extract assistant text from a /responses payload without
// re-implementing the walk. Single source of truth — keep behavior
// changes here, not in a sibling copy.
export function extractResponsesText(response: ResponsesApiResponse): string {
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
 * tuple is empirically predicted to bust the 60s ceiling.
 *
 * SCOPE: the cap is JSON-PATH ONLY. Callers (handleMcpPost) MUST gate
 * the call site by `!acceptsEventStream(...)`. The SSE path
 * (handleToolsCallSSE) keeps the connection open past the 60s ceiling
 * via heartbeats — size-based pre-flight rejection there would just
 * lock SSE clients out of their primary advantage. JSON-path clients
 * (raw curl with `Accept: application/json`, older MCP clients without
 * SSE awareness) DO still hit the underlying tools/call timer, so the
 * cap is the only way to surface a fast actionable error there
 * instead of a slot-leaking timeout.
 *
 * INVARIANT: pre-flight MUST fire BEFORE inFlightToolsCall++ — the
 * slot must not be acquired for a rejected pre-flight. handleMcpPost
 * runs the check before delegating to handleRpc → handleToolsCall (the
 * function that increments the counter). Documented in CLAUDE.md.
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

/**
 * Tokens reserved below a peer model's `max_prompt_tokens` for the
 * per-call message framing (role wrappers, output_config, etc.) and any
 * discrepancy between our o200k count and Copilot's full-payload count.
 */
const PEER_PROMPT_TOKEN_RESERVE = 2_000

/**
 * Prompt-window guard. Unlike `predictedTooLong` (a JSON-path *timeout*
 * predictor in bytes), this guards the *context window*: it counts the
 * EXACT o200k tokens of the text actually sent to the peer (system
 * instructions + prompt + context) and compares against the persona
 * model's live `max_prompt_tokens`. Applies on BOTH the SSE and JSON
 * paths (called from `handleToolsCall`, before slot acquisition) because
 * an over-window brief 400s `model_max_prompt_tokens_exceeded` upstream
 * regardless of transport — and on SSE there is no other size bound.
 *
 * Returns an actionable message when over budget (reject, don't
 * truncate — silently dropping lines from a review artifact is worse
 * than a clear error), or undefined when it fits or the limit is unknown.
 */
async function predictedWindowOverflow(
  persona: PersonaSpec,
  prompt: string,
  context: string | undefined,
): Promise<string | undefined> {
  const id = resolveModel(persona.model)
  const entry = state.models?.data?.find((m) => m.id === id)
  if (!entry) return undefined // model not in catalog — let upstream decide
  const maxPromptTokens = entry.capabilities?.limits?.max_prompt_tokens
  if (
    typeof maxPromptTokens !== "number"
    || !Number.isFinite(maxPromptTokens)
    || maxPromptTokens <= 0
  ) {
    return undefined // unknown window — let the upstream call decide
  }
  const budget = maxPromptTokens - PEER_PROMPT_TOKEN_RESERVE
  const inputText = `${persona.baseInstructions}\n${buildUserText(prompt, context)}`
  // Cheap lower-bound fast-path: o200k_base is a byte-level BPE, so the
  // token count is ALWAYS ≤ the UTF-8 byte length (merges only reduce
  // count). When the bytes alone fit the budget, the call definitely
  // fits — skip the (relatively) expensive exact tokenization. This
  // bounds tokenization work to briefs large enough in bytes to plausibly
  // overflow, so a burst of normal-sized calls never pays for it.
  if (Buffer.byteLength(inputText, "utf8") <= budget) return undefined
  let tokens: number
  try {
    const encoding = getTokenizerFromModel(entry)
    tokens = await getTextTokenCount(inputText, encoding)
  } catch (err) {
    // Tokenizer load/encode failure is non-fatal: the upstream call still
    // enforces the real limit. Fail OPEN (let it through) rather than
    // turning an optimization into a hard error.
    consola.debug("[mcp] window-guard tokenization failed; allowing call:", err)
    return undefined
  }
  if (tokens <= budget) return undefined
  const opusHint = OPUS_1M_RE.test(id)
    ? ""
    : " / `opus_critic` (Opus-4.7 1M ≈ 936K tokens, when the enterprise catalog carries it)"
  // Report against `budget` (window minus the framing reserve), not the
  // raw window, so the message can't read paradoxically (e.g. "127900
  // exceeds 128000") when tokens land in the reserve band. Peer calls
  // carry no tool schemas or message history — just system=baseInstructions
  // + a single user message — so the ${PEER_PROMPT_TOKEN_RESERVE}-token
  // reserve is a generous cover for the JSON wire framing.
  return (
    `pre-flight rejected: this ${persona.toolNameHttp} brief is ≈${tokens} tokens, over the `
    + `${budget}-token budget for ${persona.model} (its ${maxPromptTokens}-token prompt window `
    + `minus a ${PEER_PROMPT_TOKEN_RESERVE}-token framing reserve). Do NOT summarize or truncate `
    + `the artifact to fit. Route the full artifact to a larger-window peer — `
    + `\`codex_critic\` (gpt-5.5 ≈ 922K tokens)${opusHint} — or split it into focused `
    + `sub-calls BY CONCERN and call them in parallel, then aggregate.`
  )
}

/**
 * JSON-path pre-flight predictedTooLong gate. Returns a JSON-RPC result
 * body wrapping a tool-error envelope when the call would bust the 60s
 * tools/call ceiling on the JSON path; returns undefined when the call
 * should proceed normally.
 *
 * Skips the check (returns undefined) for any shape problem so
 * handleRpc can return the canonical JSON-RPC error code instead:
 *   - notification (no id) → handleRpc returns 202 + empty body
 *   - missing/unknown name  → handleRpc returns -32601
 *   - missing prompt        → handleRpc returns -32602
 *   - invalid effort string → handleRpc returns -32602
 *   - effort not in persona.allowedEfforts → handleRpc returns -32602
 */
function jsonPathPreflightCap(body: JsonRpcRequest):
  | { jsonrpc: "2.0"; id: JsonRpcRequest["id"] | null; result: ToolErrorContent }
  | undefined {
  if (body.id === undefined) return undefined
  const params = (body.params ?? {}) as Record<string, unknown>
  const name = typeof params.name === "string" ? params.name : ""
  const args = (params.arguments ?? {}) as Record<string, unknown>
  if (!name) return undefined

  // stand_in: non-persona tool with a different input shape
  // ({decision, options, context}) and a single fixed-per-model effort
  // tier (xhigh/xhigh/high), so the existing persona-keyed
  // `predictedTooLong` cap table doesn't apply. Run a dedicated check.
  //
  // The cap exists because stand_in fundamentally cannot fit in the
  // JSON-path 60s tools/call ceiling on any non-trivial input: two
  // sequential voting rounds × ~60-90s per round across three frontier
  // models = 2-3 minutes typical wall-clock. The size threshold (~6KB)
  // is conservative — bursting it means the JSON-path caller will
  // definitely time out, so we surface the actionable "use SSE" error
  // up front instead of leaking an inFlight slot for the duration.
  if (name === "stand_in") {
    const decision = typeof args.decision === "string" ? args.decision : ""
    const optionsRaw = Array.isArray(args.options) ? args.options : []
    const standInContext = typeof args.context === "string" ? args.context : ""
    if (!decision || optionsRaw.length === 0) return undefined // shape error → -32602 path
    const briefBytes = Buffer.byteLength(
      decision + JSON.stringify(optionsRaw) + standInContext,
      "utf8",
    )
    const STAND_IN_CAP_BYTES = 6 * 1024
    if (briefBytes > STAND_IN_CAP_BYTES) {
      return rpcResult(
        body.id,
        toolError(
          `pre-flight rejected: stand_in on a ${briefBytes}-byte input is `
            + `predicted to exceed the JSON tools/call timeout (cap=${STAND_IN_CAP_BYTES} bytes). `
            + `stand_in runs two sequential voting rounds across three frontier `
            + `models — wall-clock is typically 2-3 minutes regardless of input `
            + `size. Send Accept: text/event-stream to use the SSE path which `
            + `bypasses this cap, or trim the decision/options/context.`,
        ),
      )
    }
    return undefined
  }

  // Persona path (existing logic).
  const prompt = typeof args.prompt === "string" ? args.prompt : ""
  const context = typeof args.context === "string" ? args.context : undefined
  const rawEffort = args.effort
  if (!prompt) return undefined
  const persona = activePersonas().find((p) => p.toolNameHttp === name)
  if (!persona) return undefined
  if (rawEffort !== undefined && !isEffort(rawEffort)) return undefined
  const effortMaybe = rawEffort as Effort | undefined
  if (
    effortMaybe !== undefined
    && !persona.allowedEfforts.includes(effortMaybe)
  ) {
    return undefined
  }
  const effort: Effort = effortMaybe ?? persona.defaultEffort
  const briefBytes = Buffer.byteLength(buildUserText(prompt, context), "utf8")
  const verdict = predictedTooLong(persona, effort, briefBytes)
  if (!verdict.tooLong) return undefined
  return rpcResult(
    body.id,
    toolError(
      `pre-flight rejected: ${persona.toolNameHttp} at effort=${effort} on a `
        + `${briefBytes}-byte brief is empirically predicted to exceed the JSON `
        + `tools/call timeout (cap=${verdict.capBytes} bytes for this tier). `
        + `Either drop to a lower effort tier, split the brief into 2-4 `
        + `parallel sub-calls per the decomposition guidance, or send `
        + `Accept: text/event-stream to use the SSE path which bypasses this cap.`,
    ),
  )
}

/**
 * Per-endpoint wire dispatch for a single peer-model call. Returns the
 * assistant's raw text (possibly empty — caller decides what "empty"
 * means in their context). Upstream errors (network, 4xx, 5xx) propagate
 * as exceptions via `await`.
 *
 * Extracted from `callPersona()` so non-persona callers — specifically
 * the `stand_in` orchestrator in `src/lib/stand-in.ts` — can reuse the
 * same per-endpoint request shaping without re-implementing it. The
 * stand_in tool needs to drive its own per-round system prompts across
 * three concrete models (gpt-5.5, claude-opus-4-7, gemini-3.1-pro-preview),
 * each on a different endpoint; doing that with a `PersonaSpec` would
 * require either inventing throwaway personas per round or duplicating
 * the dispatch switch.
 *
 * NOTE on consumer-cancel signal: we deliberately do NOT pass
 * c.req.raw.signal into the upstream fetch. Bun/srvx aborts the
 * request signal as soon as the request body is fully consumed
 * (after `await c.req.json()`), which would make every call fail
 * immediately with "This operation was aborted". The caller creates
 * its own AbortController and threads it through `signal`. See CLAUDE.md
 * "Bun request-signal quirk" for full context.
 */
export async function dispatchModelCall(args: {
  model: string
  endpoint: PersonaSpec["endpoint"]
  instructions: string
  userText: string
  effort: Effort
  signal?: AbortSignal
}): Promise<string> {
  // Resolve the model id against the live catalog so a slug rename
  // (e.g., gemini-3.1-pro-preview → gemini-3.1-pro at GA) auto-resolves
  // through the existing fuzzy matcher rather than 404'ing.
  const resolvedModel = resolveModel(args.model)

  if (args.endpoint === "/v1/responses") {
    const payload: ResponsesPayload = {
      model: resolvedModel,
      instructions: args.instructions,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: args.userText }],
        },
      ],
      stream: false,
      // Reasoning effort — gpt-5.x adaptive-thinking reads this field
      // directly. Copilot's translator buckets to its own internal
      // levels (CLAUDE.md "Thinking-mode translation").
      reasoning: { effort: args.effort },
    }
    const response = (await createResponses(
      payload,
      undefined,
      args.signal,
    )) as ResponsesApiResponse
    return extractResponsesText(response)
  }

  if (args.endpoint === "/v1/messages") {
    // claude-opus-4-7 path. Copilot's adaptive-thinking models reject
    // Anthropic's standard `thinking: {type:"enabled", budget_tokens:N}`
    // shape with HTTP 400: "thinking.type.enabled is not supported for
    // this model. Use thinking.type.adaptive and output_config.effort".
    // Build the Copilot-shape directly. Empirical: confirmed 2026-05-14
    // via curl test against the proxy after build, opus_critic@xhigh
    // returned the expected 400 with that exact wording.
    //
    // max_tokens budget: choose a generous ceiling per effort tier so
    // the model has room for substantive reasoning + response without
    // truncation. Numbers chosen empirically:
    //   low → 4096, medium → 8192, high → 16384, xhigh → 32768.
    const maxTokens =
      args.effort === "low" ? 4096
      : args.effort === "medium" ? 8192
      : args.effort === "high" ? 16384
      : 32768  // xhigh
    const body = JSON.stringify({
      model: resolvedModel,
      max_tokens: maxTokens,
      system: args.instructions,
      thinking: { type: "adaptive" },
      output_config: { effort: args.effort },
      messages: [{ role: "user", content: args.userText }],
    })
    const response = await createMessages(body, undefined, args.signal)
    const json = (await response.json()) as MessagesApiResponse
    return extractMessagesText(json)
  }

  // /v1/chat/completions (Gemini)
  const payload: ChatCompletionsPayload = {
    model: resolvedModel,
    messages: [
      { role: "system", content: args.instructions },
      { role: "user", content: args.userText },
    ],
    stream: false,
    // Forwarded as-is. Per gemini_critic's review (see
    // docs/research/peer-mcp-investigation.md): Copilot's gemini route
    // may silently ignore this knob or 400 if it strict-validates the
    // schema; the latter surfaces through the existing tool-error path.
    reasoning_effort: args.effort,
  }
  const response = (await createChatCompletions(
    payload,
    undefined,
    args.signal,
  )) as ChatCompletionResponse
  return extractChatCompletionText(response)
}

// Exported so `src/lib/worker-agent/tools.ts` (worker `peer_review` tool)
// can reuse the same persona dispatch — single source of truth for the
// per-endpoint Copilot request shape (Responses vs Messages vs
// chat-completions). Thin wrapper around `dispatchModelCall` that adds
// persona-specific framing: the user-text concat (prompt + context) and
// the canonical `persona <agentName>: empty assistant output` error
// message that the existing persona test suites assert against.
export async function callPersona(
  persona: PersonaSpec,
  prompt: string,
  context: string | undefined,
  effort: Effort,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  // NOTE: predictedTooLong pre-flight cap fires in handleMcpPost
  // BEFORE handleRpc → handleToolsCall → inFlightToolsCall++ — see
  // the architectural invariant documented in CLAUDE.md. JSON-path
  // only; SSE callers bypass it. Don't duplicate it here.
  const userText = buildUserText(prompt, context)
  const text = await dispatchModelCall({
    model: persona.model,
    endpoint: persona.endpoint,
    instructions: persona.baseInstructions,
    userText,
    effort,
    signal,
  })
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
  // Opt-in via GH_ROUTER_LOG_PEER_MCP=1 (mirrors GH_ROUTER_LOG_FIELDS).
  // Default off: the proxy shares a TTY with the Claude TUI under
  // `github-router claude`, and an unconditional stderr write per tool
  // call shows up as ambient noise. Maintainer "earn their keep"
  // analysis still works — flip the flag when you want it.
  if (process.env.GH_ROUTER_LOG_PEER_MCP !== "1") return
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

  if (!name) {
    return rpcError(body.id, RPC_INVALID_PARAMS, "tools/call missing name")
  }

  // Routing: try personas first; fall through to non-persona utility
  // tools (currently just `web_search`). The two registries share the
  // tools/list surface but have different validation gates — personas
  // get the prompt+effort+predictedTooLong gauntlet; non-persona tools
  // do their own arg validation inside the handler closure.
  const persona = activePersonas().find((p) => p.toolNameHttp === name)
  const nonPersonaTool: NonPersonaMcpTool | undefined = persona
    ? undefined
    : NON_PERSONA_MCP_TOOLS.find((t) => t.toolNameHttp === name)

  if (!persona && !nonPersonaTool) {
    return rpcError(
      body.id,
      RPC_METHOD_NOT_FOUND,
      `tools/call: unknown tool "${name}"`,
    )
  }

  // Defense-in-depth: even if a client hard-codes a tool name to bypass
  // the `tools/list` filter, the call-time gate runs the SAME
  // `workerToolsEnabled()` / `standInToolEnabled()` check and rejects
  // with -32601 (same code as an unknown tool — the gated tool is
  // functionally invisible). This mirrors the list-time filter in
  // `toolEntries()` exactly so the two surfaces stay symmetric.
  if (
    nonPersonaTool
    && nonPersonaTool.capability === "worker"
    && !workerToolsEnabled()
  ) {
    return rpcError(
      body.id,
      RPC_METHOD_NOT_FOUND,
      `tools/call: unknown tool "${name}"`,
    )
  }
  if (
    nonPersonaTool
    && nonPersonaTool.capability === "stand_in"
    && !standInToolEnabled()
  ) {
    return rpcError(
      body.id,
      RPC_METHOD_NOT_FOUND,
      `tools/call: unknown tool "${name}"`,
    )
  }
  if (
    nonPersonaTool
    && nonPersonaTool.capability === "browser"
    && !browserToolsEnabled()
  ) {
    return rpcError(
      body.id,
      RPC_METHOD_NOT_FOUND,
      `tools/call: unknown tool "${name}"`,
    )
  }

  // Persona-only validation: prompt required, effort schema-checked
  // against EFFORT_LEVELS and gated by per-persona allowedEfforts. None
  // of this applies to non-persona tools (no prompt, no effort).
  let personaPrompt: string | undefined
  let personaContext: string | undefined
  let personaEffort: Effort | undefined
  if (persona) {
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

    const prompt = typeof args.prompt === "string" ? args.prompt : ""
    if (!prompt) {
      return rpcError(
        body.id,
        RPC_INVALID_PARAMS,
        `tools/call: arguments.prompt is required`,
      )
    }
    personaPrompt = prompt
    personaContext = typeof args.context === "string" ? args.context : undefined

    // Per-persona effort gate. All four personas now allow all four
    // effort tiers (low|medium|high|xhigh). The gate remains in place so
    // a future persona that needs to constrain its tiers can do so
    // declaratively via PersonaSpec.allowedEfforts.
    if (
      requestedEffort !== undefined
      && !persona.allowedEfforts.includes(requestedEffort)
    ) {
      return rpcError(
        body.id,
        RPC_INVALID_PARAMS,
        `tools/call: persona "${persona.toolNameHttp}" does not accept effort="${requestedEffort}". `
          + `Allowed: ${persona.allowedEfforts.join("|")}.`,
      )
    }
    personaEffort = requestedEffort ?? persona.defaultEffort
  }

  // Prompt-window guard (BOTH paths). predictedTooLong below is JSON-path
  // only; this token-exact window check runs here, before slot acquisition,
  // so an over-window brief fails fast with an actionable "route to a
  // larger-window peer or decompose" message instead of leaking the upstream
  // 400 (or, on SSE where there's no size bound at all, burning a slot for a
  // doomed call). MUST stay before acquireInFlightSlot per the load-bearing
  // invariant (a reject after acquisition leaks a concurrency slot).
  if (persona && personaPrompt !== undefined) {
    const overflow = await predictedWindowOverflow(
      persona,
      personaPrompt,
      personaContext,
    )
    if (overflow) return rpcResult(body.id, toolError(overflow))
  }

  // predictedTooLong pre-flight cap is enforced upstream of this
  // function — see `jsonPathPreflightCap` invoked by handleMcpPost
  // BEFORE handleRpc/handleToolsCall, so the slot increment below is
  // never reached for a rejected pre-flight (architectural invariant
  // documented in CLAUDE.md). The cap is JSON-PATH ONLY: SSE-streamed
  // responses (handleToolsCallSSE) bypass Claude Code's ~60s
  // tools/call ceiling via heartbeats and therefore don't need the
  // size-based gate. Non-persona tools have no thinking budget and so
  // the predictedTooLong cap doesn't apply to them either (the
  // jsonPathPreflightCap returns undefined when persona lookup misses,
  // which naturally exempts non-persona tools).

  // Documented per-call cap. NOT silent serialization — surface the
  // backpressure so Opus knows to retry shortly. The slot is held in
  // the shared mcp-inflight counter so worker-side nested peer/advisor
  // calls compete for the same 8-wide budget.
  const release = acquireInFlightSlot()
  if (!release) {
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
  const startedAt = Date.now()
  // Phase D P1.5: register an AbortController so notifications/cancelled
  // (or an SSE consumer disconnect) can free the slot. Use the JSON-RPC
  // request id as the key — clients emit `params.requestId` matching it.
  // If the client doesn't supply an id (notification request), skip
  // registration; nothing to cancel.
  //
  // Slot ownership: the InflightEntry holds BOTH the AbortController AND
  // a closure-captured `release` callback. `cancelInflight()` (called
  // from `notifications/cancelled` and from `handleToolsCallSSE.cancel()`)
  // invokes BOTH: aborting the upstream fetch tears down the socket,
  // and synchronously releasing the slot frees the cap=8 budget without
  // waiting for the upstream call's promise to settle.
  //
  // The `finally` block at the bottom of this function only deletes the
  // map entry when it still owns the same object (identity check). This
  // protects against a stale finally racing with a cancel that already
  // cleaned up — and (rare) a brand new tools/call having registered a
  // fresh entry under the same id in between.
  const abortKey =
    body.id !== undefined && body.id !== null ? body.id : undefined
  let aborter: AbortController | undefined
  let inflightEntry: InflightEntry | undefined
  if (abortKey !== undefined) {
    aborter = new AbortController()
    inflightEntry = { aborter, release }
    inflightAborts.set(abortKey, inflightEntry)
  }
  // Telemetry shape differs per branch — personas have a model id;
  // non-persona tools don't dispatch to a peer LLM, so log the tool
  // name as the "model" slot for grep'ability.
  const telemetryName = persona ? persona.agentName : nonPersonaTool!.toolNameHttp
  const telemetryModel = persona ? persona.model : "(non-persona)"
  try {
    const result = persona
      ? await callPersona(
          persona,
          personaPrompt!,
          personaContext,
          personaEffort!,
          aborter?.signal,
        )
      : await nonPersonaTool!.handler(args, aborter?.signal)
    logTelemetry({
      name: telemetryName,
      model: telemetryModel,
      durationMs: Date.now() - startedAt,
      result: result.isError ? "isError" : "ok",
    })
    return rpcResult(body.id, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logTelemetry({
      name: telemetryName,
      model: telemetryModel,
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
          text: persona
            ? `persona ${persona.agentName} failed: ${message}`
            : `tool ${nonPersonaTool!.toolNameHttp} failed: ${message}`,
        },
      ],
      isError: true,
    })
  } finally {
    release()
    if (abortKey !== undefined && inflightEntry !== undefined) {
      // Identity-check: only delete if the registered entry is still
      // ours. A racing cancel may have already replaced/cleaned it.
      if (inflightAborts.get(abortKey) === inflightEntry) {
        inflightAborts.delete(abortKey)
      }
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
  // cancelInflight is idempotent and handles the missing-entry case
  // (already-completed or never-registered). It aborts the upstream
  // fetch via the AbortController AND synchronously frees the slot.
  cancelInflight(requestId, "client requested cancellation")
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

  // SSE-streamed response branch for `tools/call` when the client
  // advertises text/event-stream Accept (Claude Code's MCP HTTP client
  // does, per MCP 2025-06-18 Streamable HTTP transport spec). Streamed
  // responses bypass the per-tool-call wait timer that ~60s-caps JSON
  // responses on Claude Code v2.1.113+ (regressions #50289 / #52137,
  // documented in docs/research/peer-mcp-investigation.md). Heartbeat
  // `notifications/progress` events keep the connection alive while
  // the upstream Copilot call is in flight; the final tools/call
  // response is delivered as the closing `message` event. Non-tools/call
  // RPC methods (initialize, tools/list, etc.) stay on the JSON path —
  // they're synchronous and don't benefit from streaming.
  if (
    typeof body === "object"
    && body !== null
    && !Array.isArray(body)
    && body.method === "tools/call"
    && acceptsEventStream(c.req.header("accept"))
  ) {
    return handleToolsCallSSE(body)
  }

  // JSON-path pre-flight predictedTooLong cap. SSE clients (above)
  // bypass Claude Code's ~60s tools/call ceiling via heartbeats, but
  // JSON-path clients (raw curl with `Accept: application/json`,
  // older MCP clients without SSE awareness) still hit the underlying
  // timer. Reject here as a fast actionable error instead of letting
  // the request burn an inFlight slot for ~60s before the client
  // times out — invariant: the cap MUST fire BEFORE handleToolsCall
  // so inFlightToolsCall++ is never reached for a rejected pre-flight
  // (CLAUDE.md). `jsonPathPreflightCap` returns undefined for any
  // shape problem (missing prompt, unknown name, invalid effort) so
  // handleRpc returns the canonical -32601/-32602 error code.
  if (
    typeof body === "object"
    && body !== null
    && !Array.isArray(body)
    && body.method === "tools/call"
  ) {
    const preflight = jsonPathPreflightCap(body)
    if (preflight) return c.json(preflight, 200)
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

/**
 * Accept-header parsing for MCP Streamable HTTP. Per MCP 2025-06-18
 * spec, clients send `Accept: application/json, text/event-stream` to
 * indicate they can consume either response shape. Server picks; for
 * tools/call we pick SSE because Claude Code's per-tool-call timer
 * (~60s on v2.1.113+) does not fire on streamed responses.
 *
 * Lenient parse: split on commas, strip params (q-values, charset),
 * trim, lowercase, look for the SSE token. Returns false on undefined
 * / empty / strict-JSON-only Accept.
 */
function acceptsEventStream(accept: string | undefined): boolean {
  if (!accept) return false
  const tokens = accept
    .toLowerCase()
    .split(",")
    .map((t) => t.split(";")[0].trim())
  return tokens.includes("text/event-stream")
}

/**
 * SSE-streamed response for a single tools/call. Delegates the actual
 * upstream call to `handleToolsCall` (so the per-persona effort gate,
 * the token-exact prompt-window guard, AbortController registration,
 * telemetry, and inFlight slot accounting all run identically); wraps
 * the awaited result in an SSE envelope with periodic heartbeats while
 * the upstream fetch is in flight. NOTE: the JSON-path `predictedTooLong`
 * byte cap is NOT applied here — it lives in `jsonPathPreflightCap`
 * (JSON path only); SSE bypasses it intentionally because heartbeats
 * keep the call alive past the ~60s tools/call ceiling it guards.
 *
 * SSE event format (per MCP Streamable HTTP):
 *   event: message
 *   data: <json-rpc-2.0 message>\n\n
 *
 * - Heartbeats are JSON-RPC `notifications/progress` notifications with
 *   the request id as `progressToken` (per MCP progress-notification spec).
 * - The final message is the JSON-RPC response envelope returned by
 *   handleToolsCall — same structure as the JSON-path response.
 * - On consumer cancel (ReadableStream.cancel), the heartbeat interval
 *   is cleared and the inFlight slot's AbortController is signalled
 *   (handleToolsCall observes the abort and returns an error envelope
 *   that we drop unwritten — controller is already closed).
 *
 * Per CLAUDE.md "Stream lifecycle" / "The smoking gun" rules: every
 * controller.enqueue/close is wrapped in a try/catch that swallows the
 * "Invalid state: Controller is already closed" race without warning.
 */
const SSE_HEARTBEAT_INTERVAL_MS = 5000

async function handleToolsCallSSE(body: JsonRpcRequest): Promise<Response> {
  const encoder = new TextEncoder()
  // Kick off the actual tool call as a Promise. handleToolsCall handles
  // all gates, slot accounting, abort registration, telemetry — we just
  // wrap its eventual result in an SSE envelope.
  const callPromise = handleToolsCall(body)
  // Heartbeat interval is hoisted out of `start()` so `cancel()` can
  // clear it synchronously on consumer disconnect — otherwise a 5-second
  // tick fires into a closed controller after every cancel, and the
  // interval continues until `callPromise` settles (potentially minutes
  // later) instead of stopping immediately.
  let heartbeatHandle: ReturnType<typeof setInterval> | undefined

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const safeEnqueue = (chunk: Uint8Array): void => {
        if (closed) return
        try {
          controller.enqueue(chunk)
        } catch (err) {
          // Controller already closed by consumer cancel or earlier
          // close — common race between heartbeat tick and stream
          // teardown. Per CLAUDE.md "smoking gun" rule, do NOT log
          // this as a warning; it's expected.
          consola.debug("/mcp SSE enqueue after close (expected race):", err)
          closed = true
        }
      }
      const safeClose = (): void => {
        if (closed) return
        closed = true
        try {
          controller.close()
        } catch (err) {
          consola.debug("/mcp SSE close after close:", err)
        }
      }
      const sseFrame = (rpcMessage: object): Uint8Array =>
        encoder.encode(`event: message\ndata: ${JSON.stringify(rpcMessage)}\n\n`)
      const heartbeatFrame = (): Uint8Array =>
        sseFrame({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: body.id ?? null,
            progress: 0,
            message: "in flight",
          },
        })

      // Initial heartbeat (proves the stream is open) + recurring
      // heartbeats every SSE_HEARTBEAT_INTERVAL_MS until the call
      // resolves. Cleared in BOTH the `finally` below (natural
      // completion) AND the `cancel()` callback (consumer disconnect).
      safeEnqueue(heartbeatFrame())
      heartbeatHandle = setInterval(
        () => safeEnqueue(heartbeatFrame()),
        SSE_HEARTBEAT_INTERVAL_MS,
      )

      try {
        const result = await callPromise
        safeEnqueue(sseFrame(result))
      } catch (err) {
        consola.error("/mcp SSE upstream error:", err)
        safeEnqueue(
          sseFrame(
            rpcError(
              body.id ?? null,
              RPC_INTERNAL_ERROR,
              err instanceof Error ? err.message : String(err),
            ),
          ),
        )
      } finally {
        if (heartbeatHandle !== undefined) {
          clearInterval(heartbeatHandle)
          heartbeatHandle = undefined
        }
        safeClose()
      }
    },
    cancel() {
      // Consumer disconnected. Three things must happen synchronously:
      //   1. Stop the heartbeat — otherwise the 5s interval keeps
      //      firing into a closed controller (and stays alive in the
      //      Node/Bun event loop) until callPromise settles.
      //   2. Abort the upstream Copilot fetch so the socket tears
      //      down and any thread-blocked persona handler unwinds.
      //   3. Free the in-flight slot synchronously (don't wait for
      //      handleToolsCall's `finally` to run — the upstream fetch
      //      may take minutes to abort, and the slot blocks other
      //      tools/call callers in the meantime).
      // `cancelInflight` does (2) + (3) atomically and is idempotent.
      if (heartbeatHandle !== undefined) {
        clearInterval(heartbeatHandle)
        heartbeatHandle = undefined
      }
      const abortKey =
        body.id !== undefined && body.id !== null ? body.id : undefined
      if (abortKey !== undefined) {
        cancelInflight(abortKey, "client disconnected SSE stream")
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // MCP Streamable HTTP transport identifier so middleboxes (and
      // future Claude Code versions that key off this) handle the
      // response correctly.
      "X-Accel-Buffering": "no",
    },
  })
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
  __resetInFlightSharedForTests()
}

/** Test helper: peek the in-flight counter. */
export function __getInFlightForTests(): number {
  return currentInFlight()
}
