/**
 * Anthropic Messages request ingest.
 *
 * Parses an incoming Anthropic `/v1/messages` body into the provider-neutral
 * request shape (`NeutralMessage[]` + tools + reasoning effort + …) and builds
 * the Copilot `/responses` payload via the shared `assembleResponsesPayload`.
 *
 * Correspondence (Anthropic → Responses):
 *   system (string | text blocks)          → instructions
 *   user text/image blocks                 → input[] user message (input_text/input_image)
 *   user tool_result blocks                → input[] function_call_output (+ follow-up user input_image for image content)
 *   assistant text blocks                  → input[] assistant output_text
 *   assistant tool_use blocks              → input[] function_call items
 *   assistant thinking blocks              → dropped (not replayable to Responses)
 *   tools[] {name, input_schema}           → tools[] {type:function, name, parameters}
 *   tool_choice {auto|any|tool|none}       → tool_choice auto|required|{type:function,name}|none (name-less tool → unset)
 *   tool_choice.disable_parallel_tool_use  → parallel_tool_calls:false (only the disable; never sends true)
 *   thinking {enabled, budget_tokens}      → reasoning.effort (bucketed + clamped)
 *   max_tokens                             → max_output_tokens
 *   stop_sequences                         → stop (Copilot's /responses accepts it — verified live)
 */

import type { ResponsesPayload } from "~/services/copilot/create-responses"
import {
  assembleResponsesPayload,
  type NeutralContentPart,
  type NeutralMessage,
  type NeutralTool,
} from "~/services/copilot/responses-request"
import type { Model } from "~/services/copilot/get-models"
import { bucketEffort, clampEffort } from "~/lib/reasoning-effort"

type AnyRecord = Record<string, unknown>

export interface ParsedAnthropicRequest {
  model: string
  instructions?: string
  messages: Array<NeutralMessage>
  tools?: Array<NeutralTool>
  toolChoice?: ResponsesPayload["tool_choice"]
  reasoningEffort?: string
  maxOutputTokens?: number
  /**
   * Anthropic `stop_sequences`, forwarded to the wire as Responses/chat `stop`.
   * Copilot's `/responses` and `/chat/completions` both accept `stop` (verified
   * live, HTTP 200), so the sequences are honored rather than dropped.
   */
  stopSequences?: string[]
  /**
   * Signal that Anthropic's `tool_choice.disable_parallel_tool_use` was `true`.
   * Only ever `false` (the disable) — carried so the payload builders emit
   * `parallel_tool_calls: false`; absent means the field is omitted (never sent
   * as `true`).
   */
  parallelToolCalls?: false
  stream: boolean
}

/** Flatten Anthropic `system` (string | array of text blocks) into a string. */
function flattenSystem(system: unknown): string | undefined {
  if (typeof system === "string") return system.length > 0 ? system : undefined
  if (Array.isArray(system)) {
    let s = ""
    for (const block of system) {
      if (block && typeof block === "object" && (block as AnyRecord).type === "text") {
        const t = (block as AnyRecord).text
        if (typeof t === "string") s += t
      }
    }
    return s.length > 0 ? s : undefined
  }
  return undefined
}

/**
 * Parse an Anthropic `tool_result.content` (string | block array) into the
 * plain-text `output` for the Responses `function_call_output` (a string-only
 * item) PLUS any image parts found in the content. A `function_call_output`
 * cannot carry images, so the caller emits the extracted images as a follow-up
 * user message (Claude Code browser screenshots/observations arrive this way).
 * `isError` (the tool_result `is_error` flag) is preserved by prefixing the
 * text so the model still learns the tool call failed.
 */
function parseToolResultContent(
  content: unknown,
  isError: boolean,
): { output: string; images: Array<NeutralContentPart> } {
  const images: Array<NeutralContentPart> = []
  let text = ""
  if (typeof content === "string") {
    text = content
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue
      const b = block as AnyRecord
      if (b.type === "text" && typeof b.text === "string") {
        text += b.text
      } else if (b.type === "image") {
        const img = anthropicImageToNeutral(b.source as AnyRecord)
        if (img) images.push(img)
      }
    }
  }
  // A function_call_output must be a meaningful string; when the tool returned
  // only image(s), point the model at the follow-up user message that carries
  // them rather than emitting an empty output.
  if (images.length > 0 && text.length === 0) {
    text = "[image result below]"
  }
  if (isError) {
    text = text.length > 0 ? `[tool error] ${text}` : "[tool error]"
  }
  return { output: text, images }
}

/** Map an Anthropic `image` block source to a neutral image part. */
function anthropicImageToNeutral(source: AnyRecord | undefined): NeutralContentPart | null {
  if (!source || typeof source !== "object") return null
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image", url: source.url }
  }
  if (source.type === "base64" && typeof source.data === "string") {
    return {
      type: "image",
      mimeType: typeof source.media_type === "string" ? source.media_type : "image/png",
      data: source.data,
    }
  }
  return null
}

/** Concatenate the text of an Anthropic `document` `content`-source block array. */
function joinDocumentContentText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  let text = ""
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as AnyRecord
      if (b.type === "text" && typeof b.text === "string") text += b.text
    }
  }
  return text
}

/**
 * Map an Anthropic `document` block to a neutral content part.
 *   - base64 source → neutral `document` (mimeType + data) → Responses
 *     `input_file` with `file_data`; on the chat path → an inline text note
 *     (Copilot's `/chat/completions` rejects file parts).
 *   - url source → neutral `document` (url) → Responses `input_file.file_url`.
 *   - text source (a plain-text document) → the doc's text folded into a `text`
 *     part, so the model sees it on BOTH paths.
 *   - content source (content-block document) → its text blocks folded into a
 *     `text` part.
 * Missing/invalid fields (unknown source type, `file`-id references Copilot has
 * no Files API for, empty text) yield null and are dropped.
 */
function anthropicDocumentToNeutral(b: AnyRecord): NeutralContentPart | null {
  const source = b.source
  if (!source || typeof source !== "object") return null
  const s = source as AnyRecord
  const filename =
    typeof b.title === "string" && b.title.length > 0 ? b.title : "document.pdf"
  if (s.type === "base64" && typeof s.data === "string") {
    return {
      type: "document",
      mimeType: typeof s.media_type === "string" ? s.media_type : "application/pdf",
      data: s.data,
      filename,
    }
  }
  if (s.type === "url" && typeof s.url === "string") {
    return { type: "document", url: s.url, filename }
  }
  if (s.type === "text" && typeof s.data === "string") {
    return s.data.length > 0 ? { type: "text", text: s.data } : null
  }
  if (s.type === "content") {
    const text = joinDocumentContentText(s.content)
    return text.length > 0 ? { type: "text", text } : null
  }
  return null
}

/**
 * Convert one Anthropic message into zero-or-more neutral messages. A user
 * message with `tool_result` blocks fans out: text/image content becomes a
 * user message and each tool_result becomes its own `toolResult` message,
 * emitted in wire order so a function_call_output never precedes its text.
 */
function anthropicMessageToNeutral(msg: AnyRecord): Array<NeutralMessage> {
  const role = msg.role
  const content = msg.content

  if (role === "assistant") {
    const parts: Array<NeutralContentPart> = []
    if (typeof content === "string") {
      if (content.length > 0) parts.push({ type: "text", text: content })
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue
        const b = block as AnyRecord
        if (b.type === "text" && typeof b.text === "string") {
          parts.push({ type: "text", text: b.text })
        } else if (b.type === "tool_use") {
          parts.push({
            type: "toolCall",
            id: typeof b.id === "string" ? b.id : "",
            name: typeof b.name === "string" ? b.name : "",
            arguments: b.input ?? {},
          })
        }
        // thinking / redacted_thinking blocks are dropped.
      }
    }
    return [{ role: "assistant", content: parts }]
  }

  // Treat everything else as a user turn (Anthropic only has user/assistant).
  const out: Array<NeutralMessage> = []
  let userParts: Array<NeutralContentPart> = []
  const flushUser = (): void => {
    if (userParts.length === 0) return
    out.push({ role: "user", content: userParts })
    userParts = []
  }

  if (typeof content === "string") {
    if (content.length > 0) out.push({ role: "user", content })
    return out
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue
      const b = block as AnyRecord
      if (b.type === "text" && typeof b.text === "string") {
        userParts.push({ type: "text", text: b.text })
      } else if (b.type === "image") {
        const img = anthropicImageToNeutral(b.source as AnyRecord)
        if (img) userParts.push(img)
      } else if (b.type === "document") {
        // A PDF / document block. base64 & url sources ride as a neutral
        // `document` part (→ Responses input_file; chat path degrades to a text
        // note); text/content sources fold into a text part right here.
        const doc = anthropicDocumentToNeutral(b)
        if (doc) userParts.push(doc)
      } else if (b.type === "tool_result") {
        // A tool result closes the current user text/image run and becomes its
        // own neutral message so it lands as a Responses function_call_output
        // (a string-only item). Image blocks inside the tool_result (e.g.
        // Claude Code browser screenshots) can't ride in that item, so they're
        // emitted as a follow-up user message in wire order right after it —
        // otherwise the model never sees the pixels it asked for.
        flushUser()
        const { output, images } = parseToolResultContent(
          b.content,
          b.is_error === true,
        )
        out.push({
          role: "toolResult",
          toolCallId: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
          output,
        })
        if (images.length > 0) {
          out.push({ role: "user", content: images })
        }
      }
    }
  }
  flushUser()
  return out
}

function parseTools(tools: unknown): Array<NeutralTool> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out: Array<NeutralTool> = []
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue
    const t = tool as AnyRecord
    if (typeof t.name !== "string" || t.name.length === 0) continue
    const schema = t.input_schema ?? t.parameters
    out.push({
      name: t.name,
      description: typeof t.description === "string" ? t.description : undefined,
      parameters:
        schema && typeof schema === "object"
          ? (schema as Record<string, unknown>)
          : { type: "object", properties: {} },
    })
  }
  return out.length > 0 ? out : undefined
}

function parseToolChoice(
  toolChoice: unknown,
): ResponsesPayload["tool_choice"] | undefined {
  if (!toolChoice || typeof toolChoice !== "object") return undefined
  const tc = toolChoice as AnyRecord
  switch (tc.type) {
    case "auto":
      return "auto"
    case "any":
      return "required"
    case "none":
      return "none"
    case "tool":
      // A forced tool call. WITH a usable `name`, force that function. WITHOUT
      // one the shape is malformed — return undefined so the caller's documented
      // default applies, rather than SILENTLY downgrading a forced call to
      // "auto" (model discretion), which would defeat the caller's intent to
      // force a specific tool.
      return typeof tc.name === "string" && tc.name.length > 0
        ? { type: "function", name: tc.name }
        : undefined
    default:
      return undefined
  }
}

/**
 * Anthropic carries `disable_parallel_tool_use` on the `tool_choice` object.
 * Returns `false` (the wire signal to disable parallel tool calls) only when it
 * is explicitly `true`; `undefined` otherwise, so the payload builders omit the
 * field rather than ever sending `parallel_tool_calls: true`.
 */
function parseDisableParallelToolUse(toolChoice: unknown): false | undefined {
  if (!toolChoice || typeof toolChoice !== "object") return undefined
  return (toolChoice as AnyRecord).disable_parallel_tool_use === true
    ? false
    : undefined
}

/**
 * Map Anthropic `thinking` to a Responses reasoning effort, clamped to the
 * model's `reasoning_effort` allowlist. Returns undefined when thinking is
 * absent/disabled (no `reasoning` field is sent).
 */
function parseReasoningEffort(
  thinking: unknown,
  model?: Model,
): string | undefined {
  if (!thinking || typeof thinking !== "object") return undefined
  const t = thinking as AnyRecord
  if (t.type !== "enabled") return undefined
  const bucketed = bucketEffort(t.budget_tokens)
  const supported = model?.capabilities?.supports?.reasoning_effort
  return Array.isArray(supported) && supported.length > 0
    ? clampEffort(bucketed, supported)
    : bucketed
}

/**
 * Parse an already-JSON-parsed Anthropic Messages body into the neutral shape.
 * `resolvedModel` is the catalog id the request will run on; `model` its
 * catalog entry (for the reasoning-effort allowlist).
 */
export function parseAnthropicRequest(
  body: AnyRecord,
  resolvedModel: string,
  model?: Model,
): ParsedAnthropicRequest {
  const messages: Array<NeutralMessage> = []
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg && typeof msg === "object") {
        for (const n of anthropicMessageToNeutral(msg as AnyRecord)) messages.push(n)
      }
    }
  }

  const maxTokens =
    typeof body.max_tokens === "number" && body.max_tokens > 0
      ? body.max_tokens
      : undefined

  const stopSequences =
    Array.isArray(body.stop_sequences)
      ? body.stop_sequences.filter((s: unknown): s is string => typeof s === "string")
      : undefined

  return {
    model: resolvedModel,
    instructions: flattenSystem(body.system),
    messages,
    tools: parseTools(body.tools),
    toolChoice: parseToolChoice(body.tool_choice),
    parallelToolCalls: parseDisableParallelToolUse(body.tool_choice),
    reasoningEffort: parseReasoningEffort(body.thinking, model),
    maxOutputTokens: maxTokens,
    stopSequences: stopSequences && stopSequences.length > 0 ? stopSequences : undefined,
    stream: body.stream === true,
  }
}

/** Build the Copilot `/responses` payload from a parsed Anthropic request. */
export function parsedToResponsesPayload(
  parsed: ParsedAnthropicRequest,
): ResponsesPayload {
  return assembleResponsesPayload({
    model: parsed.model,
    instructions: parsed.instructions,
    messages: parsed.messages,
    tools: parsed.tools,
    toolChoice: parsed.toolChoice,
    reasoningEffort: parsed.reasoningEffort,
    maxOutputTokens: parsed.maxOutputTokens,
    stopSequences: parsed.stopSequences,
    parallelToolCalls: parsed.parallelToolCalls,
    stream: parsed.stream,
  })
}
