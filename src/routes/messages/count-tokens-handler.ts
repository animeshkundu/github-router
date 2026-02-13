import type { Context } from "hono"

import { logRequest } from "~/lib/request-log"
import { filterBetaHeader, resolveModel } from "~/lib/utils"
import { state } from "~/lib/state"
import { countTokens } from "~/services/copilot/create-messages"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>

const isWebSearchTool = (tool: AnyRecord): boolean =>
  (typeof tool.type === "string" && tool.type.startsWith("web_search")) ||
  tool.name === "web_search"

/**
 * Strip web_search tools from the request body before forwarding
 * to Copilot's count_tokens endpoint, which rejects unknown tool types.
 * Returns the original raw body if no web_search tools are present.
 */
function stripWebSearchFromBody(rawBody: string): string {
  if (!rawBody.includes("web_search")) return rawBody

  let body: AnyRecord
  try {
    body = JSON.parse(rawBody)
  } catch {
    return rawBody
  }

  const hasWebSearch = body.tools?.some(
    (tool: AnyRecord) => isWebSearchTool(tool),
  )
  if (!hasWebSearch) return rawBody

  body.tools = body.tools.filter(
    (tool: AnyRecord) => !isWebSearchTool(tool),
  )

  if (body.tools.length === 0) {
    body.tools = undefined
    body.tool_choice = undefined
  } else if (
    body.tool_choice &&
    typeof body.tool_choice === "object" &&
    body.tool_choice.type === "tool"
  ) {
    const choiceName = body.tool_choice.name
    if (
      choiceName &&
      !body.tools.some((tool: AnyRecord) => tool.name === choiceName)
    ) {
      body.tool_choice = { type: "auto" }
    }
  }

  return JSON.stringify(body)
}

/**
 * Passthrough handler for Anthropic token counting.
 * Strips web_search tools and forwards beta headers to Copilot's
 * native /v1/messages/count_tokens endpoint.
 */
export async function handleCountTokens(c: Context) {
  const startTime = Date.now()
  const rawBody = await c.req.text()
  const strippedBody = stripWebSearchFromBody(rawBody)
  const { body: finalBody, originalModel, resolvedModel } = resolveModelInBody(strippedBody)

  const extraHeaders: Record<string, string> = {}
  const anthropicBeta = c.req.header("anthropic-beta")
  if (anthropicBeta) {
    const filtered = filterBetaHeader(anthropicBeta)
    if (filtered) extraHeaders["anthropic-beta"] = filtered
  }

  const response = await countTokens(finalBody, extraHeaders)
  const responseBody = (await response.json()) as { input_tokens?: number }

  const modelId = resolvedModel ?? originalModel
  const selectedModel = state.models?.data.find((m) => m.id === modelId)

  logRequest(
    {
      method: "POST",
      path: c.req.path,
      model: originalModel,
      resolvedModel,
      inputTokens: responseBody.input_tokens,
      status: response.status,
    },
    selectedModel,
    startTime,
  )

  return c.json(responseBody)
}

/**
 * Parse the JSON body, resolve the model name, and re-serialize.
 */
function resolveModelInBody(rawBody: string): {
  body: string
  originalModel?: string
  resolvedModel?: string
} {
  let parsed: AnyRecord
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return { body: rawBody }
  }

  const originalModel =
    typeof parsed.model === "string" ? parsed.model : undefined
  if (!originalModel) return { body: rawBody, originalModel }

  const resolved = resolveModel(originalModel)
  if (resolved === originalModel)
    return { body: rawBody, originalModel, resolvedModel: originalModel }

  parsed.model = resolved
  return {
    body: JSON.stringify(parsed),
    originalModel,
    resolvedModel: resolved,
  }
}
