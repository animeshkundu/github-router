/**
 * Custom Pi `StreamFn` that routes all worker-agent LLM traffic through the
 * proxy's existing `createChatCompletions` to Copilot.
 *
 * Contract (per `@earendil-works/pi-ai` `StreamFunction` documentation):
 *   - Never throws. Never returns a rejected promise.
 *   - Errors (payload-build, fetch reject, HTTPError, mid-stream reject) are
 *     encoded as a terminal `error` event with stopReason "error" or
 *     "aborted" plus a populated `errorMessage` field.
 *
 * Event ordering follows the spec: `start` (always first) → progressive
 * `text_*` / `toolcall_*` events → terminal `done` or `error`.
 *
 * Event-shape note: this module follows the *vendored* Pi source as the
 * authoritative truth (see `src/vendor/pi/ai/types.ts:347-359`). Some prior
 * design drafts referenced `message_start` / `content_delta` / `message_end`
 * — those names belong to a higher-level agent-loop emission, not to this
 * stream protocol.
 */

import type {
  Api,
  AssistantMessage,
  Context,
  Message as PiMessage,
  Model,
  Provider,
  SimpleStreamOptions,
  StopReason,
  TextContent,
  ThinkingContent,
  Tool as PiTool,
  ToolCall as PiToolCall,
  Usage,
} from "@earendil-works/pi-ai"
// Note: import the class from the deeper module path because `pi-ai`'s
// barrel re-exports `AssistantMessageEventStream` as a type-only alias via
// `types.ts`, which `verbatimModuleSyntax` then refuses to treat as a value.
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream.ts"
import type { StreamFn } from "@earendil-works/pi-agent-core"

import { HTTPError } from "~/lib/error"
import type {
  ChatCompletionChunk,
  ChatCompletionsPayload,
  ContentPart,
  Message as OAIMessage,
  Tool as OAITool,
  ToolCall as OAIToolCall,
} from "~/services/copilot/create-chat-completions"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import {
  createResponses,
} from "~/services/copilot/create-responses"
import type {
  ResponsesInputItem,
  ResponsesPayload,
  ResponsesTool,
} from "~/services/copilot/create-responses"
import { endpointForModelId } from "~/services/copilot/endpoint"

import { type ContextBudget, IMAGE_BYTES_EQUIV, tokensFromBytes } from "./context-budget"

export type ResolvedThinking =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"

/**
 * Minimum description of the model + thinking level that the worker-agent
 * engine has already validated/clamped. The engine (task #6) owns the
 * upstream type — we keep this surface narrow so this module compiles
 * standalone with no inbound dependency on sibling files.
 */
export interface ResolvedModel {
  /** Copilot catalog model id (e.g. "gemini-3.1-pro-preview"). */
  modelId: string
  /** Effective (post-clamp) thinking level. "off" drops reasoning_effort. */
  thinking: ResolvedThinking
  /** Pi Provider tag stamped on synthetic AssistantMessages. */
  provider?: Provider
  /** Pi Api tag stamped on synthetic AssistantMessages. */
  api?: Api
}

export interface CreateCopilotStreamFnOptions {
  resolved: ResolvedModel
  /**
   * Opaque per-chunk hook for the engine's budget tracker. Called for every
   * parsed `ChatCompletionChunk`. Must NOT throw — this stream's contract
   * forbids it; any exception is caught and encoded as a terminal error.
   */
  onChunk?: (chunk: ChatCompletionChunk) => void
  /**
   * Per-run context budget. When set, a request-boundary backstop estimates
   * the assembled payload BEFORE the endpoint split and, on predicted
   * overflow, stops the run with an actionable diagnostic instead of letting
   * the upstream return an opaque 413/400. The structural compactor is
   * best-effort; this is the hard correctness boundary.
   */
  contextBudget?: ContextBudget
}

export function createCopilotStreamFn(
  opts: CreateCopilotStreamFnOptions,
): StreamFn {
  return (
    _model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = new AssistantMessageEventStream()
    // Emit `start` synchronously so consumers see the prologue before any
    // async work (per Pi protocol doc).
    stream.push({ type: "start", partial: makeBaseMessage(opts.resolved) })

    void (async () => {
      try {
        await runStreamLoop(stream, context, opts, options)
      } catch (err) {
        // Defensive — runStreamLoop catches its own errors. This guards
        // against an unforeseen sync throw between the start push above
        // and the first internal await.
        pushTerminalError(stream, opts.resolved, err)
      }
    })()

    return stream
  }
}

// ----- internals -------------------------------------------------------------

interface Accumulator {
  /** Content blocks in wire order. */
  blocks: Array<BlockRecord>
  /**
   * Per-text-block append-only chunk arrays. We store the raw chunks (NOT
   * a cumulative string) so that each delta is O(1) — `push(delta)` — and
   * materialization (`chunks.join("")`) is paid ONCE per text segment at
   * `text_end` time, plus once more at `done` when assembling the final
   * message. Previously this map held cumulative strings via
   * `prev + delta.content`; that pattern is O(n²) total for n deltas under
   * the JS string-concat memory model (even when the engine optimizes
   * via cons-strings, the worst case is O(n²) flattening). Codex MEDIUM 6.
   */
  textChunksByIndex: Map<number, Array<string>>
  toolByIndex: Map<number, ToolAccum>
  usage?: ChatCompletionChunk["usage"]
  finishReason?: string
}

type BlockRecord =
  | { kind: "text"; contentIndex: number }
  | { kind: "tool"; contentIndex: number; openaiIndex: number }

interface ToolAccum {
  id: string
  name: string
  /**
   * Append-only chunks for the tool-call `arguments` JSON string. Same
   * rationale as `textChunksByIndex`: `push(delta)` is O(1); the join +
   * `JSON.parse` is paid ONCE per tool call at `toolcall_end` / `done`,
   * not on every delta. Previously this was `arguments: string` with
   * `entry.arguments += argDelta` (O(n²) total) AND a per-delta `trim() +
   * JSON.parse(entry.arguments)` inside `makePiToolCall` (also O(n²)).
   */
  argumentChunks: Array<string>
}

async function runStreamLoop(
  stream: AssistantMessageEventStream,
  context: Context,
  opts: CreateCopilotStreamFnOptions,
  options: SimpleStreamOptions | undefined,
): Promise<void> {
  const { resolved } = opts

  // Request-boundary backstop. Runs BEFORE the endpoint split so it guards
  // BOTH the chat and `/responses` paths (browse routes through `/responses`).
  // Estimates the assembled payload (system prompt + tool schemas + the
  // post-compaction wire messages) and, if it exceeds the model's input bound,
  // stops the run with an actionable diagnostic carried as assistant TEXT —
  // which the engine surfaces as an isError result — instead of letting the
  // upstream reject it with an opaque error. The structural compactor is
  // best-effort (a byte-floor estimate); this is the hard guarantee.
  if (opts.contextBudget) {
    const assembledTokens = tokensFromBytes(estimateContextBytes(context))
    if (assembledTokens > opts.contextBudget.inputHardLimitTokens) {
      pushBackstopDiagnostic(
        stream,
        resolved,
        assembledTokens,
        opts.contextBudget.inputHardLimitTokens,
      )
      return
    }
  }

  // Endpoint split: the gpt-5.x family (gpt-5.4-mini, gpt-5.5, *-codex) is
  // `/responses`-only and 400s on `/chat/completions`. Route those through
  // the parallel Responses parser; everything else keeps the chat path
  // below byte-for-byte. `endpointForModelId` consults the live catalog's
  // `supported_endpoints` (shared with the rest of the proxy).
  if (endpointForModelId(resolved.modelId) === "responses") {
    await runResponsesStreamLoop(stream, context, opts, options)
    return
  }

  let payload: ChatCompletionsPayload
  try {
    payload = buildPayload(context, resolved)
  } catch (err) {
    pushTerminalError(stream, resolved, err)
    return
  }

  // createChatCompletions throws an HTTPError on non-2xx, AND can synchronously
  // raise an AbortError if `options.signal` is already aborted at the fetch
  // boundary. Encode either as a terminal error.
  let sseStream: AsyncIterable<{ data?: string }>
  try {
    // retryTransient: true: pre-first-byte retry on a transient network/5xx
    // blip. The SSE body is iterated below, not inside createChatCompletions, so
    // a re-issue at the fetch boundary cannot duplicate already-streamed output;
    // mid-stream body errors still surface via pushTerminalError (not retried).
    const result = await createChatCompletions(
      payload,
      undefined,
      options?.signal,
      true,
    )
    if (
      result == null
      || typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator]
        !== "function"
    ) {
      throw new Error(
        "Upstream did not return an SSE stream (stream: true expected)",
      )
    }
    sseStream = result as AsyncIterable<{ data?: string }>
  } catch (err) {
    pushTerminalError(stream, resolved, err)
    return
  }

  const accum: Accumulator = {
    blocks: [],
    textChunksByIndex: new Map(),
    toolByIndex: new Map(),
  }
  let nextContentIndex = 0
  let activeTextIndex: number | null = null
  const toolPiIndexByOAI = new Map<number, number>()

  try {
    for await (const evt of sseStream) {
      const data = evt?.data
      if (data == null) continue
      if (data === "[DONE]") break

      let chunk: ChatCompletionChunk
      try {
        chunk = JSON.parse(data) as ChatCompletionChunk
      } catch {
        // Skip unparseable SSE lines — proxy is forgiving here.
        continue
      }

      try {
        opts.onChunk?.(chunk)
      } catch {
        // onChunk MUST NOT break the stream — swallow.
      }

      if (chunk.usage) accum.usage = chunk.usage

      const choice = chunk.choices?.[0]
      if (!choice) {
        // Some prelude / terminal chunks carry only usage / id with no choices.
        continue
      }
      const delta = choice.delta ?? {}

      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (activeTextIndex == null) {
          activeTextIndex = nextContentIndex++
          accum.blocks.push({ kind: "text", contentIndex: activeTextIndex })
          accum.textChunksByIndex.set(activeTextIndex, [])
          stream.push({
            type: "text_start",
            contentIndex: activeTextIndex,
            partial: buildPartial(resolved, accum),
          })
        }
        // O(1) push. The cumulative text is materialized lazily in the
        // `partial` snapshot via `makeLazyTextPart` and eagerly exactly
        // once on `text_end` / `done`.
        const chunks = accum.textChunksByIndex.get(activeTextIndex)!
        chunks.push(delta.content)
        stream.push({
          type: "text_delta",
          contentIndex: activeTextIndex,
          delta: delta.content,
          partial: buildPartial(resolved, accum),
        })
      }

      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        // Close the active text block before opening any tool calls.
        if (activeTextIndex != null) {
          stream.push({
            type: "text_end",
            contentIndex: activeTextIndex,
            content: joinTextChunks(accum, activeTextIndex),
            partial: buildPartial(resolved, accum),
          })
          activeTextIndex = null
        }

        for (const tcd of delta.tool_calls) {
          if (tcd == null || tcd.index == null) continue
          let piIdx = toolPiIndexByOAI.get(tcd.index)
          if (piIdx == null) {
            piIdx = nextContentIndex++
            toolPiIndexByOAI.set(tcd.index, piIdx)
            accum.blocks.push({
              kind: "tool",
              contentIndex: piIdx,
              openaiIndex: tcd.index,
            })
            accum.toolByIndex.set(piIdx, {
              id: "",
              name: "",
              argumentChunks: [],
            })
            stream.push({
              type: "toolcall_start",
              contentIndex: piIdx,
              partial: buildPartial(resolved, accum),
            })
          }
          const entry = accum.toolByIndex.get(piIdx)
          if (!entry) continue
          if (tcd.id) entry.id = tcd.id
          if (tcd.function?.name) entry.name = tcd.function.name
          const argDelta = tcd.function?.arguments
          if (typeof argDelta === "string" && argDelta.length > 0) {
            // O(1) push; one-shot join + parse happens in `makePiToolCall`
            // on `toolcall_end` / final-message assembly.
            entry.argumentChunks.push(argDelta)
            stream.push({
              type: "toolcall_delta",
              contentIndex: piIdx,
              delta: argDelta,
              partial: buildPartial(resolved, accum),
            })
          }
        }
      }

      if (choice.finish_reason) {
        accum.finishReason = choice.finish_reason
      }
    }
  } catch (err) {
    pushTerminalError(stream, resolved, err)
    return
  }

  // Close any still-open text block.
  if (activeTextIndex != null) {
    stream.push({
      type: "text_end",
      contentIndex: activeTextIndex,
      content: joinTextChunks(accum, activeTextIndex),
      partial: buildPartial(resolved, accum),
    })
    activeTextIndex = null
  }

  // Emit `toolcall_end` for each accumulated tool call in wire order.
  for (const block of accum.blocks) {
    if (block.kind !== "tool") continue
    const entry = accum.toolByIndex.get(block.contentIndex)
    if (!entry) continue
    stream.push({
      type: "toolcall_end",
      contentIndex: block.contentIndex,
      toolCall: makePiToolCall(entry),
      partial: buildPartial(resolved, accum),
    })
  }

  const finalMessage = buildFinalMessage(resolved, accum)
  const reason = mapFinishReason(accum.finishReason)
  stream.push({ type: "done", reason, message: finalMessage })
}

// ----- payload construction --------------------------------------------------

function buildPayload(
  context: Context,
  resolved: ResolvedModel,
): ChatCompletionsPayload {
  const messages: Array<OAIMessage> = []
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt })
  }
  for (const m of context.messages) {
    const oai = translateMessage(m)
    if (oai) messages.push(oai)
  }

  const tools = translateTools(context.tools)
  const payload: ChatCompletionsPayload = {
    model: resolved.modelId,
    messages,
    stream: true,
  }
  if (tools && tools.length > 0) {
    payload.tools = tools
    payload.tool_choice = "auto"
  }
  if (resolved.thinking !== "off") {
    payload.reasoning_effort = resolved.thinking
  }
  return payload
}

function translateMessage(m: PiMessage): OAIMessage | null {
  if (m.role === "user") return translateUser(m)
  if (m.role === "assistant") return translateAssistant(m)
  if (m.role === "toolResult") return translateToolResult(m)
  return null
}

function translateUser(
  m: Extract<PiMessage, { role: "user" }>,
): OAIMessage {
  if (typeof m.content === "string") return { role: "user", content: m.content }
  const hasImage = m.content.some((c) => c.type === "image")
  if (!hasImage) {
    return { role: "user", content: joinTextParts(m.content) }
  }
  const parts: Array<ContentPart> = []
  for (const c of m.content) {
    if (c.type === "text") {
      parts.push({ type: "text", text: c.text })
    } else if (c.type === "image") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${c.mimeType};base64,${c.data}` },
      })
    }
  }
  return { role: "user", content: parts }
}

function translateAssistant(
  m: Extract<PiMessage, { role: "assistant" }>,
): OAIMessage {
  const text = joinAssistantText(m.content)
  const toolCalls: Array<OAIToolCall> = []
  for (const c of m.content) {
    if (c.type === "toolCall") {
      toolCalls.push({
        id: c.id,
        type: "function",
        function: {
          name: c.name,
          arguments: JSON.stringify(c.arguments ?? {}),
        },
      })
    }
  }
  const out: OAIMessage = {
    role: "assistant",
    content: text.length > 0 ? text : null,
  }
  if (toolCalls.length > 0) out.tool_calls = toolCalls
  return out
}

function translateToolResult(
  m: Extract<PiMessage, { role: "toolResult" }>,
): OAIMessage {
  return {
    role: "tool",
    tool_call_id: m.toolCallId,
    content: joinTextParts(m.content),
  }
}

function translateTools(
  tools: ReadonlyArray<PiTool> | undefined,
): Array<OAITool> | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    },
  }))
}

function joinTextParts(
  parts: ReadonlyArray<{ type: string; text?: string }>,
): string {
  let s = ""
  for (const p of parts) {
    if (p.type === "text" && typeof p.text === "string") s += p.text
  }
  return s
}

function joinAssistantText(
  parts: ReadonlyArray<TextContent | ThinkingContent | PiToolCall>,
): string {
  let s = ""
  for (const p of parts) {
    if (p.type === "text") s += p.text
    // thinking + toolCall parts are intentionally dropped — Copilot
    // doesn't accept thinking parts as input, and tool_calls go on the
    // top-level `tool_calls` field instead.
  }
  return s
}

// ----- /responses streaming path ---------------------------------------------

/**
 * Shape of the `/responses` streaming SSE events we consume. Captured
 * empirically against gpt-5.4-mini (forced-tool + plain-text turns):
 *   response.created / response.in_progress      — prologue (ignored)
 *   response.output_item.added {item.type:reasoning}   — ignored
 *   response.output_item.added {item.type:message}     — text block opens
 *   response.content_part.added                  — ignored (text via deltas)
 *   response.output_text.delta {delta}           — text delta
 *   response.output_text.done {text}             — text block closes
 *   response.output_item.added {item.type:function_call, name, call_id, id} — tool starts
 *   response.function_call_arguments.delta {delta, item_id}  — arg delta
 *   response.function_call_arguments.done {arguments, item_id} — full args
 *   response.output_item.done {item:function_call}  — tool item closes
 *   response.completed {response.status, usage}  — terminal (no [DONE])
 * Arg-delta events key off the item's opaque `id` (`item_id`), NOT the
 * `call_id`; we map id→pi-index at `output_item.added` time.
 */
interface ResponsesSseEvent {
  type?: string
  /**
   * STABLE per-output-item index (reasoning=0, first function_call=1, …).
   * Constant across output_item.added → arg deltas → arg done →
   * output_item.done for ONE item — UNLIKE `item.id`/`item_id`, which Copilot
   * re-encrypts on every event (verified live: 10 arg-deltas, 10 distinct
   * item_ids, 1 output_index). This is the load-bearing key for the tool map;
   * keying off the per-event id makes every delta lookup miss → args stay
   * empty → the tool runs with {} → the model loops forever.
   */
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
  }
  response?: {
    status?: string
    usage?: ResponsesUsage
    incomplete_details?: { reason?: string }
    error?: { message?: string }
  }
}

/**
 * The stable map key for a /responses output item: prefer `output_index`
 * (constant per item); fall back to the opaque id only when output_index is
 * absent (older/alt upstreams). Namespaced so a numeric index and a string id
 * can never collide.
 */
function responsesToolKey(
  outputIndex: number | undefined,
  fallbackId: string | undefined,
): string | undefined {
  if (typeof outputIndex === "number") return `oi:${outputIndex}`
  if (typeof fallbackId === "string" && fallbackId.length > 0) return `id:${fallbackId}`
  return undefined
}

interface ResponsesUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
}

function mapResponsesUsage(
  u: ResponsesUsage | undefined,
): ChatCompletionChunk["usage"] | undefined {
  if (!u) return undefined
  return {
    prompt_tokens: u.input_tokens ?? 0,
    completion_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
    prompt_tokens_details:
      u.input_tokens_details?.cached_tokens != null
        ? { cached_tokens: u.input_tokens_details.cached_tokens }
        : undefined,
  }
}

/**
 * The Responses-API analogue of `runStreamLoop`'s chat body. Builds a
 * `ResponsesPayload`, streams `/responses`, and emits the SAME Pi
 * `AssistantMessageEventStream` protocol (start already pushed by the
 * caller, then text / toolcall events, then done/error). Reuses the chat
 * path's `Accumulator` + final-message helpers so the produced
 * AssistantMessage is structurally identical regardless of endpoint.
 */
async function runResponsesStreamLoop(
  stream: AssistantMessageEventStream,
  context: Context,
  opts: CreateCopilotStreamFnOptions,
  options: SimpleStreamOptions | undefined,
): Promise<void> {
  const { resolved } = opts

  let payload: ResponsesPayload
  try {
    payload = buildResponsesPayload(context, resolved)
  } catch (err) {
    pushTerminalError(stream, resolved, err)
    return
  }

  let sseStream: AsyncIterable<{ data?: string }>
  try {
    // retryTransient: true: pre-first-byte retry; SSE body is iterated below
    // (not inside createResponses), so a fetch-boundary re-issue can't duplicate
    // streamed output. Mid-stream errors still surface via pushTerminalError.
    const result = await createResponses(payload, undefined, options?.signal, true)
    if (
      result == null
      || typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator]
        !== "function"
    ) {
      throw new Error(
        "Upstream did not return an SSE stream (stream: true expected)",
      )
    }
    sseStream = result as AsyncIterable<{ data?: string }>
  } catch (err) {
    pushTerminalError(stream, resolved, err)
    return
  }

  const accum: Accumulator = {
    blocks: [],
    textChunksByIndex: new Map(),
    toolByIndex: new Map(),
  }
  let nextContentIndex = 0
  let activeTextIndex: number | null = null
  // Keyed by `responsesToolKey` (output_index-first), NOT the per-event
  // item.id/item_id — Copilot re-encrypts those every event, so an id key
  // makes every delta/done lookup miss and tool args drop to {}.
  const toolPiIndexByKey = new Map<string, number>()
  // Tool items already closed with a `toolcall_end` at their per-item
  // `output_item.done`. The post-loop sweep skips these and only ends
  // tool calls the stream left dangling (no done event).
  const closedToolItems = new Set<number>()

  const closeActiveText = (): void => {
    if (activeTextIndex == null) return
    stream.push({
      type: "text_end",
      contentIndex: activeTextIndex,
      content: joinTextChunks(accum, activeTextIndex),
      partial: buildPartial(resolved, accum),
    })
    activeTextIndex = null
  }

  try {
    for await (const evt of sseStream) {
      const data = evt?.data
      if (data == null) continue
      if (data === "[DONE]") break // not emitted by /responses, but harmless

      let ev: ResponsesSseEvent
      try {
        ev = JSON.parse(data) as ResponsesSseEvent
      } catch {
        continue
      }

      switch (ev.type) {
        case "response.output_text.delta": {
          const delta = ev.delta
          if (typeof delta !== "string" || delta.length === 0) break
          if (activeTextIndex == null) {
            activeTextIndex = nextContentIndex++
            accum.blocks.push({ kind: "text", contentIndex: activeTextIndex })
            accum.textChunksByIndex.set(activeTextIndex, [])
            stream.push({
              type: "text_start",
              contentIndex: activeTextIndex,
              partial: buildPartial(resolved, accum),
            })
          }
          accum.textChunksByIndex.get(activeTextIndex)!.push(delta)
          stream.push({
            type: "text_delta",
            contentIndex: activeTextIndex,
            delta,
            partial: buildPartial(resolved, accum),
          })
          break
        }

        case "response.output_text.done": {
          // Normally the block is already open from deltas. Guard the
          // no-delta case (a `done` carrying the full text with no prior
          // deltas) so the text isn't silently lost.
          if (
            activeTextIndex == null
            && typeof ev.text === "string"
            && ev.text.length > 0
          ) {
            activeTextIndex = nextContentIndex++
            accum.blocks.push({ kind: "text", contentIndex: activeTextIndex })
            accum.textChunksByIndex.set(activeTextIndex, [])
            stream.push({
              type: "text_start",
              contentIndex: activeTextIndex,
              partial: buildPartial(resolved, accum),
            })
            accum.textChunksByIndex.get(activeTextIndex)!.push(ev.text)
            stream.push({
              type: "text_delta",
              contentIndex: activeTextIndex,
              delta: ev.text,
              partial: buildPartial(resolved, accum),
            })
          }
          closeActiveText()
          break
        }

        case "response.output_item.added": {
          const item = ev.item
          if (item?.type !== "function_call") break
          // Key off the STABLE output_index (fall back to the opaque id only
          // when absent). The live id is re-encrypted per event.
          const key = responsesToolKey(ev.output_index, item.id)
          if (key == null) break
          // Dedup: a duplicate `added` for the same item would otherwise
          // remap its pi-index → a second toolcall_start + a dangling end.
          if (toolPiIndexByKey.has(key)) break
          // A tool call supersedes any open text block.
          closeActiveText()
          const piIdx = nextContentIndex++
          toolPiIndexByKey.set(key, piIdx)
          accum.blocks.push({
            kind: "tool",
            contentIndex: piIdx,
            openaiIndex: piIdx,
          })
          accum.toolByIndex.set(piIdx, {
            id: item.call_id ?? item.id ?? key,
            name: item.name ?? "",
            argumentChunks: [],
          })
          stream.push({
            type: "toolcall_start",
            contentIndex: piIdx,
            partial: buildPartial(resolved, accum),
          })
          break
        }

        case "response.function_call_arguments.delta": {
          // Look up by output_index-first key (deltas carry a re-encrypted
          // item_id that never matches what output_item.added recorded).
          const key = responsesToolKey(ev.output_index, ev.item_id)
          if (key == null) break
          const piIdx = toolPiIndexByKey.get(key)
          if (piIdx == null) break
          const entry = accum.toolByIndex.get(piIdx)
          if (!entry) break
          const delta = ev.delta
          if (typeof delta !== "string" || delta.length === 0) break
          entry.argumentChunks.push(delta)
          stream.push({
            type: "toolcall_delta",
            contentIndex: piIdx,
            delta,
            partial: buildPartial(resolved, accum),
          })
          break
        }

        case "response.function_call_arguments.done": {
          // The `.done` event carries the AUTHORITATIVE full args string.
          // OVERWRITE (not a length-gated append): if the delta stream was
          // corrupted/partial, the accumulated chunks would be invalid JSON
          // that makePiToolCall parses to {} — the tool then runs with EMPTY
          // args (a no-op) and the model repeats the call forever. The full
          // `.done` string supersedes whatever the deltas left.
          const key = responsesToolKey(ev.output_index, ev.item_id)
          if (key == null) break
          const piIdx = toolPiIndexByKey.get(key)
          if (piIdx == null) break
          const entry = accum.toolByIndex.get(piIdx)
          if (entry && typeof ev.arguments === "string") {
            entry.argumentChunks = [ev.arguments]
          }
          break
        }

        case "response.output_item.done": {
          // Authoritative final view of the function_call item: backfill
          // name / call_id / args if the streaming deltas missed anything,
          // then close the tool call HERE (the Responses API gives a clean
          // per-item completion signal, so we don't defer to stream end —
          // that keeps lifecycle order correct when a later item follows).
          const item = ev.item
          if (item?.type !== "function_call") break
          const key = responsesToolKey(ev.output_index, item.id)
          if (key == null) break
          const piIdx = toolPiIndexByKey.get(key)
          if (piIdx == null) break
          const entry = accum.toolByIndex.get(piIdx)
          if (!entry) break
          if (item.call_id) entry.id = item.call_id
          if (item.name) entry.name = item.name
          if (typeof item.arguments === "string") {
            // Authoritative full args — overwrite any partial delta stream
            // (same rationale as function_call_arguments.done above).
            entry.argumentChunks = [item.arguments]
          }
          stream.push({
            type: "toolcall_end",
            contentIndex: piIdx,
            toolCall: makePiToolCall(entry),
            partial: buildPartial(resolved, accum),
          })
          closedToolItems.add(piIdx)
          break
        }

        case "response.completed":
        case "response.incomplete": {
          accum.usage = mapResponsesUsage(ev.response?.usage)
          if (
            ev.type === "response.incomplete"
            && ev.response?.incomplete_details?.reason === "max_output_tokens"
          ) {
            accum.finishReason = "length"
          }
          if (opts.onChunk && accum.usage) {
            try {
              opts.onChunk({
                id: "",
                object: "chat.completion.chunk",
                created: 0,
                model: resolved.modelId,
                choices: [],
                usage: accum.usage,
              })
            } catch {
              // onChunk MUST NOT break the stream — swallow.
            }
          }
          break
        }

        case "response.failed": {
          closeActiveText()
          pushTerminalError(
            stream,
            resolved,
            new Error(ev.response?.error?.message ?? "response.failed"),
          )
          return
        }

        default:
          // response.created / in_progress / content_part.* / reasoning
          // items / unknown events: nothing to emit.
          break
      }
    }
  } catch (err) {
    pushTerminalError(stream, resolved, err)
    return
  }

  // Close any still-open text block (defensive — output_text.done should
  // have fired).
  closeActiveText()

  // Fallback: emit toolcall_end for any tool call the stream left
  // dangling (no `response.output_item.done`). Calls already closed
  // inline above are skipped to avoid a duplicate end event.
  for (const block of accum.blocks) {
    if (block.kind !== "tool") continue
    if (closedToolItems.has(block.contentIndex)) continue
    const entry = accum.toolByIndex.get(block.contentIndex)
    if (!entry) continue
    stream.push({
      type: "toolcall_end",
      contentIndex: block.contentIndex,
      toolCall: makePiToolCall(entry),
      partial: buildPartial(resolved, accum),
    })
  }

  // Finish reason: tool calls → toolUse, max-tokens → length (set above),
  // else stop. `mapFinishReason` maps the chat vocabulary we reuse here.
  if (accum.finishReason == null) {
    accum.finishReason = accum.blocks.some((b) => b.kind === "tool")
      ? "tool_calls"
      : "stop"
  }
  const finalMessage = buildFinalMessage(resolved, accum)
  const reason = mapFinishReason(accum.finishReason)
  stream.push({ type: "done", reason, message: finalMessage })
}

// ----- /responses payload construction ---------------------------------------

function buildResponsesPayload(
  context: Context,
  resolved: ResolvedModel,
): ResponsesPayload {
  const input: Array<ResponsesInputItem> = []
  for (const m of context.messages) {
    for (const item of translateMessageToResponses(m)) input.push(item)
  }

  const payload: ResponsesPayload = {
    model: resolved.modelId,
    input,
    stream: true,
  }
  if (context.systemPrompt) payload.instructions = context.systemPrompt
  const tools = translateToolsToResponses(context.tools)
  if (tools && tools.length > 0) {
    payload.tools = tools
    payload.tool_choice = "auto"
  }
  if (resolved.thinking !== "off") {
    payload.reasoning = { effort: resolved.thinking }
  }
  return payload
}

function translateMessageToResponses(m: PiMessage): Array<ResponsesInputItem> {
  if (m.role === "user") return translateUserToResponses(m)
  if (m.role === "assistant") return translateAssistantToResponses(m)
  if (m.role === "toolResult") {
    return [
      {
        type: "function_call_output",
        call_id: m.toolCallId,
        output: joinTextParts(m.content),
      },
    ]
  }
  return []
}

function translateUserToResponses(
  m: Extract<PiMessage, { role: "user" }>,
): Array<ResponsesInputItem> {
  if (typeof m.content === "string") {
    return [{ role: "user", content: m.content }]
  }
  const hasImage = m.content.some((c) => c.type === "image")
  if (!hasImage) {
    return [{ role: "user", content: joinTextParts(m.content) }]
  }
  const parts: Array<Record<string, unknown>> = []
  for (const c of m.content) {
    if (c.type === "text") {
      parts.push({ type: "input_text", text: c.text })
    } else if (c.type === "image") {
      parts.push({
        type: "input_image",
        image_url: `data:${c.mimeType};base64,${c.data}`,
      })
    }
  }
  return [{ role: "user", content: parts }]
}

function translateAssistantToResponses(
  m: Extract<PiMessage, { role: "assistant" }>,
): Array<ResponsesInputItem> {
  // Preserve the original text/toolCall ordering: flush the pending text
  // buffer as a message item whenever a tool call is reached, so an
  // assistant turn like [text, call, text, call] round-trips in order
  // instead of collapsing into one text blob followed by all calls.
  const items: Array<ResponsesInputItem> = []
  let buffer = ""
  const flush = (): void => {
    if (buffer.length === 0) return
    items.push({ role: "assistant", content: [{ type: "output_text", text: buffer }] })
    buffer = ""
  }
  for (const c of m.content) {
    if (c.type === "text") {
      buffer += c.text
    } else if (c.type === "toolCall") {
      flush()
      items.push({
        type: "function_call",
        call_id: c.id,
        name: c.name,
        arguments: JSON.stringify(c.arguments ?? {}),
      })
    }
    // thinking parts are dropped — the Responses API doesn't accept them
    // as replayed input.
  }
  flush()
  return items
}

function translateToolsToResponses(
  tools: ReadonlyArray<PiTool> | undefined,
): Array<ResponsesTool> | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters as unknown as Record<string, unknown>,
  }))
}

// ----- message + event helpers -----------------------------------------------

function makeBaseMessage(resolved: ResolvedModel): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: resolved.api ?? "openai-completions",
    provider: resolved.provider ?? "github-copilot",
    model: resolved.modelId,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  }
}

function buildPartial(
  resolved: ResolvedModel,
  accum: Accumulator,
): AssistantMessage {
  return {
    ...makeBaseMessage(resolved),
    content: collectContent(accum, { final: false }),
    usage: deriveUsage(accum.usage),
  }
}

function buildFinalMessage(
  resolved: ResolvedModel,
  accum: Accumulator,
): AssistantMessage {
  return {
    ...makeBaseMessage(resolved),
    content: collectContent(accum, { final: true }),
    usage: deriveUsage(accum.usage),
    stopReason: mapFinishReasonToStop(accum.finishReason),
  }
}

/**
 * O(1)-amortized cumulative-text accessor used at event boundaries
 * (text_end / done). The chunk array is append-only; one `join("")` per
 * call costs O(n) where n is the chunk count for that text segment.
 *
 * The function is also used internally by `collectContent` on the eager
 * (`final: true`) path so there's exactly one join site per text segment.
 */
function joinTextChunks(accum: Accumulator, idx: number): string {
  const chunks = accum.textChunksByIndex.get(idx)
  return chunks ? chunks.join("") : ""
}

/**
 * Snapshot-safe lazy text part. The `.text` getter captures
 * `chunks.length` at construction time, so the visible value matches the
 * snapshot even if the underlying chunks array continues to grow after
 * this part is created. Materialization is deferred to the first `.text`
 * read and cached thereafter.
 *
 * This is the load-bearing piece of the O(n²) → O(n) fix: per-delta
 * `buildPartial` calls now do O(1) work (one `Array#push` already done by
 * the caller, plus one lazy-part construction with a length snapshot)
 * instead of cumulative `prev + delta` string concatenation. The actual
 * join is only paid if a consumer reads `.text` on that specific partial.
 * The worker engine only subscribes to `message_end`, so partial-text
 * reads do not happen on the hot path in production.
 */
function makeLazyTextPart(chunks: ReadonlyArray<string>): TextContent {
  const upTo = chunks.length
  let cached: string | undefined
  return {
    type: "text",
    get text(): string {
      if (cached === undefined) {
        cached
          = upTo === chunks.length
            ? chunks.join("")
            : chunks.slice(0, upTo).join("")
      }
      return cached
    },
  } as TextContent
}

/**
 * Build the AssistantMessage content array.
 *
 * - `final: true` — used by `buildFinalMessage` (and transitively by the
 *   `done` event). Eagerly joins text chunks and parses tool args; the
 *   result is a plain immutable shape suitable for downstream consumers
 *   like the engine's `message_end` subscriber.
 * - `final: false` — used by `buildPartial` on every per-delta event.
 *   Text parts are lazy (see `makeLazyTextPart`); tool args are emitted
 *   as the placeholder `{}` (which matches the observable behavior of the
 *   pre-fix code, since mid-stream tool-arg JSON is typically incomplete
 *   and `JSON.parse` would fall back to `{}` anyway). Consumers that need
 *   final parsed args listen for `toolcall_end` / `done`.
 */
function collectContent(
  accum: Accumulator,
  opts: { final: boolean },
): AssistantMessage["content"] {
  const parts: AssistantMessage["content"] = []
  for (const block of accum.blocks) {
    if (block.kind === "text") {
      const chunks = accum.textChunksByIndex.get(block.contentIndex) ?? []
      parts.push(
        opts.final
          ? { type: "text", text: chunks.join("") }
          : makeLazyTextPart(chunks),
      )
    } else {
      const entry = accum.toolByIndex.get(block.contentIndex)
      if (!entry) continue
      if (opts.final) {
        parts.push(makePiToolCall(entry))
      } else {
        parts.push({
          type: "toolCall",
          id: entry.id,
          name: entry.name,
          arguments: {},
        })
      }
    }
  }
  return parts
}

function makePiToolCall(entry: ToolAccum): PiToolCall {
  // Eager join + parse — both O(n) in the chunk count for this tool call.
  // Previously this code path executed once per delta via collectContent's
  // partial branch, which combined with `entry.arguments += delta` was
  // O(n²) for both the concat AND the per-delta JSON.parse retry. After
  // the refactor, this runs ONLY at toolcall_end / final-message assembly,
  // so total work is O(n) per tool call.
  let args: Record<string, unknown> = {}
  const joined = entry.argumentChunks.join("")
  if (joined.trim().length > 0) {
    try {
      const parsed = JSON.parse(joined) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>
      }
    } catch {
      // Pi's `validateToolArguments` will surface the malformed-args case
      // to the model on the next turn — keep args empty here.
      args = {}
    }
  }
  return {
    type: "toolCall",
    id: entry.id,
    name: entry.name,
    arguments: args,
  }
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function deriveUsage(u: ChatCompletionChunk["usage"] | undefined): Usage {
  if (!u) return emptyUsage()
  return {
    input: u.prompt_tokens ?? 0,
    output: u.completion_tokens ?? 0,
    cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWrite: 0,
    totalTokens: u.total_tokens ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function mapFinishReason(
  reason: string | undefined,
): "stop" | "length" | "toolUse" {
  if (reason === "length") return "length"
  if (reason === "tool_calls") return "toolUse"
  return "stop"
}

function mapFinishReasonToStop(reason: string | undefined): StopReason {
  if (reason === "length") return "length"
  if (reason === "tool_calls") return "toolUse"
  return "stop"
}

function pushTerminalError(
  stream: AssistantMessageEventStream,
  resolved: ResolvedModel,
  err: unknown,
): void {
  const aborted = isAbortError(err)
  const reason: Extract<StopReason, "aborted" | "error"> = aborted
    ? "aborted"
    : "error"
  const errorMessage = describeError(err)
  const final: AssistantMessage = {
    ...makeBaseMessage(resolved),
    content: [],
    stopReason: reason,
    errorMessage,
  }
  stream.push({ type: "error", reason, error: final })
}

/**
 * Estimate the assembled request's byte size for the request-boundary backstop
 * — system prompt + tool schemas + wire messages — counting any image part at
 * a fixed token-equivalent (`IMAGE_BYTES_EQUIV`) rather than its base64 byte
 * length. A vision image costs ~1.5k tokens regardless of base64 size, so
 * counting the raw base64 (as a naive `JSON.stringify` would) over-estimates
 * by ~45× and false-positives the backstop on any screenshot. Counting text
 * parts by their bytes keeps it consistent with the compactor. Never throws.
 */
function estimateContextBytes(context: Context): number {
  let bytes = Buffer.byteLength(context.systemPrompt ?? "", "utf8")
  try {
    bytes += Buffer.byteLength(JSON.stringify(context.tools ?? []), "utf8")
  } catch {
    /* tool schemas are bounded + base64-free; a stringify failure is non-fatal */
  }
  for (const m of context.messages ?? []) {
    bytes += messageWireBytes(m)
  }
  return bytes
}

/** Bytes of one wire message: text content + per-image equivalent + bulk fields. */
function messageWireBytes(m: unknown): number {
  if (!m || typeof m !== "object") return 0
  const mo = m as Record<string, unknown>
  let b = 0
  const content = mo.content
  if (typeof content === "string") {
    b += Buffer.byteLength(content, "utf8")
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue
      const p = part as { type?: unknown; text?: unknown; refusal?: unknown }
      if (typeof p.text === "string") b += Buffer.byteLength(p.text, "utf8")
      else if (typeof p.refusal === "string") b += Buffer.byteLength(p.refusal, "utf8")
      else if (typeof p.type === "string" && p.type.includes("image")) {
        // image part (image / image_url / input_image) — DON'T count the base64
        b += IMAGE_BYTES_EQUIV
      }
    }
  }
  // Bulk text also lives in top-level fields on some wire shapes — chat
  // `tool_calls`, /responses `function_call.arguments` / `function_call_output.output`,
  // chat `refusal`. Count them so a large payload can't slip past the backstop
  // as ~0 bytes (an UNDER-count is the dangerous direction — it would let a real
  // overflow reach the upstream as a 400). These fields carry no base64.
  const toolCalls = mo.tool_calls
  if (Array.isArray(toolCalls)) {
    for (const t of toolCalls) b += fieldBytes(t)
  }
  b += fieldBytes(mo.arguments) + fieldBytes(mo.output) + fieldBytes(mo.refusal)
  return b
}

/** UTF-8 bytes of a string, or of the JSON of an object; 0 otherwise. */
function fieldBytes(v: unknown): number {
  if (typeof v === "string") return Buffer.byteLength(v, "utf8")
  if (v && typeof v === "object") {
    try {
      return Buffer.byteLength(JSON.stringify(v), "utf8")
    } catch {
      return 0
    }
  }
  return 0
}

/**
 * Emit a terminal diagnostic when the assembled request would overflow the
 * model's input bound. Carries the actionable message as assistant TEXT (so
 * the engine's `finalText` capture surfaces it) with stopReason "error" (so
 * the engine marks the result isError). No upstream call is made — this
 * replaces an opaque upstream 4xx with an actionable, sanitized message.
 */
function pushBackstopDiagnostic(
  stream: AssistantMessageEventStream,
  resolved: ResolvedModel,
  assembledTokens: number,
  limitTokens: number,
): void {
  const text =
    `Request too large: the assembled input is ~${assembledTokens} tokens, over `
    + `the ~${limitTokens}-token budget for ${resolved.modelId}. The run was `
    + "stopped before an overflow error. Retry with a narrower task — target a "
    + "specific section / file / element rather than reading everything at once."
  const final: AssistantMessage = {
    ...makeBaseMessage(resolved),
    content: [{ type: "text", text }],
    stopReason: "error",
    errorMessage: "context budget exceeded (request-boundary backstop)",
  }
  stream.push({ type: "error", reason: "error", error: final })
}

function describeError(err: unknown): string {
  if (err instanceof HTTPError) {
    return `${err.message} (status ${err.response.status})`
  }
  if (err instanceof Error) return err.message
  return String(err)
}

function isAbortError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false
  const name = (err as { name?: unknown }).name
  if (
    typeof name === "string"
    && (name === "AbortError" || name === "TimeoutError")
  ) {
    return true
  }
  const code = (err as { code?: unknown }).code
  if (typeof code === "string" && code === "ABORT_ERR") return true
  return false
}

/** Test-only internals. */
export const __testExports = {
  estimateContextBytes,
}
