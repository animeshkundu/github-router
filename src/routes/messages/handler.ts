import type { Context } from "hono"

import consola from "consola"

import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { checkRateLimit } from "~/lib/rate-limit"
import { logRequest } from "~/lib/request-log"
import { state } from "~/lib/state"
import { filterBetaHeader, resolveModel } from "~/lib/utils"
import { createMessages } from "~/services/copilot/create-messages"
import { searchWeb } from "~/services/copilot/web-search"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>

const isWebSearchTool = (tool: AnyRecord): boolean =>
  (typeof tool.type === "string" && tool.type.startsWith("web_search")) ||
  tool.name === "web_search"

/**
 * Extract whitelisted beta headers from the incoming request to forward
 * to the Copilot API. VS Code sends these to enable extended features
 * like thinking, context management, and advanced tool use.
 */
function extractBetaHeaders(c: Context): Record<string, string> {
  const headers: Record<string, string> = {}
  const anthropicBeta = c.req.header("anthropic-beta")
  if (anthropicBeta) {
    const filtered = filterBetaHeader(anthropicBeta)
    if (filtered) headers["anthropic-beta"] = filtered
  }
  return headers
}

/**
 * Extract the text content from the last user message for web search.
 * Handles both string content and content block arrays (multimodal).
 */
function extractUserQuery(
  messages: Array<AnyRecord>,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user") {
      if (typeof msg.content === "string") return msg.content
      if (Array.isArray(msg.content)) {
        const textBlock = msg.content.find(
          (block: AnyRecord) => block.type === "text",
        )
        if (textBlock?.text) return textBlock.text as string
      }
    }
  }
  return undefined
}

/**
 * Check if any user message contains tool_result content blocks,
 * indicating a follow-up turn where we should skip web search.
 * In Anthropic format, tool results are content blocks inside user messages,
 * NOT separate role: "tool" messages like in OpenAI format.
 */
function hasToolResultContent(messages: Array<AnyRecord>): boolean {
  return messages.some(
    (msg) =>
      Array.isArray(msg.content) &&
      msg.content.some(
        (block: AnyRecord) => block.type === "tool_result",
      ),
  )
}

/**
 * Inject web search results into the Anthropic system field.
 * Handles three cases: absent, string, or array of content blocks.
 * When array, prepends without cache_control to preserve existing directives.
 */
function injectSearchResults(
  body: AnyRecord,
  searchContext: string,
): void {
  if (body.system === undefined || body.system === null) {
    body.system = searchContext
  } else if (typeof body.system === "string") {
    body.system = `${searchContext}\n\n${body.system}`
  } else if (Array.isArray(body.system)) {
    body.system = [
      { type: "text", text: searchContext },
      ...body.system,
    ]
  }
}

/**
 * Strip web_search tools from the request and clean up tool_choice.
 * Returns the modified body object.
 */
function stripWebSearchTool(body: AnyRecord): void {
  if (!body.tools) return

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
    // If tool_choice forced the removed web_search tool, fall back to auto
    const choiceName = body.tool_choice.name
    if (
      choiceName &&
      !body.tools.some((tool: AnyRecord) => tool.name === choiceName)
    ) {
      body.tool_choice = { type: "auto" }
    }
  }
}

/**
 * Process web search if the request contains a web_search tool.
 * Performs the search, injects results into system, and strips the tool.
 * Returns the (possibly modified) body string to forward.
 */
async function processWebSearch(rawBody: string): Promise<string> {
  // Fast path: skip parsing if no web_search tool present
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

  // Skip search on follow-up messages (tool call results)
  const hasToolResult = hasToolResultContent(body.messages ?? [])
  const query = hasToolResult ? undefined : extractUserQuery(body.messages ?? [])

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

      injectSearchResults(body, searchContext)
    } catch (error) {
      consola.warn("Web search failed, continuing without results:", error)
    }
  }

  // Always strip web_search tool regardless of whether search succeeded
  stripWebSearchTool(body)

  return JSON.stringify(body)
}

export async function handleCompletion(c: Context) {
  const startTime = Date.now()
  await checkRateLimit(state)

  const rawBody = await c.req.text()

  const debugEnabled = consola.level >= 4
  if (debugEnabled) {
    consola.debug("Anthropic request body:", rawBody.slice(0, 2000))
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  const betaHeaders = extractBetaHeaders(c)
  const finalBody = await processWebSearch(rawBody)

  // Resolve model name (e.g. opus → opus-1m variant)
  const { body: resolvedBody, originalModel, resolvedModel } = resolveModelInBody(finalBody)

  // Look up model metadata for context window info
  const selectedModel = state.models?.data.find(
    (m) => m.id === (resolvedModel ?? originalModel),
  )

  // Apply default anthropic-beta for Claude models when client sends none
  const effectiveBetas = applyDefaultBetas(betaHeaders, resolvedModel ?? originalModel)

  let response: Response
  try {
    response = await createMessages(resolvedBody, {
      ...selectedModel?.requestHeaders,
      ...effectiveBetas,
    })
  } catch (error) {
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
  }

  const contentType = response.headers.get("content-type") ?? ""
  const isStreaming = contentType.includes("text/event-stream")

  // Streaming: pipe the upstream SSE response body directly
  if (isStreaming) {
    logRequest(
      {
        method: "POST",
        path: c.req.path,
        model: originalModel,
        resolvedModel,
        status: response.status,
        streaming: true,
      },
      selectedModel,
      startTime,
    )

    if (debugEnabled) {
      consola.debug("Streaming response from Copilot /v1/messages")
    }
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    })
  }

  // Non-streaming: extract usage from response body
  const responseBody = (await response.json()) as AnyRecord

  logRequest(
    {
      method: "POST",
      path: c.req.path,
      model: originalModel,
      resolvedModel,
      inputTokens: responseBody.usage?.input_tokens,
      outputTokens: responseBody.usage?.output_tokens,
      status: response.status,
    },
    selectedModel,
    startTime,
  )

  if (debugEnabled) {
    consola.debug(
      "Non-streaming response from Copilot /v1/messages:",
      JSON.stringify(responseBody).slice(0, 2000),
    )
  }
  return c.json(responseBody, response.status as 200)
}

/**
 * Parse the JSON body, resolve the model name, and re-serialize.
 * Returns the body string plus the original and resolved model names.
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

/**
 * Apply default anthropic-beta values for Claude models when the client
 * (e.g. curl) sends no beta headers. Claude CLI sends its own betas,
 * so this only fires as a safety net for bare clients.
 */
function applyDefaultBetas(
  betaHeaders: Record<string, string>,
  modelId?: string,
): Record<string, string> {
  if (betaHeaders["anthropic-beta"]) return betaHeaders
  if (!modelId || !modelId.startsWith("claude-")) return betaHeaders

  return {
    ...betaHeaders,
    "anthropic-beta": [
      "interleaved-thinking-2025-05-14",
      "token-counting-2024-11-01",
    ].join(","),
  }
}
