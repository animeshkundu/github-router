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
import { GEMINI_REVIEW_DEFAULT_MODEL } from "./gemini-review-model"
import { OPENAI_FRONTIER_MODELS } from "./openai-frontier"
import { ONE_M_TOKENS } from "./one-m-context"
import { maxProReplacementModel } from "./max-profile-contract"
import { fastEndpointForModel } from "./fast-endpoint"
import {
  FAST_PROFILE_ADVISOR_EFFORT,
  FAST_PROFILE_NATIVE_EFFORTS,
  FAST_PROFILE_NATIVE_MODELS,
  FAST_PROFILE_ORACLE_EFFORT,
  FAST_PROFILE_ORACLE_MODEL,
} from "./fast-profile-contract"
import { FAST_REVIEWER_MIN_PROMPT_TOKENS } from "./launch-profile"
import { state, type State } from "./state"
import {
  BROWSE_DEFAULT_MODEL,
  DEFAULT_MODEL_CHAIN as WORKER_DEFAULT_MODEL_CHAIN,
} from "./worker-agent"
import { pickEndpoint } from "../services/copilot/endpoint"

export const REVIEW_FAST_DEFAULT_MODEL = "gemini-3.7-flash"

/**
 * Gate for the `stand_in` tool.
 *
 * Returns true iff Copilot's live catalog (`state.models?.data`) contains
 * ALL THREE peer models the consensus protocol needs:
 *   - an OpenAI frontier model (`gpt-5.6-sol`, else `gpt-5.5` — see
 *     `resolveOpenAiFrontier`)
 *   - `claude-opus-5`       (stand_in's Anthropic slot)
 *   - standard/BYO: the preferred Gemini reviewer model
 *     (`gemini-3.1-pro-preview`, falling back to `gemini-3.7-flash`)
 *   - max: Grok 4.6/high when usable, otherwise Gemini 3.7 Flash 1M/high
 *
 * If any one is missing, `stand_in` is dropped from `tools/list` AND
 * fails `tools/call` with -32601 (mirroring the `worker` capability's
 * defense-in-depth pattern — the gated tool is functionally invisible).
 *
 * `claude-opus-5` is a single-segment slug (dotted == dashed), so the
 * catalog probe matches Copilot's actual id shape directly.
 */
/**
 * Any live-catalog model matching Google's `gemini-3.x-pro` family, excluding
 * the two known literals — catches a GA rename of the preview slug (e.g.
 * `gemini-3.1-pro-preview` -> `gemini-3.1-pro`) so a vendor rename doesn't
 * silently downgrade every Gemini-gated resolver to the flash fallback while a
 * real pro-tier successor is actually present in the catalog. This is the
 * same regex the removed `geminiAvailable()` used, for the same reason —
 * losing it here was a real regression caught in review, not a deliberate
 * simplification.
 */
function findGeminiProGaRename(models: ReadonlyArray<{ id: string }>): string | undefined {
  return models.find(
    (m) => /^gemini-3\..*pro/i.test(m.id)
      && m.id !== GEMINI_REVIEW_DEFAULT_MODEL
      && m.id !== REVIEW_FAST_DEFAULT_MODEL,
  )?.id
}

export function resolveGeminiReviewModel(
  source: Pick<State, "models"> = state,
): string | undefined {
  const models = source.models?.data
  if (!models) return undefined
  if (models.some((m) => m.id === GEMINI_REVIEW_DEFAULT_MODEL)) return GEMINI_REVIEW_DEFAULT_MODEL
  const gaRename = findGeminiProGaRename(models)
  if (gaRename) return gaRename
  if (models.some((m) => m.id === REVIEW_FAST_DEFAULT_MODEL)) {
    return REVIEW_FAST_DEFAULT_MODEL
  }
  return undefined
}

/**
 * Gemini review candidates in preference order, for resolvers that ALSO need
 * `firstPresentInCatalog`'s `requireToolCalls`/`minContextTokens` enforcement
 * (`resolveGeminiReviewModel()` only checks id presence, not those capability
 * flags). Mirrors `resolveGeminiReviewModel()`'s own preference order: the
 * known preview id, then a GA rename of it, then the flash fallback — kept as
 * a shared helper so `reviewerModel()`/`brainstormModel()` can't drift from
 * `resolveGeminiReviewModel()`'s GA-rename handling the way the hardcoded
 * per-resolver chains did before this was extracted.
 */
function geminiReviewChainCandidates(): Array<string> {
  const models = state.models?.data ?? []
  const gaRename = findGeminiProGaRename(models)
  return [GEMINI_REVIEW_DEFAULT_MODEL, ...(gaRename ? [gaRename] : []), REVIEW_FAST_DEFAULT_MODEL]
}

export function geminiAvailable(source: Pick<State, "models"> = state): boolean {
  return resolveGeminiReviewModel(source) != null
}

/**
 * OpenAI frontier reasoning models in preference order. `gpt-5.6-sol` is the
 * current default; `gpt-5.5` is retained as a fallback. Both share the same
 * `pro_plus/business/enterprise/max` restriction tier, so the fallback only
 * matters during a rollout-lag window where the newer slug hasn't yet appeared
 * in the account's catalog.
 */
export { OPENAI_FRONTIER_MODELS } from "./openai-frontier"

/**
 * First id in `chain` that is present in the live catalog. With
 * `requireToolCalls`, skips an entry whose catalog record does not advertise
 * `tool_calls` (strict `!== true`, so absent metadata fails closed). With
 * `minContextTokens`, skips an entry whose advertised context window is below
 * that floor (absent metadata likewise fails closed). Returns undefined when
 * the catalog is unavailable or nothing in the chain matches, so every caller
 * degrades gracefully rather than throwing on a thin catalog.
 *
 * Extracted from `resolveOpenAiFrontier` so the per-agent resolvers below share
 * one walk instead of hand-copying it. Ids are matched EXACTLY against
 * `catalog.id` — no slug translation, matching the pre-existing behavior.
 *
 * `minContextTokens` is OPT-IN because the constraint is genuinely per-agent:
 * the conditional cheaper-tier agents promise 1M end to end. Enforcing the
 * floor here rather than by comment is what stops a chain silently degrading
 * when an id's advertised window shrinks upstream — `withOneMSuffix` would then
 * just omit the `[1m]` bracket, and the agent would be budgeted at Claude Code's
 * 200K default with no signal that anything changed.
 */
export function firstPresentInCatalog(
  chain: ReadonlyArray<string>,
  opts?: { requireToolCalls?: boolean, minContextTokens?: number },
): string | undefined {
  const models = state.models?.data
  if (!models) return undefined
  for (const id of chain) {
    const found = models.find((m) => m.id === id)
    if (!found) continue
    if (opts?.requireToolCalls && found.capabilities?.supports?.tool_calls !== true) {
      continue
    }
    if (
      opts?.minContextTokens != null
      && (found.capabilities?.limits?.max_context_window_tokens ?? 0)
        < opts.minContextTokens
    ) {
      continue
    }
    return id
  }
  return undefined
}

/**
 * First available OpenAI frontier model in the live catalog (prefer
 * `gpt-5.6-sol`, fall back to `gpt-5.5`). Returns undefined when neither is
 * present. With `requireToolCalls`, only returns a model whose catalog entry
 * advertises `tool_calls`.
 */
export function resolveOpenAiFrontier(opts?: {
  requireToolCalls?: boolean
}): string | undefined {
  return firstPresentInCatalog(OPENAI_FRONTIER_MODELS, opts)
}

export function standInToolEnabled(opts: { maxProfile?: boolean } = {}): boolean {
  const models = state.models?.data
  if (!models) return false
  const hasOpenAi = resolveOpenAiFrontier() != null
  const hasOpus = models.some((m) => m.id === "claude-opus-5")
  const hasThirdLab = opts.maxProfile
    ? maxProReplacementModel() != null
    : geminiAvailable()
  return hasOpenAi && hasOpus && hasThirdLab
}

/** Model for the native subagent that wants the OpenAI frontier coder
 *  (`implementer`) iff it is live with tool calls. Prefers `gpt-5.6-sol`, falls
 *  back to `gpt-5.5`. Absent → the agent omits its `model:` line and inherits
 *  the lead's model.
 *
 *  Public web benchmarks put `gpt-5.6-sol` ahead of both `gpt-5.6-terra` and
 *  `gpt-5.3-codex` on coding (Terminal-Bench 2.1 88.8 vs 87.1; SWE-bench
 *  Verified 96.2 vs ~80 for 5.3-codex, which also trails gpt-5.5 on SWE-bench
 *  Pro). Terra is the cheaper tier at ~98% of the capability, so it is the right
 *  call only if cost dominates, which this project's operating rules say it does
 *  not. Left on sol deliberately. */
export function nativeSubagentModel(): string | undefined {
  return resolveOpenAiFrontier({ requireToolCalls: true })
}

/**
 * Model for `reviewer` — Google-first, deliberately NOT the implementer's model.
 *
 * `reviewer` used to share `nativeSubagentModel()` with `implementer`, which
 * meant that whenever `implementer` produced the artifact the default review path
 * was one model checking its own output. Not merely the same lab: the same
 * model. Two independent blind audits flagged it, and the repo already applies
 * the opposite rule one layer down, where `worker-review` runs
 * `GEMINI_REVIEW_DEFAULT_MODEL` precisely so the reviewer's lab is decorrelated from the
 * producer's.
 *
 * The Anthropic lead and the OpenAI-frontier `implementer` are the two producers
 * that matter here, so a Google reviewer is cross-lab against both. The OpenAI
 * frontier remains the fallback: a same-lab reviewer still beats no reviewer.
 */
export function reviewerModel(): string | undefined {
  return firstPresentInCatalog(
    // GEMINI_REVIEW_DEFAULT_MODEL is deprecated for 2026-09-01 removal.
    // geminiReviewChainCandidates() also catches a GA rename of it ahead of
    // the Flash fallback, which stays ahead of OpenAI so review remains
    // decorrelated from implementer. Once Pro disappears (and no GA successor
    // has shipped), reviewer and reviewer-fast intentionally converge on Flash
    // until Google ships a real pro-tier successor.
    [...geminiReviewChainCandidates(), ...OPENAI_FRONTIER_MODELS],
    { requireToolCalls: true },
  )
}

/*
 * The per-agent preference chains are built INSIDE their resolvers, not as
 * module-level consts. `./worker-agent` participates in an import cycle with
 * this module, so its exported bindings are still in the temporal dead zone
 * while this module's top level runs — a `const CHAIN = [GEMINI_REVIEW_DEFAULT_MODEL]`
 * throws `Cannot access ... before initialization` at load. Referencing them
 * lazily inside a function body defers the read until after both modules have
 * initialized, which is why reads of the worker fallback chain below stay
 * function-local too.
 */

/** Model for `brainstorm`. Absent → inherits the lead's model.
 *
 *  Leads with Google so the options it generates come from a third lab: the
 *  Anthropic lead is the producer and the OpenAI frontier already backs
 *  `implementer`/`reviewer`, so a same-lab brainstormer would mostly restate
 *  what the lead already thought of. */
export function brainstormModel(): string | undefined {
  return firstPresentInCatalog(
    // Match reviewerModel's same-lab deprecation + GA-rename fallback. The
    // temporary reviewer/reviewer-fast convergence after Pro removal is
    // deliberate.
    [...geminiReviewChainCandidates(), ...OPENAI_FRONTIER_MODELS],
    { requireToolCalls: true },
  )
}

/** Model for `scribe`. Absent → inherits the lead's model.
 *
 *  Leads with the mid tier: documentation is verifiable prose, not frontier
 *  reasoning. */
export function scribeModel(): string | undefined {
  return firstPresentInCatalog(
    ["gpt-5.6-terra", ...OPENAI_FRONTIER_MODELS],
    { requireToolCalls: true },
  )
}

/**
 * Model for `scout` — CHEAP TIER ONLY, with no frontier fallback on purpose.
 *
 * `scout` exists so a foreground repository lookup does not run at the lead's
 * model rates. The usual "absent → omit `model:` and inherit the lead" fallback
 * would therefore defeat the agent: on a thin or briefly-unavailable catalog it
 * would silently start answering grep-and-summarize questions on Opus, which is
 * the exact cost it was added to avoid. Returning undefined here makes the
 * caller drop the agent instead, so the lead falls back to the CLI's `Explore`
 * (same behavior as before `scout` existed) rather than to an expensive
 * impostor wearing the cheap agent's name.
 *
 * `gpt-5.6-luna` leads because it is the cheapest 1M-context model in the
 * catalog; `gemini-3.7-flash` remains the cross-vendor fallback so an OpenAI-side
 * outage does not remove the scout. Both entries must continue advertising at
 * least 1M context so Claude Code's `[1m]` accounting remains honest if an
 * upstream catalog entry shrinks.
 *
 * The fallback moved off `gemini-3.6-flash` on 2026-08-13: `gemini-3.7-flash`
 * is strictly better on every axis this chain cares about — half the price
 * (75/375 vs 150/750 per 1M), materially faster (measured tool-call p50 ~1.2s
 * against 3.6's ~2.6s), same 1M window, same vendor, so the cross-vendor
 * property the fallback exists for is preserved.
 *
 * This chain deliberately uses literal ids rather than `EXPLORE_DEFAULT_MODEL`:
 * the explore worker default and scout's cross-vendor fallback are independent
 * policies, so retuning one must not silently collapse the other. There is no
 * 400K last resort. On a catalog carrying neither chain member, `scout` is
 * dropped rather than inheriting the lead or presenting a narrower-context agent.
 */
export const SCOUT_MODEL_CHAIN = Object.freeze([
  "gpt-5.6-luna",
  "gemini-3.7-flash",
] as const)

export function scoutModel(): string | undefined {
  return firstPresentInCatalog(
    SCOUT_MODEL_CHAIN,
    { requireToolCalls: true, minContextTokens: ONE_M_TOKENS },
  )
}

/*
 * The cheaper non-lead agents.
 *
 * `implementer-fast` is the mechanical implementation specialist, while
 * `general-purpose-fast` handles work no specialist fits. Like `scout` and for
 * the same reason, both are DROPPED rather than downgraded when their chain
 * misses: an agent whose whole value is costing less than the lead defeats
 * itself by silently inheriting Opus.
 *
 * Both carry `minContextTokens: ONE_M_TOKENS`. Their descriptions promise a 1M
 * window, so the floor is what keeps that promise true against an upstream
 * catalog change rather than merely asserted in a comment.
 */

/** Model for `implementer-fast` — the cheaper implementation tier. Absent →
 *  the agent is dropped.
 *
 *  `gpt-5.6-sol` is deliberately NOT in this chain: changes needing frontier
 *  judgment already belong to `implementer`, while this agent handles
 *  well-specified, mechanical changes at a lower tier. Both entries are 1M+;
 *  their different speed and effort properties stay out of shared claims. */
export function implementerFastModel(): string | undefined {
  return firstPresentInCatalog(
    ["gpt-5.6-terra", GEMINI_REVIEW_DEFAULT_MODEL],
    { requireToolCalls: true, minContextTokens: ONE_M_TOKENS },
  )
}

/** Model for `reviewer-fast` — the cheaper Google review tier. Absent → the
 *  agent is dropped. Single-entry by design: inheriting the lead or falling
 *  across labs would defeat both its cost purpose and its decorrelation from
 *  the OpenAI-backed implementer. */
export function reviewerFastModel(): string | undefined {
  return firstPresentInCatalog(
    [REVIEW_FAST_DEFAULT_MODEL],
    { requireToolCalls: true, minContextTokens: ONE_M_TOKENS },
  )
}

/** Model for `general-purpose-fast` — the fast, cheapest catch-all. Absent →
 *  dropped.
 *
 *  Single-entry by design. `gpt-5.6-luna` is the cheapest model in the live
 *  catalog and measured fastest among the catch-all candidates, while carrying
 *  1.05M context and the full `none..max` effort ladder. No
 *  `-mini`/`-lite`/`-haiku` model in the catalog serves 1M, which is why this
 *  catch-all uses a `gpt-5.6-*` slug rather than a mini one. */
export function generalPurposeFastModel(): string | undefined {
  return firstPresentInCatalog(
    ["gpt-5.6-luna"],
    { requireToolCalls: true, minContextTokens: ONE_M_TOKENS },
  )
}

/*
 * Fast-launch-profile ("-m fast") native model resolvers.
 *
 * These are deliberately separate from the standard resolvers above. The fast
 * profile is a hard, single-entry, no-fallback assignment: `Explore` and
 * `implementer` pin to Luna, `reviewer` pins to Grok, and `planner` pins to
 * Sol. Retuning a standard resolver must never move a fast role silently.
 */

export const FAST_EXPLORE_MODEL = FAST_PROFILE_NATIVE_MODELS.Explore
/** @deprecated Fast `scout` was renamed to capitalized `Explore`. */
export const FAST_SCOUT_MODEL = FAST_EXPLORE_MODEL
export const FAST_IMPLEMENTER_MODEL = FAST_PROFILE_NATIVE_MODELS.implementer
/** Grok 4.6 advertises 500K total context / 372K max prompt, so it remains bare
 *  and is gated by max_prompt_tokens rather than the 1M floor. */
export const FAST_REVIEWER_MODEL = FAST_PROFILE_NATIVE_MODELS.reviewer
export const FAST_PLANNER_MODEL = FAST_PROFILE_NATIVE_MODELS.planner
export const FAST_CRITIC_MODEL = FAST_PROFILE_NATIVE_MODELS.critic
export const FAST_ORACLE_MODEL = FAST_PROFILE_ORACLE_MODEL

/** Shared with startup validation so the reviewer resolver and fast launch
 * prerequisite cannot drift. */
export { FAST_REVIEWER_MIN_PROMPT_TOKENS } from "./launch-profile"

/** Fixed effort pins for the fast profile. */
export const FAST_EXPLORE_EFFORT = FAST_PROFILE_NATIVE_EFFORTS.Explore
/** @deprecated Fast `scout` was renamed to capitalized `Explore`. */
export const FAST_SCOUT_EFFORT = FAST_EXPLORE_EFFORT
export const FAST_IMPLEMENTER_EFFORT = FAST_PROFILE_NATIVE_EFFORTS.implementer
export const FAST_REVIEWER_EFFORT = FAST_PROFILE_NATIVE_EFFORTS.reviewer
export const FAST_PLANNER_EFFORT = FAST_PROFILE_NATIVE_EFFORTS.planner
export const FAST_CRITIC_EFFORT = FAST_PROFILE_NATIVE_EFFORTS.critic
export const FAST_ORACLE_EFFORT = FAST_PROFILE_ORACLE_EFFORT
export const FAST_ADVISOR_EFFORT = FAST_PROFILE_ADVISOR_EFFORT

export function fastScoutModel(): string | undefined {
  const id = firstPresentInCatalog(
    [FAST_SCOUT_MODEL],
    { requireToolCalls: true, minContextTokens: ONE_M_TOKENS },
  )
  if (!id) return undefined
  const found = state.models?.data.find((m) => m.id === id)
  return found && fastEndpointForModel(found) === "responses" ? id : undefined
}

export function fastImplementerModel(): string | undefined {
  const id = firstPresentInCatalog(
    [FAST_IMPLEMENTER_MODEL],
    { requireToolCalls: true, minContextTokens: ONE_M_TOKENS },
  )
  if (!id) return undefined
  const found = state.models?.data.find((m) => m.id === id)
  return found && fastEndpointForModel(found) === "responses" ? id : undefined
}

export function fastPlannerModel(): string | undefined {
  const id = firstPresentInCatalog(
    [FAST_PLANNER_MODEL],
    { requireToolCalls: true, minContextTokens: ONE_M_TOKENS },
  )
  if (!id) return undefined
  const found = state.models?.data.find((m) => m.id === id)
  const efforts = found?.capabilities?.supports?.reasoning_effort
  if (!Array.isArray(efforts) || !efforts.includes(FAST_PLANNER_EFFORT)) return undefined
  if (!found || fastEndpointForModel(found) !== "responses") return undefined
  return id
}

/** Gate Grok on the prompt limit that actually constrains pasted review input. */
export function fastReviewerModel(): string | undefined {
  const models = state.models?.data
  if (!models) return undefined
  const found = models.find((m) => m.id === FAST_REVIEWER_MODEL)
  if (!found) return undefined
  if (found.capabilities?.supports?.tool_calls !== true) return undefined
  const efforts = found.capabilities?.supports?.reasoning_effort
  if (!Array.isArray(efforts) || !efforts.includes(FAST_REVIEWER_EFFORT)) return undefined
  const maxPrompt = found.capabilities?.limits?.max_prompt_tokens ?? 0
  if (maxPrompt < FAST_REVIEWER_MIN_PROMPT_TOKENS) return undefined
  if (fastEndpointForModel(found) !== "responses") return undefined
  return FAST_REVIEWER_MODEL
}

/** Exact Gemini 3.7 Flash only: the fast native critic has no fallback.
 * Unlike the fast Advisor, it needs tool calls and a medium effort choice. */
export function fastCriticModel(): string | undefined {
  const found = state.models?.data.find((m) => m.id === FAST_CRITIC_MODEL)
  if (!found) return undefined
  if (found.capabilities?.supports?.tool_calls !== true) return undefined
  if ((found.capabilities?.limits?.max_context_window_tokens ?? 0) < ONE_M_TOKENS) return undefined
  const efforts = found.capabilities?.supports?.reasoning_effort
  if (!Array.isArray(efforts) || !efforts.includes(FAST_CRITIC_EFFORT)) return undefined
  if (fastEndpointForModel(found) !== "chat") return undefined
  return FAST_CRITIC_MODEL
}

/** Exact Opus 5 only: the fast Oracle never inherits standard opus_critic's
 *  older-family fallback. */
export function fastOracleModel(): string | undefined {
  const found = state.models?.data.find((m) => m.id === FAST_ORACLE_MODEL)
  if (!found) return undefined
  if ((found.capabilities?.limits?.max_context_window_tokens ?? 0) < ONE_M_TOKENS) return undefined
  if ((found.capabilities?.limits?.max_prompt_tokens ?? 0) <= 0) return undefined
  const efforts = found.capabilities?.supports?.reasoning_effort
  if (!Array.isArray(efforts) || !efforts.includes(FAST_ORACLE_EFFORT)) return undefined
  if (found.capabilities?.supports?.adaptive_thinking !== true) return undefined
  if (fastEndpointForModel(found) !== "messages") return undefined
  return FAST_ORACLE_MODEL
}

// Compatibility aliases for tests and callers on the first fast-profile commit.
// New fast wiring uses the role names above.
export const FAST_IMPLEMENTER_FAST_MODEL = FAST_IMPLEMENTER_MODEL
export const FAST_REVIEWER_FAST_MODEL = FAST_REVIEWER_MODEL
export const FAST_IMPLEMENTER_FAST_EFFORT = FAST_IMPLEMENTER_EFFORT
export const FAST_REVIEWER_FAST_EFFORT = FAST_REVIEWER_EFFORT
export const fastImplementerFastModel = fastImplementerModel
export const fastReviewerFastModel = fastReviewerModel

/**
 * Gate for the worker tools (`explore`, `review`, `implement`).
 *
 * Returns true iff BOTH:
 *   1. Copilot's live catalog (`state.models?.data`) contains any model in the
 *      ordered worker gate chain (`gpt-5.6-luna` → `gpt-5.4-mini`) and that
 *      entry advertises `capabilities.supports.tool_calls === true`. Luna leads
 *      on qualifying tiers; mini preserves the worker surface on individual
 *      trial and education catalogs. The catalog is the entitlement signal.
 *      The worker loop is function-calling, so a model without tool calls is
 *      unusable. Per-mode defaults are NOT gated here — an absent mode default
 *      surfaces a clean resolve error rather than disabling all worker tools.
 *   2. The operator hasn't set `GH_ROUTER_DISABLE_WORKER_TOOLS=1`
 *      (opt-out — workers ship enabled by default per plan).
 *
 * Callers that pass `model: <non-default>` bypass this list-time
 * gate but still hit the per-call `resolveModelAndThinking`
 * validation in the engine, which surfaces a clean `isError`
 * envelope with the catalog's eligible model ids on mismatch.
 *
 * `WORKER_DEFAULT_MODEL_CHAIN` is imported from `src/lib/worker-agent` so the
 * engine owns the single source of truth for both gating and fallback order.
 */
export function workerToolsEnabled(): boolean {
  if (process.env.GH_ROUTER_DISABLE_WORKER_TOOLS === "1") return false
  return firstPresentInCatalog(
    WORKER_DEFAULT_MODEL_CHAIN,
    { requireToolCalls: true },
  ) != null
}

/**
 * Gate for the compound L2 browser tools (`browser_act`, `browser_observe`,
 * `browser_extract`, `browser_find`).
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
 * `browser_close_tab`, `browser_list_tabs`, `browser_wait`,
 * `browser_download`).
 *
 * Returns true iff `state.powerBrowseEnabled` (set by `--power-browse`
 * or `GH_ROUTER_ENABLE_POWER_BROWSE=1`). When off, the default
 * `--browse` surface exposes the base lead tools (`navigate`, `screenshot`,
 * `open_tab`) and, when the compound gate passes, `act`, `observe`,
 * `extract`, and `find`. Power mode adds the raw primitives for users who
 * want direct coord/keystroke control.
 *
 * `handler.ts` filter chain ANDs this with `browserToolsEnabled()`
 * (defense-in-depth: power without the base browser server is meaningless and
 * the setup path already forces basic on when power is on).
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
 *   2. The browse default model (`BROWSE_DEFAULT_MODEL`, `gpt-5.6-luna`)
 *      is in Copilot's live catalog AND `pickEndpoint()` resolves a
 *      reachable endpoint for it. Unlike `workerToolsEnabled()` (which
 *      checks `tool_calls` on the shared gate sentinel), the browse default is
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

