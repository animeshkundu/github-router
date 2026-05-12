import type { Context } from "hono"

import consola from "consola"

import { logRequest } from "~/lib/request-log"
import { filterBetaHeader, resolveModel } from "~/lib/utils"
import { state } from "~/lib/state"
import { countTokens } from "~/services/copilot/create-messages"
import { parseJsonOrDiagnose } from "~/lib/diagnose-response"

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

  const modelId = resolvedModel ?? originalModel
  const selectedModel = state.models?.data.find((m) => m.id === modelId)

  const response = await countTokens(finalBody, {
    ...selectedModel?.requestHeaders,
    ...extraHeaders,
  })
  const responseBody = await parseJsonOrDiagnose<{ input_tokens?: number }>(
    response,
    c.req.path,
  )

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
 * Parse the JSON body, resolve the model name, sanitize cache_control, and re-serialize.
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

  let modified = false
  if (originalModel) {
    const resolved = resolveModel(originalModel)
    if (resolved !== originalModel) {
      parsed.model = resolved
      modified = true
    }
  }

  const needsSanitize = rawBody.includes('"scope"')
  if (needsSanitize && sanitizeCacheControl(parsed)) {
    modified = true
  }

  // Strip Anthropic-only body fields Copilot 400s on. See
  // `stripAnthropicOnlyFields` in handler.ts for full rationale + empirical
  // evidence (2026-05-11 verification). count_tokens uses the same Copilot
  // schema validator as /v1/messages so the same fields are rejected.
  const needsAnthropicOnlyStrip =
    rawBody.includes('"budget"')
    || rawBody.includes('"output_config"')
    || rawBody.includes('"betas"')
  if (needsAnthropicOnlyStrip && stripAnthropicOnlyFields(parsed)) {
    modified = true
  }

  const resolvedModel =
    typeof parsed.model === "string" ? parsed.model : originalModel

  return {
    body: modified ? JSON.stringify(parsed) : rawBody,
    originalModel,
    resolvedModel,
  }
}

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
 * Strip top-level body fields Copilot 400s on (budget, output_config.schema,
 * betas). Duplicated structurally from handler.ts because count_tokens uses
 * its own JSON-pass; the bodies are independent. Behavior must stay in lock-
 * step with handler.ts's stripAnthropicOnlyFields — covered by integration
 * tests (Phase F P2.4).
 */
function stripAnthropicOnlyFields(body: AnyRecord): boolean {
  let stripped = false
  if (body.budget !== undefined) {
    consola.warn(
      "[count_tokens] Stripping body-level `budget` field (Copilot 400s)",
    )
    delete body.budget
    stripped = true
  }
  if (body.output_config !== undefined) {
    if (body.output_config && typeof body.output_config === "object"
        && (body.output_config as AnyRecord).schema !== undefined) {
      consola.warn(
        "[count_tokens] Stripping body-level `output_config.schema` field (Copilot 400s on Structured Outputs)",
      )
      delete (body.output_config as AnyRecord).schema
      if (Object.keys(body.output_config as AnyRecord).length === 0) {
        delete body.output_config
      }
      stripped = true
    }
  }
  if (Array.isArray(body.betas)) {
    consola.warn(
      "[count_tokens] Stripping body-level `betas` array (Copilot 400s; conveyed via header)",
    )
    delete body.betas
    stripped = true
  }
  return stripped
}
