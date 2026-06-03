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

import { compressorAvailable } from "./browser-mcp/compressor"
import { state } from "./state"
import { DEFAULT_MODEL as WORKER_DEFAULT_MODEL } from "./worker-agent"

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
 * Gate for the worker tools (`worker_explore`, `worker_implement`).
 *
 * Returns true iff BOTH:
 *   1. Copilot's live catalog (`state.models?.data`) contains the
 *      worker's default model (`gemini-3.5-flash`) AND that entry
 *      advertises `capabilities.supports.tool_calls === true`. The
 *      worker loop is function-calling; a model that can't emit
 *      tool_calls is unusable, so dormant-register (omit from
 *      `tools/list`) keeps the surface honest.
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
 * the compressor fallback chain (`gemini-3.5-flash` → `gpt-5.4-mini` →
 * `claude-haiku-4-5`) is present in the live catalog with `tool_calls`
 * support. When none are reachable the compound tools are dropped from
 * `tools/list` AND fail `tools/call` with -32601.
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
