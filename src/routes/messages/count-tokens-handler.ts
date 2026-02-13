import type { Context } from "hono"

import consola from "consola"

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
  const rawBody = await c.req.text()
  const finalBody = stripWebSearchFromBody(rawBody)

  const extraHeaders: Record<string, string> = {}
  const anthropicBeta = c.req.header("anthropic-beta")
  if (anthropicBeta) extraHeaders["anthropic-beta"] = anthropicBeta
  const capiBeta = c.req.header("capi-beta-1")
  if (capiBeta) extraHeaders["capi-beta-1"] = capiBeta

  const response = await countTokens(finalBody, extraHeaders)
  const body = await response.json()

  consola.info("Token count:", JSON.stringify(body))

  return c.json(body)
}
