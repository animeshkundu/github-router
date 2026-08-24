/**
 * Shared builder that assembles an OpenAI-`/responses` request payload from a
 * small, provider-neutral message shape. Both callers of the Responses API
 * feed it:
 *
 *   - the worker-agent stream (`src/lib/worker-agent/stream-fn.ts`), converting
 *     Pi `Context` messages into the neutral shape, and
 *   - the Anthropic-translation shim (`src/lib/anthropic-translate/`), converting
 *     Anthropic Messages blocks into the neutral shape.
 *
 * Keeping the Responses field mapping in ONE place means the two callers can
 * never drift on how a tool result, an image, or the assistant text/tool-call
 * ordering is encoded on the wire. The mapping mirrors the empirically-correct
 * behaviour the worker path shipped with (input_text / input_image parts,
 * assistant text flushed before each function_call, function_call_output for
 * tool results, `reasoning.effort`).
 */

import type {
  ResponsesInputItem,
  ResponsesPayload,
  ResponsesTool,
} from "~/services/copilot/create-responses"
import {
  applyResponsesCachePolicy,
  type ResponsesCachePolicyOptions,
} from "~/lib/prompt-cache"

/**
 * Copilot's `/responses` endpoint rejects a positive `max_output_tokens` below
 * 16 with an HTTP 400 (verified live on gpt-5.5 and gpt-5.3-codex):
 *   Invalid 'max_output_tokens': integer below minimum value. Expected a value
 *   >= 16, but got 1 instead.
 * Anthropic's `/v1/messages` allows any `max_tokens >= 1`, so a valid low
 * Anthropic request (`max_tokens` 1..15) would otherwise 400 on the Responses
 * path. Clamp a positive sub-16 value UP to this minimum; leave `undefined`
 * and normal (>= 16) values EXACTLY as-is so the worker hot path and all
 * normal requests stay byte-identical. The chat path has NO such minimum
 * (gemini / `/chat/completions` accepts small values, verified HTTP 200), so
 * this clamp lives only here, never in `chat-request.ts`.
 */
const RESPONSES_MIN_MAX_OUTPUT_TOKENS = 16

/** A single piece of message content in the neutral shape. */
export type NeutralContentPart =
  | { type: "text"; text: string }
  /**
   * An image. Exactly one source is used: `url` (forwarded verbatim) OR
   * `data` (base64, wrapped into a `data:<mimeType>;base64,<data>` URI).
   * Anthropic sends both forms (`source.type` "url" | "base64"); Pi only ever
   * sends base64.
   */
  | { type: "image"; mimeType?: string; data?: string; url?: string }
  /**
   * A document (e.g. a PDF). Mirrors the `image` variant: a base64 document
   * carries `mimeType` + `data` (wrapped into a `data:<mimeType>;base64,<data>`
   * URI and emitted as a Responses `input_file`), a URL document carries `url`
   * (emitted as `input_file.file_url`); `filename` is the document title. An
   * Anthropic `document` block with a `text`/`content` source is folded into a
   * `text` part at parse time and never reaches this variant. Only the
   * Anthropic-translation shim produces documents; Pi (the worker path) never
   * does, so a worker payload is unaffected.
   */
  | { type: "document"; mimeType?: string; data?: string; url?: string; filename?: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }

/** A neutral message. Tool results are their own role (as in the Pi shape and
 *  the Responses wire shape), NOT nested inside a user message. */
export type NeutralMessage =
  | { role: "user"; content: string | Array<NeutralContentPart> }
  | { role: "assistant"; content: Array<NeutralContentPart> }
  | { role: "toolResult"; toolCallId: string; output: string }

export interface NeutralTool {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface AssembleResponsesOptions {
  model: string
  instructions?: string
  /** Volatile system material that must remain after the stable prefix. */
  dynamicInstructions?: string
  messages: ReadonlyArray<NeutralMessage>
  tools?: ReadonlyArray<NeutralTool>
  /**
   * Responses `tool_choice`. Defaults to "auto" when tools are present and
   * this is omitted (matches the worker path). Ignored when there are no
   * tools.
   */
  toolChoice?: ResponsesPayload["tool_choice"]
  /** "off"/undefined drops the `reasoning` field; anything else sets `reasoning.effort`. */
  reasoningEffort?: string
  maxOutputTokens?: number
  /**
   * Anthropic `stop_sequences` → Responses `stop` (Copilot accepts it, verified
   * live). Optional and omitted-by-default: the worker hot path never passes it,
   * so a worker payload is byte-identical to before.
   */
  stopSequences?: ReadonlyArray<string>
  /**
   * Anthropic `tool_choice.disable_parallel_tool_use` → Responses
   * `parallel_tool_calls: false`. Only ever `false` (the disable signal);
   * omitted-by-default so the worker hot path is unaffected.
   */
  parallelToolCalls?: false
  /** Router-owned policy only; public passthrough callers omit this. */
  cachePolicy?: ResponsesCachePolicyOptions
  stream: boolean
}

/** Build the `data:` URI (base64) or return the verbatim URL for an image part. */
function imageUrlFor(part: Extract<NeutralContentPart, { type: "image" }>): string {
  if (typeof part.url === "string" && part.url.length > 0) return part.url
  const mime = part.mimeType ?? "image/png"
  return `data:${mime};base64,${part.data ?? ""}`
}

/**
 * Map a document part to a Responses `input_file` item. A base64 document is
 * wrapped into a `data:<mime>;base64,<data>` `file_data` URI (the verified-working
 * Copilot shape — gpt-5.5 reads it); a URL document carries `file_url`. Returns
 * null when neither source is present (malformed) so it's dropped, not emitted
 * as an invalid item.
 */
function documentInputFile(
  part: Extract<NeutralContentPart, { type: "document" }>,
): Record<string, unknown> | null {
  const filename = part.filename ?? "document.pdf"
  if (typeof part.data === "string" && part.data.length > 0) {
    const mime = part.mimeType ?? "application/pdf"
    return { type: "input_file", filename, file_data: `data:${mime};base64,${part.data}` }
  }
  if (typeof part.url === "string" && part.url.length > 0) {
    return { type: "input_file", filename, file_url: part.url }
  }
  return null
}

function joinText(parts: ReadonlyArray<NeutralContentPart>): string {
  let s = ""
  for (const p of parts) {
    if (p.type === "text") s += p.text
  }
  return s
}

function neutralUserToResponses(
  m: Extract<NeutralMessage, { role: "user" }>,
): Array<ResponsesInputItem> {
  if (typeof m.content === "string") {
    return [{ role: "user", content: m.content }]
  }
  // A document or image forces the structured `content` parts form (input_file
  // / input_image); a text-only turn collapses to a single string.
  const needsParts = m.content.some((c) => c.type === "image" || c.type === "document")
  if (!needsParts) {
    return [{ role: "user", content: joinText(m.content) }]
  }
  const parts: Array<Record<string, unknown>> = []
  for (const c of m.content) {
    if (c.type === "text") {
      parts.push({ type: "input_text", text: c.text })
    } else if (c.type === "image") {
      parts.push({ type: "input_image", image_url: imageUrlFor(c) })
    } else if (c.type === "document") {
      const item = documentInputFile(c)
      if (item) parts.push(item)
    }
  }
  return [{ role: "user", content: parts }]
}

function neutralAssistantToResponses(
  m: Extract<NeutralMessage, { role: "assistant" }>,
): Array<ResponsesInputItem> {
  // Preserve original text/toolCall ordering: flush the pending text buffer as
  // a message item whenever a tool call is reached, so [text, call, text, call]
  // round-trips in order rather than collapsing into one text blob + all calls.
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
  }
  flush()
  return items
}

/** Translate one neutral message into zero-or-more Responses input items. */
export function neutralMessageToResponsesInput(
  m: NeutralMessage,
): Array<ResponsesInputItem> {
  if (m.role === "user") return neutralUserToResponses(m)
  if (m.role === "assistant") return neutralAssistantToResponses(m)
  return [{ type: "function_call_output", call_id: m.toolCallId, output: m.output }]
}

export function neutralToolsToResponses(
  tools: ReadonlyArray<NeutralTool> | undefined,
): Array<ResponsesTool> | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
}

/** Assemble the full Responses payload from the neutral request shape. */
export function assembleResponsesPayload(
  opts: AssembleResponsesOptions,
): ResponsesPayload {
  const input: Array<ResponsesInputItem> = []
  if (opts.dynamicInstructions) {
    input.push({ role: "system", content: opts.dynamicInstructions })
  }
  for (const m of opts.messages) {
    for (const item of neutralMessageToResponsesInput(m)) input.push(item)
  }

  const payload: ResponsesPayload = {
    model: opts.model,
    input,
    stream: opts.stream,
  }
  if (opts.instructions) payload.instructions = opts.instructions

  const tools = neutralToolsToResponses(opts.tools)
  if (tools && tools.length > 0) {
    payload.tools = tools
    payload.tool_choice = opts.toolChoice ?? "auto"
  }

  if (opts.reasoningEffort && opts.reasoningEffort !== "off") {
    payload.reasoning = { effort: opts.reasoningEffort }
  }

  if (typeof opts.maxOutputTokens === "number" && opts.maxOutputTokens > 0) {
    // Raise a valid low Anthropic `max_tokens` (1..15) up to Copilot's minimum
    // so it doesn't 400; >= 16 passes through untouched (Math.max is a no-op).
    payload.max_output_tokens = Math.max(
      opts.maxOutputTokens,
      RESPONSES_MIN_MAX_OUTPUT_TOKENS,
    )
  }

  if (opts.stopSequences && opts.stopSequences.length > 0) {
    payload.stop = [...opts.stopSequences]
  }

  if (opts.parallelToolCalls === false) {
    payload.parallel_tool_calls = false
  }

  return opts.cachePolicy
    ? applyResponsesCachePolicy(payload, {
        ...opts.cachePolicy,
        stablePrefix: opts.cachePolicy.stablePrefix ?? opts.instructions,
      })
    : payload
}
