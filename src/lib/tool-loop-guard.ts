import { createHash } from "node:crypto"

import consola from "consola"

type AnyRecord = Record<string, unknown>

/**
 * Tool results a CLIENT emits to say "you already made this exact call". These
 * are the strongest loop signal available: the client has already adjudicated
 * that the call was redundant, so no inference is needed and there is no
 * polling ambiguity (a status poll never produces one of these).
 *
 * Matched by WHOLE-RESULT equality, never substring — the text below also lives
 * in this repository's docs and in stored session transcripts, so a substring
 * match would fire on an agent reading its own project. `tests/canaries/`
 * pins this set against the installed client so a reword fails loudly instead
 * of silently switching Tier A off.
 */
export const CLIENT_REDUNDANCY_MARKERS: ReadonlySet<string> = new Set([
  // Claude Code's duplicate-read guard. Verified byte-identical across 4,019
  // consecutive occurrences in the incident that motivated this module, always
  // as the entire result content and always with `is_error` unset.
  "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.",
])

const DEFAULT_NUDGE_AT = 4
const DEFAULT_ABORT_AT = 7

/**
 * Results are compared by equality, and a single `read` can return megabytes.
 * Anything longer than this is compared by digest instead so a comparison stays
 * cheap and bounded; below it the raw text is kept so short results stay
 * readable in a failing test.
 */
const RESULT_DIGEST_THRESHOLD = 4096

/**
 * Strict env parse. Modelled on `envInt` in `~/lib/port.ts` (digits only, warn
 * rather than silently misconfigure) with one deliberate difference: `0` is a
 * MEANINGFUL value here — it disables a stage — so it is accepted instead of
 * being treated as absent.
 */
function envThreshold(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  if (!/^[0-9]+$/.test(raw.trim())) {
    consola.warn(
      `${key}=${JSON.stringify(raw)} is not a non-negative integer; using fallback ${fallback}`,
    )
    return fallback
  }
  const parsed = Number.parseInt(raw.trim(), 10)
  return Number.isSafeInteger(parsed) ? parsed : fallback
}

export function loopNudgeAt(): number {
  return envThreshold("GH_ROUTER_LOOP_NUDGE_AT", DEFAULT_NUDGE_AT)
}

export function loopAbortAt(): number {
  return envThreshold("GH_ROUTER_LOOP_ABORT_AT", DEFAULT_ABORT_AT)
}

/** One tool call plus the result it received, normalized for comparison. */
export interface NormalizedCall {
  name: string
  /**
   * `${name}:${JSON.stringify(args)}`, deliberately NOT key-order-canonical, so
   * this guard and the in-process worker guard (`stableArgs` in
   * `~/lib/worker-agent/budget.ts`) agree on what "identical" means.
   */
  argsKey: string
  /**
   * LAZY and memoized. Extraction walks the whole history, but `detectToolLoop`
   * only ever inspects the tail, and normalizing a result means hashing what
   * can be megabytes of file content. Computing it eagerly would digest every
   * result in the history on every single request — on an incident-sized
   * conversation that is thousands of hashes to answer a question about the
   * last seven turns.
   */
  resultKey: () => string
  /** The result was exactly a known client redundancy marker. */
  isMarker: boolean
}

/**
 * One assistant turn that issued at least one tool call, together with whether
 * the model said anything of its own in that turn.
 */
export interface NormalizedTurn {
  calls: Array<NormalizedCall>
  /** Turn carried non-empty text or a thinking block, not just tool calls. */
  hasNarration: boolean
}

export type LoopAction = "none" | "nudge" | "abort"

export interface LoopVerdict {
  action: LoopAction
  /** Which predicate fired: "A" = client marker, "B" = generic. */
  tier: "A" | "B" | null
  /** Length of the trailing run of identical turns. */
  repeats: number
  /** Tool name to name in the nudge / abort message, when unambiguous. */
  toolName?: string
}

const NO_LOOP: LoopVerdict = { action: "none", tier: null, repeats: 0 }

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

function boundedText(value: string): string {
  return value.length > RESULT_DIGEST_THRESHOLD ? `#${digest(value)}` : value
}

/**
 * Canonical string for a tool result.
 *
 * Under-specifying this is a correctness bug in both directions: dropping
 * non-text blocks makes DIFFERENT results compare equal (an image that changed
 * every turn would look like a loop), and serializing whole wire objects makes
 * IDENTICAL results compare unequal (a re-encrypted id would mask a real loop).
 * So every block contributes, identified by type, and `is_error` participates —
 * a call that starts failing is not the same result as one that succeeded.
 */
export function normalizeResult(content: unknown, isError?: unknown): string {
  const errTag = isError === true ? "E" : "N"
  return `${errTag}|${normalizeResultBody(content)}`
}

function normalizeResultBody(content: unknown): string {
  if (content === null || content === undefined) return "∅"
  if (typeof content === "string") return `s:${boundedText(content)}`
  if (Array.isArray(content)) {
    return content.map((block) => normalizeResultBlock(block)).join("")
  }
  return `j:${boundedText(safeJson(content))}`
}

function normalizeResultBlock(block: unknown): string {
  if (typeof block === "string") return `s:${boundedText(block)}`
  if (!isRecord(block)) return `j:${boundedText(safeJson(block))}`
  const type = typeof block.type === "string" ? block.type : "unknown"
  if (type === "text" && typeof block.text === "string") {
    return `t:${boundedText(block.text)}`
  }
  // Image / document / anything else: identified by type plus a digest of the
  // whole block, so it is distinguishable without being reproduced.
  return `${type}:${digest(safeJson(block))}`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    // Matches `stableArgs`: an unserializable value collapses to "", which can
    // only make two things look MORE alike — it never throws inside the guard.
    return ""
  }
}

export function argsKeyFor(name: string, args: unknown): string {
  return `${name}:${safeJson(args)}`
}

export function buildCall(
  name: string,
  args: unknown,
  content: unknown,
  isError?: unknown,
): NormalizedCall {
  const raw = typeof content === "string" ? content : undefined
  let cached: string | undefined
  return {
    name,
    argsKey: argsKeyFor(name, args),
    resultKey: () => (cached ??= normalizeResult(content, isError)),
    isMarker: raw !== undefined && CLIENT_REDUNDANCY_MARKERS.has(raw),
  }
}
/**
 * Signature of a whole turn: every (call, result) pair, sorted so the order the
 * client happened to serialize parallel calls and their results in cannot
 * change the answer.
 */
function turnSignature(turn: NormalizedTurn): string {
  return turn.calls
    .map((call) => `${call.argsKey}${call.resultKey()}`)
    .sort()
    .join("")
}

/**
 * Decide whether the tail of a conversation is a stuck tool loop.
 *
 * Compares WHOLE TURNS, not individual calls. Flattening a parallel-tool turn
 * into a call sequence is wrong in both directions: a turn issuing calls A and
 * B flattens to `A,B,A,B,…`, where no two neighbours match, so a repeating
 * parallel batch never registers; and seven identical calls inside ONE turn
 * look like a run of seven even though the model has observed no results at all
 * and completed zero feedback cycles.
 *
 * Only an immediately-repeating turn counts. A cycle with a period longer than
 * one turn (turn A, turn B, turn A, …) is NOT detected — a deliberate scope
 * limit, matching the single-slot reset semantics of the in-process worker
 * guard rather than trying to be a general cycle finder.
 */
export function detectToolLoop(
  turns: Array<NormalizedTurn>,
  options: { nudgeAt?: number; abortAt?: number } = {},
): LoopVerdict {
  const nudgeAt = options.nudgeAt ?? loopNudgeAt()
  const abortAt = options.abortAt ?? loopAbortAt()
  const active = [nudgeAt, abortAt].filter((n) => n > 0)
  if (active.length === 0 || turns.length === 0) return NO_LOOP

  // Only ever needs the tail, and stops at the first mismatch: at most
  // `max(nudgeAt, abortAt)` turns are inspected however long the history is.
  const limit = Math.max(...active)
  const last = turns[turns.length - 1]
  if (!last || last.calls.length === 0) return NO_LOOP

  const signature = turnSignature(last)
  const run: Array<NormalizedTurn> = [last]
  for (let i = turns.length - 2; i >= 0 && run.length < limit; i--) {
    const turn = turns[i]
    if (!turn || turn.calls.length === 0) break
    if (turnSignature(turn) !== signature) break
    run.push(turn)
  }

  const repeats = run.length
  const toolName = uniqueToolName(last)

  // Tier A: the client itself declared every call in the run redundant. No
  // silence test — the client has already ruled out the polling case.
  const markerRun = run.every((turn) =>
    turn.calls.every((call) => call.isMarker),
  )
  if (abortAt > 0 && repeats >= abortAt) {
    if (markerRun) return { action: "abort", tier: "A", repeats, toolName }
    // Tier B: identical results are NOT enough on their own — a status poll
    // returns byte-identical output for minutes. The second discriminator is
    // silence: a deliberate poller narrates between calls, a wedged model does
    // not (the motivating incident emitted tool_use blocks and nothing else
    // across all 4,060 turns).
    if (!run.some((turn) => turn.hasNarration)) {
      return { action: "abort", tier: "B", repeats, toolName }
    }
  }
  if (nudgeAt > 0 && repeats >= nudgeAt) {
    return { action: "nudge", tier: markerRun ? "A" : "B", repeats, toolName }
  }
  return NO_LOOP
}

function uniqueToolName(turn: NormalizedTurn): string | undefined {
  const names = new Set(turn.calls.map((call) => call.name))
  return names.size === 1 ? [...names][0] : undefined
}

/** Text injected as a sibling block when a loop is suspected but not certain. */
export function nudgeText(verdict: LoopVerdict): string {
  const what = verdict.toolName ? `\`${verdict.toolName}\` call` : "tool call"
  return (
    `[github-router] The same ${what} has now been repeated ${verdict.repeats}× `
    + "in a row with an identical result. Nothing has changed and nothing will "
    + "change by repeating it. Use the result you already have, try a materially "
    + "different approach, or stop and report what you found."
  )
}

/** Message returned to the client when the loop is aborted. */
export function abortMessage(verdict: LoopVerdict): string {
  const what = verdict.toolName ? `\`${verdict.toolName}\` call` : "tool call"
  return (
    `Request blocked by github-router: the same ${what} has been repeated `
    + `${verdict.repeats}× consecutively with an identical result and no `
    + "intervening progress. Continuing would burn inference with no possible "
    + "change in outcome. Vary the call or end the turn. Tune or disable this "
    + "with GH_ROUTER_LOOP_ABORT_AT."
  )
}

// ---------------------------------------------------------------------------
// Per-format extractors
//
// Every extractor is READ-ONLY: it never mutates or re-serializes the body it
// is handed. On `/v1/messages` that is load-bearing — that path is otherwise a
// raw-string passthrough, and a stray JSON round-trip there would silently
// change values JavaScript cannot hold exactly (`9007199254740993` becomes
// `…992`), corrupting tool arguments.
// ---------------------------------------------------------------------------

/**
 * Cheap pre-check so a request with no tool traffic never pays for a parse.
 * Substring test against the raw body: false positives merely cost the parse
 * the guard would have done anyway, and there are no false negatives because
 * every wire format spells its result marker literally.
 */
export function mayContainToolTraffic(rawBody: string): boolean {
  return (
    rawBody.includes("tool_result")
    || rawBody.includes("tool_call_id")
    || rawBody.includes("function_call_output")
  )
}

function blockType(block: unknown): string | undefined {
  return isRecord(block) && typeof block.type === "string"
    ? block.type
    : undefined
}

/** Anthropic Messages: assistant `tool_use` blocks ↔ user `tool_result` blocks. */
export function extractAnthropicTurns(body: unknown): Array<NormalizedTurn> {
  if (!isRecord(body) || !Array.isArray(body.messages)) return []
  const turns: Array<NormalizedTurn> = []

  for (let i = 0; i < body.messages.length; i++) {
    const message = body.messages[i]
    if (!isRecord(message) || message.role !== "assistant") continue
    if (!Array.isArray(message.content)) continue

    const uses = message.content.filter((b) => blockType(b) === "tool_use")
    if (uses.length === 0) {
      // A tool-less assistant turn is real progress between tool attempts.
      // Skipping it entirely would splice the tool turns on either side into a
      // false "consecutive, silent" run and abort an agent that was visibly
      // reasoning. Emitted with no calls, which breaks the run in
      // `detectToolLoop`.
      turns.push({
        calls: [],
        hasNarration: anthropicHasNarration(message.content),
      })
      continue
    }

    // Results for this turn live in the user message(s) that follow, keyed by
    // tool_use_id. Pairing by id, not by position, is what makes a reordered
    // parallel batch still compare equal.
    const results = new Map<string, AnyRecord>()
    for (let j = i + 1; j < body.messages.length; j++) {
      const next = body.messages[j]
      if (!isRecord(next) || next.role !== "user") break
      if (!Array.isArray(next.content)) break
      for (const block of next.content) {
        if (!isRecord(block) || blockType(block) !== "tool_result") continue
        const id = block.tool_use_id
        if (typeof id === "string") results.set(id, block)
      }
    }

    const calls: Array<NormalizedCall> = []
    for (const use of uses) {
      if (!isRecord(use)) continue
      const name = typeof use.name === "string" ? use.name : "unknown"
      const id = typeof use.id === "string" ? use.id : undefined
      const result = id === undefined ? undefined : results.get(id)
      // An unanswered call contributes nothing to compare, but the ANSWERED
      // calls in the same turn still do. Dropping the whole turn on a partial
      // batch would blind the guard to a loop that repeats that exact partial
      // batch forever.
      if (!result) continue
      calls.push(buildCall(name, use.input, result.content, result.is_error))
    }
    if (calls.length === 0) continue

    turns.push({ calls, hasNarration: anthropicHasNarration(message.content) })
  }
  return turns
}

function anthropicHasNarration(content: Array<unknown>): boolean {
  return content.some((block) => {
    const type = blockType(block)
    if (type === "thinking" || type === "redacted_thinking") return true
    return (
      type === "text"
      && isRecord(block)
      && typeof block.text === "string"
      && block.text.trim() !== ""
    )
  })
}

/** OpenAI Chat Completions: assistant `tool_calls[]` ↔ `role:"tool"` messages. */
export function extractChatTurns(body: unknown): Array<NormalizedTurn> {
  if (!isRecord(body) || !Array.isArray(body.messages)) return []
  const turns: Array<NormalizedTurn> = []

  for (let i = 0; i < body.messages.length; i++) {
    const message = body.messages[i]
    if (!isRecord(message) || message.role !== "assistant") continue
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      // Same reasoning as the Anthropic extractor: a tool-less assistant turn
      // breaks the run rather than being spliced out of it.
      turns.push({ calls: [], hasNarration: chatHasNarration(message.content) })
      continue
    }

    const results = new Map<string, AnyRecord>()
    for (let j = i + 1; j < body.messages.length; j++) {
      const next = body.messages[j]
      if (!isRecord(next) || next.role !== "tool") break
      const id = next.tool_call_id
      if (typeof id === "string") results.set(id, next)
    }

    const calls: Array<NormalizedCall> = []
    for (const call of message.tool_calls) {
      if (!isRecord(call)) continue
      const fn = isRecord(call.function) ? call.function : undefined
      const name = typeof fn?.name === "string" ? fn.name : "unknown"
      const id = typeof call.id === "string" ? call.id : undefined
      const result = id === undefined ? undefined : results.get(id)
      if (!result) continue
      // `arguments` is already a JSON string on this wire; it is compared as
      // the string the client sent, matching the non-canonical rule above.
      calls.push(buildCall(name, fn?.arguments, result.content))
    }
    if (calls.length === 0) {
      continue
    }

    turns.push({ calls, hasNarration: chatHasNarration(message.content) })
  }
  return turns
}

/**
 * OpenAI allows assistant `content` to be either a string or an array of
 * multimodal parts. Treating only the string form as narration would classify
 * an array-narrating model as silent and expose it to the Tier B abort.
 */
function chatHasNarration(content: unknown): boolean {
  if (typeof content === "string") return content.trim() !== ""
  if (!Array.isArray(content)) return false
  return content.some(
    (part) =>
      isRecord(part)
      && typeof part.text === "string"
      && part.text.trim() !== "",
  )
}

/** OpenAI Responses: `function_call` items ↔ `function_call_output` items. */
export function extractResponsesTurns(body: unknown): Array<NormalizedTurn> {
  if (!isRecord(body) || !Array.isArray(body.input)) return []
  const items = body.input

  // Outputs can trail well past their call, so index them once up front.
  const results = new Map<string, AnyRecord>()
  for (const item of items) {
    if (!isRecord(item) || item.type !== "function_call_output") continue
    const id = item.call_id
    if (typeof id === "string") results.set(id, item)
  }

  const turns: Array<NormalizedTurn> = []
  let i = 0
  while (i < items.length) {
    const item = items[i]
    if (!isRecord(item) || item.type !== "function_call") {
      i++
      continue
    }
    // A parallel batch arrives as consecutive function_call items; they belong
    // to one model decision and so form one turn.
    const batch: Array<AnyRecord> = []
    while (i < items.length) {
      const candidate = items[i]
      if (!isRecord(candidate) || candidate.type !== "function_call") break
      batch.push(candidate)
      i++
    }

    const calls: Array<NormalizedCall> = []
    for (const call of batch) {
      const name = typeof call.name === "string" ? call.name : "unknown"
      const id = typeof call.call_id === "string" ? call.call_id : undefined
      const result = id === undefined ? undefined : results.get(id)
      if (!result) continue
      calls.push(buildCall(name, call.arguments, result.output))
    }
    if (calls.length === 0) continue

    turns.push({
      calls,
      hasNarration: responsesHasNarration(items, i - batch.length),
    })
  }
  return turns
}

/**
 * Responses has no turn envelope, so narration is whatever the model emitted
 * immediately before the call batch: an assistant/message item or a reasoning
 * item.
 */
function responsesHasNarration(
  items: Array<unknown>,
  batchStart: number,
): boolean {
  for (let i = batchStart - 1; i >= 0; i--) {
    const item = items[i]
    if (!isRecord(item)) return false
    if (item.type === "function_call_output") continue
    if (item.type === "reasoning") return true
    if (item.type === "message" || item.role === "assistant") {
      return responsesItemHasText(item)
    }
    return false
  }
  return false
}

function responsesItemHasText(item: AnyRecord): boolean {
  if (typeof item.content === "string") return item.content.trim() !== ""
  if (!Array.isArray(item.content)) return false
  return item.content.some(
    (block) =>
      isRecord(block)
      && typeof block.text === "string"
      && block.text.trim() !== "",
  )
}

// ---------------------------------------------------------------------------
// Nudge injection
//
// Each injector adds a protocol-valid SIBLING to the trailing turn and leaves
// every existing tool result byte-identical. Appending prose into a result
// payload instead would corrupt structured output — `{"status":"ok"}` followed
// by a sentence is no longer JSON — and each format's content shape differs.
//
// The sibling goes at the TAIL rather than into the top-level system prompt so
// the prompt-cache prefix survives; on an incident-sized request the system
// block sits in front of ~378K cached tokens.
//
// Each returns whether it injected, so a caller only re-serializes a body it
// actually changed.
// ---------------------------------------------------------------------------

export function injectAnthropicNudge(body: unknown, text: string): boolean {
  if (!isRecord(body) || !Array.isArray(body.messages)) return false
  const messages = body.messages
  const last = messages[messages.length - 1]
  if (!isRecord(last) || last.role !== "user") return false
  if (!Array.isArray(last.content)) return false
  messages[messages.length - 1] = {
    ...last,
    content: [...last.content, { type: "text", text }],
  }
  return true
}

export function injectChatNudge(body: unknown, text: string): boolean {
  if (!isRecord(body) || !Array.isArray(body.messages)) return false
  body.messages = [...body.messages, { role: "user", content: text }]
  return true
}

export function injectResponsesNudge(body: unknown, text: string): boolean {
  if (!isRecord(body) || !Array.isArray(body.input)) return false
  body.input = [
    ...body.input,
    { role: "user", content: [{ type: "input_text", text }] },
  ]
  return true
}

// ---------------------------------------------------------------------------
// Per-format entry points
// ---------------------------------------------------------------------------

export interface GuardOutcome {
  action: LoopAction
  /** Rewritten body, present only when a nudge was actually injected. */
  body?: string
  /** Client-facing text, present only on abort. */
  message?: string
  verdict: LoopVerdict
}

const NO_ACTION: GuardOutcome = { action: "none", verdict: NO_LOOP }

function report(verdict: LoopVerdict, route: string): void {
  consola.warn(
    `[LOOP-GUARD] ${verdict.action} on ${route}: tier=${verdict.tier} `
    + `repeats=${verdict.repeats} tool=${verdict.toolName ?? "multiple"}`,
  )
}

/**
 * Anthropic Messages. Takes and returns the raw body string because that path
 * is otherwise a passthrough; the body is re-serialized ONLY when a nudge is
 * injected, mirroring `resolveModelInBody`'s `modified ? stringify : raw`
 * contract so detection alone can never perturb values JavaScript cannot round
 * -trip exactly (`9007199254740993` becomes `…992`).
 *
 * Injecting a nudge inherently requires re-serializing, so on the rare request
 * that would otherwise pass through raw a nudge does extend that exposure. It
 * is not a NEW class of hazard — `resolveModelInBody` already re-serializes
 * whenever it changed anything, which for Claude Code is essentially every
 * request, since the model slug is rewritten.
 */
export function guardAnthropicBody(rawBody: string): GuardOutcome {
  if (!mayContainToolTraffic(rawBody)) return NO_ACTION
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody) as unknown
  } catch {
    // Malformed bodies are surfaced downstream; the guard stays out of it.
    return NO_ACTION
  }
  const verdict = detectToolLoop(extractAnthropicTurns(parsed))
  if (verdict.action === "none") return NO_ACTION
  report(verdict, "/v1/messages")
  if (verdict.action === "abort") {
    return { action: "abort", message: abortMessage(verdict), verdict }
  }
  if (!injectAnthropicNudge(parsed, nudgeText(verdict))) return NO_ACTION
  return { action: "nudge", body: JSON.stringify(parsed), verdict }
}

/** OpenAI Chat Completions. Mutates the already-parsed payload in place. */
export function guardChatPayload(payload: unknown): GuardOutcome {
  const verdict = detectToolLoop(extractChatTurns(payload))
  if (verdict.action === "none") return NO_ACTION
  report(verdict, "/v1/chat/completions")
  if (verdict.action === "abort") {
    return { action: "abort", message: abortMessage(verdict), verdict }
  }
  if (!injectChatNudge(payload, nudgeText(verdict))) return NO_ACTION
  return { action: "nudge", verdict }
}

/** OpenAI Responses. Mutates the already-parsed payload in place. */
export function guardResponsesPayload(payload: unknown): GuardOutcome {
  const verdict = detectToolLoop(extractResponsesTurns(payload))
  if (verdict.action === "none") return NO_ACTION
  report(verdict, "/v1/responses")
  if (verdict.action === "abort") {
    return { action: "abort", message: abortMessage(verdict), verdict }
  }
  if (!injectResponsesNudge(payload, nudgeText(verdict))) return NO_ACTION
  return { action: "nudge", verdict }
}

