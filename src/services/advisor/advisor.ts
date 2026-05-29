/**
 * Phase I: ADVISOR proxy-side translation.
 *
 * ADVISOR is Anthropic's server-side server_tool_use mechanism — the
 * model invokes a stronger reviewer model with the full conversation
 * context. Copilot doesn't implement it (returns 400 'unsupported beta
 * header(s): advisor-tool-2026-03-01'). This module implements the
 * equivalent semantics proxy-side per gemini-critic's streaming design:
 *
 * 1. Strip the `advisor-tool-` beta header before forwarding to Copilot
 *    (Phase A already does this via EXPLICITLY_STRIPPED_BETA_PREFIXES).
 * 2. Inject a `__anthropic_advisor` tool definition into body.tools[]
 *    (with cc-backup's ADVISOR_TOOL_INSTRUCTIONS as the description so
 *    the model knows when to call it). The double-underscore prefix
 *    avoids collision with any user MCP server's `advisor` tool.
 * 3. Stream the Copilot response, watching for tool_use blocks with
 *    name `__anthropic_advisor`. When detected:
 *    a. Translate the block in-flight: emit
 *       `{type: "server_tool_use", name: "advisor"}` to the client so
 *       Claude Code's AdvisorMessage.tsx renders the "Consulting
 *       advisor..." spinner immediately (gemini: do NOT buffer the loop
 *       — the UI hangs without an indicator).
 *    b. After the current turn's `message_stop` would have arrived,
 *       suppress it and run the advisor model server-side with the
 *       conversation context up through the current assistant turn.
 *    c. Synthesize an `advisor_tool_result` block to the client with
 *       the advisor's text response.
 *    d. Append the synthetic tool_result to the conversation and
 *       re-call Copilot for the next turn — stream onto the SAME
 *       SSE connection (no new message_start; the original one is
 *       still open). Loop up to ADVISOR_MAX_TURNS times.
 * 4. Cross-lab default: route the advisor call to a different model
 *    family than the main loop (gpt-5.5 by default) so the user gets
 *    a true "second set of eyes" instead of Opus reviewing Opus
 *    (gemini-critic finding).
 *
 * The translate-loop is bounded to a single user request — no
 * persistent state across requests is needed (unlike Phase G's
 * mcp_servers translate which had unfix-able continuation-after-TTL
 * holes). Each request evaluates ADVISOR fresh from the body.
 */

import consola from "consola"
import { events } from "fetch-event-stream"

import { isControllerClosedError } from "~/lib/stream-relay"
import { resolveModel } from "~/lib/utils"
import { createMessages } from "~/services/copilot/create-messages"
import {
  createResponses,
  type ResponsesApiResponse,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>

const ENCODER = new TextEncoder()

/** The tool name we inject for Copilot. Double-underscore prefix
 *  avoids collision with any user MCP server's `advisor` tool. */
export const ADVISOR_INTERNAL_TOOL_NAME = "__anthropic_advisor"

/** The Anthropic-spec name used in the translated server_tool_use
 *  block sent to the client. cc-backup AdvisorMessage.tsx requires
 *  this exact name to render the advisor spinner. */
export const ADVISOR_CLIENT_TOOL_NAME = "advisor"

/** Hard cap on advisor calls per request to bound runaway behavior.
 *  Matches Phase G's loop bound; ADVISOR is typically called 1-3
 *  times per session per cc-backup ADVISOR_TOOL_INSTRUCTIONS. */
export const ADVISOR_MAX_TURNS = 16

/** Default advisor model + reasoning effort. Per gemini-critic + user
 *  direction: hardcode to a cross-lab model (gpt-5.5 — Copilot's
 *  /responses-only flagship) at xhigh effort. The cross-lab choice
 *  gives a true "second set of eyes" instead of the main model
 *  reviewing itself; xhigh effort buys the deep-dive reasoning that
 *  matches Anthropic's own ADVISOR (which uses a stronger reviewer
 *  model — Opus 4.6/Sonnet 4.6 typically). */
export const ADVISOR_DEFAULT_MODEL = "gpt-5.5"
export const ADVISOR_DEFAULT_EFFORT = "xhigh"

type Effort = "low" | "medium" | "high" | "xhigh"

/** ADVISOR_TOOL_INSTRUCTIONS verbatim from cc-backup
 *  src/utils/advisor.ts — describes when the model should invoke
 *  the advisor. Long-form prose; see source for justification. */
export const ADVISOR_TOOL_INSTRUCTIONS = `# Advisor Tool

You have access to an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters -- when you call it, your entire conversation history is automatically forwarded. The advisor sees the task, every tool call you've made, every result you've seen.

Call advisor BEFORE substantive work -- before writing code, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, reading code, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, stage the change, save the result. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck -- errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling -- the advisor adds most of its value on the first call, before the approach crystallizes.

Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the code does Y), adapt. A passing self-test is not evidence the advice is wrong -- it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call -- "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.`

const ADVISOR_OPT_OUT_ENV = "CLAUDE_CODE_DISABLE_ADVISOR_TOOL"

/**
 * Detect whether the request asked for ADVISOR (incoming
 * `anthropic-beta` header contains an `advisor-tool-` prefix). Also
 * respects the `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` opt-out env var
 * (set by the user to globally disable; matches cc-backup advisor.ts
 * line 61).
 */
export function isAdvisorRequested(rawBetaHeader: string | undefined): boolean {
  if (!rawBetaHeader) return false
  if (process.env[ADVISOR_OPT_OUT_ENV]) return false
  return rawBetaHeader
    .split(",")
    .map((s) => s.trim())
    .some((v) => v.startsWith("advisor-tool-"))
}

/**
 * Inject the __anthropic_advisor tool definition into the body's tools
 * array. Returns a new body string. Idempotent — if the tool is already
 * present (e.g. the user's MCP shadowed it) we leave the existing one
 * alone and return the body unchanged.
 *
 * Also strips any tool entry with `type: "advisor_*"` (Anthropic API's
 * native server-side advisor tool — `advisor_20260301` and future
 * variants). When `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1` is
 * set, Claude Code injects its own advisor tool with this type into
 * `tools[]`. Copilot 400s on the unknown tool type ("Input tag
 * 'advisor_20260301' found using 'type' does not match any of the
 * expected tags"), so the proxy must strip it before forwarding while
 * still injecting our custom `__anthropic_advisor` tool that the model
 * can invoke. The proxy's intercept on the response stream then
 * translates the model's `tool_use{__anthropic_advisor}` to the
 * client-shape `server_tool_use{name:"advisor"}` + `advisor_tool_result`
 * blocks the client expects.
 */
export function injectAdvisorTool(rawBody: string): string {
  let parsed: AnyRecord
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return rawBody
  }
  const rawTools = Array.isArray(parsed.tools) ? parsed.tools : []
  // Strip Anthropic-native advisor typed tools (Copilot 400s on these).
  const tools = rawTools.filter((t: AnyRecord) => {
    if (typeof t !== "object" || t === null) return true
    const type = (t as AnyRecord).type
    return typeof type !== "string" || !type.startsWith("advisor_")
  })
  const stripped = tools.length !== rawTools.length
  const alreadyInjected = tools.some(
    (t: AnyRecord) => t?.name === ADVISOR_INTERNAL_TOOL_NAME,
  )
  if (alreadyInjected && !stripped) {
    return rawBody // no-op: already injected and nothing to strip
  }
  parsed.tools = alreadyInjected
    ? tools
    : [
        ...tools,
        {
          name: ADVISOR_INTERNAL_TOOL_NAME,
          description: ADVISOR_TOOL_INSTRUCTIONS,
          input_schema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      ]
  return JSON.stringify(parsed)
}

/** Character budget for rendered conversation text passed to the
 *  advisor model. gpt-5.5 (default advisor) caps prompt input at
 *  272,000 tokens. At a conservative ~3 chars/token (mixed prose +
 *  code + JSON), 720,000 chars renders to ≈240,000 tokens, leaving
 *  ~32,000 tokens of headroom for the system prompt and per-turn
 *  framing overhead. Without this cap, long Claude Code sessions
 *  produce 400 `model_max_prompt_tokens_exceeded` from /v1/responses
 *  and the advisor falls back silently. */
export const ADVISOR_MAX_CONVERSATION_CHARS = 720_000

/**
 * Render an Anthropic-shape conversation (messages array with
 * role/content blocks) as a single human-readable text blob. Used
 * as the input to the advisor model (gpt-5.5 via /v1/responses
 * doesn't have a 1:1 mapping for Anthropic's tool_use/tool_result
 * blocks; serializing to text preserves the semantics — the advisor
 * just needs to READ the conversation, not produce more of it).
 *
 * Front-truncates oldest turns when the rendered output would exceed
 * `maxChars`. The advisor cares more about current state (latest
 * tool calls, errors, in-flight task) than the original prompt —
 * mirrors Claude Code's own context-truncation strategy. When any
 * turns are dropped, prepends a `[TRUNCATED: N earlier turn(s)
 * omitted ...]` notice so the advisor knows the transcript is
 * partial and can flag if it needs the missing context.
 */
export function renderConversationAsText(
  conversation: Array<AnyRecord>,
  maxChars: number = ADVISOR_MAX_CONVERSATION_CHARS,
): string {
  const turnBlocks: Array<string> = []
  for (let i = 0; i < conversation.length; i++) {
    const msg = conversation[i]
    const role = (msg.role as string) ?? "unknown"
    const block: Array<string> = [`### Turn ${i + 1} — ${role}`]
    const content = msg.content
    if (typeof content === "string") {
      block.push(content)
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part !== "object" || part === null) continue
        const b = part as AnyRecord
        if (b.type === "text" && typeof b.text === "string") {
          block.push(b.text)
        } else if (b.type === "tool_use") {
          block.push(
            `[tool_use ${b.name ?? "?"}(${b.id ?? "?"}): ${JSON.stringify(b.input ?? {})}]`,
          )
        } else if (b.type === "tool_result") {
          const c =
            typeof b.content === "string" ? b.content : JSON.stringify(b.content)
          block.push(`[tool_result ${b.tool_use_id ?? "?"}]:\n${c}`)
        } else {
          block.push(`[${b.type}: ${JSON.stringify(b).slice(0, 500)}]`)
        }
      }
    }
    block.push("")
    turnBlocks.push(block.join("\n"))
  }

  // Walk from the latest turn backward, accumulating until the next
  // turn would push us over budget. The "+1" accounts for the join
  // separator between turn blocks.
  let totalChars = 0
  let firstKeptIdx = turnBlocks.length
  for (let i = turnBlocks.length - 1; i >= 0; i--) {
    const len = turnBlocks[i].length + 1
    if (totalChars + len > maxChars) break
    totalChars += len
    firstKeptIdx = i
  }

  // Edge case: even the latest turn alone exceeds the budget. Hard-
  // truncate its tail to fit (advisor still gets the most-recent
  // context, just not all of it). 200-char reserve for the notice.
  if (firstKeptIdx === turnBlocks.length && turnBlocks.length > 0) {
    const last = turnBlocks[turnBlocks.length - 1]
    const reserve = 200
    const tail = last.slice(-(maxChars - reserve))
    return (
      `[TRUNCATED: conversation too long for advisor model context; `
      + `only the tail of the latest (turn ${turnBlocks.length}) is shown]\n\n`
      + tail
    )
  }

  const kept = turnBlocks.slice(firstKeptIdx)
  if (firstKeptIdx > 0) {
    kept.unshift(
      `[TRUNCATED: ${firstKeptIdx} earlier turn(s) omitted to fit advisor `
        + `model context budget; ${turnBlocks.length - firstKeptIdx} most-recent `
        + `turn(s) shown below]\n`,
    )
  }
  return kept.join("\n")
}

/**
 * Run the advisor model with the full conversation context. Returns
 * the advisor's text response.
 *
 * Routes by model family:
 *   - gpt-5.x / codex / o-series (have `/responses` in supported_endpoints):
 *     use createResponses with `reasoning.effort` set. This is the
 *     default path — gpt-5.5 at xhigh effort.
 *   - claude-* (no `/responses`): fall back to createMessages.
 *
 * The conversation is serialized to text via renderConversationAsText
 * so the advisor model (which may not natively understand Anthropic's
 * tool_use/tool_result block shapes) sees a flat readable transcript.
 * This loses some structural fidelity but matches the spirit of
 * Anthropic's own ADVISOR ("see the whole task + every tool call +
 * every result").
 */
async function runAdvisor(
  conversation: Array<AnyRecord>,
  advisorModel: string,
  advisorEffort: Effort,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    throw new Error("advisor call aborted before dispatch")
  }
  const advisorSystem =
    "You are an expert advisor reviewing an in-progress Claude Code session. "
    + "The transcript below is the work-in-progress (turns numbered, with "
    + "tool calls and results inlined). Read carefully and provide concrete, "
    + "actionable advice on the next step or course-correction. Be specific — "
    + "cite the parts of the transcript you're responding to. If the assistant "
    + "is on the right track, say so explicitly. If they're stuck or off-track, "
    + "name the specific assumption or step to revisit. Aim for 2-5 paragraphs "
    + "of substantive guidance."

  const conversationText = renderConversationAsText(conversation)
  const resolvedAdvisorModel = resolveModel(advisorModel)

  // Route by model family. gpt-5.x / o-series / codex go through
  // /v1/responses with reasoning.effort. claude-* stays on /v1/messages.
  // Quick heuristic: if the model id starts with "gpt-" or contains
  // "codex" or starts with "o", use /responses. Otherwise /v1/messages.
  // (Could be tightened with a state.models lookup, but the fast-path
  // text match is correct for every model in Copilot's catalog today.)
  const useResponses = /^(gpt-|o\d|.*codex)/i.test(resolvedAdvisorModel)

  if (useResponses) {
    const payload: ResponsesPayload = {
      model: resolvedAdvisorModel,
      instructions: advisorSystem,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: conversationText }],
        },
      ],
      stream: false,
      // gpt-5.x reads reasoning.effort directly. xhigh is the deepest
      // reasoning bucket — appropriate for adversarial review since the
      // advisor adds most of its value on the FIRST call (per cc-backup
      // ADVISOR_TOOL_INSTRUCTIONS line 31), so don't be cheap.
      reasoning: { effort: advisorEffort },
    }
    const response = (await createResponses(payload, undefined, signal)) as ResponsesApiResponse
    const out: Array<string> = []
    for (const item of response.output) {
      if (typeof item !== "object" || item === null) continue
      const obj = item as Record<string, unknown>
      if (obj.type !== "message" || obj.role !== "assistant") continue
      const content = obj.content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (typeof part !== "object" || part === null) continue
        const p = part as Record<string, unknown>
        if (
          (p.type === "output_text" || p.type === "text")
          && typeof p.text === "string"
        ) {
          out.push(p.text)
        }
      }
    }
    const text = out.join("")
    if (!text) {
      throw new Error(
        `Advisor model ${resolvedAdvisorModel} returned empty assistant output`,
      )
    }
    return text
  }

  // claude-* fallback: /v1/messages with the conversation as a single
  // user message. Effort doesn't apply (Anthropic uses thinking mode
  // separately).
  const advisorBody = JSON.stringify({
    model: resolvedAdvisorModel,
    max_tokens: 4096,
    system: advisorSystem,
    messages: [{ role: "user", content: conversationText }],
    stream: false,
  })
  const response = await createMessages(advisorBody, {}, signal)
  const json = (await response.json()) as AnyRecord
  const blocks = Array.isArray(json.content) ? json.content : []
  const text = blocks
    .filter((b: AnyRecord) => b.type === "text" && typeof b.text === "string")
    .map((b: AnyRecord) => b.text as string)
    .join("\n\n")
  if (!text) {
    throw new Error(`Advisor model ${resolvedAdvisorModel} returned empty response`)
  }
  return text
}

interface ToolUseTracker {
  /** Block index from the SSE stream */
  index: number
  /** tool_use_id assigned by the upstream model — used in the
   *  conversation-replay path sent back to Copilot in next turns of
   *  the in-loop advisor flow (must match Anthropic `^toolu_*$`). */
  id: string
  /** Client-facing server_tool_use id derived from `id` — used in
   *  the translated server_tool_use + advisor_tool_result blocks
   *  emitted on the SSE stream to the client. Anthropic spec
   *  requires this to match `^srvtoolu_[a-zA-Z0-9_]+$` (parallel to
   *  `toolu_*` for client-fulfilled tools). Mismatched format causes
   *  Copilot to 400 the conversation history when Claude Code
   *  replays it later — the failure is delayed because the original
   *  request succeeds; the broken block only hits a validator on a
   *  much-later turn that includes it in the message history. */
  clientId: string
  /** Accumulated input_json_delta text (advisor takes no input but
   *  we accumulate defensively) */
  inputJson: string
}

/**
 * Derive a spec-compliant `srvtoolu_*` id for a client-facing
 * `server_tool_use` (and matching `advisor_tool_result.tool_use_id`)
 * from the upstream model's `toolu_*` id.
 *
 * Anthropic spec: `^srvtoolu_[a-zA-Z0-9_]+$`. If the upstream id
 * suffix contains chars outside that charset (e.g., a hyphenated id
 * from a non-Anthropic provider, or a corrupt id), fall back to a
 * synthesized stable id keyed by the SSE block index. Defensive
 * against edge cases that would otherwise emit a malformed block —
 * spec violation in either direction is a 400.
 */
export function toClientServerToolUseId(
  id: string,
  fallbackIndex: number,
): string {
  const suffix = id.startsWith("toolu_") ? id.slice("toolu_".length) : id
  if (/^[a-zA-Z0-9_]+$/.test(suffix)) return `srvtoolu_${suffix}`
  return `srvtoolu_advisor_${fallbackIndex}`
}

/**
 * A captured assistant content block from the upstream Copilot stream,
 * suitable for replay back to Copilot in the advisor loop's
 * continuation turn. Holds the raw `content_block` object verbatim so
 * future block types we don't recognize today (thinking, redacted_
 * thinking, image, document, citations, etc.) flow through correctly.
 *
 * Mutated in place during streaming: text_delta appends to .block.text,
 * thinking_delta to .block.thinking, signature_delta to .block.signature,
 * input_json_delta accumulates into partialJson and is parsed into
 * .block.input at content_block_stop (Anthropic spec requires
 * tool_use.input to be a parsed object on replay, not a raw JSON string).
 *
 * Special case: when the upstream block is `tool_use{__anthropic_advisor}`,
 * the proxy SYNTHESIZES a different block for client output
 * (`server_tool_use{name:"advisor"}` with the `srvtoolu_*` clientId)
 * AND tracks the original `toolu_*` id in `advisorReplay` so the
 * Copilot-replay continuation request uses the original.
 */
interface CapturedBlock {
  /** The full `content_block` object from the upstream
   *  content_block_start event (or, for advisor blocks, an internal
   *  representation we'll synthesize on emit). */
  block: AnyRecord
  /** Raw partial_json buffer for tool_use blocks. JSON.parse'd into
   *  `block.input` at content_block_stop. */
  partialJson: string
  /** Set if this block was the advisor invocation. The
   *  Copilot-replay path must emit a `tool_use{__anthropic_advisor}`
   *  with the original `toolu_*` id, NOT the client-facing
   *  `srvtoolu_*` id; the input is the parsed advisor input (defaults
   *  to {} if no input_json_delta arrived — codex round-7: don't bake
   *  "advisor takes no input" as a load-bearing invariant). */
  advisorReplay?: { id: string }
  /** Set during content_block_stop if this block should be dropped
   *  from the replay (e.g., empty text block). */
  dropFromReplay?: boolean
}

/**
 * Build an SSE event line in the canonical Anthropic shape:
 *   event: <type>
 *   data: <json>
 *   <blank>
 */
function sseEvent(type: string, data: AnyRecord): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * The streaming translate-loop. Returns a ReadableStream<Uint8Array>
 * suitable to wrap with Hono's c.body() / new Response().
 *
 * @param firstResponse The first Copilot streaming response
 * @param initialConversation The conversation messages from the
 *   incoming request (used as the starting context for advisor calls
 *   and continuation Copilot calls).
 * @param baseBody Parsed initial request body (model, max_tokens,
 *   system, etc.) — used as the template for continuation Copilot calls.
 * @param requestHeaders Extra headers (model-specific + filtered
 *   anthropic-beta) for downstream Copilot calls.
 * @param advisorModel Which model to route advisor calls to. Defaults
 *   to ADVISOR_DEFAULT_MODEL (cross-lab).
 */
export function buildAdvisorStream(opts: {
  firstResponse: Response
  initialConversation: Array<AnyRecord>
  baseBody: AnyRecord
  requestHeaders: Record<string, string>
  advisorModel?: string
  advisorEffort?: Effort
}): ReadableStream<Uint8Array> {
  const advisorModel = opts.advisorModel ?? ADVISOR_DEFAULT_MODEL
  const advisorEffort = opts.advisorEffort ?? ADVISOR_DEFAULT_EFFORT

  // Internal AbortController for consumer-disconnect cancellation.
  // Threads into runAdvisor() (which forwards to createResponses /
  // createMessages via their `callerSignal` arg) AND the continuation
  // createMessages() call. Without this, a consumer cancel mid-stream
  // left the outer turn loop running — the `for await (const ev of
  // events(response))` inside `processOneTurn` would early-return on
  // safeEnqueue failure, but only AFTER the advisor + continuation
  // upstream calls had already burned tokens and held sockets open.
  // Up to ~16 leaked upstream calls per cancelled request.
  const aborter = new AbortController()
  // Hoist `conversation` so cancel() can clear the reference and let
  // the accumulated tool_result text get GC'd promptly (a long
  // advisor loop accumulates hundreds of KB of upstream content).
  let conversation: Array<AnyRecord> | null = [...opts.initialConversation]

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let messageStartForwarded = false
      let nextSyntheticIndex = 0
      let turnsRun = 0

      const safeEnqueue = (bytes: Uint8Array): boolean => {
        try {
          controller.enqueue(bytes)
          return true
        } catch (err) {
          if (isControllerClosedError(err)) {
            // Consumer is gone — also signal the upstream abort so the
            // outer loop and any in-flight createMessages/runAdvisor
            // tear down on the next signal check (or sooner, via the
            // fetch's AbortSignal). Safe to call repeatedly — abort()
            // is idempotent.
            if (!aborter.signal.aborted) {
              aborter.abort(new Error("advisor stream consumer disconnected"))
            }
            return false
          }
          throw err
        }
      }

      const safeEnqueueEvent = (type: string, data: AnyRecord): boolean =>
        safeEnqueue(ENCODER.encode(sseEvent(type, data)))

      // Process one Copilot streaming response. Returns the assistant
      // turn's blocks + the advisor tool_use info if one was called.
      // Forwards events to the client as it goes.
      async function processOneTurn(
        response: Response,
      ): Promise<{
        capturedBlocks: Array<CapturedBlock>
        advisorToolUse: ToolUseTracker | null
      }> {
        const capturedBlocks: Array<CapturedBlock> = []
        let advisorToolUse: ToolUseTracker | null = null
        // Track which upstream block index corresponds to which entry
        // in capturedBlocks (so deltas know which to update).
        const indexToBlock = new Map<number, CapturedBlock>()

        for await (const ev of events(response)) {
          if (!ev.event || !ev.data) continue
          let payload: AnyRecord
          try {
            payload = JSON.parse(ev.data) as AnyRecord
          } catch {
            // Non-JSON data — forward as-is (defensive).
            const ok = safeEnqueue(ENCODER.encode(`event: ${ev.event}\ndata: ${ev.data}\n\n`))
            if (!ok) return { capturedBlocks, advisorToolUse }
            continue
          }

          switch (ev.event) {
            case "message_start": {
              if (!messageStartForwarded) {
                if (!safeEnqueueEvent(ev.event, payload)) return { capturedBlocks, advisorToolUse }
                messageStartForwarded = true
              }
              // Suppress duplicate message_start on continuation turns —
              // we keep one open for the entire advisor loop.
              continue
            }

            case "content_block_start": {
              const block = (payload as AnyRecord).content_block as AnyRecord | undefined
              const upstreamIndex = (payload as AnyRecord).index as number | undefined
              if (block && upstreamIndex !== undefined) {
                // Re-index to the synthetic stream's monotonic index
                // (continuation turns reset their upstream index to 0,
                // which would collide with prior turns' indices).
                const myIndex = nextSyntheticIndex++

                if (
                  block.type === "tool_use"
                  && block.name === ADVISOR_INTERNAL_TOOL_NAME
                ) {
                  // Translate to server_tool_use{advisor}
                  const id =
                    typeof block.id === "string"
                      ? block.id
                      : `toolu_advisor_${myIndex}`
                  advisorToolUse = {
                    index: myIndex,
                    id,
                    clientId: toClientServerToolUseId(id, myIndex),
                    inputJson: "",
                  }
                  const translated = {
                    ...payload,
                    index: myIndex,
                    content_block: {
                      type: "server_tool_use",
                      id: advisorToolUse.clientId,
                      name: ADVISOR_CLIENT_TOOL_NAME,
                      input: {},
                    },
                  }
                  if (!safeEnqueueEvent(ev.event, translated)) return { capturedBlocks, advisorToolUse }
                  // Track for later — the Copilot-replay continuation
                  // turn needs to round-trip with the INTERNAL name +
                  // ORIGINAL toolu_* id (Copilot doesn't know
                  // server_tool_use). The advisor branch reuses the
                  // standard captured-block pipeline (deltas accumulate,
                  // input parses) so that future versions of advisor
                  // that take params would Just Work — we synthesize
                  // the actual replay shape in the content mapping.
                  const captured: CapturedBlock = {
                    block: {
                      type: "tool_use",
                      id,
                      name: ADVISOR_INTERNAL_TOOL_NAME,
                      input: {},
                    },
                    partialJson: "",
                    advisorReplay: { id },
                  }
                  capturedBlocks.push(captured)
                  indexToBlock.set(upstreamIndex, captured)
                } else {
                  // Forward as-is, with re-indexed.
                  const reindexed = { ...payload, index: myIndex }
                  if (!safeEnqueueEvent(ev.event, reindexed)) return { capturedBlocks, advisorToolUse }
                  // Store the raw content_block verbatim — preserves
                  // every field upstream sent (including ones the proxy
                  // doesn't know about: thinking, signature, image src,
                  // document data, citations, etc.). Mutated in place
                  // by deltas; emitted verbatim on replay.
                  const captured: CapturedBlock = {
                    block: { ...block },
                    partialJson: "",
                  }
                  capturedBlocks.push(captured)
                  indexToBlock.set(upstreamIndex, captured)
                }
              }
              continue
            }

            case "content_block_delta": {
              const upstreamIndex = (payload as AnyRecord).index as number | undefined
              const delta = (payload as AnyRecord).delta as AnyRecord | undefined
              if (upstreamIndex !== undefined) {
                const captured =
                  upstreamIndex !== undefined ? indexToBlock.get(upstreamIndex) : undefined
                // Re-index for the outgoing event
                const reindexed = {
                  ...payload,
                  index: captured
                    ? capturedBlocks.indexOf(captured) >= 0
                      ? // Find the synthetic index by matching back.
                        nextSyntheticIndex - capturedBlocks.length + capturedBlocks.indexOf(captured)
                      : upstreamIndex
                    : upstreamIndex,
                }
                if (!safeEnqueueEvent(ev.event, reindexed)) return { capturedBlocks, advisorToolUse }
                // Accumulate every delta type into the right field on
                // captured.block. The block is mutated in place; on
                // replay it's emitted verbatim, so every field upstream
                // sent (text, thinking, signature, citations, image
                // src, document data, etc.) flows back correctly.
                if (captured && delta) {
                  if (delta.type === "text_delta" && typeof delta.text === "string") {
                    captured.block.text =
                      ((captured.block.text as string | undefined) ?? "") + delta.text
                  } else if (
                    delta.type === "thinking_delta"
                    && typeof delta.thinking === "string"
                  ) {
                    // Anthropic spec: thinking blocks must carry their
                    // text on replay. signature_delta carries the
                    // cryptographic signature separately.
                    captured.block.thinking =
                      ((captured.block.thinking as string | undefined) ?? "") + delta.thinking
                  } else if (
                    delta.type === "signature_delta"
                    && typeof delta.signature === "string"
                  ) {
                    // Concatenate verbatim — Anthropic verifies
                    // signatures cryptographically; mutating bytes
                    // (e.g., normalization, base64 decode/re-encode)
                    // would break verification. Pure string append.
                    captured.block.signature =
                      ((captured.block.signature as string | undefined) ?? "") + delta.signature
                  } else if (
                    delta.type === "input_json_delta"
                    && typeof delta.partial_json === "string"
                  ) {
                    captured.partialJson += delta.partial_json
                  } else if (
                    delta.type === "citations_delta"
                    && delta.citation
                  ) {
                    // Append citations array. Future-proof for the
                    // citations Anthropic feature without us needing
                    // to know its shape.
                    if (!Array.isArray(captured.block.citations)) {
                      captured.block.citations = [] as Array<unknown>
                    }
                    ;(captured.block.citations as Array<unknown>).push(delta.citation)
                  }
                  // Other delta types: leave block as-is. The
                  // content_block_start payload is preserved verbatim,
                  // so any future delta type that the proxy hasn't
                  // explicitly accumulated still has the original
                  // start-state to fall back to.
                }
              } else {
                if (!safeEnqueueEvent(ev.event, payload)) return { capturedBlocks, advisorToolUse }
              }
              continue
            }

            case "content_block_stop": {
              const upstreamIndex = (payload as AnyRecord).index as number | undefined
              const captured = upstreamIndex !== undefined ? indexToBlock.get(upstreamIndex) : undefined
              const reindexed = {
                ...payload,
                index: captured
                  ? nextSyntheticIndex - capturedBlocks.length + capturedBlocks.indexOf(captured)
                  : (upstreamIndex ?? 0),
              }
              if (!safeEnqueueEvent(ev.event, reindexed)) return { capturedBlocks, advisorToolUse }

              // Finalize block state for replay:
              if (captured) {
                // (a) For tool_use blocks, parse the accumulated raw
                //     partial_json into the block's `input` field.
                //     Anthropic spec requires `tool_use.input` to be a
                //     parsed JSON object on replay, not a string.
                //     Warn-log on parse failure rather than silent
                //     fallback so corruption surfaces in production
                //     stderr (codex round-7).
                if (
                  captured.block.type === "tool_use"
                  && captured.partialJson.length > 0
                ) {
                  try {
                    captured.block.input = JSON.parse(captured.partialJson)
                  } catch (err) {
                    consola.warn(
                      `advisor: malformed input_json_delta for tool_use `
                        + `id=${(captured.block.id as string | undefined) ?? "?"} `
                        + `name=${(captured.block.name as string | undefined) ?? "?"} `
                        + `partialJson.length=${captured.partialJson.length} `
                        + `parseError=${err instanceof Error ? err.message : String(err)}`,
                    )
                    captured.block.input = {}
                  }
                }
                // (b) Drop empty text blocks from replay — empty
                //     {type:"text", text:""} is at best meaningless and
                //     at worst spec-invalid (codex round-7).
                if (
                  captured.block.type === "text"
                  && (typeof captured.block.text !== "string"
                    || (captured.block.text as string).length === 0)
                ) {
                  captured.dropFromReplay = true
                }
              }
              continue
            }

            case "message_delta": {
              // Forward as-is (usage updates etc.)
              if (!safeEnqueueEvent(ev.event, payload)) return { capturedBlocks, advisorToolUse }
              continue
            }

            case "message_stop": {
              // CRITICAL: do NOT forward yet if advisor was called —
              // we need to run advisor + continue the loop. message_stop
              // ends the entire outgoing assistant turn. Only emit it
              // when the advisor loop is fully done.
              if (advisorToolUse) {
                return { capturedBlocks, advisorToolUse }
              }
              if (!safeEnqueueEvent(ev.event, payload)) return { capturedBlocks, advisorToolUse }
              return { capturedBlocks, advisorToolUse }
            }

            default: {
              // Unknown event — forward as-is.
              if (!safeEnqueueEvent(ev.event, payload)) return { capturedBlocks, advisorToolUse }
            }
          }
        }
        return { capturedBlocks, advisorToolUse }
      }

      try {
        let response: Response = opts.firstResponse

        for (turnsRun = 0; turnsRun < ADVISOR_MAX_TURNS; turnsRun++) {
          // Top-of-loop abort check — bail before processing the next
          // turn if the consumer has disconnected. Without this, the
          // outer for-loop kept iterating after a mid-stream cancel,
          // burning advisor + continuation calls into a dead stream.
          if (aborter.signal.aborted) return
          if (conversation === null) return

          const { capturedBlocks, advisorToolUse } = await processOneTurn(response)

          if (!advisorToolUse) {
            // No advisor call this turn — message_stop was already
            // forwarded. We're done.
            return
          }

          // Immediate post-turn abort check — `processOneTurn` returns
          // early on `safeEnqueue` failure (which now also aborts the
          // controller). Don't dispatch runAdvisor + continuation if
          // the consumer is already gone.
          if (aborter.signal.aborted) return
          if (conversation === null) return

          // Advisor was called this turn. Run advisor model with the
          // full conversation extended by the assistant turn.
          //
          // Replay strategy: emit captured.block VERBATIM for every
          // captured block (preserves thinking, signature, redacted_
          // thinking, image, document, citations, anything Anthropic
          // adds tomorrow). Special-case ONLY the advisor block, which
          // needs the INTERNAL `__anthropic_advisor` name + ORIGINAL
          // `toolu_*` id (Copilot doesn't know server_tool_use).
          const assistantTurn = {
            role: "assistant",
            content: capturedBlocks
              .filter((c) => !c.dropFromReplay)
              .map((c) => {
                if (c.advisorReplay) {
                  // Use the parsed input if any input_json_delta
                  // arrived; otherwise default to {}. Don't bake
                  // "advisor takes no input" as a load-bearing
                  // invariant (codex round-7).
                  const input =
                    typeof c.block.input === "object" && c.block.input !== null
                      ? (c.block.input as AnyRecord)
                      : {}
                  return {
                    type: "tool_use",
                    id: c.advisorReplay.id, // toolu_*, NOT srvtoolu_*
                    name: ADVISOR_INTERNAL_TOOL_NAME,
                    input,
                  }
                }
                return c.block // verbatim — the bug fix
              }),
          }
          conversation.push(assistantTurn)

          let advisorText: string
          try {
            advisorText = await runAdvisor(
              conversation,
              advisorModel,
              advisorEffort,
              aborter.signal,
            )
          } catch (err) {
            // If the failure was the consumer-cancel abort, bail
            // silently — there's nothing left to deliver. Otherwise
            // synthesize an inline notice so the model can degrade
            // gracefully (same path as before).
            if (aborter.signal.aborted) return
            const msg = err instanceof Error ? err.message : String(err)
            consola.warn(`Advisor model call failed: ${msg}`)
            advisorText =
              `[Advisor unavailable: ${msg}. Continuing without external review — `
              + `proceed with caution and consider self-checking against your `
              + `primary-source evidence.]`
          }

          // Synthesize advisor_tool_result block to client.
          // tool_use_id MUST be the client-facing srvtoolu_* id so it
          // pairs with the server_tool_use block emitted earlier; the
          // internal toolu_* id is only used in the Copilot-replay
          // path below.
          if (aborter.signal.aborted) return
          if (conversation === null) return
          const resultIndex = nextSyntheticIndex++
          const startOk = safeEnqueueEvent("content_block_start", {
            type: "content_block_start",
            index: resultIndex,
            content_block: {
              type: "advisor_tool_result",
              tool_use_id: advisorToolUse.clientId,
              content: { type: "advisor_result", text: advisorText },
            },
          })
          if (!startOk) return
          const stopOk = safeEnqueueEvent("content_block_stop", {
            type: "content_block_stop",
            index: resultIndex,
          })
          if (!stopOk) return

          // Append the tool_result to conversation as a USER turn for
          // the next Copilot call. NOTE we use the standard tool_result
          // shape (Copilot doesn't know advisor_tool_result).
          conversation.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: advisorToolUse.id,
                content: advisorText,
              },
            ],
          })

          // Make the next Copilot call to continue the model's response
          // post-advisor. Reuse baseBody fields (max_tokens, system,
          // tools, etc.) but with the extended conversation and
          // stream:true.
          if (aborter.signal.aborted) return
          const continuationBody = JSON.stringify({
            ...opts.baseBody,
            messages: conversation,
            stream: true,
          })
          response = await createMessages(
            continuationBody,
            opts.requestHeaders,
            aborter.signal,
          )
        }

        // Loop exhausted. Synthesize final message_stop + an error text
        // block so the client doesn't hang.
        if (aborter.signal.aborted) return
        const finalIndex = nextSyntheticIndex++
        safeEnqueueEvent("content_block_start", {
          type: "content_block_start",
          index: finalIndex,
          content_block: { type: "text", text: "" },
        })
        safeEnqueueEvent("content_block_delta", {
          type: "content_block_delta",
          index: finalIndex,
          delta: {
            type: "text_delta",
            text: `\n\n[Advisor loop exceeded ${ADVISOR_MAX_TURNS} turns; halting]`,
          },
        })
        safeEnqueueEvent("content_block_stop", {
          type: "content_block_stop",
          index: finalIndex,
        })
        safeEnqueueEvent("message_stop", { type: "message_stop" })
      } catch (err) {
        // Suppress advisor-stream error path on consumer cancel —
        // emitting `event: error` would log a misleading "advisor loop
        // failed" line; the consumer is already gone.
        if (aborter.signal.aborted) return
        const msg = err instanceof Error ? err.message : String(err)
        consola.error(`Advisor stream error: ${msg}`)
        safeEnqueueEvent("error", {
          type: "error",
          error: { type: "api_error", message: `advisor loop failed: ${msg}` },
        })
      } finally {
        // Truncate the conversation reference so the accumulated
        // tool_result text gets GC'd promptly (long advisor loops
        // accumulate hundreds of KB).
        conversation = null
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
    },
    cancel(reason) {
      // Consumer disconnected. Abort the upstream advisor /
      // continuation fetches so the sockets tear down immediately,
      // and clear the conversation reference for GC. The outer turn
      // loop observes `aborter.signal.aborted` at the top of every
      // iteration AND after each await point, so it exits at the
      // next checkpoint without dispatching another upstream call.
      if (!aborter.signal.aborted) {
        aborter.abort(
          new Error(
            `advisor stream cancelled: ${
              reason instanceof Error ? reason.message : String(reason ?? "no reason")
            }`,
          ),
        )
      }
      conversation = null
    },
  })
}
