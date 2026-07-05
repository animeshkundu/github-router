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
  stream: boolean
}

/** Build the `data:` URI (base64) or return the verbatim URL for an image part. */
function imageUrlFor(part: Extract<NeutralContentPart, { type: "image" }>): string {
  if (typeof part.url === "string" && part.url.length > 0) return part.url
  const mime = part.mimeType ?? "image/png"
  return `data:${mime};base64,${part.data ?? ""}`
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
  const hasImage = m.content.some((c) => c.type === "image")
  if (!hasImage) {
    return [{ role: "user", content: joinText(m.content) }]
  }
  const parts: Array<Record<string, unknown>> = []
  for (const c of m.content) {
    if (c.type === "text") {
      parts.push({ type: "input_text", text: c.text })
    } else if (c.type === "image") {
      parts.push({ type: "input_image", image_url: imageUrlFor(c) })
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
    payload.max_output_tokens = opts.maxOutputTokens
  }

  if (opts.stopSequences && opts.stopSequences.length > 0) {
    payload.stop = [...opts.stopSequences]
  }

  if (opts.parallelToolCalls === false) {
    payload.parallel_tool_calls = false
  }

  return payload
}
