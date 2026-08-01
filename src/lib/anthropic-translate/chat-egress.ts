/**
 * Copilot `/chat/completions` → Anthropic Messages egress (the Gemini path).
 *
 *  - `chatResponseToAnthropicMessage` maps a non-streaming chat/completions
 *    object to an Anthropic Messages object (text + tool_use blocks, usage,
 *    stop_reason).
 *  - `synthAnthropicFromChat` is the streaming state machine: it consumes
 *    Copilot's chat SSE (`choices[].delta`) and yields Anthropic stream events
 *    (message_start → content_block_* → message_delta → message_stop), reusing
 *    the shared `anthropic-sse.ts` frame builders.
 *
 * Chat streaming differs from the Responses path in one load-bearing way: there
 * is NO authoritative per-tool `.done` event carrying the full arguments — a
 * tool call's `id`/`name` arrive early (first delta for its array `index`) and
 * its `arguments` stream incrementally across later deltas keyed by that same
 * array `index`. So each tool is BUFFERED per OpenAI array index and its
 * Anthropic block is emitted ATOMICALLY at end-of-stream (content_block_start →
 * one input_json_delta with the full assembled args → content_block_stop). This
 * carries the Phase 1 C1 correctness lesson to the chat path: parallel/multiple
 * tools keep DISTINCT block indices and never lose their args to a clobbered
 * shared pointer. An open TEXT block is closed before any tool block opens (a
 * tool_use must not nest inside a text block on the wire). The Anthropic block
 * index is assigned at emit time so indices stay monotonic on the wire.
 */

import { randomUUID } from "node:crypto"

import type {
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

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
  makeTextDelta,
} from "./anthropic-sse"

type AnyRecord = Record<string, unknown>

/** Streaming chat chunk subset we consume (`choices[].delta` + trailing usage). */
interface ChatSseChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        /** OpenAI array index — the load-bearing correlation key. */
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: ChatUsage
}

interface ChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

/** Synthesize a matchable Anthropic tool_use id when the upstream id is absent. */
function makeToolUseId(): string {
  return `toolu_${randomUUID().replace(/-/g, "")}`
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

function anthropicUsageFromChat(u: ChatUsage | undefined): AnthropicUsage {
  if (!u) return {}
  return {
    input_tokens: u.prompt_tokens ?? 0,
    output_tokens: u.completion_tokens ?? 0,
    cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    cache_creation_input_tokens: 0,
  }
}

/**
 * Map a chat/completions `finish_reason` to an Anthropic stop_reason. A
 * truncated (`length`) response is `max_tokens` even when a partial tool call
 * is present — the response was cut — mirroring the Responses egress precedence.
 * `tool_calls` (or any buffered tool) → `tool_use`; everything else (`stop`,
 * `content_filter`, null) → `end_turn`.
 */
function chatStopReason(finishReason: string | null, sawTool: boolean): string {
  if (finishReason === "length") return "max_tokens"
  if (finishReason === "tool_calls" || sawTool) return "tool_use"
  return "end_turn"
}

// ---------------------------------------------------------------------------
// non-streaming
// ---------------------------------------------------------------------------

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
 * Map a non-streaming chat/completions object to an Anthropic Messages object.
 * The first choice's `message.content` becomes a text block (when non-empty)
 * and each `message.tool_calls[]` becomes a tool_use block.
 */
export function chatResponseToAnthropicMessage(
  resp: ChatCompletionResponse,
  modelId: string,
): AnthropicMessageResult {
  const choice = resp.choices?.[0]
  const content: Array<AnyRecord> = []
  let sawTool = false

  const message = choice?.message
  if (message) {
    if (typeof message.content === "string" && message.content.length > 0) {
      content.push({ type: "text", text: message.content })
    }
    if (Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        sawTool = true
        const rawId = typeof tc.id === "string" ? tc.id : ""
        content.push({
          type: "tool_use",
          id: rawId.length > 0 ? rawId : makeToolUseId(),
          name: typeof tc.function?.name === "string" ? tc.function.name : "",
          input: parseToolArgs(tc.function?.arguments),
        })
      }
    }
  }

  const usage = anthropicUsageFromChat(resp.usage)
  const stopReason = chatStopReason(choice?.finish_reason ?? null, sawTool)

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

/** Per-tool buffered state; the Anthropic block index is assigned at emit time. */
interface ChatToolState {
  id: string
  name: string
  /** Accumulated argument JSON fragments (chat streams args incrementally). */
  args: string
}

/**
 * Streaming synthesizer: consume a chat/completions SSE iterable, yield the
 * Anthropic event sequence. Emits `message_start` first, streams text live,
 * buffers tool calls per OpenAI array index and flushes them atomically at
 * end-of-stream (in numeric index order), then a terminal `message_delta`
 * (accumulated usage + stop_reason) and `message_stop`. The `[DONE]` sentinel
 * is the authoritative clean-end marker: a stream that ends WITHOUT it is
 * treated as truncated and throws so the stream adapter can emit a terminal
 * `event: error`. A clean `[DONE]` carrying no chunk-level `finish_reason`
 * still completes cleanly (stop_reason from any buffered tool, else `end_turn`).
 */
export async function* synthAnthropicFromChat(
  upstream: AsyncIterable<{ data?: string }>,
  opts: { modelId: string; messageId?: string },
): AsyncGenerator<AnthropicStreamEvent> {
  const messageId = opts.messageId ?? makeMessageId()

  let nextIndex = 0
  let activeTextIndex: number | null = null
  // OpenAI array index → buffered tool state (flushed in numeric-index order).
  const toolByIndex = new Map<number, ChatToolState>()

  let usageIn = 0
  let usageOut = 0
  let usageCacheRead = 0
  // The last finish_reason seen — informs stop_reason ONLY (null → end_turn).
  let finishReason: string | null = null
  // The `[DONE]` sentinel is the authoritative clean-end marker. A stream that
  // ends WITHOUT it was cut mid-flight (I4) and must NOT be synthesized as a
  // clean success. finish_reason is NOT the signal: Copilot's Gemini path can
  // omit a chunk-level finish_reason on an otherwise-clean stream, so keying the
  // truncation guard off it would falsely error every such stream.
  let sawDone = false

  yield makeMessageStart(messageId, opts.modelId)

  for await (const evt of upstream) {
    const data = evt?.data
    if (data == null) continue
    if (data === "[DONE]") {
      sawDone = true
      break
    }

    let chunk: ChatSseChunk
    try {
      chunk = JSON.parse(data) as ChatSseChunk
    } catch {
      continue
    }

    // Usage may ride on any chunk (typically a trailing choices-empty chunk).
    // Max-accumulate so a later zeroed frame can't clobber a real count.
    if (chunk.usage) {
      usageIn = Math.max(usageIn, chunk.usage.prompt_tokens ?? 0)
      usageOut = Math.max(usageOut, chunk.usage.completion_tokens ?? 0)
      usageCacheRead = Math.max(
        usageCacheRead,
        chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
      )
    }

    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta

    if (delta && typeof delta.content === "string" && delta.content.length > 0) {
      if (activeTextIndex == null) {
        activeTextIndex = nextIndex++
        yield makeContentBlockStart(activeTextIndex, { type: "text", text: "" })
      }
      yield makeTextDelta(activeTextIndex, delta.content)
    }

    if (delta && Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      // A tool_use block must not nest inside an open text block: close the
      // active text block before recording any tool call.
      if (activeTextIndex != null) {
        yield makeContentBlockStop(activeTextIndex)
        activeTextIndex = null
      }
      for (const tcd of delta.tool_calls) {
        if (tcd == null || typeof tcd.index !== "number") continue
        let entry = toolByIndex.get(tcd.index)
        if (!entry) {
          entry = { id: "", name: "", args: "" }
          toolByIndex.set(tcd.index, entry)
        }
        if (typeof tcd.id === "string" && tcd.id.length > 0) entry.id = tcd.id
        const name = tcd.function?.name
        if (typeof name === "string" && name.length > 0) entry.name = name
        const argDelta = tcd.function?.arguments
        if (typeof argDelta === "string" && argDelta.length > 0) entry.args += argDelta
      }
    }

    if (choice.finish_reason != null) {
      finishReason = choice.finish_reason
    }
  }

  if (!sawDone) {
    throw new Error("chat stream ended without a [DONE] sentinel (truncated)")
  }

  // Close a still-open text block, then flush the buffered tools atomically in
  // numeric provider-index order (so out-of-order deltas still emit as block
  // 0,1,2…) — each a distinct block index with its full assembled args,
  // sanitized via parseToolArgs so truncated/malformed JSON degrades to `{}`
  // (matching the non-streaming path) instead of shipping bytes an Anthropic
  // client can't JSON.parse at content_block_stop.
  if (activeTextIndex != null) {
    yield makeContentBlockStop(activeTextIndex)
  }
  let sawTool = false
  const orderedTools = [...toolByIndex.entries()].sort((a, b) => a[0] - b[0])
  for (const [, entry] of orderedTools) {
    sawTool = true
    const index = nextIndex++
    const id = entry.id.length > 0 ? entry.id : makeToolUseId()
    yield makeContentBlockStart(index, {
      type: "tool_use",
      id,
      name: entry.name,
      input: {},
    })
    yield makeInputJsonDelta(index, JSON.stringify(parseToolArgs(entry.args)))
    yield makeContentBlockStop(index)
  }

  const stopReason = chatStopReason(finishReason, sawTool)
  yield makeMessageDelta(stopReason, null, {
    input_tokens: usageIn,
    output_tokens: usageOut,
    cache_read_input_tokens: usageCacheRead,
    cache_creation_input_tokens: 0,
  })
  yield makeMessageStop()
}
