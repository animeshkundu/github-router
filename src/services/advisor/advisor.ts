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

/** Default advisor model. Per gemini-critic: hardcode to a
 *  cross-lab model so the user gets a true "second set of eyes"
 *  instead of the main model reviewing itself. gpt-5.5 is the
 *  cross-lab equivalent of codex-critic; users can configure via
 *  `--advisor-model` (TODO: wire flag). */
export const ADVISOR_DEFAULT_MODEL = "gpt-5.5"

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
 */
export function injectAdvisorTool(rawBody: string): string {
  let parsed: AnyRecord
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return rawBody
  }
  const tools = Array.isArray(parsed.tools) ? parsed.tools : []
  if (tools.some((t: AnyRecord) => t?.name === ADVISOR_INTERNAL_TOOL_NAME)) {
    return rawBody // already injected
  }
  parsed.tools = [
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

/**
 * Run the advisor model with the full conversation context. Returns
 * the advisor's text response. Uses createMessages directly so we get
 * Copilot's full feature surface (caching, etc.).
 *
 * The advisor model is called as a NON-streaming /v1/messages with a
 * system prompt instructing it to act as an expert reviewer. We pass
 * the user's full conversation as the messages array.
 */
async function runAdvisor(
  conversation: Array<AnyRecord>,
  advisorModel: string,
): Promise<string> {
  const advisorSystem =
    "You are an expert advisor reviewing an in-progress Claude Code session. "
    + "The user/assistant conversation below is the work-in-progress. "
    + "Read carefully and provide concrete, actionable advice on the next step "
    + "or course-correction. Be specific — cite the parts of the conversation "
    + "you're responding to. If the assistant is on the right track, say so "
    + "explicitly. If they're stuck or off-track, name the specific assumption "
    + "or step to revisit. Aim for 2-5 paragraphs of substantive guidance."

  // Build a non-streaming request body. The conversation is forwarded
  // as the messages array; system is the advisor instruction.
  const advisorBody = JSON.stringify({
    model: resolveModel(advisorModel),
    max_tokens: 4096,
    system: advisorSystem,
    messages: conversation,
    stream: false,
  })

  const response = await createMessages(advisorBody, {})
  const json = (await response.json()) as AnyRecord
  // Anthropic message response shape: {content: [{type: "text", text: ...}], ...}
  const blocks = Array.isArray(json.content) ? json.content : []
  const text = blocks
    .filter((b: AnyRecord) => b.type === "text" && typeof b.text === "string")
    .map((b: AnyRecord) => b.text as string)
    .join("\n\n")
  if (!text) {
    throw new Error("Advisor model returned empty response")
  }
  return text
}

interface ToolUseTracker {
  /** Block index from the SSE stream */
  index: number
  /** tool_use_id assigned by the upstream model */
  id: string
  /** Accumulated input_json_delta text (advisor takes no input but
   *  we accumulate defensively) */
  inputJson: string
}

interface AssistantBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: AnyRecord
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
}): ReadableStream<Uint8Array> {
  const advisorModel = opts.advisorModel ?? ADVISOR_DEFAULT_MODEL

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const conversation = [...opts.initialConversation]
      let messageStartForwarded = false
      let nextSyntheticIndex = 0
      let turnsRun = 0

      const safeEnqueue = (bytes: Uint8Array): boolean => {
        try {
          controller.enqueue(bytes)
          return true
        } catch (err) {
          if (isControllerClosedError(err)) return false
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
        assistantBlocks: Array<AssistantBlock>
        advisorToolUse: ToolUseTracker | null
      }> {
        const assistantBlocks: Array<AssistantBlock> = []
        let advisorToolUse: ToolUseTracker | null = null
        // Track which upstream block index corresponds to which entry
        // in assistantBlocks (so deltas know which to update).
        const indexToBlock = new Map<number, AssistantBlock>()

        for await (const ev of events(response)) {
          if (!ev.event || !ev.data) continue
          let payload: AnyRecord
          try {
            payload = JSON.parse(ev.data) as AnyRecord
          } catch {
            // Non-JSON data — forward as-is (defensive).
            const ok = safeEnqueue(ENCODER.encode(`event: ${ev.event}\ndata: ${ev.data}\n\n`))
            if (!ok) return { assistantBlocks, advisorToolUse }
            continue
          }

          switch (ev.event) {
            case "message_start": {
              if (!messageStartForwarded) {
                if (!safeEnqueueEvent(ev.event, payload)) return { assistantBlocks, advisorToolUse }
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
                  advisorToolUse = {
                    index: myIndex,
                    id: typeof block.id === "string" ? block.id : `advisor_${myIndex}`,
                    inputJson: "",
                  }
                  const translated = {
                    ...payload,
                    index: myIndex,
                    content_block: {
                      type: "server_tool_use",
                      id: advisorToolUse.id,
                      name: ADVISOR_CLIENT_TOOL_NAME,
                      input: {},
                    },
                  }
                  if (!safeEnqueueEvent(ev.event, translated)) return { assistantBlocks, advisorToolUse }
                  // Track for later — we need this in the conversation
                  // for the next-turn Copilot call, but we use the
                  // INTERNAL name (Copilot doesn't know server_tool_use).
                  const ab: AssistantBlock = {
                    type: "tool_use",
                    id: advisorToolUse.id,
                    name: ADVISOR_INTERNAL_TOOL_NAME,
                    input: {},
                  }
                  assistantBlocks.push(ab)
                  indexToBlock.set(upstreamIndex, ab)
                } else {
                  // Forward as-is, with re-indexed.
                  const reindexed = { ...payload, index: myIndex }
                  if (!safeEnqueueEvent(ev.event, reindexed)) return { assistantBlocks, advisorToolUse }
                  const ab: AssistantBlock = {
                    type: typeof block.type === "string" ? block.type : "unknown",
                    id: typeof block.id === "string" ? block.id : undefined,
                    name: typeof block.name === "string" ? block.name : undefined,
                    text: typeof block.text === "string" ? block.text : undefined,
                  }
                  assistantBlocks.push(ab)
                  indexToBlock.set(upstreamIndex, ab)
                }
              }
              continue
            }

            case "content_block_delta": {
              const upstreamIndex = (payload as AnyRecord).index as number | undefined
              const delta = (payload as AnyRecord).delta as AnyRecord | undefined
              if (upstreamIndex !== undefined) {
                const ab =
                  upstreamIndex !== undefined ? indexToBlock.get(upstreamIndex) : undefined
                // Re-index for the outgoing event
                const reindexed = {
                  ...payload,
                  index: ab
                    ? assistantBlocks.indexOf(ab) >= 0
                      ? // Find the synthetic index by matching back.
                        nextSyntheticIndex - assistantBlocks.length + assistantBlocks.indexOf(ab)
                      : upstreamIndex
                    : upstreamIndex,
                }
                if (!safeEnqueueEvent(ev.event, reindexed)) return { assistantBlocks, advisorToolUse }
                // Accumulate text/input for re-call
                if (ab && delta) {
                  if (delta.type === "text_delta" && typeof delta.text === "string") {
                    ab.text = (ab.text ?? "") + delta.text
                  } else if (
                    delta.type === "input_json_delta"
                    && typeof delta.partial_json === "string"
                  ) {
                    if (!ab.input) ab.input = {} as AnyRecord
                    // We'll just track raw partial_json into ab.input as
                    // a hidden field; for advisor (no input) this is moot.
                  }
                }
              } else {
                if (!safeEnqueueEvent(ev.event, payload)) return { assistantBlocks, advisorToolUse }
              }
              continue
            }

            case "content_block_stop": {
              const upstreamIndex = (payload as AnyRecord).index as number | undefined
              const ab = upstreamIndex !== undefined ? indexToBlock.get(upstreamIndex) : undefined
              const reindexed = {
                ...payload,
                index: ab
                  ? nextSyntheticIndex - assistantBlocks.length + assistantBlocks.indexOf(ab)
                  : (upstreamIndex ?? 0),
              }
              if (!safeEnqueueEvent(ev.event, reindexed)) return { assistantBlocks, advisorToolUse }
              continue
            }

            case "message_delta": {
              // Forward as-is (usage updates etc.)
              if (!safeEnqueueEvent(ev.event, payload)) return { assistantBlocks, advisorToolUse }
              continue
            }

            case "message_stop": {
              // CRITICAL: do NOT forward yet if advisor was called —
              // we need to run advisor + continue the loop. message_stop
              // ends the entire outgoing assistant turn. Only emit it
              // when the advisor loop is fully done.
              if (advisorToolUse) {
                return { assistantBlocks, advisorToolUse }
              }
              if (!safeEnqueueEvent(ev.event, payload)) return { assistantBlocks, advisorToolUse }
              return { assistantBlocks, advisorToolUse }
            }

            default: {
              // Unknown event — forward as-is.
              if (!safeEnqueueEvent(ev.event, payload)) return { assistantBlocks, advisorToolUse }
            }
          }
        }
        return { assistantBlocks, advisorToolUse }
      }

      try {
        let response: Response = opts.firstResponse

        for (turnsRun = 0; turnsRun < ADVISOR_MAX_TURNS; turnsRun++) {
          const { assistantBlocks, advisorToolUse } = await processOneTurn(response)

          if (!advisorToolUse) {
            // No advisor call this turn — message_stop was already
            // forwarded. We're done.
            return
          }

          // Advisor was called this turn. Run advisor model with the
          // full conversation extended by the assistant turn.
          const assistantTurn = {
            role: "assistant",
            content: assistantBlocks.map((b) => {
              if (b.type === "text") return { type: "text", text: b.text ?? "" }
              if (b.type === "tool_use") {
                return {
                  type: "tool_use",
                  id: b.id,
                  name: b.name,
                  input: b.input ?? {},
                }
              }
              return { type: b.type }
            }),
          }
          conversation.push(assistantTurn)

          let advisorText: string
          try {
            advisorText = await runAdvisor(conversation, advisorModel)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            consola.warn(`Advisor model call failed: ${msg}`)
            advisorText =
              `[Advisor unavailable: ${msg}. Continuing without external review — `
              + `proceed with caution and consider self-checking against your "
              + "primary-source evidence.]`
          }

          // Synthesize advisor_tool_result block to client.
          const resultIndex = nextSyntheticIndex++
          const startOk = safeEnqueueEvent("content_block_start", {
            type: "content_block_start",
            index: resultIndex,
            content_block: {
              type: "advisor_tool_result",
              tool_use_id: advisorToolUse.id,
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
          const continuationBody = JSON.stringify({
            ...opts.baseBody,
            messages: conversation,
            stream: true,
          })
          response = await createMessages(continuationBody, opts.requestHeaders)
        }

        // Loop exhausted. Synthesize final message_stop + an error text
        // block so the client doesn't hang.
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
        const msg = err instanceof Error ? err.message : String(err)
        consola.error(`Advisor stream error: ${msg}`)
        safeEnqueueEvent("error", {
          type: "error",
          error: { type: "api_error", message: `advisor loop failed: ${msg}` },
        })
      } finally {
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
    },
  })
}
