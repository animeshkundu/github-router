import type { Context } from "hono"

import consola from "consola"

import { awaitApproval } from "~/lib/approval"
import { parseJsonOrDiagnose } from "~/lib/diagnose-response"
import { HTTPError } from "~/lib/error"
import { logEndpointMismatch } from "~/lib/model-validation"
import { checkRateLimit } from "~/lib/rate-limit"
import { logRequest } from "~/lib/request-log"
import { sanitizeAnthropicBody } from "~/lib/sanitize-anthropic-body"
import { state } from "~/lib/state"
import { relayAnthropicStream } from "~/lib/stream-relay"
import { filterBetaHeader, resolveModel } from "~/lib/utils"
import {
  buildAdvisorStream,
  injectAdvisorTool,
  isAdvisorRequested,
} from "~/services/advisor/advisor"
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

  // Phase I: detect ADVISOR request BEFORE filterBetaHeader strips
  // the advisor-tool- prefix from the outgoing header. We need the raw
  // incoming header to know whether the user asked for ADVISOR.
  const incomingBeta = c.req.header("anthropic-beta")
  const advisorEnabled = isAdvisorRequested(incomingBeta)

  let finalBody = await processWebSearch(rawBody)
  // Inbound advisor-history sanitization: rewrite malformed
  // server_tool_use ids in Claude Code's replayed conversation history
  // (left over from before the round-5 fix or any non-spec-compliant
  // source). Without this, Copilot 400s on
  //   `messages.N.content.M.server_tool_use.id: String should match
  //    pattern '^srvtoolu_[a-zA-Z0-9_]+$'`
  // when the conversation grows long enough to echo a malformed block.
  // Scoped narrowly to advisor pairs to avoid the ID round-trip trap
  // (see src/lib/sanitize-anthropic-body.ts header comment).
  finalBody = sanitizeAnthropicBody(finalBody)
  if (advisorEnabled) {
    // Inject __anthropic_advisor tool definition (with cc-backup's
    // ADVISOR_TOOL_INSTRUCTIONS as description) so the model knows
    // when to call it. Tool name uses double-underscore prefix to
    // avoid collision with any user MCP server's `advisor`.
    finalBody = injectAdvisorTool(finalBody)
    consola.info(
      "ADVISOR enabled for this request — injecting __anthropic_advisor tool; will translate tool_use → server_tool_use{advisor} on the SSE stream",
    )
  }

  // Phase G fail-fast (deferred translate path per codex-critic): if the
  // request includes inline `mcp_servers`, refuse with a clear Anthropic-
  // format error before forwarding. The original plan was to translate
  // (instantiate MCP clients server-side and inline tools) but the design
  // has structural holes — continuation after pool TTL isn't implementable
  // from the request alone, and streaming correctness during the multi-turn
  // tool loop is fragile. Local stdio MCP (~/.claude/mcp.json) covers the
  // common Claude usage; remote-managed MCP is the rare path. Fail-fast
  // with a clear pointer is the better Pareto choice (codex-critic 2/2/3
  // verdict on the translate-path design).
  if (finalBody.includes('"mcp_servers"')) {
    try {
      const probe = JSON.parse(finalBody) as AnyRecord
      if (Array.isArray(probe.mcp_servers) && probe.mcp_servers.length > 0) {
        return c.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "Inline `mcp_servers` body field is not supported by github-router "
                + "(Copilot returns 400 'Extra inputs are not permitted'; the proxy "
                + "would need a multi-turn tool-loop translation that has unresolved "
                + "design holes — see Phase G in the plan). Configure your remote MCP "
                + "servers as local stdio entries in `~/.claude/mcp.json` instead — "
                + "Claude Code will spawn them locally and the proxy passes their "
                + "tool calls through transparently. (https://docs.claude.com/en/docs/claude-code/mcp)",
            },
          },
          400,
        )
      }
    } catch {
      // Body wasn't valid JSON — fall through, downstream handlers will
      // surface the parse error in their own way.
    }
  }

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
  // Trust the upstream content-type when it's explicit. Two anomalies need
  // a fallback: (a) header missing entirely, (b) header is
  // `application/octet-stream` (some proxies normalize SSE this way). In
  // those cases, treat as streaming if the client asked for it via the
  // Accept header — Anthropic SDKs send `Accept: text/event-stream` for
  // streaming requests. We do NOT fall back when content-type is
  // explicitly `application/json` — that's almost always an upstream
  // error response that should be parsed via parseJsonOrDiagnose.
  const clientAcceptsSSE = (c.req.header("accept") ?? "").includes(
    "text/event-stream",
  )
  let isStreaming = contentType.includes("text/event-stream")
  if (!isStreaming && clientAcceptsSSE) {
    if (contentType === "" || contentType === "application/octet-stream") {
      consola.warn(
        `Upstream /v1/messages returned status=${response.status} content-type=${JSON.stringify(contentType)} but client requested streaming; treating response body as SSE`,
      )
      isStreaming = true
    }
  }

  if (debugEnabled) {
    consola.debug(
      `Upstream /v1/messages: status=${response.status} content-type="${contentType}" isStreaming=${isStreaming}`,
    )
  }

  // Streaming: pipe the upstream SSE response body directly (or wrap
  // with the ADVISOR translate-loop if advisor was requested).
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
      "transfer-encoding": "chunked",
      connection: "keep-alive",
    }
    const requestId = response.headers.get("x-request-id")
    if (requestId) streamHeaders["x-request-id"] = requestId
    const reqId = response.headers.get("request-id")
    if (reqId) streamHeaders["request-id"] = reqId

    // Phase I: branch into the advisor translate-loop if the user
    // requested ADVISOR. The loop intercepts tool_use{__anthropic_advisor}
    // blocks, translates to server_tool_use{advisor}, runs the advisor
    // model server-side, emits advisor_tool_result, and continues the
    // Copilot conversation on the SAME SSE connection (no intermediate
    // message_stop). See src/services/advisor/advisor.ts for the design
    // (gemini-critic streaming-during-loop pattern).
    if (advisorEnabled && response.body) {
      // Parse the resolved body once to extract the conversation +
      // base body for continuation calls. The translate-loop needs
      // these to extend the conversation across advisor turns.
      let parsedBase: AnyRecord = {}
      try {
        parsedBase = JSON.parse(resolvedBody) as AnyRecord
      } catch {
        // Should not happen since resolveModelInBody just re-serialized
        // it. Fallback: pass empty conversation; translate-loop will
        // skip advisor calls if it can't construct continuations.
      }
      const initialConversation = Array.isArray(parsedBase.messages)
        ? (parsedBase.messages as Array<AnyRecord>)
        : []
      return new Response(
        buildAdvisorStream({
          firstResponse: response,
          initialConversation,
          baseBody: parsedBase,
          requestHeaders: {
            ...selectedModel?.requestHeaders,
            ...effectiveBetas,
          },
        }),
        {
          status: response.status,
          headers: streamHeaders,
        },
      )
    }

    return new Response(
      response.body
        ? relayAnthropicStream(response.body, { routePath: c.req.path })
        : null,
      {
        status: response.status,
        headers: streamHeaders,
      },
    )
  }

  // Non-streaming: extract usage from response body
  const responseBody = await parseJsonOrDiagnose<AnyRecord>(
    response,
    c.req.path,
  )

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

  // Strip Anthropic-only top-level body fields Copilot 400s on. Empirical
  // verification (2026-05-11 against api.enterprise.githubcopilot.com):
  //   - `budget: {total_tokens}` (Task Budgets) → 400 "budget: Extra inputs not permitted"
  //   - `output_config: {schema}` (Structured Outputs) → 400 "output_config.schema: Extra..."
  //   - `betas: [...]` (top-level array, distinct from anthropic-beta header) → 400 "betas: Extra..."
  // Fast-path skip when none of the field names appear in the raw body.
  // NOT stripped:
  //   - `mcp_servers` — Phase G builds the translate path; silent strip
  //     here would cause LLM to hallucinate tools (gemini-critic finding).
  //   - `metadata: {user_id}` — Copilot 200s, ignores harmlessly. Strip
  //     would be cosmetic (codex-critic: "preserve unknown fields unless
  //     documented reason"); ~0.1ms re-serialize cost per request adds up.
  const needsAnthropicOnlyStrip =
    rawBody.includes('"budget"')
    || rawBody.includes('"output_config"')
    || rawBody.includes('"betas"')
  if (needsAnthropicOnlyStrip && stripAnthropicOnlyFields(parsed)) {
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

/**
 * Strip top-level body fields that Anthropic's Messages API accepts but
 * Copilot rejects with HTTP 400 "Extra inputs are not permitted". Mutates
 * `body` in place; returns true if anything was stripped.
 *
 * Empirical verification (2026-05-11):
 *   POST /v1/messages?beta=true { ..., budget: {total_tokens: 10000} } → 400
 *   POST /v1/messages?beta=true { ..., output_config: {schema: {...}} }  → 400
 *   POST /v1/messages?beta=true { ..., betas: ["..."] }                  → 400
 *
 * Each strip emits a one-line consola.warn so users running with these
 * features (e.g. `claude --max-budget-usd`, `--json-schema`) understand
 * the request succeeds with the *body field* dropped — semantics may
 * differ from upstream Anthropic. The corresponding `anthropic-beta`
 * header is preserved (Phase A allowlist) so the *intent* still flows
 * to Copilot, even if the per-request enforcement field is gone.
 *
 * NOT stripped here:
 *   - `mcp_servers` (Phase G translate path — silent strip causes LLM
 *     to hallucinate tools per gemini-critic finding)
 *   - `metadata` (Copilot 200s, ignores harmlessly)
 */
function stripAnthropicOnlyFields(body: AnyRecord): boolean {
  let stripped = false
  if (body.budget !== undefined) {
    consola.warn(
      "Stripping body-level `budget` field (Copilot 400s; the `task-budgets-` beta header is preserved but cost ceiling is not enforced server-side)",
    )
    delete body.budget
    stripped = true
  }
  if (body.output_config !== undefined) {
    // output_config has multiple known shapes:
    //   - `{schema:{...}}` (Structured Outputs full form) — Copilot 400s
    //   - `{type:"json_object"}` (Structured Outputs short form, used
    //     by Claude Code's hook evaluator + the Anthropic SDK's
    //     structured-output API) — Copilot 400s with the same
    //     `output_config: Extra inputs are not permitted` message,
    //     just at the top-level field rather than the nested .schema.
    //   - `{effort:"high"}` (proxy-set during adaptive-thinking
    //     translation) — Copilot 200s, required by translateThinking.
    //
    // Strategy: strip every Structured-Outputs field (`schema`,
    // `type`, `response_format`, anything else we don't recognize as
    // proxy-internal). Keep `effort` if present. If the object ends
    // up empty, drop the whole field.
    //
    // **Schema preservation via prompt injection**: stripping
    // `output_config.schema` removes server-side enforcement, which
    // makes the model's output non-deterministic. Claude Code's
    // hook evaluator then fails with "JSON validation failed" because
    // it tries to `JSON.parse(response)` and gets natural-language
    // text. To preserve the structured-output INTENT through Copilot,
    // append a system-prompt instruction telling the model to produce
    // JSON conforming to the schema. This isn't as strong as
    // server-side enforcement (the model may occasionally deviate),
    // but it's much better than no constraint at all.
    if (body.output_config && typeof body.output_config === "object") {
      const oc = body.output_config as AnyRecord
      const PROXY_OWNED_FIELDS = new Set(["effort"])
      // Capture the schema BEFORE stripping so we can inject it.
      const schema = oc.schema
      const ocType = oc.type
      let strippedAny = false
      for (const key of Object.keys(oc)) {
        if (!PROXY_OWNED_FIELDS.has(key)) {
          delete oc[key]
          strippedAny = true
        }
      }
      if (strippedAny) {
        consola.warn(
          "Stripping client-set `output_config` Structured-Outputs fields"
          + " (Copilot 400s on `output_config.*` other than `effort`;"
          + " injecting schema as system-prompt instruction so the"
          + " model still produces JSON conforming to the structured-"
          + "outputs schema, since server-side enforcement is gone)",
        )
        if (Object.keys(oc).length === 0) {
          delete body.output_config
        }
        if (schema !== undefined || ocType === "json_object") {
          appendStructuredOutputInstruction(body, schema, ocType)
        }
        stripped = true
      }
    }
  }
  if (Array.isArray(body.betas)) {
    consola.warn(
      "Stripping body-level `betas` array (Copilot 400s; the betas are conveyed via the `anthropic-beta` header instead)",
    )
    delete body.betas
    stripped = true
  }
  return stripped
}

/**
 * Append a system-prompt instruction telling the model to produce JSON
 * conforming to a Structured Outputs schema. Used after the proxy
 * strips `output_config` to preserve the schema enforcement intent
 * via prompt engineering instead of server-side validation.
 *
 * Mutates `body.system` in place. Handles both string and array shapes
 * (Anthropic spec allows either).
 */
function appendStructuredOutputInstruction(
  body: AnyRecord,
  schema: unknown,
  ocType: unknown,
): void {
  let instruction =
    "\n\nIMPORTANT: Your response MUST be a single valid JSON object."
    + " Do not wrap it in markdown code fences. Do not include any text"
    + " before or after the JSON object."
  if (schema !== undefined) {
    instruction +=
      ` The JSON object MUST conform to this JSON Schema:\n${JSON.stringify(schema)}`
  } else if (typeof ocType === "string") {
    instruction +=
      ` Output type requested: ${ocType}.`
  }
  if (typeof body.system === "string") {
    body.system = body.system + instruction
  } else if (Array.isArray(body.system)) {
    body.system = [
      ...body.system,
      { type: "text", text: instruction.trimStart() },
    ]
  } else {
    body.system = instruction.trimStart()
  }
}
