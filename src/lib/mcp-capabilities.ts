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
  colbertArtifactsPresent,
  colbertSmokeOk,
} from "./colbert/provision"
import { parseBoolEnv } from "./exec"
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
 *      worker's default model (`gemini-3.1-pro-preview`) AND that entry
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
 * the compressor fallback chain (`gpt-5.4-mini` → `claude-sonnet-4-6` →
 * `claude-haiku-4-5`) is present in the live catalog with `tool_calls`
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
 * Gate for the `semantic_search` tool (the ColBERT sidecar).
 *
 * Semantic search is ON BY DEFAULT (the proxy auto-provisions the
 * colgrep binary + ONNX Runtime + ColBERT model and background-indexes
 * the cwd at launch), so unlike `--browse` there is no opt-IN flag —
 * only an opt-OUT env var, mirroring the toolbelt convention.
 *
 * Returns true iff BOTH:
 *   1. **Not opted out:** `GH_ROUTER_DISABLE_SEMANTIC_SEARCH` is unset /
 *      falsy.
 *   2. **Actually available on disk:** the colgrep binary + model + ORT
 *      are provisioned AND the post-provision smoke test passed
 *      (`colbertArtifactsPresent()` && `colbertSmokeOk()`).
 *
 * This is **availability-based**, exactly like `browserToolsEnabled()`'s
 * `hasSupportedBrowserInstalled()` check — and it's the load-bearing
 * regression guard: in any environment where provisioning hasn't
 * completed or can't run (CI, sandboxes, no network), the artifacts are
 * absent ⇒ the gate is false ⇒ `semantic_search` is NOT listed and NOT
 * callable ⇒ the existing `{code, web}` `tools/list` surface is
 * unchanged. The tool appears only on a machine where provisioning
 * succeeded.
 *
 * Gate fires symmetrically at `tools/list` and `tools/call` (drop +
 * -32601), exactly like the other capability tags.
 */
export function semanticSearchEnabled(): boolean {
  if (parseBoolEnv(process.env.GH_ROUTER_DISABLE_SEMANTIC_SEARCH) === true) {
    return false
  }
  return colbertArtifactsPresent() && colbertSmokeOk()
}

