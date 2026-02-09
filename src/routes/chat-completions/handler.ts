import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type Message,
} from "~/services/copilot/create-chat-completions"
import { searchWeb } from "~/services/copilot/web-search"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  await injectWebSearchIfNeeded(payload)

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info("Current token count:", tokenCount)
    } else {
      consola.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  const response = await createChatCompletions(payload)

  if (isNonStreaming(response)) {
    consola.debug("Non-streaming response:", JSON.stringify(response))
    return c.json(response)
  }

  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      consola.debug("Streaming chunk:", JSON.stringify(chunk))
      await stream.writeSSE(chunk as SSEMessage)
    }
  })
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
