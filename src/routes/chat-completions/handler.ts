import type { Context } from "hono"

import consola from "consola"

import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { logEndpointMismatch } from "~/lib/model-validation"
import { checkRateLimit } from "~/lib/rate-limit"
import { logRequest } from "~/lib/request-log"
import { UPSTREAM_INACTIVITY_TIMEOUT_MS } from "~/lib/port"
import { state } from "~/lib/state"
import { buildOpenAIErrorEvent, isControllerClosedError, logStreamError, readIteratorWithTimeout } from "~/lib/stream-relay"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish, resolveModel } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type Message,
} from "~/services/copilot/create-chat-completions"
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

export async function handleCompletion(c: Context) {
  const startTime = Date.now()
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  const debugEnabled = consola.level >= 4
  if (debugEnabled) {
    consola.debug("Request payload:", JSON.stringify(payload).slice(-400))
  }

  if (state.manualApprove) await awaitApproval()

  await injectWebSearchIfNeeded(payload)

  // Resolve model name (e.g. opus → opus-1m variant)
  const originalModel = payload.model
  const resolvedModel = resolveModel(payload.model)
  if (resolvedModel !== payload.model) {
    payload.model = resolvedModel
  }

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  logEndpointMismatch(payload.model, "/chat/completions")

  // Calculate token count
  let inputTokens: number | undefined
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      inputTokens = tokenCount.input
    }
  } catch {
    // Token counting is best-effort
  }

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities?.limits?.max_output_tokens,
    }
    if (debugEnabled) {
      consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
    }
  }

  // retryTransient: true — pre-first-byte retry; the body is consumed only
  // after the ok-check inside createChatCompletions, so a re-issue here
  // cannot duplicate streamed output.
  const response = await createChatCompletions(
    payload,
    selectedModel?.requestHeaders,
    undefined,
    true,
  ).catch(
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

  // Extract output tokens from non-streaming response (no extra call)
  const outputTokens = !isStreaming
    ? (response as ChatCompletionResponse).usage?.completion_tokens
    : undefined

  logRequest(
    {
      method: "POST",
      path: c.req.path,
      model: originalModel,
      resolvedModel,
      inputTokens,
      outputTokens,
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
  const iterator = (response as AsyncIterableIterator<UpstreamSSEEvent>)[
    Symbol.asyncIterator
  ]()
  const firstResult = await readIteratorWithTimeout(iterator, UPSTREAM_INACTIVITY_TIMEOUT_MS)
  if (firstResult.done) {
    consola.warn(
      `Upstream /chat/completions returned an empty stream at ${c.req.path}`,
    )
  }

  let pendingFirstChunk: UpstreamSSEEvent | undefined = firstResult.done
    ? undefined
    : firstResult.value
  let upstreamFinished = firstResult.done
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
          // would crash formatSSE() below. Skip silently and pull again on
          // the next consumer demand. Real upstream iterators never emit
          // this shape, but a misbehaving / proxied iterator might.
          if (result.value === undefined || result.value === null) return
          if (debugEnabled) {
            consola.debug("Streaming chunk:", JSON.stringify(result.value))
          }
          safeEnqueue(controller, ENCODER.encode(formatSSE(result.value)))
        } catch (error) {
          upstreamFinished = true
          if (consumerCancelled) {
            // Consumer-cancelled mid-pull, not an upstream failure. Close
            // so the consumer's read settles cleanly. Also release the
            // upstream iterator — the cancel() callback may not have
            // fired if the controller was closed by Bun's HTTP layer.
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
          // We've decided this stream is done — release the upstream
          // iterator since the cancel() callback won't fire on a
          // server-initiated close.
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
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

async function injectWebSearchIfNeeded(
  payload: ChatCompletionsPayload,
): Promise<void> {
  const hasWebSearch = payload.tools?.some(
    (t) =>
      ("type" in t && (t as unknown as Record<string, unknown>).type === "web_search")
      || t.function?.name === "web_search",
  )
  if (!hasWebSearch) return

  // Skip search on follow-up messages (tool call results)
  const hasToolResult = payload.messages.some((msg) => msg.role === "tool")
  const query = hasToolResult ? undefined : extractUserQuery(payload.messages)

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

      // Prepend to existing system message or inject a new one
      const systemMsg = payload.messages.find((msg) => msg.role === "system")
      if (systemMsg) {
        const existingContent =
          typeof systemMsg.content === "string" ? systemMsg.content
          : Array.isArray(systemMsg.content) ?
            systemMsg.content
              .filter((p) => p.type === "text")
              .map((p) => ("text" in p ? p.text : ""))
              .join("\n")
          : ""
        systemMsg.content = `${searchContext}\n\n${existingContent}`
      } else {
        payload.messages.unshift({
          role: "system",
          content: searchContext,
        })
      }
    } catch (error) {
      consola.warn("Web search failed, continuing without results:", error)
    }
  }

  // Remove web_search from tools before forwarding
  payload.tools = payload.tools?.filter(
    (t) =>
      !(
        ("type" in t && (t as unknown as Record<string, unknown>).type === "web_search")
        || t.function?.name === "web_search"
      ),
  ) as typeof payload.tools
  if (payload.tools?.length === 0) {
    payload.tools = undefined
  }
  if (!payload.tools) {
    payload.tool_choice = undefined
  } else if (
    payload.tool_choice
    && typeof payload.tool_choice === "object"
    && "type" in payload.tool_choice
    && payload.tool_choice.type === "function"
  ) {
    const toolChoiceName = payload.tool_choice.function?.name
    if (
      toolChoiceName
      && !payload.tools.some((tool) => tool.function.name === toolChoiceName)
    ) {
      payload.tool_choice = undefined
    }
  }
}

function extractUserQuery(messages: Array<Message>): string | undefined {
  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user") {
      if (typeof msg.content === "string") return msg.content
      if (Array.isArray(msg.content)) {
        const text = msg.content.find((p) => p.type === "text")
        if (text && "text" in text) return text.text as string
      }
    }
  }
  return undefined
}
