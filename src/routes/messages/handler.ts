import type { Context } from "hono"

import consola from "consola"

import { awaitApproval } from "~/lib/approval"
import {
  classifyMessagesRoute,
  handleNonClaudeChat,
  handleNonClaudeResponses,
  makeShimContinueTurn,
  parseAnthropicRequest,
  streamParsedRequestViaShim,
  type ShimEndpoint,
} from "~/lib/anthropic-translate"
import { HTTPError } from "~/lib/error"
import {
  identityPreflightErrorResponse,
  runMessagesIdentityPreflight,
} from "~/lib/messages-identity-preflight"
import { logEndpointMismatch } from "~/lib/model-validation"
import { checkRateLimit } from "~/lib/rate-limit"
import { EFFORT_ORDER, UNKNOWN_EFFORT_ANCHOR, bucketEffort, clampEffort } from "~/lib/reasoning-effort"
import { logRequest, logRequestFields, recordBodySize } from "~/lib/request-log"
import { MAX_RESPONSE_BODY_BYTES, readResponseBodyCapped } from "~/lib/response-cap"
import { sanitizeAnthropicBody } from "~/lib/sanitize-anthropic-body"
import { state } from "~/lib/state"
import { relayAnthropicStream } from "~/lib/stream-relay"
import { guardAnthropicBody } from "~/lib/tool-loop-guard"
import {
  formatThinkingRepairDecline,
  rememberThinkingHistoryRepair,
  repairKnownThinkingHistory,
  repairRejectedThinkingHistory,
  type ThinkingHistoryRepair,
} from "~/lib/thinking-history-repair"
import { filterBetaHeader, resolveModel } from "~/lib/utils"
import { preprocessFastRequest } from "~/lib/fast-request-preprocess"
import {
  buildWebSearchContext,
  injectAnthropicWebSearchContext,
} from "~/lib/web-search-context"
import {
  ADVISOR_INTERNAL_TOOL_NAME,
  FAST_ADVISOR_TOOL_INSTRUCTIONS,
  buildAdvisorStream,
  injectAdvisorTool,
  isAdvisorRequested,
  isFastProfileLead,
  resolveAdvisorEffort,
  resolveAdvisorModel,
} from "~/services/advisor/advisor"
import { createMessages } from "~/services/copilot/create-messages"
import type { Model } from "~/services/copilot/get-models"
import { searchWeb } from "~/services/copilot/web-search"

type AnyRecord = Record<string, unknown>

// Upper bound on repair-and-retry round trips for signed-thinking rejections.
// Each attempt clears at most one assistant turn, so this caps how many
// corrupt turns one request can converge past before we surface the rejection.
const MAX_THINKING_REPAIR_ATTEMPTS = 5

const isWebSearchTool = (tool: AnyRecord): boolean =>
  !!tool
  && typeof tool === "object"
  && ((typeof tool.type === "string" && tool.type.startsWith("web_search"))
    || tool.name === "web_search")

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
 * Strip web_search tools from the request and clean up tool_choice.
 * Returns the modified body object.
 */
function stripWebSearchTool(body: AnyRecord): void {
  if (!body.tools) return

  const tools = (body.tools as Array<AnyRecord>).filter(
    (tool: AnyRecord) => !isWebSearchTool(tool),
  )
  body.tools = tools

  if (tools.length === 0) {
    body.tools = undefined
    body.tool_choice = undefined
  } else if (
    body.tool_choice &&
    typeof body.tool_choice === "object" &&
    (body.tool_choice as AnyRecord).type === "tool"
  ) {
    // If tool_choice forced the removed web_search tool, fall back to auto
    const choiceName = (body.tool_choice as AnyRecord).name
    if (
      choiceName &&
      !tools.some(
        (tool: AnyRecord) =>
          tool && typeof tool === "object" && tool.name === choiceName,
      )
    ) {
      body.tool_choice = { type: "auto" }
    }
  }
}

/**
 * Strip the injected `__anthropic_advisor` tool (and any Anthropic-native
 * `advisor_*` typed tool) from a request body. Used on non-Claude shim paths
 * without an advisor handler and on authenticated fast Task-subagent requests,
 * where Advisor is intentionally lead-only. Mirrors stripWebSearchTool's
 * tool_choice cleanup. Returns the original string when nothing was removed.
 */
function stripAdvisorTool(rawBody: string): string {
  let body: AnyRecord
  try {
    body = JSON.parse(rawBody)
  } catch {
    return rawBody
  }
  if (!Array.isArray(body.tools)) return rawBody
  const original = body.tools as Array<AnyRecord>
  const tools = original.filter((tool: AnyRecord) => {
    if (typeof tool !== "object" || tool === null) return true
    if (tool.name === ADVISOR_INTERNAL_TOOL_NAME) return false
    const type = tool.type
    return typeof type !== "string" || !type.startsWith("advisor_")
  })
  if (tools.length === original.length) return rawBody

  if (tools.length === 0) {
    body.tools = undefined
    body.tool_choice = undefined
  } else {
    body.tools = tools
    if (
      body.tool_choice
      && typeof body.tool_choice === "object"
      && (body.tool_choice as AnyRecord).type === "tool"
    ) {
      const choiceName = (body.tool_choice as AnyRecord).name
      if (
        choiceName
        && !tools.some(
          (tool: AnyRecord) =>
            tool && typeof tool === "object" && tool.name === choiceName,
        )
      ) {
        body.tool_choice = { type: "auto" }
      }
    }
  }
  return JSON.stringify(body)
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

  const hasWebSearch = (body.tools as Array<AnyRecord> | undefined)?.some(
    (tool: AnyRecord) => isWebSearchTool(tool),
  )
  if (!hasWebSearch) return rawBody

  // Skip search on follow-up messages (tool call results)
  const messages = (body.messages ?? []) as Array<AnyRecord>
  const hasToolResult = hasToolResultContent(messages)
  const query = hasToolResult ? undefined : extractUserQuery(messages)

  if (query) {
    try {
      const results = await searchWeb(query)
      injectAnthropicWebSearchContext(body, buildWebSearchContext(results))
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

  // `/v1/messages` identity preflight. Runs before ANY body consumer
  // (`c.req.text()` below is the first one) — this only reads a header.
  // See `runMessagesIdentityPreflight`'s doc for the bound-vs-unbound-BYO
  // distinction and why a failed preflight answers 403, never 401 (the
  // no-401 invariant — Claude Code's reactive refresh path fires on any
  // 401 and would try the synthetic refresh token, breaking the session).
  const identity = runMessagesIdentityPreflight(c)
  if (!identity.ok) {
    return identityPreflightErrorResponse(c, identity.reason)
  }

  await checkRateLimit(state)

  const rawBody = await c.req.text()
  // Feed the rolling body-size distribution. The prologue below (guards,
  // parses, re-serialization) scales with this, so its p50/p95 is what decides
  // whether optimizing the prologue is worth any risk at all.
  recordBodySize(rawBody.length)

  const debugEnabled = consola.level >= 4
  if (debugEnabled) {
    consola.debug("Anthropic request body:", rawBody.slice(0, 2000))
  }

  // Opt-in field-key discovery (Phase 0.5 of the long-horizon plan).
  // No-op unless GH_ROUTER_LOG_FIELDS=1 is set. Feeds
  // scripts/discover-new-fields.sh.
  if (process.env.GH_ROUTER_LOG_FIELDS === "1") {
    let parsedForLog: unknown = undefined
    try {
      parsedForLog = JSON.parse(rawBody) as unknown
    } catch {
      // Body parse failures are surfaced downstream; don't double-warn here.
    }
    logRequestFields({
      path: c.req.path,
      body: parsedForLog,
      betaHeader: c.req.header("anthropic-beta"),
      agentId: c.req.header("x-claude-code-agent-id"),
    })
  }

  // The delegation eval measures the lead's choice, not the delegated work.
  // Keep subagent requests valid but token-free; unset in every normal launch.
  if (
    process.env.GH_ROUTER_DELEGATION_EVAL === "1"
    && c.req.header("x-claude-code-agent-id")
  ) {
    let request: AnyRecord = {}
    try {
      request = JSON.parse(rawBody) as AnyRecord
    } catch {
      // The normal request path below owns malformed-body errors. Eval traffic
      // comes from Claude Code and is valid JSON, so defaults are sufficient.
    }
    const model = typeof request.model === "string" ? request.model : "delegation-eval"
    if (request.stream === true) {
      const events: Array<[string, AnyRecord]> = [
        [
          "message_start",
          {
            type: "message_start",
            message: {
              id: "msg_delegation_eval",
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
        ],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 0 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ]
      const body = events
        .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        .join("")
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      })
    }
    return c.json({
      id: "msg_delegation_eval",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    })
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  const betaHeaders = extractBetaHeaders(c)

  // Phase I: detect ADVISOR request BEFORE filterBetaHeader strips
  // the advisor-tool- prefix from the outgoing header. We need the raw
  // incoming header to know whether the user asked for ADVISOR.
  const incomingBeta = c.req.header("anthropic-beta")
  const advisorRequested = isAdvisorRequested(incomingBeta)
  const fastProfileRequest = identity.launch?.profileId === "fast"
  const fastSubagentRequest =
    fastProfileRequest && Boolean(c.req.header("x-claude-code-agent-id"))
  const fastLeadAdvisor = fastProfileRequest && !fastSubagentRequest
  const advisorEnabled = advisorRequested && !fastSubagentRequest

  const fastPreprocess = preprocessFastRequest(rawBody, identity.launch)
  if (fastPreprocess.rejectedAlias || fastPreprocess.rejectedModel) {
    const message = fastPreprocess.rejectedAlias
      ? `Router-owned model alias ${JSON.stringify(fastPreprocess.rejectedAlias)} is valid only for an authenticated -m fast launch.`
      : `Model ${JSON.stringify(fastPreprocess.rejectedModel)} is outside the fixed -m fast model set.`
    return c.json(
      { type: "error", error: { type: "invalid_request_error", message } },
      400,
    )
  }

  let finalBody = await processWebSearch(fastPreprocess.body)
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
  // Fast Advisor is transcript-aware specifically because it sees the primary
  // lead's conversation. A Task subagent has a different, narrower transcript,
  // so exposing Advisor there adds cost and conflicting authority without the
  // intended context. Strip both Claude Code's native typed tool and any
  // replay-injected proxy tool before routing.
  if (fastSubagentRequest) {
    finalBody = stripAdvisorTool(finalBody)
  }

  // Runaway-tool-loop guard. Placed before the Claude-passthrough vs
  // translation-shim fork so one site covers all three branches. Detection is
  // read-only; `guardAnthropicBody` re-serializes only when it injects a nudge.
  const loopGuard = guardAnthropicBody(finalBody)
  if (loopGuard.action === "abort") {
    return c.json(
      {
        type: "error",
        error: { type: "invalid_request_error", message: loopGuard.message },
      },
      400,
      // The proxy cannot kill a client's agent loop; it can only refuse. A 400
      // is already terminal in the Anthropic SDK's retry policy, but that
      // policy checks `x-should-retry` BEFORE any status test, so sending it
      // explicitly keeps this working even if the retryable-status list
      // changes. Without a terminal refusal we would trade a tool loop for a
      // retry loop.
      { "x-should-retry": "false" },
    )
  }
  if (loopGuard.body !== undefined) finalBody = loopGuard.body

  if (advisorEnabled) {
    // Inject __anthropic_advisor tool definition (with cc-backup's
    // ADVISOR_TOOL_INSTRUCTIONS as description) so the model knows
    // when to call it. Tool name uses double-underscore prefix to
    // avoid collision with any user MCP server's `advisor`.
    finalBody = injectAdvisorTool(
      finalBody,
      fastLeadAdvisor ? FAST_ADVISOR_TOOL_INSTRUCTIONS : undefined,
    )
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
                "Inline `mcp_servers` body field is not supported by github-router. "
                + "Configure remote MCP servers as local stdio entries in `~/.claude/mcp.json` instead — "
                + "Claude Code will spawn them locally and the proxy passes their tool calls through transparently. "
                + "(https://docs.claude.com/en/docs/claude-code/mcp)",
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

  // Non-Claude models are diverted to the Anthropic-translation shim: those
  // Copilot serves via `/responses` (gpt-5.5, gpt-5.3-codex) take the Responses
  // path, those it serves via `/chat/completions` (gemini) take the chat path.
  // Claude models fall through to the native `createMessages` passthrough below,
  // byte-for-byte unchanged. The decision is keyed off the resolved model's
  // identity + catalog endpoint (see classifyMessagesRoute), never a hardcoded
  // slug list. The ORIGINAL (pre-resolution) request model id is passed as the
  // 3rd arg so a Claude alias that resolveModel maps onto a non-Claude-looking
  // id can never be diverted to either shim (fail-closed to Claude).
  const messagesRoute = classifyMessagesRoute(modelId, selectedModel, originalModel)
  if (messagesRoute !== "claude-passthrough") {
    // ADVISOR is Claude-only in the GENERAL case: the server-side advisor
    // translate-loop (buildAdvisorStream) exists only on the native
    // /v1/messages path. The ONE exception is the fast Luna-lead profile,
    // whose advisor (Gemini 3.7 Flash, via `resolveAdvisorModel`) runs
    // through THIS SAME shim's translation + SSE-synthesis machinery
    // (`streamParsedRequestViaShim` for the initial turn, a
    // `makeShimContinueTurn`-built continuation for every turn after) —
    // see plan section 8 "Enable Gemini 3.7 Flash Advisor on the Luna
    // translation path". Every OTHER non-Claude lead still gracefully
    // degrades below exactly as before. Advisor only ever runs on a
    // STREAMING request (mirrors the Claude-passthrough branch, which gates
    // buildAdvisorStream on `isStreaming` too — a non-streaming request
    // never gets the advisor loop on ANY lead).
    const endpoint: ShimEndpoint = messagesRoute === "chat-shim" ? "chat" : "responses"
    let parsedBase: AnyRecord | undefined
    try {
      parsedBase = JSON.parse(resolvedBody) as AnyRecord
    } catch {
      // Malformed body — fall through to the plain shim handlers below,
      // which re-parse and surface their own 400.
    }
    const wantsStream = parsedBase?.stream === true

    if (
      advisorEnabled
      && wantsStream
      && identity.launch?.profileId === "fast"
      && isFastProfileLead(modelId)
    ) {
      const initialConversation = Array.isArray(parsedBase!.messages)
        ? (parsedBase!.messages as Array<AnyRecord>)
        : []
      const parsedInitial = parseAnthropicRequest(parsedBase!, modelId!, selectedModel)
      const fastAdvisorAborter = new AbortController()
      const firstResponse = await streamParsedRequestViaShim(
        parsedInitial,
        endpoint,
        {
          modelId: modelId!,
          model: selectedModel,
          routePath: c.req.path,
          onCancel: () => fastAdvisorAborter.abort(),
        },
        fastAdvisorAborter.signal,
      )

      logRequest(
        {
          method: "POST",
          path: c.req.path,
          model: originalModel,
          resolvedModel: modelId,
          status: 200,
          streaming: true,
        },
        selectedModel,
        startTime,
      )

      const advisorChoice = resolveAdvisorModel(modelId, true)
      return new Response(
        buildAdvisorStream({
          firstResponse,
          initialConversation,
          baseBody: parsedBase!,
          // Unused when `continueTurn` is supplied (the shim builds its own
          // request headers from the catalog entry); kept non-undefined for
          // type simplicity/back-compat with the default-`continueTurn` path.
          requestHeaders: {},
          advisorModel: advisorChoice.model,
          advisorEscalated: advisorChoice.escalated,
          advisorFastProfile: advisorChoice.fastProfile,
          advisorEffort: resolveAdvisorEffort(rawBody, advisorChoice.model, true),
          externalAborter: fastAdvisorAborter,
          continueTurn: makeShimContinueTurn(endpoint, {
            modelId: modelId!,
            model: selectedModel,
          }),
        }),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "transfer-encoding": "chunked",
            connection: "keep-alive",
          },
        },
      )
    }

    // ADVISOR is unavailable on every OTHER non-Claude model — whether picked
    // via `-m <model>` or switched at runtime via the /model picker —
    // gracefully DEGRADE instead of 400ing every request (which would break
    // `github-router claude -m gpt-5.5` entirely, since the claude launcher
    // auto-enables the advisor beta). Strip the injected `__anthropic_advisor`
    // tool (which would otherwise reach the model with no server-side
    // handler) and ignore the advisor beta, then forward to the shim so the
    // request succeeds. The Claude passthrough path (below) is unchanged —
    // the advisor loop still runs there.
    // Strip the internal advisor tool UNCONDITIONALLY on every shim path
    // (defense-in-depth): the reserved `__anthropic_advisor` / `advisor_*` tool
    // is a proxy-internal contract with no server-side handler off the Claude
    // path, so it must never reach gpt/gemini regardless of whether the advisor
    // beta was present — a hand-crafted client could decouple the tool from the
    // beta. stripAdvisorTool returns the same string when nothing matched.
    const shimBody = stripAdvisorTool(resolvedBody)
    if (advisorEnabled) {
      consola.info(
        "ADVISOR requested with a non-Claude model — stripping the injected "
          + "__anthropic_advisor tool and proceeding without advisor (Claude-only "
          + "feature; gracefully degraded).",
      )
    }
    const shimOpts = {
      rawBody: shimBody,
      modelId: modelId!,
      model: selectedModel,
      originalModel,
      startTime,
    }
    return messagesRoute === "chat-shim"
      ? handleNonClaudeChat(c, shimOpts)
      : handleNonClaudeResponses(c, shimOpts)
  }

  if (modelId) logEndpointMismatch(modelId, "/v1/messages")

  // Apply default anthropic-beta for Claude models when client sends none
  const effectiveBetas = applyDefaultBetas(betaHeaders, resolvedModel ?? originalModel)

  // When ADVISOR is enabled, create a shared AbortController BEFORE the
  // initial createMessages call so consumer-cancel propagates to the
  // initial response body (not just continuation/runAdvisor calls). Pre-
  // fix the initial createMessages had no callerSignal, so the response
  // body survived cancellation for up to UPSTREAM_FETCH_TIMEOUT_MS (0 disables),
  // burning tokens and holding a socket.
  // NOTE: do NOT use c.req.raw.signal here — Bun aborts it after request-
  // body consumption (see CLAUDE.md "Bun request-signal quirk").
  const advisorAborter = advisorEnabled ? new AbortController() : undefined
  const requestHeaders = {
    ...selectedModel?.requestHeaders,
    ...effectiveBetas,
  }
  let nativeBody = resolvedBody
  const knownThinkingRepair = repairKnownThinkingHistory(nativeBody)
  if (knownThinkingRepair) {
    nativeBody = knownThinkingRepair.body
    consola.warn(
      `Reapplying proven thinking-history repair: message=${knownThinkingRepair.messageIndex} removed_blocks=${knownThinkingRepair.removedBlocks}`,
    )
  }

  // Repair-and-retry loop. Copilot names only the FIRST offending message per
  // rejection, so a history with several corrupt assistant turns needs one
  // round trip per turn to converge — a single retry would surface the first
  // rejection forever and never memoize, bricking the session permanently.
  let response: Response | undefined
  let acceptedRepair: ThinkingHistoryRepair | undefined
  const repairedMessageIndices = new Set<number>()
  for (let attempt = 0; response === undefined; attempt++) {
    try {
      // retryTransient: true — pre-first-byte retry on a 429/5xx/network blip.
      // The response body is not consumed until the streaming/non-streaming
      // branch below, so re-issuing here cannot duplicate streamed output.
      response = await createMessages(
        nativeBody,
        requestHeaders,
        advisorAborter?.signal,
        true,
      )
      if (acceptedRepair) {
        rememberThinkingHistoryRepair(acceptedRepair.fingerprint)
        consola.warn(
          `Thinking-history repair succeeded: message=${acceptedRepair.messageIndex} removed_blocks=${acceptedRepair.removedBlocks} attempts=${attempt}`,
        )
      }
    } catch (error) {
      // A non-HTTP failure (transport exhaustion, abort) is not a thinking
      // rejection. Surface it as itself — reporting it as the earlier 400
      // would misdiagnose the outage.
      if (!(error instanceof HTTPError)) throw error
      const errorBody = await error.response.clone().text().catch(() => "")
      const outcome =
        attempt < MAX_THINKING_REPAIR_ATTEMPTS ?
          repairRejectedThinkingHistory(nativeBody, errorBody)
        : undefined
      const thinkingRepair = outcome?.ok ? outcome.repair : undefined
      // Give up when nothing is repairable, or when upstream names a message
      // already repaired this request — that means no forward progress, and
      // retrying would spin until the attempt cap.
      if (
        !thinkingRepair
        || repairedMessageIndices.has(thinkingRepair.messageIndex)
      ) {
        // Say WHY. A silent decline here is what made a 44-rejection incident
        // impossible to diagnose after the fact: the upstream 400 carries a
        // unique request_id so it is logged every time, while the route-level
        // error is a constant string that the log's dedup window collapses —
        // leaving a log that reads as unexplained repeated failure.
        if (outcome && !outcome.ok) {
          consola.warn(
            `Thinking-history repair declined: ${formatThinkingRepairDecline(outcome.decline)}`,
          )
        } else if (thinkingRepair) {
          consola.warn(
            `Thinking-history repair made no progress; upstream re-named message=${thinkingRepair.messageIndex} after it was already repaired`,
          )
        }
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
        // The CURRENT rejection, not the first one: it names the message that
        // actually blocked the request after earlier repairs were accepted.
        throw error
      }
      // Copilot validates messages in order, so a rejection naming a later
      // message proves the previous repair cleared. Memoize it now so partial
      // progress survives even if a subsequent attempt fails outright.
      if (acceptedRepair) rememberThinkingHistoryRepair(acceptedRepair.fingerprint)
      consola.warn(
        `Copilot rejected signed thinking history; retrying without rejected historical blocks: message=${thinkingRepair.messageIndex} removed_blocks=${thinkingRepair.removedBlocks} attempt=${attempt + 1}`,
      )
      nativeBody = thinkingRepair.body
      acceptedRepair = thinkingRepair
      repairedMessageIndices.add(thinkingRepair.messageIndex)
    }
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
        parsedBase = JSON.parse(nativeBody) as AnyRecord
      } catch {
        // Should not happen since resolveModelInBody just re-serialized
        // it. Fallback: pass empty conversation; translate-loop will
        // skip advisor calls if it can't construct continuations.
      }
      const initialConversation = Array.isArray(parsedBase.messages)
        ? (parsedBase.messages as Array<AnyRecord>)
        : []
      // Resolve the advisor per REQUEST, not per launch: both the lead model and
      // the effort level change mid-session via the CLI pickers, so a value
      // pinned at spawn would go stale on the first `/model` switch.
      //
      // Two different bodies feed this on purpose. The lead identity comes from
      // `originalModel` — the pre-resolution, user-facing slug that still
      // carries `[1m]` and the dashed-vs-dotted form. The effort comes from
      // `rawBody`, NOT `nativeBody`/`parsedBase`, because those have already
      // been through `translateThinking`, which clamps to the LEAD model's
      // allowlist; reading them would hand the advisor what the lead could do
      // instead of what the user picked.
      const advisorChoice = resolveAdvisorModel(originalModel)
      return new Response(
        buildAdvisorStream({
          firstResponse: response,
          initialConversation,
          baseBody: parsedBase,
          requestHeaders,
          advisorModel: advisorChoice.model,
          advisorEscalated: advisorChoice.escalated,
          advisorEffort: resolveAdvisorEffort(rawBody, advisorChoice.model),
          externalAborter: advisorAborter,
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

  // Non-streaming: read response body with a 10 MiB size cap to prevent OOM
  // from a misbehaving upstream that sends a multi-GB application/json body.
  // The streaming branch is safe by construction (chunk-by-chunk processing).
  const cappedResult = await readResponseBodyCapped<AnyRecord>(
    response,
    c.req.path,
    MAX_RESPONSE_BODY_BYTES,
  )

  if (!cappedResult.ok) {
    return c.json(cappedResult.errorResponse, cappedResult.status as 502)
  }

  const responseBody = cappedResult.value

  const usage = responseBody.usage as
    | {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
      }
    | undefined

  logRequest(
    {
      method: "POST",
      path: c.req.path,
      model: originalModel,
      resolvedModel,
      inputTokens: anthropicTotalInputTokens(usage),
      outputTokens: usage?.output_tokens,
      // Anthropic's own usage shape already reports disjoint buckets (unlike
      // OpenAI's inclusive totals), so these ride straight through with no
      // `normalizeOpenAIUsage` step — see that function's doc for why the
      // OpenAI-shaped routes need one and this one doesn't.
      cacheReadTokens: usage?.cache_read_input_tokens,
      cacheWriteTokens: usage?.cache_creation_input_tokens,
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

  // Fast-profile aliases and fixed efforts are handled before this helper by
  // `preprocessFastRequest`, which has the authenticated launch identity. This
  // generic resolver deliberately has no private-alias semantics.

  const resolvedOriginalModel =
    typeof parsed.model === "string" ? parsed.model : originalModel

  if (resolvedOriginalModel) {
    const resolved = resolveModel(resolvedOriginalModel)
    if (resolved !== resolvedOriginalModel) {
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

  // Unconditionally clamp output_config.effort to the model's
  // reasoning_effort allowlist. Runs even when translateThinking did
  // not fire — catches requests that arrive ALREADY in Copilot shape
  // (e.g. Claude Code agent-teams teammates that send xhigh to opus-4.8,
  // which Copilot rejects with "output_config.effort 'xhigh' is not
  // supported by model claude-opus-4.8; supported values: [medium]").
  // Policy: the proxy does not forward a value upstream rejects.
  if (clampOutputConfigEffortInPlace(parsed, selectedModel)) {
    modified = true
  }

  // Copilot rejects cache_control.scope generally and rejects the entire
  // cache_control object on signed thinking history. Keep the common fast path
  // while detecting the signed-block special case.
  const needsSanitize =
    rawBody.includes('"scope"')
    || (
      rawBody.includes('"cache_control"')
      && (
        rawBody.includes('"thinking"')
        || rawBody.includes('"redacted_thinking"')
      )
    )
  if (needsSanitize && sanitizeCacheControl(parsed)) {
    modified = true
  }

  // Strip Anthropic-only top-level body fields Copilot 400s on. Empirical
  // verification (2026-05-11 / 2026-05-13 against api.enterprise.githubcopilot.com):
  //   - `budget: {total_tokens}` (Task Budgets) → 400 "budget: Extra inputs not permitted"
  //   - `output_config: {schema}` (Structured Outputs) → 400 "output_config.schema: Extra..."
  //   - `betas: [...]` (top-level array, distinct from anthropic-beta header) → 400 "betas: Extra..."
  //   - `tools[i].eager_input_streaming` (Fine-Grained Tool Streaming) → 400
  //     "tools.0.custom.eager_input_streaming: Extra inputs are not permitted"
  //     (the `.custom.` infix is Copilot's error-format; the actual emit
  //     location from Claude Code is the top of each tool object per
  //     https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming).
  //     Stripping disables only the streaming-chunk-size optimization;
  //     correctness is unaffected — `input_json_delta` events still flow,
  //     just with `partial_json:""` instead of populated chunks.
  //     Probes: `eager_input_streaming_strips` / `eager_input_streaming_passthrough`
  //     in scripts/probe-copilot-compat.sh.
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
    || rawBody.includes('"eager_input_streaming"')
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

// Re-exported for backward compatibility — the definitions moved to
// `~/lib/reasoning-effort` (shared with the Anthropic-translation shim).
export { EFFORT_ORDER, bucketEffort, clampEffort }

/**
 * Clamp `body.output_config.effort` to the model's
 * `capabilities.supports.reasoning_effort` allowlist. Mutates `body`
 * in place. Returns true iff a clamp was applied.
 *
 * Sibling to `translateThinking`'s internal clamp — that one only fires
 * when the request arrives in the Anthropic `thinking:{type:"enabled"}`
 * shape (which the translator converts into `output_config.effort`).
 * Requests that arrive ALREADY in Copilot shape (`output_config.effort`
 * set by the client) would otherwise pass through unclamped and 400 at
 * upstream — the failure mode is exactly the one Claude Code agent-teams
 * teammates hit on opus-4.8 with `xhigh` effort (Copilot rejects with
 * "output_config.effort 'xhigh' is not supported by model
 * claude-opus-4.8; supported values: [medium]").
 *
 * Generic policy: the proxy does not forward a value upstream rejects.
 * If the model declares a `reasoning_effort` allowlist and the
 * client-supplied `output_config.effort` is not in it, clamp via
 * `clampEffort` (using `EFFORT_ORDER` bucketing). Unknown effort
 * values fall through to `clampEffort`'s "no closer tier" branch
 * (returns the original); the model would then 400 at upstream, which
 * is the right behaviour for genuinely invalid input.
 *
 * No-ops when:
 *   - The model has no `reasoning_effort` allowlist (some models
 *     accept arbitrary efforts; treat absent allowlist as "any
 *     accepted")
 *   - `body.output_config` is missing or not a plain object
 *   - `body.output_config.effort` is missing or not a string
 *   - The current effort is already in the allowlist (no-op clamp)
 */
export function clampOutputConfigEffortInPlace(
  body: AnyRecord,
  model?: Model,
): boolean {
  if (!model?.capabilities?.supports?.reasoning_effort) return false
  const supported = model.capabilities.supports.reasoning_effort
  if (!Array.isArray(supported) || supported.length === 0) return false
  if (!body.output_config || typeof body.output_config !== "object") return false
  const oc = body.output_config as AnyRecord
  const current = oc.effort
  if (typeof current !== "string") return false
  if (supported.includes(current)) return false
  // Pass the current effort through `clampEffort` if it is a known
  // EFFORT_ORDER bucket; otherwise fall back to picking the nearest
  // supported tier by treating unknown values as the TOP tier (so we always
  // clamp DOWN to the highest supported, never up).
  const bucketed = (EFFORT_ORDER as ReadonlyArray<string>).includes(current)
    ? (current as (typeof EFFORT_ORDER)[number])
    : UNKNOWN_EFFORT_ANCHOR
  const clamped = clampEffort(bucketed, supported)
  if (clamped === current) return false
  oc.effort = clamped
  return true
}

/**
 * Sum native Claude `/v1/messages` usage into the TOTAL input-token figure
 * `logRequest`'s context-window-fill display expects.
 *
 * Anthropic's `input_tokens` is the NEW (uncached) portion ONLY — unlike
 * OpenAI's inclusive total, it excludes both `cache_read_input_tokens` and
 * `cache_creation_input_tokens`. Forwarding it alone understates the real
 * prompt size on any cache hit, sometimes drastically: a live warm-cache turn
 * measured `input_tokens: 26` alongside `cache_read_input_tokens: 97304` — the
 * actual prompt was ~97k tokens, not 26. Returns `undefined` only when
 * `usage` itself is absent, so the log line omits the field entirely rather
 * than reporting a fabricated total (matching how `formatTokenInfo` treats an
 * undefined `inputTokens`).
 */
export function anthropicTotalInputTokens(
  usage:
    | {
        input_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
      }
    | undefined,
): number | undefined {
  if (usage === undefined) return undefined
  return (
    (usage.input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
  )
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
  const t = thinking as AnyRecord
  if (t.type !== "enabled") return false

  const bucketed = bucketEffort(t.budget_tokens)
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
 * Strip the `scope` field from ordinary `cache_control` objects. Copilot
 * rejects the entire cache_control object on signed thinking blocks, so remove
 * that unsigned transport metadata without touching thinking/signature/data.
 * Claude CLI 2.1.88+ sends {"type":"ephemeral","scope":"global"} which
 * Copilot rejects. Mutates the parsed object in place.
 *
 * Covers: system blocks, message content blocks (including nested
 * tool_result content), and tool definitions.
 */
function sanitizeCacheControl(body: AnyRecord): boolean {
  let stripped = false
  function stripScope(block: AnyRecord): void {
    const cc = block.cache_control as AnyRecord | undefined
    if (
      cc
      && (block.type === "thinking" || block.type === "redacted_thinking")
    ) {
      delete block.cache_control
      stripped = true
      return
    }
    if (cc?.scope !== undefined) {
      delete cc.scope
      if (Object.keys(cc).length === 0) {
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
  // Per-tool field strip: `eager_input_streaming` (Fine-Grained Tool Streaming).
  // Auto-enabled by getClaudeCodeEnvVars setting CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1
  // (see src/lib/server-setup.ts), which causes the Claude Code SDK to emit
  // `eager_input_streaming: true` on each custom tool definition. Copilot rejects.
  // JSON-AST traversal — never regex on the raw body (gemini-critic: would
  // corrupt prompt text containing the same string).
  if (Array.isArray(body.tools)) {
    let warnedFGTS = false
    for (const tool of body.tools) {
      if (typeof tool === "object" && tool !== null) {
        const t = tool as AnyRecord
        if (t.eager_input_streaming !== undefined) {
          delete t.eager_input_streaming
          stripped = true
          if (!warnedFGTS) {
            consola.warn(
              "Stripping per-tool `eager_input_streaming` field (Copilot 400s on `tools.*.custom.eager_input_streaming`; FGTS chunk-size optimization disabled, but streaming correctness is unaffected — `input_json_delta` events still flow normally)",
            )
            warnedFGTS = true
          }
        }
      }
    }
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
