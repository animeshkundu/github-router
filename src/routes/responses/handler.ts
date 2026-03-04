import { randomUUID } from "node:crypto"
import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { logEndpointMismatch } from "~/lib/model-validation"
import { checkRateLimit } from "~/lib/rate-limit"
import { logRequest } from "~/lib/request-log"
import { state } from "~/lib/state"
import { resolveModel } from "~/lib/utils"
import {
  createResponses,
  type ResponsesApiResponse,
  type ResponsesInputItem,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"
import { searchWeb } from "~/services/copilot/web-search"

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

  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      if (debugEnabled) {
        consola.debug("Streaming chunk:", JSON.stringify(chunk))
      }

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
  const response = await fetch(
    `${copilotBaseUrl(state)}/responses/compact`,
    {
      method: "POST",
      headers: copilotHeaders(state),
      body: JSON.stringify(body),
    },
  )

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
