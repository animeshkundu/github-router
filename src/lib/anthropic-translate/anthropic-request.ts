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
 *   thinking absent                        → reasoning.effort high (clamped)
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
import { shimDefaultsToXhigh } from "~/lib/openai-frontier"
import {
  EFFORT_ORDER,
  UNKNOWN_EFFORT_ANCHOR,
  bucketEffort,
  clampEffort,
  type Effort,
} from "~/lib/reasoning-effort"
import { parseBoolEnv } from "~/lib/exec"
import { isRouterDynamicSystemText } from "~/lib/web-search-context"

type AnyRecord = Record<string, unknown>

export interface ParsedAnthropicRequest {
  model: string
  instructions?: string
  dynamicInstructions?: string
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

/**
 * Steering appended to `instructions` for shim-routed (non-Claude) models when
 * the request carries Claude Code's native file tools. gpt-5.5 and other
 * OpenAI/Gemini-lineage models receive the Edit/Write tool definitions verbatim
 * (the shim never mangles them), but their base prior is to script file ops in
 * Python/Bash rather than call the dedicated tools. Claude models never reach
 * this code path (they fall through to the /v1/messages passthrough), so this is
 * automatically scoped to the models that need the nudge. Strong PREFERENCE, not
 * a Bash ban — running builds/tests/git still belongs in Bash.
 */
const FILE_TOOL_GUIDANCE = `<file_tools>
You have dedicated tools for files: use Read to read a file, Edit to modify an existing file, and Write to create one. Prefer them over shell for reading or editing. Do NOT shell out (cat, sed, awk, echo >, here-docs, or python/one-off scripts) to read, search, or rewrite file contents when a dedicated tool exists — the dedicated tools are safer and produce reviewable diffs. Use Grep/Glob to search rather than shell grep/find. Reserve Bash for commands that have no dedicated tool: builds, tests, git, package managers, and running programs.
</file_tools>`

/**
 * Append `FILE_TOOL_GUIDANCE` to the STABLE system prefix iff the request
 * carries Claude Code's canonical `Edit` or `Write` tool. The exact
 * capitalized-name match is deliberately precise: it fires for a Claude Code
 * editing session but not for arbitrary MCP tools like `write_file`, and not for
 * non-editing chats (so a plain gpt-5.5 conversation is not polluted). The block
 * is appended AFTER the existing stable text (end-of-prompt recency within the
 * stable prefix) and the original system text is preserved, never replaced.
 *
 * Always lands in `system.stable`, never `system.dynamic` — the guidance is
 * static content that never changes per request, so it belongs in the part of
 * the prompt the cache key is derived from (`applyResponsesCachePolicy` hashes
 * `stablePrefix`, not the dynamic web-search suffix). Landing it in `dynamic`
 * would make the stable prefix — and therefore the GPT-5.6 `prompt_cache_key`
 * and which bytes carry the Claude cache marker — differ depending on whether a
 * web-search dynamic suffix happened to be present on a given turn, which
 * defeats the whole point of a stable prefix. Opt out with
 * `GH_ROUTER_DISABLE_SHIM_TOOL_STEERING=1`.
 */
function appendFileToolGuidance(
  instructions: string | undefined,
  tools: Array<NeutralTool> | undefined,
): string | undefined {
  if (parseBoolEnv(process.env.GH_ROUTER_DISABLE_SHIM_TOOL_STEERING) === true) {
    return instructions
  }
  const hasFileTool = tools?.some((t) => t.name === "Edit" || t.name === "Write")
  if (!hasFileTool) return instructions
  return instructions && instructions.length > 0
    ? `${instructions}\n\n${FILE_TOOL_GUIDANCE}`
    : FILE_TOOL_GUIDANCE
}

interface SystemSegments {
  stable?: string
  dynamic?: string
}

/**
 * Preserve the caller's last system cache boundary and the router's dynamic
 * web-search suffix. The translated endpoints can then keep stable system
 * bytes before volatile results instead of flattening both into one changing
 * instruction string.
 *
 * `dynamic` blocks are joined with a blank-line delimiter, never
 * concatenated raw: `injectAnthropicWebSearchContext` appends the search
 * results block and the authoritative-instruction block as two SEPARATE
 * system text blocks, and Anthropic's own text blocks carry no delimiter of
 * their own. A bare `.join("")` therefore glued `[End Web Search
 * Results]Use factual claims…` into one run-on sentence with no boundary.
 * `stable` keeps the historical no-delimiter join: it reassembles the
 * caller's OWN adjacent text blocks (e.g. Claude Code's own system-prompt
 * segments), which are not this router's to reformat.
 */
function splitSystem(system: unknown): SystemSegments {
  if (typeof system === "string") {
    return system.length > 0 ? { stable: system } : {}
  }
  if (!Array.isArray(system)) return {}

  const textBlocks = system.filter(
    (block): block is AnyRecord =>
      !!block
      && typeof block === "object"
      && (block as AnyRecord).type === "text"
      && typeof (block as AnyRecord).text === "string",
  )
  let boundary = textBlocks.findIndex((block) =>
    isRouterDynamicSystemText(block.text),
  )
  if (boundary < 0) {
    const lastMarked = textBlocks.findLastIndex(
      (block) => block.cache_control !== undefined,
    )
    boundary = lastMarked >= 0 && lastMarked < textBlocks.length - 1
      ? lastMarked + 1
      : textBlocks.length
  }

  const stable = textBlocks
    .slice(0, boundary)
    .map((block) => block.text as string)
    .join("")
  const dynamic = textBlocks
    .slice(boundary)
    .map((block) => block.text as string)
    .join("\n\n")
  return {
    ...(stable.length > 0 ? { stable } : {}),
    ...(dynamic.length > 0 ? { dynamic } : {}),
  }
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

/** Default absent Anthropic `thinking` to an effort, clamped by the model.
 *  Every shim model defaults to `high`, so a client level maps to the identical
 *  provider level (low→low, medium→medium, high→high, xhigh→xhigh) and `high` is
 *  the only value the router injects on its own. There is deliberately NO floor:
 *  an explicit client budget that buckets to `medium` yields `medium`, because a
 *  one-directional max() would mean the router silently overriding the level the
 *  user chose.
 *
 *  Opt in to the previous behavior (xhigh for the OpenAI frontier models when no
 *  thinking is sent) with `GH_ROUTER_FRONTIER_XHIGH_DEFAULT=1`. This replaces the
 *  old opt-OUT `GH_ROUTER_DISABLE_FRONTIER_XHIGH_DEFAULT`, whose meaning would
 *  have inverted under the new default.
 *
 *  Two honest limits, both pre-existing: the level is bucketed from a token
 *  budget so the mapping is lossy at the boundaries, and `clampEffort` moves a
 *  level the model does not advertise (gemini has no `xhigh`). Returns undefined
 *  for a model that advertises NO `reasoning_effort` allowlist, which leaves the
 *  provider's own default rather than `high` — forcing an effort there could 400.
 *  An explicit client `thinking` budget is handled by parseReasoningEffort and is
 *  NOT affected by this default. */
function defaultReasoningEffort(model?: Model): string | undefined {
  const supported = model?.capabilities?.supports?.reasoning_effort
  if (!(Array.isArray(supported) && supported.length > 0)) return undefined
  const wantXhigh =
    parseBoolEnv(process.env.GH_ROUTER_FRONTIER_XHIGH_DEFAULT) === true
    && model?.id != null
    && shimDefaultsToXhigh(model.id)
    && supported.includes("xhigh")
  return clampEffort(wantXhigh ? "xhigh" : "high", supported)
}

/**
 * Map Anthropic `thinking` to a Responses reasoning effort, clamped to the
 * model's `reasoning_effort` allowlist. Returns undefined when thinking is
 * absent/disabled/non-enabled; the absent default is applied at the call site.
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
 * Client-selected reasoning effort in Copilot shape (`output_config.effort`) —
 * what Claude Code's effort picker puts on the wire.
 *
 * This is the highest-precedence signal, matching the rule the passthrough path
 * already documents ("client-supplied `output_config.effort` always wins",
 * `routes/messages/handler.ts`). Before it was read here the field survived
 * every preprocessing step and was then simply dropped by the shim, which made
 * the picker a no-op on non-Claude models in three distinct ways: alone it fell
 * through to the `high` default, alongside a `thinking` budget it lost to the
 * bucketed budget, and alongside `thinking:{type:"adaptive"}` it produced NO
 * reasoning field at all (the adaptive shape is neither `undefined` nor
 * `enabled`, so both of the other branches decline it).
 *
 * `clampOutputConfigEffortInPlace` has normally already clamped this against the
 * model's allowlist upstream, but the clamp is repeated here so the shim is
 * correct when called directly, and so an unrecognized level (a future Copilot
 * tier) resolves the same way it does on the passthrough path: anchored at
 * `UNKNOWN_EFFORT_ANCHOR` and clamped DOWN to the highest the model actually
 * advertises, never up.
 *
 * When the model advertises NO allowlist there is nothing to validate against,
 * so only a recognized tier is honored and anything else declines to the
 * `thinking`/default chain. Passing an arbitrary string through would let a
 * typo become a synthesized `reasoning.effort` on a payload we build, which is
 * the 400 that `defaultReasoningEffort` already refuses to risk by returning
 * undefined in exactly this case.
 */
function parseOutputConfigEffort(
  body: AnyRecord,
  model?: Model,
): string | undefined {
  const oc = body.output_config
  if (!oc || typeof oc !== "object") return undefined
  const effort = (oc as AnyRecord).effort
  if (typeof effort !== "string" || effort === "") return undefined
  const known = (EFFORT_ORDER as ReadonlyArray<string>).includes(effort)
  const supported = model?.capabilities?.supports?.reasoning_effort
  if (!(Array.isArray(supported) && supported.length > 0)) {
    return known ? effort : undefined
  }
  if (supported.includes(effort)) return effort
  return clampEffort(known ? (effort as Effort) : UNKNOWN_EFFORT_ANCHOR, supported)
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

  const tools = parseTools(body.tools)
  const system = splitSystem(body.system)
  // Always lands in `stable`, regardless of whether a dynamic (e.g.
  // web-search) suffix is present — see `appendFileToolGuidance`'s doc.
  system.stable = appendFileToolGuidance(system.stable, tools)

  return {
    model: resolvedModel,
    instructions: system.stable,
    dynamicInstructions: system.dynamic,
    messages,
    tools,
    toolChoice: parseToolChoice(body.tool_choice),
    parallelToolCalls: parseDisableParallelToolUse(body.tool_choice),
    reasoningEffort:
      parseOutputConfigEffort(body, model)
      ?? (body.thinking === undefined
        ? defaultReasoningEffort(model)
        : parseReasoningEffort(body.thinking, model)),
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
    dynamicInstructions: parsed.dynamicInstructions,
    messages: parsed.messages,
    tools: parsed.tools,
    toolChoice: parsed.toolChoice,
    reasoningEffort: parsed.reasoningEffort,
    maxOutputTokens: parsed.maxOutputTokens,
    stopSequences: parsed.stopSequences,
    parallelToolCalls: parsed.parallelToolCalls,
    cachePolicy: { workload: "conversation" },
    stream: parsed.stream,
  })
}
