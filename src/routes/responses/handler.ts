import { randomUUID } from "node:crypto"
import type { Context } from "hono"

import consola from "consola"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { logEndpointMismatch } from "~/lib/model-validation"
import { UPSTREAM_FETCH_TIMEOUT_MS } from "~/lib/port"
import { checkRateLimit } from "~/lib/rate-limit"
import { logRequest } from "~/lib/request-log"
import { UPSTREAM_INACTIVITY_TIMEOUT_MS } from "~/lib/port"
import { state } from "~/lib/state"
import { buildOpenAIErrorEvent, isControllerClosedError, logStreamError, readIteratorWithTimeout } from "~/lib/stream-relay"
import { tryRefreshAndRetry } from "~/lib/token"
import { resolveModel } from "~/lib/utils"
import {
  createResponses,
  type ResponsesApiResponse,
  type ResponsesInputItem,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"
import { searchWeb } from "~/services/copilot/web-search"

interface UpstreamSSEEvent {
  event?: string
  data?: string
  id?: string | number
}

const ENCODER = new TextEncoder()

function formatSSE(chunk: UpstreamSSEEvent): string {
  const parts: Array<string> = []
  if (chunk.event) parts.push(`event: ${chunk.event}`)
  if (chunk.data !== undefined) {
    for (const line of String(chunk.data).split(/\r\n|\r|\n/)) {
      parts.push(`data: ${line}`)
    }
  }
  if (chunk.id !== undefined) parts.push(`id: ${String(chunk.id)}`)
  return parts.join("\n") + "\n\n"
}

export async function handleResponses(c: Context) {
  const startTime = Date.now()
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  const debugEnabled = consola.level >= 4
  if (debugEnabled) {
    consola.debug(
      "Responses request payload:",
      JSON.stringify(payload).slice(-400),
    )
  }

  // Resolve model name (e.g. opus → opus-1m variant)
  const originalModel = payload.model
  const resolvedModel = resolveModel(payload.model)
  if (resolvedModel !== payload.model) {
    payload.model = resolvedModel
  }

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  logEndpointMismatch(payload.model, "/responses")

  if (state.manualApprove) await awaitApproval()

  await injectWebSearchIfNeeded(payload)

  const response = await createResponses(payload, selectedModel?.requestHeaders).catch(
    async (error: unknown) => {
      if (error instanceof HTTPError) {
        const errorBody = await error.response.clone().text().catch(() => "")
        logRequest(
          {
            method: "POST",
            path: c.req.path,
            model: originalModel,
            resolvedModel,
            status: error.response.status,
            errorBody,
          },
          selectedModel,
          startTime,
        )
      }
      throw error
    },
  )
  const isStreaming = !isNonStreaming(response)

  logRequest(
    {
      method: "POST",
      path: c.req.path,
      model: originalModel,
      resolvedModel,
      status: 200,
      streaming: isStreaming,
    },
    selectedModel,
    startTime,
  )

  if (!isStreaming) {
    if (debugEnabled) {
      consola.debug("Non-streaming response:", JSON.stringify(response))
    }
    return c.json(response)
  }

  // Streaming: peek the first SSE event so pre-byte upstream errors surface
  // through the route's try/catch → forwardError as a clean JSON response,
  // and only mid-stream errors hit the manual ReadableStream's pull-error path.
  // The /responses iterator emits a final `[DONE]` sentinel which we drop.
  const iterator = (response as AsyncIterableIterator<UpstreamSSEEvent>)[
    Symbol.asyncIterator
  ]()

  // Skip leading empty / [DONE] sentinels until we get a real event.
  let firstChunk: UpstreamSSEEvent | undefined
  let upstreamFinished = false
  while (true) {
    const r = await readIteratorWithTimeout(iterator, UPSTREAM_INACTIVITY_TIMEOUT_MS)
    if (r.done) {
      upstreamFinished = true
      break
    }
    // Defensive guard against an iterator that yields {done:false, value:undefined}
    // before we dereference r.value.data below.
    if (r.value === undefined || r.value === null) continue
    if (r.value.data === "[DONE]") {
      upstreamFinished = true
      break
    }
    if (!r.value.data) continue
    firstChunk = r.value
    break
  }
  if (firstChunk === undefined) {
    consola.warn(
      `Upstream /responses returned no payload events at ${c.req.path}`,
    )
  }

  let pendingFirstChunk: UpstreamSSEEvent | undefined = firstChunk
  let consumerCancelled = false

  const safeClose = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    try {
      controller.close()
    } catch {
      // already closed / errored
    }
  }
  const releaseUpstream = (reason?: unknown) => {
    if (typeof iterator.return === "function") {
      iterator.return(reason).catch(() => {
        // upstream may already be closed
      })
    }
  }
  const safeEnqueue = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    bytes: Uint8Array,
  ): boolean => {
    try {
      controller.enqueue(bytes)
      return true
    } catch (e) {
      if (isControllerClosedError(e)) {
        consumerCancelled = true
        // The downstream cancel() callback may not fire if the controller
        // was closed by Bun's HTTP layer rather than an explicit consumer
        // .cancel() — release the upstream iterator here so the upstream
        // socket does not leak.
        releaseUpstream(e)
        return false
      }
      throw e
    }
  }

  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (consumerCancelled || upstreamFinished) {
          safeClose(controller)
          return
        }
        if (pendingFirstChunk !== undefined) {
          const chunk = pendingFirstChunk
          pendingFirstChunk = undefined
          if (debugEnabled) {
            consola.debug("Streaming chunk:", JSON.stringify(chunk))
          }
          safeEnqueue(controller, ENCODER.encode(formatSSE(chunk)))
          return
        }
        try {
          const result = await readIteratorWithTimeout(iterator, UPSTREAM_INACTIVITY_TIMEOUT_MS)
          if (consumerCancelled) {
            safeClose(controller)
            return
          }
          if (result.done) {
            upstreamFinished = true
            safeClose(controller)
            return
          }
          // Defensive: an upstream iterator that yields `{done:false, value:undefined}`
          // would crash on `result.value.data` below. Skip silently and
          // pull again on the next consumer demand. Real upstream iterators
          // never emit this shape, but a misbehaving / proxied iterator might.
          if (result.value === undefined || result.value === null) return
          if (result.value.data === "[DONE]") {
            upstreamFinished = true
            safeClose(controller)
            return
          }
          if (!result.value.data) return
          if (debugEnabled) {
            consola.debug("Streaming chunk:", JSON.stringify(result.value))
          }
          safeEnqueue(controller, ENCODER.encode(formatSSE(result.value)))
        } catch (error) {
          upstreamFinished = true
          if (consumerCancelled) {
            // Consumer-cancelled mid-pull. Release the upstream iterator
            // — the cancel() callback may not have fired if the controller
            // was closed by Bun's HTTP layer.
            //
            // We deliberately do NOT call isControllerClosedError(error)
            // on iterator-side errors here — the helper matches substrings
            // like "stream is closed" which can appear in real upstream
            // errors, and treating them as consumer-cancel would silently
            // suppress the OpenAI-shape error frame the consumer needs.
            releaseUpstream(error)
            safeClose(controller)
            return
          }
          const { errName, errMessage } = logStreamError(c.req.path, error)
          safeEnqueue(
            controller,
            ENCODER.encode(buildOpenAIErrorEvent(errName, errMessage)),
          )
          // Server-initiated close — release the upstream iterator since
          // our cancel() callback won't fire.
          releaseUpstream(error)
          safeClose(controller)
        }
      },
      cancel() {
        consumerCancelled = true
        upstreamFinished = true
        releaseUpstream()
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "transfer-encoding": "chunked",
        connection: "keep-alive",
      },
    },
  )
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createResponses>>,
): response is ResponsesApiResponse => Object.hasOwn(response, "output")

async function injectWebSearchIfNeeded(
  payload: ResponsesPayload,
): Promise<void> {
  const hasWebSearch = payload.tools?.some((t) => t.type === "web_search")
  if (!hasWebSearch) return

  // Skip search on follow-up messages (function call results)
  if (Array.isArray(payload.input)) {
    const hasFollowUp = payload.input.some(
      (item: ResponsesInputItem) => item.type === "function_call_output",
    )
    if (hasFollowUp) return
  }

  const query = extractUserQuery(payload.input)
  if (query) {
    try {
      const results = await searchWeb(query)
      const searchContext = [
        "[Web Search Results]",
        results.content,
        "",
        results.references.map((r) => `- [${r.title}](${r.url})`).join("\n"),
        "[End Web Search Results]",
      ].join("\n")

      payload.instructions =
        payload.instructions ?
          `${searchContext}\n\n${payload.instructions}`
        : searchContext
    } catch (error) {
      consola.warn("Web search failed, continuing without results:", error)
    }
  }

  // Strip the legacy `web_search` tool — defensive. Copilot's /responses
  // empirically accepts bare `web_search` on gpt-5.x today (2026-05-15
  // probe `web_search_responses_preview`: model invokes it natively, output
  // contains a `web_search_call` block), and also accepts the explicit
  // `web_search_preview` / `web_search_preview_2025_03_11` shapes. We strip
  // here as belt-and-suspenders against version drift across Copilot tiers
  // — the proxy's MCP fallback (`injectWebSearchIfNeeded`) substitutes a
  // pre-fetched result so the user-facing path always works regardless of
  // upstream support. Lift this strip if/when we trust bare `web_search`
  // across all served gpt-5.x variants. Other tool types pass through
  // unchanged.
  payload.tools = payload.tools?.filter((t) => t.type !== "web_search")
  if (payload.tools && payload.tools.length === 0) {
    payload.tools = undefined
  }
  if (!payload.tools) {
    payload.tool_choice = undefined
  } else if (
    payload.tool_choice
    && typeof payload.tool_choice === "object"
  ) {
    const choice = payload.tool_choice as {
      name?: string
      function?: { name?: string }
    }
    const choiceName = choice.function?.name ?? choice.name
    if (choiceName === "web_search") {
      payload.tool_choice = undefined
    }
  }
}

function extractUserQuery(
  input: ResponsesPayload["input"],
): string | undefined {
  if (typeof input === "string") return input
  if (!Array.isArray(input)) return undefined

  // Find the last user message
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i]
    if ("role" in item && item.role === "user") {
      if (typeof item.content === "string") return item.content
      if (Array.isArray(item.content)) {
        const text = item.content.find(
          (p: Record<string, unknown>) => p.type === "input_text",
        )
        if (text && "text" in text) return text.text as string
      }
    }
  }
  return undefined
}

/**
 * Compaction prompt used when GitHub Copilot API does not support
 * /responses/compact natively. Matches the prompt Codex CLI uses for
 * local (non-OpenAI) compaction.
 */
const COMPACTION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`

interface CompactRequestPayload {
  model: string
  input: Array<Record<string, unknown>>
  instructions?: string
  [key: string]: unknown
}

export async function handleResponsesCompact(c: Context) {
  const startTime = Date.now()
  await checkRateLimit(state)

  if (!state.copilotToken) throw new Error("Copilot token not found")

  if (state.manualApprove) await awaitApproval()

  const body = await c.req.json<CompactRequestPayload>()

  // Try Copilot's native compact endpoint first (future-proofs for when they add support)
  const compactUrl = `${copilotBaseUrl(state)}/responses/compact`
  const doFetch = (): Promise<Response> => fetch(compactUrl, {
    method: "POST",
    headers: copilotHeaders(state),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS || 300_000),
  })
  const response = await tryRefreshAndRetry(doFetch, "/responses/compact")

  if (response.ok) {
    logRequest(
      { method: "POST", path: c.req.path, status: 200 },
      undefined,
      startTime,
    )
    return c.json(await response.json())
  }

  // Copilot doesn't support /responses/compact — perform synthetic compaction
  // by sending a regular /responses call with a summarization prompt
  if (response.status === 404) {
    consola.debug("Copilot API does not support /responses/compact, using synthetic compaction")
    // Consume the 404 response body to release the upstream TCP connection.
    await response.body?.cancel().catch(() => {})
    return await syntheticCompact(c, body, startTime)
  }

  // Other errors: throw as before
  logRequest(
    { method: "POST", path: c.req.path, status: response.status },
    undefined,
    startTime,
  )
  throw new HTTPError("Copilot responses/compact request failed", response)
}

/**
 * Synthetic compaction: sends the conversation history to Copilot's
 * regular /responses endpoint with a compaction prompt appended,
 * then returns the model's summary in the compact response format.
 */
async function syntheticCompact(
  c: Context,
  body: CompactRequestPayload,
  startTime: number,
) {
  const input = Array.isArray(body.input) ? [...body.input] : []

  // Append compaction prompt as the last user message
  input.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: COMPACTION_PROMPT }],
  })

  const payload: ResponsesPayload = {
    model: body.model,
    input: input as Array<ResponsesInputItem>,
    instructions: body.instructions,
    stream: false,
    store: false,
  }

  let result: ResponsesApiResponse
  try {
    result = (await createResponses(payload)) as ResponsesApiResponse
  } catch (error) {
    if (error instanceof HTTPError) {
      logRequest(
        { method: "POST", path: c.req.path, status: error.response.status },
        undefined,
        startTime,
      )
    }
    throw error
  }

  logRequest(
    { method: "POST", path: c.req.path, status: 200 },
    undefined,
    startTime,
  )

  return c.json({
    id: `resp_compact_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "response.compaction",
    created_at: Math.floor(Date.now() / 1000),
    output: result.output,
    usage: result.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  })
}
