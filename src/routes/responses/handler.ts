import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { isNullish } from "~/lib/utils"
import {
  createResponses,
  type ResponsesApiResponse,
  type ResponsesInputItem,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"
import { searchWeb } from "~/services/copilot/web-search"

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  consola.debug(
    "Responses request payload:",
    JSON.stringify(payload).slice(-400),
  )

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  consola.info("Token counting not yet supported for /responses endpoint")

  if (state.manualApprove) await awaitApproval()

  await injectWebSearchIfNeeded(payload)

  if (isNullish(payload.max_output_tokens)) {
    payload.max_output_tokens =
      selectedModel?.capabilities.limits.max_output_tokens
    consola.debug(
      "Set max_output_tokens to:",
      JSON.stringify(payload.max_output_tokens),
    )
  }

  const response = await createResponses(payload)

  if (isNonStreaming(response)) {
    consola.debug("Non-streaming response:", JSON.stringify(response))
    return c.json(response)
  }

  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      consola.debug("Streaming chunk:", JSON.stringify(chunk))

      if (chunk.data === "[DONE]") {
        break
      }

      if (!chunk.data) {
        continue
      }

      await stream.writeSSE({
        data: chunk.data,
        event: chunk.event,
        id: chunk.id?.toString(),
      })
    }
  })
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

    payload.instructions =
      payload.instructions ?
        `${searchContext}\n\n${payload.instructions}`
      : searchContext
  } catch (error) {
    consola.warn("Web search failed, continuing without results:", error)
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
