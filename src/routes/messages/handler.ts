import type { Context } from "hono"

import consola from "consola"

import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { logEndpointMismatch } from "~/lib/model-validation"
import { checkRateLimit } from "~/lib/rate-limit"
import { logRequest } from "~/lib/request-log"
import { state } from "~/lib/state"
import { filterBetaHeader, resolveModel } from "~/lib/utils"
import { createMessages } from "~/services/copilot/create-messages"
import type { Model } from "~/services/copilot/get-models"
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

  // Resolve model name (e.g. opus → opus-1m variant) and translate
  // thinking-mode shape for adaptive-thinking models.
  const {
    body: resolvedBody,
    originalModel,
    resolvedModel,
    selectedModel,
  } = resolveModelInBody(finalBody)

  const modelId = resolvedModel ?? originalModel
  if (modelId) logEndpointMismatch(modelId, "/v1/messages")

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
    const streamHeaders: Record<string, string> = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    }
    const requestId = response.headers.get("x-request-id")
    if (requestId) streamHeaders["x-request-id"] = requestId
    const reqId = response.headers.get("request-id")
    if (reqId) streamHeaders["request-id"] = reqId

    return new Response(response.body, {
      status: response.status,
      headers: streamHeaders,
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
  const xRequestId = response.headers.get("x-request-id")
  if (xRequestId) c.header("x-request-id", xRequestId)
  const requestIdHeader = response.headers.get("request-id")
  if (requestIdHeader) c.header("request-id", requestIdHeader)
  return c.json(responseBody, response.status as 200)
}

/**
 * Parse the JSON body, resolve the model name, sanitize cache_control
 * fields, translate thinking-mode shape for adaptive-thinking models,
 * and re-serialize. Returns the body string, original/resolved model
 * names, and the matching model metadata (if any).
 *
 * Re-serialization is skipped when no modifications are needed.
 */
function resolveModelInBody(rawBody: string): {
  body: string
  originalModel?: string
  resolvedModel?: string
  selectedModel?: Model
} {
  let parsed: AnyRecord
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return { body: rawBody }
  }

  const originalModel =
    typeof parsed.model === "string" ? parsed.model : undefined

  let modified = false
  if (originalModel) {
    const resolved = resolveModel(originalModel)
    if (resolved !== originalModel) {
      parsed.model = resolved
      modified = true
    }
  }

  const resolvedModel =
    typeof parsed.model === "string" ? parsed.model : originalModel

  const selectedModel = resolvedModel
    ? state.models?.data.find((m) => m.id === resolvedModel)
    : undefined

  // Translate thinking-mode shape for adaptive-thinking models — Copilot
  // wants {type:"adaptive"} + output_config.effort, not Anthropic's
  // {type:"enabled", budget_tokens}.
  if (translateThinking(parsed, selectedModel)) {
    modified = true
  }

  // Strip cache_control.scope — fast path skips when "scope" absent
  const needsSanitize = rawBody.includes('"scope"')
  if (needsSanitize && sanitizeCacheControl(parsed)) {
    modified = true
  }

  return {
    body: modified ? JSON.stringify(parsed) : rawBody,
    originalModel,
    resolvedModel,
    selectedModel,
  }
}

export const EFFORT_ORDER = ["low", "medium", "high", "xhigh"] as const

/**
 * Bucket a thinking budget into a Copilot reasoning-effort string.
 * `<2000`→low, `<8000`→medium, `<24000`→high, else→xhigh.
 * Defaults missing/non-numeric budgets to 8000 ("high").
 */
export function bucketEffort(budget: unknown): (typeof EFFORT_ORDER)[number] {
  const n =
    typeof budget === "number" && Number.isFinite(budget) ? budget : 8000
  if (n < 2000) return "low"
  if (n < 8000) return "medium"
  if (n < 24000) return "high"
  return "xhigh"
}

/**
 * Clamp a bucketed effort to the closest value in `supported`. Ties
 * resolve to the lower-tier option (per EFFORT_ORDER).
 *
 * Iterates EFFORT_ORDER (canonical low→xhigh) so the first match on a
 * given distance is always the lower-tier value, regardless of input
 * order in `supported`.
 */
export function clampEffort(
  bucketed: (typeof EFFORT_ORDER)[number],
  supported: Array<string>,
): string {
  if (supported.includes(bucketed)) return bucketed
  const targetIdx = EFFORT_ORDER.indexOf(bucketed)
  let best: (typeof EFFORT_ORDER)[number] | undefined
  let bestDist = Infinity
  for (let i = 0; i < EFFORT_ORDER.length; i++) {
    const value = EFFORT_ORDER[i]
    if (!supported.includes(value)) continue
    const dist = Math.abs(i - targetIdx)
    // strict `<` keeps the first (lower-tier) on ties
    if (dist < bestDist) {
      bestDist = dist
      best = value
    }
  }
  return best ?? bucketed
}

/**
 * Translate Anthropic-shape `thinking:{type:"enabled", budget_tokens}` to
 * Copilot-shape `thinking:{type:"adaptive"}` + `output_config.effort`
 * when the resolved model declares `adaptive_thinking: true`.
 *
 * Returns true if the body was modified. No-op when the model doesn't
 * support adaptive thinking, when thinking is missing/disabled/already
 * adaptive, or when `body` isn't a plain object. Client-supplied
 * `output_config.effort` always wins over the bucketed value.
 */
function translateThinking(body: AnyRecord, model?: Model): boolean {
  if (!model?.capabilities?.supports?.adaptive_thinking) return false
  const thinking = body.thinking
  if (!thinking || typeof thinking !== "object") return false
  if (thinking.type !== "enabled") return false

  const bucketed = bucketEffort(thinking.budget_tokens)
  const supported = model.capabilities.supports.reasoning_effort
  const effort =
    Array.isArray(supported) && supported.length > 0
      ? clampEffort(bucketed, supported)
      : bucketed

  body.thinking = { type: "adaptive" }

  const existing =
    body.output_config && typeof body.output_config === "object"
      ? (body.output_config as AnyRecord)
      : {}
  body.output_config = {
    ...existing,
    // client-supplied effort wins
    effort: existing.effort ?? effort,
  }

  return true
}

/**
 * Strip the `scope` field from all `cache_control` objects in the body.
 * Claude CLI 2.1.88+ sends {"type":"ephemeral","scope":"global"} which
 * Copilot rejects. Mutates the parsed object in place.
 *
 * Covers: system blocks, message content blocks (including nested
 * tool_result content), and tool definitions.
 */
function sanitizeCacheControl(body: AnyRecord): boolean {
  let stripped = false
  function stripScope(block: AnyRecord): void {
    if (block.cache_control?.scope !== undefined) {
      delete block.cache_control.scope
      if (Object.keys(block.cache_control).length === 0) {
        delete block.cache_control
      }
      stripped = true
    }
  }

  if (Array.isArray(body.system)) {
    for (const block of body.system) stripScope(block)
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          stripScope(block)
          if (Array.isArray(block.content)) {
            for (const nested of block.content) stripScope(nested)
          }
        }
      }
    }
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) stripScope(tool)
  }

  return stripped
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
      "context-management-2025-06-27",
    ].join(","),
  }
}
