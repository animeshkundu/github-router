import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { searchWeb } from "~/services/copilot/web-search"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  await injectWebSearchIfNeeded(anthropicPayload)

  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

async function injectWebSearchIfNeeded(
  payload: AnthropicMessagesPayload,
): Promise<void> {
  const hasWebSearch = payload.tools?.some((t) => t.name === "web_search")
  if (!hasWebSearch) return

  // Skip search on follow-up messages (tool results)
  const hasToolResult = payload.messages.some(
    (msg) =>
      msg.role === "user"
      && Array.isArray(msg.content)
      && msg.content.some(
        (block) => "type" in block && block.type === "tool_result",
      ),
  )
  if (hasToolResult) return

  const query = extractUserQuery(payload.messages)
  if (!query) return

  try {
    const results = await searchWeb(query)
    const searchContext = [
      "[Web Search Results]",
      results.content,
      "",
      results.references.map((r) => `- [${r.title}](${r.url})`).join("\n"),
      "[End Web Search Results]",
    ].join("\n")

    if (typeof payload.system === "string") {
      payload.system = `${searchContext}\n\n${payload.system}`
    } else if (Array.isArray(payload.system)) {
      payload.system = [
        { type: "text", text: searchContext },
        ...payload.system,
      ]
    } else {
      payload.system = searchContext
    }
  } catch (error) {
    consola.warn("Web search failed, continuing without results:", error)
  }

  // Remove web_search from tools before translation
  payload.tools = payload.tools?.filter((t) => t.name !== "web_search")
  if (payload.tools?.length === 0) {
    payload.tools = undefined
  }
}

function extractUserQuery(
  messages: AnthropicMessagesPayload["messages"],
): string | undefined {
  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user") {
      if (typeof msg.content === "string") return msg.content
      if (Array.isArray(msg.content)) {
        const text = msg.content.find(
          (block) => "type" in block && block.type === "text",
        )
        if (text && "text" in text) return text.text as string
      }
    }
  }
  return undefined
}
