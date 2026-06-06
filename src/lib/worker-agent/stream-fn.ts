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
    const result = await createChatCompletions(
      payload,
      undefined,
      options?.signal,
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
