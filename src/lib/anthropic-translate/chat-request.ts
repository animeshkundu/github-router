/**
 * Anthropic Messages request → Copilot `/chat/completions` payload.
 *
 * The Gemini path (`gemini-3.5-flash`, `gemini-3.1-pro-preview`) is served by
 * Copilot only via the OpenAI-compatible `/chat/completions` endpoint. This
 * module assembles a `ChatCompletionsPayload` from the SAME provider-neutral
 * `ParsedAnthropicRequest` that feeds the Responses path — the neutral parse
 * (`parseAnthropicRequest`) is reused verbatim; only the wire assembly differs.
 *
 * Correspondence (neutral → chat/completions):
 *   instructions                → messages[0] {role:"system"}
 *   user text (no image)        → messages[] {role:"user", content:string}
 *   user text + image           → {role:"user", content:[{type:"text"},{type:"image_url"}]}
 *   assistant text + tool_use   → {role:"assistant", content, tool_calls[]}
 *   toolResult                  → {role:"tool", tool_call_id, content}
 *   tools[] {name,params}       → tools[] {type:"function", function:{name,description,parameters}}
 *   tool_choice {type,name}     → NESTED chat form {type:"function", function:{name}}
 *   reasoningEffort (clamped)   → reasoning_effort (already clamped at parse time)
 *   maxOutputTokens             → max_tokens
 *
 * Structured Outputs (`response_format` / `output_config.schema`) is NOT
 * emitted: neither Gemini model advertises `structured_outputs`, and the
 * neutral parse carries no structured-output info anyway (the handler strips
 * every `output_config` member EXCEPT `effort` before the shim is reached, and
 * `effort` is consumed by `parseAnthropicRequest` as the highest-precedence
 * reasoning signal).
 */

import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
  ToolCall,
} from "~/services/copilot/create-chat-completions"

import type { ParsedAnthropicRequest } from "./anthropic-request"
import type {
  NeutralContentPart,
  NeutralMessage,
  NeutralTool,
} from "~/services/copilot/responses-request"

/** Build the `data:` URI (base64) or return the verbatim URL for an image part. */
function imageUrlFor(part: Extract<NeutralContentPart, { type: "image" }>): string {
  if (typeof part.url === "string" && part.url.length > 0) return part.url
  const mime = part.mimeType ?? "image/png"
  return `data:${mime};base64,${part.data ?? ""}`
}

/**
 * A brief inline note standing in for a document on the chat path. Copilot's
 * `/chat/completions` rejects file content parts (`type` must be `image_url` or
 * `text` → HTTP 400), so a document (PDF) can't be forwarded to a Gemini model;
 * the note keeps the document from being silently dropped and tells the model
 * one was provided but is unavailable, instead of 400ing the request.
 *
 * The note is wrapped in leading + trailing newlines so it is always DELIMITED
 * from adjacent user text — in the string-collapse branch it can't glue onto a
 * neighboring text run (`...[model]what is this?`), and in the content-parts
 * branch it stands as its own line. Regular text-to-text concatenation is left
 * untouched (only the note carries the delimiter), so wire order is preserved.
 */
function documentNote(part: Extract<NeutralContentPart, { type: "document" }>): string {
  const name = part.filename ?? "document"
  return `\n[document "${name}" attached but not supported for this model]\n`
}

/**
 * A user turn: plain string when there are no images; otherwise OpenAI content
 * parts (`text` / `image_url`). Mirrors `neutralUserToResponses` so the two
 * shims encode a multimodal user turn the same way.
 */
function neutralUserToChat(
  m: Extract<NeutralMessage, { role: "user" }>,
): Message {
  if (typeof m.content === "string") {
    return { role: "user", content: m.content }
  }
  const hasImage = m.content.some((c) => c.type === "image")
  if (!hasImage) {
    // No images → collapse to a single string. Documents can't be forwarded to
    // Copilot's chat endpoint, so each becomes an inline text note rather than
    // being silently lost.
    let text = ""
    for (const c of m.content) {
      if (c.type === "text") text += c.text
      else if (c.type === "document") text += documentNote(c)
    }
    return { role: "user", content: text }
  }
  const parts: Array<ContentPart> = []
  for (const c of m.content) {
    if (c.type === "text") {
      parts.push({ type: "text", text: c.text })
    } else if (c.type === "image") {
      parts.push({ type: "image_url", image_url: { url: imageUrlFor(c) } })
    } else if (c.type === "document") {
      // Degrade to a text note — never an upstream-invalid file part.
      parts.push({ type: "text", text: documentNote(c) })
    }
  }
  return { role: "user", content: parts }
}

/**
 * An assistant turn: text parts collapse into `content`, tool_use parts become
 * OpenAI `tool_calls`. Unlike the Responses path (which flushes text before each
 * call to preserve interleaving), the chat wire shape carries all text on
 * `content` and all calls on `tool_calls`, so ordering within the turn is not
 * representable — matching how OpenAI itself echoes an assistant turn. When the
 * turn is tool-calls-only, `content` is `null` (OpenAI convention).
 */
function neutralAssistantToChat(
  m: Extract<NeutralMessage, { role: "assistant" }>,
): Message {
  let text = ""
  const toolCalls: Array<ToolCall> = []
  for (const c of m.content) {
    if (c.type === "text") {
      text += c.text
    } else if (c.type === "toolCall") {
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
  const content = text.length > 0 ? text : toolCalls.length > 0 ? null : ""
  const msg: Message = { role: "assistant", content }
  if (toolCalls.length > 0) msg.tool_calls = toolCalls
  return msg
}

/** Translate one neutral message into a single chat/completions message. */
function neutralMessageToChat(m: NeutralMessage): Message {
  if (m.role === "user") return neutralUserToChat(m)
  if (m.role === "assistant") return neutralAssistantToChat(m)
  return { role: "tool", tool_call_id: m.toolCallId, content: m.output }
}

function neutralToolsToChat(
  tools: ReadonlyArray<NeutralTool> | undefined,
): Array<Tool> | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: "object", properties: {} },
    },
  }))
}

/**
 * Convert the parsed (Responses-flat) `tool_choice` to the chat NESTED form.
 * A forced tool is `{type:"function", function:{name}}` on chat/completions —
 * distinct from the Responses flat `{type:"function", name}`. `"auto"` /
 * `"required"` / `"none"` pass through unchanged.
 */
function toolChoiceToChat(
  tc: ParsedAnthropicRequest["toolChoice"],
): ChatCompletionsPayload["tool_choice"] {
  if (tc === undefined) return undefined
  if (typeof tc === "string") {
    return tc === "auto" || tc === "none" || tc === "required" ? tc : undefined
  }
  if (tc.type === "function" && typeof tc.name === "string" && tc.name.length > 0) {
    return { type: "function", function: { name: tc.name } }
  }
  return undefined
}

/** Assemble the `/chat/completions` payload from a parsed Anthropic request. */
export function parsedToChatPayload(
  parsed: ParsedAnthropicRequest,
): ChatCompletionsPayload {
  const messages: Array<Message> = []
  if (parsed.instructions) {
    messages.push({ role: "system", content: parsed.instructions })
  }
  if (parsed.dynamicInstructions) {
    messages.push({ role: "system", content: parsed.dynamicInstructions })
  }
  for (const m of parsed.messages) messages.push(neutralMessageToChat(m))

  const payload: ChatCompletionsPayload = {
    model: parsed.model,
    messages,
    stream: parsed.stream,
  }

  const tools = neutralToolsToChat(parsed.tools)
  if (tools && tools.length > 0) {
    payload.tools = tools
    // Default to "auto" when tools are present and no choice was given, so the
    // chat and Responses shims agree on the tools-present default.
    payload.tool_choice = toolChoiceToChat(parsed.toolChoice) ?? "auto"
  }

  // `parsed.reasoningEffort` was already bucketed AND clamped to the model's
  // `reasoning_effort` allowlist at parse time (so Gemini's xhigh → high), so
  // it is forwarded verbatim. "off"/undefined means no reasoning field.
  if (parsed.reasoningEffort && parsed.reasoningEffort !== "off") {
    payload.reasoning_effort = parsed.reasoningEffort
  }

  if (typeof parsed.maxOutputTokens === "number" && parsed.maxOutputTokens > 0) {
    payload.max_tokens = parsed.maxOutputTokens
  }

  // stop_sequences → `stop` (Copilot's /chat/completions accepts it, verified live).
  if (parsed.stopSequences && parsed.stopSequences.length > 0) {
    payload.stop = parsed.stopSequences
  }

  // tool_choice.disable_parallel_tool_use → parallel_tool_calls:false (honor the
  // disable only; never emit `true`).
  if (parsed.parallelToolCalls === false) {
    payload.parallel_tool_calls = false
  }

  return payload
}
