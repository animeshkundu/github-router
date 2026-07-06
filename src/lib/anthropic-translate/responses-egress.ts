/**
 * OpenAI `/responses` → Anthropic Messages egress.
 *
 *  - `responsesResponseToAnthropicMessage` maps a non-streaming Responses object
 *    to an Anthropic Messages object (content blocks, tool_use, usage,
 *    stop_reason).
 *  - `synthAnthropicFromResponses` is the streaming state machine: it consumes
 *    Copilot's `/responses` SSE and yields Anthropic stream events
 *    (message_start → content_block_* → message_delta → message_stop).
 *
 * The decode follows our own empirically-verified `/responses` handling
 * (`src/lib/worker-agent/stream-fn.ts`): the tool/reasoning block key is the
 * STABLE `output_index`, never the per-event `item_id` — Copilot re-encrypts
 * `item_id` on every event, so an id key makes every delta lookup miss and the
 * tool args drop to `{}`.
 *
 * Block lifecycle (mirrors stream-fn.ts): every output item is tracked
 * independently by its `output_index` key. Parallel/interleaved tool calls
 * never force-close a sibling — Responses emits ALL `output_item.added` for
 * parallel tools BEFORE the first `function_call_arguments.delta`, so opening (and
 * emitting) a tool at `added` time would ship it with empty args and drop the
 * later deltas. Instead a tool's args are BUFFERED and its Anthropic block is
 * emitted ATOMICALLY (content_block_start → single input_json_delta with the
 * full assembled args → content_block_stop) at that tool's OWN
 * `output_item.done` (or flushed at end-of-stream if the item was left
 * dangling). Only an open TEXT or THINKING block is closed on a type switch —
 * never a sibling tool. The Anthropic block index is assigned at emit time, so
 * indices stay monotonic on the wire regardless of item interleaving.
 */

import { randomUUID } from "node:crypto"

import type { ResponsesApiResponse } from "~/services/copilot/create-responses"

import {
  type AnthropicStreamEvent,
  type AnthropicUsage,
  makeContentBlockStart,
  makeContentBlockStop,
  makeInputJsonDelta,
  makeMessageDelta,
  makeMessageId,
  makeMessageStart,
  makeMessageStop,
  makeSignatureDelta,
  makeTextDelta,
  makeThinkingDelta,
} from "./anthropic-sse"

type AnyRecord = Record<string, unknown>

/** Shape of the `/responses` streaming SSE events we consume (subset). */
interface ResponsesSseEvent {
  type?: string
  /** STABLE per-output-item index — the load-bearing correlation key. */
  output_index?: number
  delta?: string
  text?: string
  arguments?: string
  item_id?: string
  item?: {
    type?: string
    id?: string
    call_id?: string
    name?: string
    arguments?: string
    encrypted_content?: string
    summary?: Array<Record<string, unknown>>
  }
  response?: {
    status?: string
    usage?: ResponsesUsage
    incomplete_details?: { reason?: string }
    error?: { message?: string }
  }
}

interface ResponsesUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
}

/**
 * Stable map key for a `/responses` output item: prefer `output_index`
 * (constant per item), fall back to the opaque id only when absent. Namespaced
 * so a numeric index and a string id can never collide.
 */
function responsesKey(
  outputIndex: number | undefined,
  fallbackId: string | undefined,
): string | undefined {
  if (typeof outputIndex === "number") return `oi:${outputIndex}`
  if (typeof fallbackId === "string" && fallbackId.length > 0) return `id:${fallbackId}`
  return undefined
}

/** Synthesize a matchable Anthropic tool_use id when the upstream id is absent. */
function makeToolUseId(): string {
  return `toolu_${randomUUID().replace(/-/g, "")}`
}

/** First non-empty string among the candidates, or "" when none qualifies. */
function firstNonEmpty(...vals: Array<string | undefined>): string {
  for (const v of vals) {
    if (typeof v === "string" && v.length > 0) return v
  }
  return ""
}

function anthropicUsageFromResponses(u: ResponsesUsage | undefined): AnthropicUsage {
  if (!u) return {}
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_input_tokens: u.input_tokens_details?.cached_tokens ?? 0,
    cache_creation_input_tokens: 0,
  }
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // malformed — surface empty args (the model can retry)
  }
  return {}
}

// ---------------------------------------------------------------------------
// non-streaming
// ---------------------------------------------------------------------------

/**
 * The Anthropic Messages object produced from a non-streaming Responses object.
 * Content blocks stay loosely typed (`Record<string, unknown>`) because the
 * block shape is a discriminated union built inline; the top-level envelope and
 * usage are pinned so callers read them without a cast.
 */
interface AnthropicMessageResult {
  id: string
  type: "message"
  role: "assistant"
  model: string
  content: Array<Record<string, unknown>>
  stop_reason: string
  stop_sequence: null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  }
}

/**
 * Map a non-streaming Responses object to an Anthropic Messages object.
 *
 * stop_reason precedence for a completed non-streaming response:
 * an incomplete/max-output response is `max_tokens` even if a partial tool call
 * is present (the response was truncated), else a function_call → `tool_use`,
 * else `end_turn`.
 */
export function responsesResponseToAnthropicMessage(
  resp: ResponsesApiResponse,
  modelId: string,
): AnthropicMessageResult {
  const output = Array.isArray(resp.output) ? resp.output : []
  const content: Array<AnyRecord> = []
  let sawToolUse = false

  for (const rawItem of output) {
    if (!rawItem || typeof rawItem !== "object") continue
    const item = rawItem as AnyRecord

    if (item.type === "message") {
      let text = ""
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part && typeof part === "object" && part.type === "output_text" && typeof part.text === "string") {
            text += part.text
          }
        }
      }
      if (text.length > 0) content.push({ type: "text", text })
    } else if (item.type === "function_call") {
      sawToolUse = true
      // S12: a missing/empty upstream id would leave `tool_use.id` as ""
      // (unmatchable by the paired tool_result); synthesize a `toolu_` id.
      const rawId =
        typeof item.call_id === "string" && item.call_id.length > 0 ? item.call_id
        : typeof item.id === "string" && item.id.length > 0 ? item.id
        : ""
      content.push({
        type: "tool_use",
        id: rawId.length > 0 ? rawId : makeToolUseId(),
        name: typeof item.name === "string" ? item.name : "",
        input: parseToolArgs(item.arguments),
      })
    } else if (item.type === "reasoning") {
      let thinking = ""
      if (Array.isArray(item.summary)) {
        for (const part of item.summary) {
          if (part && typeof part === "object" && typeof part.text === "string") thinking += part.text
        }
      }
      if (thinking.length > 0) {
        content.push({
          type: "thinking",
          thinking,
          signature: typeof item.encrypted_content === "string" ? item.encrypted_content : "",
        })
      }
    }
  }

  const usage = anthropicUsageFromResponses((resp as AnyRecord).usage as ResponsesUsage)
  const incompleteMax =
    resp.status === "incomplete"
    && (resp.incomplete_details as { reason?: string } | undefined)?.reason
      === "max_output_tokens"
  const stopReason = incompleteMax ? "max_tokens" : sawToolUse ? "tool_use" : "end_turn"

  return {
    id: typeof resp.id === "string" && resp.id.length > 0 ? `msg_${resp.id}` : makeMessageId(),
    type: "message",
    role: "assistant",
    model: modelId,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    },
  }
}

// ---------------------------------------------------------------------------
// streaming
// ---------------------------------------------------------------------------

type OpenBlockKind = "text" | "thinking"

/** Per-tool buffered state; the Anthropic block index is assigned at emit time. */
interface ToolState {
  id: string
  name: string
  /** Accumulated argument JSON (deltas appended; `.done` overwrites). */
  argsBuffer: string
  /** Whether the atomic tool block has been emitted. */
  emitted: boolean
}

/** Per-text-block state, keyed by `output_index`, tracking what was emitted. */
interface TextState {
  index: number
  /** Text already sent as `text_delta` for this block (for suffix-only `.done`). */
  emitted: string
}

/**
 * Streaming synthesizer: consume a `/responses` SSE iterable, yield the
 * Anthropic event sequence. Emits `message_start` first, then content blocks in
 * item order, then a terminal `message_delta` (accumulated usage + stop_reason)
 * and `message_stop`. A `response.failed` throws so the stream adapter can emit
 * a terminal `event: error`; a stream that ends WITHOUT a terminal event
 * (`completed`/`incomplete`/`failed`) is treated as truncated and throws too.
 */
export async function* synthAnthropicFromResponses(
  upstream: AsyncIterable<{ data?: string }>,
  opts: { modelId: string; messageId?: string },
): AsyncGenerator<AnthropicStreamEvent> {
  const messageId = opts.messageId ?? makeMessageId()
  const q: Array<AnthropicStreamEvent> = []

  let nextIndex = 0
  // The single OPEN text/thinking block (tools never occupy `current` — they
  // are emitted atomically and never stay open). At most one open at a time.
  let current: { index: number; kind: OpenBlockKind } | null = null
  // output-index key → buffered tool state.
  const toolByKey = new Map<string, ToolState>()
  // output-index key → thinking block index (reuse across reasoning deltas +
  // signature lookup at the reasoning item's `output_item.done`).
  const thinkingByKey = new Map<string, number>()
  // output-index key → text block state (index + emitted text, for I5).
  const textByKey = new Map<string, TextState>()

  let usageIn = 0
  let usageOut = 0
  let usageCacheRead = 0
  let sawTool = false
  let hitMaxTokens = false
  // I4: a terminal event (`completed`/`incomplete`/`failed`) was seen. If the
  // upstream iterable ends without one, the stream was truncated mid-flight and
  // must NOT be synthesized as a clean, successful message.
  let sawTerminal = false

  const closeCurrent = (): void => {
    if (!current) return
    q.push(makeContentBlockStop(current.index))
    current = null
  }
  // Accessors read `current` inside a closure so it keeps its declared type at
  // the loop-body call sites (a bare `let` assigned only inside closures reads
  // as `null` under TS linear control-flow, which would make `.kind`/`.index`
  // resolve to `never`).
  const currentKind = (): OpenBlockKind | null => (current ? current.kind : null)
  const currentIndex = (): number | null => (current ? current.index : null)

  const ensureTextState = (key: string): TextState => {
    const existing = textByKey.get(key)
    if (existing != null && current?.kind === "text" && current.index === existing.index) {
      return existing
    }
    // A closed (or never-opened) block cannot be reopened at the same index —
    // a type switch already closed it. Open a fresh block with a new index.
    closeCurrent()
    const index = nextIndex++
    const state: TextState = { index, emitted: "" }
    textByKey.set(key, state)
    current = { index, kind: "text" }
    q.push(makeContentBlockStart(index, { type: "text", text: "" }))
    return state
  }
  const ensureThinking = (key: string): number => {
    if (current?.kind === "thinking" && thinkingByKey.get(key) === current.index) {
      return current.index
    }
    closeCurrent()
    const index = nextIndex++
    current = { index, kind: "thinking" }
    thinkingByKey.set(key, index)
    q.push(makeContentBlockStart(index, { type: "thinking", thinking: "" }))
    return index
  }
  // Tool arguments are BUFFERED, not forwarded live: `function_call_arguments.done`
  // / `output_item.done` carry the AUTHORITATIVE full args and overwrite the
  // accumulated deltas (Copilot can send a corrupted/partial delta stream). The
  // whole tool block is emitted atomically here so a parallel sibling tool can
  // never truncate it. A streamed protocol can't retract an already-emitted
  // `input_json_delta`, so the authoritative args go out as one delta at emit.
  const emitTool = (t: ToolState): void => {
    if (t.emitted) return
    // Close the open text/thinking block first — a tool_use block must not be
    // nested inside another open block on the wire.
    closeCurrent()
    const index = nextIndex++
    q.push(makeContentBlockStart(index, { type: "tool_use", id: t.id, name: t.name, input: {} }))
    const args = t.argsBuffer.length > 0 ? t.argsBuffer : "{}"
    q.push(makeInputJsonDelta(index, args))
    q.push(makeContentBlockStop(index))
    t.emitted = true
    sawTool = true
  }

  // message_start is emitted eagerly (real input_tokens aren't known until the
  // terminal usage event; they're reported in the final message_delta).
  q.push(makeMessageStart(messageId, opts.modelId))
  for (const e of q) yield e
  q.length = 0

  for await (const evt of upstream) {
    const data = evt?.data
    if (data == null) continue
    if (data === "[DONE]") break

    let ev: ResponsesSseEvent
    try {
      ev = JSON.parse(data) as ResponsesSseEvent
    } catch {
      continue
    }

    switch (ev.type) {
      case "response.output_text.delta": {
        const d = ev.delta
        if (typeof d !== "string" || d.length === 0) break
        const key = responsesKey(ev.output_index, ev.item_id) ?? "text"
        const state = ensureTextState(key)
        state.emitted += d
        q.push(makeTextDelta(state.index, d))
        break
      }

      case "response.output_text.done": {
        const key = responsesKey(ev.output_index, ev.item_id) ?? "text"
        const fullText = typeof ev.text === "string" ? ev.text : ""
        const existing = textByKey.get(key)
        if (existing == null) {
          // No deltas were emitted for this key — emit the full text as its own
          // block (this is the only carrier of the text).
          if (fullText.length > 0) {
            const state = ensureTextState(key)
            state.emitted = fullText
            q.push(makeTextDelta(state.index, fullText))
            closeCurrent()
          }
        } else if (currentKind() === "text" && currentIndex() === existing.index) {
          // I5: deltas already streamed this text; emit ONLY the un-emitted
          // suffix (never the full text again), then close. If `.done` merely
          // repeats what the deltas already sent, the suffix is empty.
          if (fullText.length > existing.emitted.length && fullText.startsWith(existing.emitted)) {
            q.push(makeTextDelta(existing.index, fullText.slice(existing.emitted.length)))
            existing.emitted = fullText
          }
          closeCurrent()
        }
        // else: this key's block was already closed by a type switch — the
        // deltas already conveyed the text, so re-emitting would duplicate (I5).
        break
      }

      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const d = ev.delta
        if (typeof d !== "string" || d.length === 0) break
        const key = responsesKey(ev.output_index, ev.item_id) ?? "reasoning"
        q.push(makeThinkingDelta(ensureThinking(key), d))
        break
      }

      case "response.reasoning_summary_text.done":
      case "response.reasoning_text.done": {
        // C2: do NOT close the thinking block here. The block stays open so its
        // `signature_delta` (from `output_item.done{reasoning, encrypted_content}`)
        // can still be emitted into the open block. It is closed by the next
        // block's type switch, the reasoning `output_item.done`, or end-of-stream.
        break
      }

      case "response.output_item.added": {
        const item = ev.item
        if (item?.type === "function_call") {
          const key = responsesKey(ev.output_index, item.id)
          if (key == null || toolByKey.has(key)) break
          // C1: DO NOT open/emit the tool block here. Responses emits every
          // parallel tool's `added` before the first args delta; opening now would
          // force-close the sibling and ship empty args. Just record the tool;
          // its block is emitted atomically at its own `output_item.done`.
          // S12: an empty/missing upstream id must not become `tool_use.id: ""`
          // (unmatchable by the paired tool_result) — synthesize a `toolu_` id.
          const toolId = firstNonEmpty(item.call_id, item.id)
          toolByKey.set(key, {
            id: toolId.length > 0 ? toolId : makeToolUseId(),
            name: item.name ?? "",
            argsBuffer: "",
            emitted: false,
          })
          sawTool = true
        }
        // message / reasoning items open lazily on their first delta.
        break
      }

      case "response.function_call_arguments.delta": {
        const key = responsesKey(ev.output_index, ev.item_id)
        if (key == null) break
        const t = toolByKey.get(key)
        if (!t || t.emitted) break
        const d = ev.delta
        if (typeof d !== "string" || d.length === 0) break
        // Accumulate into the buffer; emission is deferred to the tool's done.
        t.argsBuffer += d
        break
      }

      case "response.function_call_arguments.done": {
        // Authoritative full args — overwrite the accumulated deltas (they may
        // have been corrupted/partial). Emission still happens at done.
        const key = responsesKey(ev.output_index, ev.item_id)
        if (key == null) break
        const t = toolByKey.get(key)
        if (!t || t.emitted) break
        if (typeof ev.arguments === "string") t.argsBuffer = ev.arguments
        break
      }

      case "response.output_item.done": {
        const item = ev.item
        if (item?.type === "function_call") {
          const key = responsesKey(ev.output_index, item.id)
          if (key == null) break
          const t = toolByKey.get(key)
          if (!t || t.emitted) break
          // Authoritative final view of the item overwrites the buffer and
          // backfills id/name, then the tool block is emitted atomically. Only a
          // non-empty id overwrites, so a synthesized `toolu_` id survives a
          // `.done` that still lacks a real id (S12).
          const doneId = firstNonEmpty(item.call_id, item.id)
          if (doneId.length > 0) t.id = doneId
          if (typeof item.name === "string" && item.name.length > 0) t.name = item.name
          if (typeof item.arguments === "string") t.argsBuffer = item.arguments
          emitTool(t)
        } else if (item?.type === "reasoning") {
          // If the reasoning item carries an encrypted signature and its
          // thinking block is still open, emit a signature_delta before closing.
          const key = responsesKey(ev.output_index, item.id)
          const idx = key != null ? thinkingByKey.get(key) : undefined
          if (
            idx != null
            && currentKind() === "thinking"
            && currentIndex() === idx
          ) {
            if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
              q.push(makeSignatureDelta(idx, item.encrypted_content))
            }
            closeCurrent()
          }
        }
        break
      }

      case "response.completed":
      case "response.incomplete": {
        sawTerminal = true
        const u = ev.response?.usage
        if (u) {
          usageIn = Math.max(usageIn, u.input_tokens ?? 0)
          usageOut = Math.max(usageOut, u.output_tokens ?? 0)
          usageCacheRead = Math.max(usageCacheRead, u.input_tokens_details?.cached_tokens ?? 0)
        }
        if (
          ev.type === "response.incomplete"
          && ev.response?.incomplete_details?.reason === "max_output_tokens"
        ) {
          hitMaxTokens = true
        }
        break
      }

      case "response.failed": {
        // A terminal failure — the stream adapter turns this throw into a
        // terminal `event: error`. (sawTerminal is moot: we exit via throw.)
        throw new Error(ev.response?.error?.message ?? "response.failed")
      }

      default:
        break
    }

    for (const e of q) yield e
    q.length = 0
  }

  // I4: the loop ended. If NO terminal event was seen the upstream was
  // truncated mid-stream (`fetch-event-stream`'s `events()` returns-done on a
  // clean-but-premature EOF rather than throwing). Surface it as a terminal
  // error instead of a clean, successful message_stop — the stream adapter
  // converts this throw into a terminal `event: error`.
  if (!sawTerminal) {
    throw new Error("responses stream ended without a terminal event (truncated)")
  }

  // Close the current text/thinking block, then flush the tool blocks the
  // stream left dangling (no `output_item.done`) so their buffered args aren't
  // lost. emitTool closes `current` first, so ordering stays correct.
  closeCurrent()
  for (const t of toolByKey.values()) {
    if (!t.emitted) emitTool(t)
  }
  // stop_reason precedence: a truncated (max-output) response is `max_tokens`
  // even with a partial tool call; else a tool call → `tool_use`; else end_turn.
  const stopReason = hitMaxTokens ? "max_tokens" : sawTool ? "tool_use" : "end_turn"
  q.push(
    makeMessageDelta(stopReason, null, {
      input_tokens: usageIn,
      output_tokens: usageOut,
      cache_read_input_tokens: usageCacheRead,
      cache_creation_input_tokens: 0,
    }),
  )
  q.push(makeMessageStop())
  for (const e of q) yield e
  q.length = 0
}
