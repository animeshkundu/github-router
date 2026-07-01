/**
 * Capability-gate predicates for the proxy's MCP tool surface.
 *
 * Extracted from `src/routes/mcp/handler.ts` so callers outside the
 * Hono route — specifically `src/claude.ts` when computing the
 * `buildPeerAwarenessSnippet` arguments — can mirror the same
 * predicates without dragging the route handler's transitive deps
 * into CLI startup.
 *
 * SINGLE SOURCE OF TRUTH. Both `handler.ts` (for `tools/list` /
 * `tools/call` gating) and `claude.ts` (for snippet text gating) import
 * from this module — drift between the snippet's tool mentions and the
 * live tool list would be a silent regression (the snippet would name
 * a tool the live catalog doesn't expose).
 */

import { hasSupportedBrowserInstalled } from "./browser-mcp/browser-detect"
import { compressorAvailable } from "./browser-mcp/compressor"
import {
  colbertSearchEnabled,
} from "./colbert"
import { state } from "./state"
import {
  BROWSE_DEFAULT_MODEL,
  DEFAULT_MODEL as WORKER_DEFAULT_MODEL,
} from "./worker-agent"
import { pickEndpoint } from "../services/copilot/endpoint"

/**
 * Gate for the `stand_in` tool.
 *
 * Returns true iff Copilot's live catalog (`state.models?.data`) contains
 * ALL THREE peer models the consensus protocol needs:
 *   - `gpt-5.5`             (codex_critic's model)
 *   - `claude-opus-4-7`     (opus_critic's model)
 *   - any `gemini-3.X.*pro` (gemini_critic's model family — matches the
 *     same regex `geminiAvailable()` uses, so the gate stays in sync if
 *     the GA slug renames `gemini-3.1-pro-preview` → `gemini-3.1-pro`)
 *
 * If any one is missing, `stand_in` is dropped from `tools/list` AND
 * fails `tools/call` with -32601 (mirroring the `worker` capability's
 * defense-in-depth pattern — the gated tool is functionally invisible).
 *
 * Tier-mismatch on `claude-opus-4-7`: the proxy's `resolveModel` will
 * fuzzy-match `claude-opus-4-7` to `claude-opus-4.7` (Copilot's dotted
 * slug). For the catalog probe we use the Anthropic-published dashed
 * slug too — `state.models?.data` mirrors Copilot's catalog where these
 * land under the dotted slug, so we match by Copilot's actual id shape.
 */
export function standInToolEnabled(): boolean {
  const models = state.models?.data
  if (!models) return false
  const hasGpt55 = models.some((m) => m.id === "gpt-5.5")
  const hasOpus = models.some(
    (m) => m.id === "claude-opus-4-7" || m.id === "claude-opus-4.7",
  )
  const hasGeminiPro = models.some((m) => /^gemini-3\..*pro/i.test(m.id))
  return hasGpt55 && hasOpus && hasGeminiPro
}

/**
 * Gate for the worker tools (`explore`, `review`, `implement`).
 *
 * Returns true iff BOTH:
 *   1. Copilot's live catalog (`state.models?.data`) contains the
 *      worker default model (`gpt-5.4-mini`, used by explore)
 *      AND that entry advertises `capabilities.supports.tool_calls ===
 *      true`. The worker loop is function-calling; a model that can't
 *      emit tool_calls is unusable, so dormant-register (omit from
 *      `tools/list`) keeps the surface honest. (The implement default
 *      `gpt-5.5` is NOT gated here — if it's absent, implement calls
 *      surface a clean resolve error rather than disabling all worker
 *      tools, since explore/review still work.)
 *   2. The operator hasn't set `GH_ROUTER_DISABLE_WORKER_TOOLS=1`
 *      (opt-out — workers ship enabled by default per plan).
 *
 * Callers that pass `model: <non-default>` bypass this list-time
 * gate but still hit the per-call `resolveModelAndThinking`
 * validation in the engine, which surfaces a clean `isError`
 * envelope with the catalog's eligible model ids on mismatch.
 *
 * `WORKER_DEFAULT_MODEL` is imported (aliased from `DEFAULT_MODEL`)
 * from `src/lib/worker-agent` so the engine owns the single source
 * of truth.
 */
export function workerToolsEnabled(): boolean {
  if (process.env.GH_ROUTER_DISABLE_WORKER_TOOLS === "1") return false
  const models = state.models?.data
  if (!models) return false
  const found = models.find((m) => m.id === WORKER_DEFAULT_MODEL)
  if (!found) return false
  return found.capabilities?.supports?.tool_calls === true
}

/**
 * Gate for the compound L2 browser tools (`browser_find`, `browser_act`
 * in intent mode, `browser_extract`).
 *
 * Returns true iff `compressorAvailable()` — i.e. at least one model in
 * the compressor fallback chain (`gpt-5.4-mini` → `claude-sonnet-4.6` →
 * `claude-haiku-4.5`) is present in the live catalog with `tool_calls`
 * AND a reachable endpoint (`/chat/completions` or `/responses`). When
 * none are reachable the compound tools are dropped from `tools/list`
 * AND fail `tools/call` with -32601.
 *
 * Note: this gate does NOT additionally re-check the `browser` opt-in.
 * The `handler.ts` filter chain runs `browser` and `browser_compound`
 * via separate `capability` tags; the compound tools' entries also
 * apply at the route level via the existing `--browse` enablement
 * because they live under the browser MCP surface that the route
 * only mounts when `state.browseEnabled`.
 */
export function browserCompoundToolsEnabled(): boolean {
  return compressorAvailable()
}

/**
 * Gate for the L0/L1 power browser tools (`browser_read_page`,
 * `browser_mouse`, `browser_drag`, `browser_type`, `browser_keyboard`,
 * `browser_scroll`, `browser_eval_js`, `browser_diagnostics`,
 * `browser_find`, `browser_close_tab`, `browser_list_tabs`,
 * `browser_wait`, `browser_download`).
 *
 * Returns true iff `state.powerBrowseEnabled` (set by `--power-browse`
 * or `GH_ROUTER_ENABLE_POWER_BROWSE=1`). When off, the default
 * `--browse` surface exposes only the 6 lead-model tools (`act`,
 * `observe`, `extract`, `navigate`, `screenshot`, `open_tab`) that
 * hide DOM details behind intent. Power mode adds the raw primitives
 * for users who want direct coord/keystroke control.
 *
 * `handler.ts` filter chain ANDs this with `browserToolsEnabled()`
 * (defense-in-depth — power without basic is meaningless and the
 * setup path already forces basic on when power is on).
 */
export function browserPowerToolsEnabled(): boolean {
  return state.powerBrowseEnabled === true
}

/**
 * Gate for the whole `browser` MCP server (the `--browse` opt-in surface).
 *
 * Returns true iff BOTH:
 *   1. The operator opted in (`state.browseEnabled`, set by `--browse`, OR
 *      `GH_ROUTER_ENABLE_BROWSE=1` read directly so non-`setupAndServe`
 *      startup paths — tests, embedded use — can still flip the gate).
 *   2. At least one Chromium-family browser is detected on disk
 *      (`hasSupportedBrowserInstalled()`, cached for the proxy lifetime).
 *
 * Moved here from `handler.ts` so both the route handler (list-time +
 * call-time gating) AND `claude.ts` (deciding whether to register the
 * `browser` scoped MCP server at launch) share one predicate — registering
 * a server whose tools would all be gated out produces an empty-server smell.
 */
export function browserToolsEnabled(): boolean {
  const optedIn =
    state.browseEnabled || process.env.GH_ROUTER_ENABLE_BROWSE === "1"
  if (!optedIn) return false
  return hasSupportedBrowserInstalled()
}

/**
 * Gate for the fleet session-control MCP tools (`mcp__fleet__*`).
 *
 * Returns true iff the operator opted in (`state.fleetEnabled`, set by
 * `--fleet`, OR `GH_ROUTER_ENABLE_FLEET=1` read directly so non-
 * `setupAndServe` startup paths — tests, embedded use — can still flip
 * the gate). Fleet needs no local installed dependency check.
 */
export function fleetToolsEnabled(): boolean {
  return state.fleetEnabled || process.env.GH_ROUTER_ENABLE_FLEET === "1"
}

/**
 * Gate for the first-mate cloud-agent MCP tools (`mcp__first-mate__*`).
 *
 * Returns true iff the operator opted in (`state.agentsEnabled`, set by
 * `--agents`, OR `GH_ROUTER_ENABLE_AGENTS=1` read directly so non-
 * `setupAndServe` startup paths — tests, embedded use — can still flip
 * the gate) AND the write-capable GitHub agent token is present. First-mate
 * drives GitHub cloud agents, so exposing the surface without that token would
 * only produce unactionable auth failures.
 */
export function agentToolsEnabled(): boolean {
  return (
    (state.agentsEnabled || process.env.GH_ROUTER_ENABLE_AGENTS === "1")
    && typeof state.githubAgentToken === "string"
    && state.githubAgentToken.length > 0
  )
}

/**
 * Gate for ai-or-die Artifact review tools.
 *
 * Returns true iff this github-router process was launched inside an
 * ai-or-die tab and received the tab-scoped API trio. The tools are
 * otherwise invisible at `tools/list` and rejected at `tools/call`; direct
 * handler calls still return a friendly isError envelope.
 */
export function artifactToolsEnabled(): boolean {
  return !!(
    process.env.AIORDIE_BASE_URL
    && process.env.AIORDIE_TOKEN
    && process.env.AIORDIE_SESSION_ID
  )
}

/**
 * Gate for the `browse` worker tool (the Pi-driven autonomous browser
 * agent that delegates a browsing task to its own context).
 *
 * Returns true iff BOTH:
 *   1. `browserToolsEnabled()` — the `--browse` opt-in AND a supported
 *      browser is on disk. The browse agent drives the SAME Chrome/Edge
 *      bridge as the raw `browser_*` tools, so it can't be useful without
 *      that surface enabled.
 *   2. The browse default model (`BROWSE_DEFAULT_MODEL`, `gpt-5.4-mini`)
 *      is in Copilot's live catalog AND `pickEndpoint()` resolves a
 *      reachable endpoint for it. Unlike `workerToolsEnabled()` (which
 *      checks `tool_calls` on the gemini default), the browse default is
 *      a `/responses`-only gpt-5.x model — `pickEndpoint` is the right
 *      reachability probe (it returns undefined only when the model
 *      serves neither chat nor responses).
 *
 * Callers that pass an explicit `model` to the browse tool still hit the
 * per-call `resolveModelAndThinking` validation in the engine; this
 * list-time gate is about the DEFAULT being reachable.
 *
 * `BROWSE_DEFAULT_MODEL` is imported from `src/lib/worker-agent` so the
 * engine owns the single source of truth (no parallel slug to drift).
 *
 * Gate fires symmetrically at `tools/list` and `tools/call` (drop +
 * -32601), the same defense-in-depth pattern as the other capability
 * tags.
 */
export function browseAgentEnabled(): boolean {
  if (!browserToolsEnabled()) return false
  const models = state.models?.data
  if (!models) return false
  const found = models.find((m) => m.id === BROWSE_DEFAULT_MODEL)
  if (!found) return false
  return pickEndpoint(found) !== undefined
}

/**
 * Internal availability predicate for ColBERT semantic search.
 *
 * NOTE: semantic search is no longer a standalone `semantic_search` MCP
 * tool — it is folded into the unified `code` tool, whose default mode
 * attempts ColBERT and transparently falls back to lexical when this
 * predicate is false or the index isn't ready. This function therefore
 * no longer gates a tool's `tools/list` visibility; it answers the
 * single question "should the `code` tool attempt ColBERT before
 * falling back to lexical?"
 *
 * Delegates to the leaf `colbertSearchEnabled()` (the single source of
 * truth, in `src/lib/colbert/`) so the unified helper can read the same
 * decision without importing this module (cycle avoidance). True iff the
 * operator hasn't opted out (`GH_ROUTER_DISABLE_SEMANTIC_SEARCH`) AND the
 * colgrep binary + model + ORT are provisioned on disk AND the
 * post-provision smoke test passed.
 */
export function semanticSearchEnabled(): boolean {
  return colbertSearchEnabled()
}

