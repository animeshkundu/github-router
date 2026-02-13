import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { logRequest } from "~/lib/request-log"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish, resolveModel } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type Message,
} from "~/services/copilot/create-chat-completions"
import { searchWeb } from "~/services/copilot/web-search"

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
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    if (debugEnabled) {
      consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
    }
  }

  const response = await createChatCompletions(payload)
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

  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      if (debugEnabled) {
        consola.debug("Streaming chunk:", JSON.stringify(chunk))
      }
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
