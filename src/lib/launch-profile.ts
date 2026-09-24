import type { Effort } from "./reasoning-effort"
import { normalizeTrailingOneMSuffix, stripTrailingOneMSuffix } from "./model-suffix"
import { fastEndpointForModel } from "./fast-endpoint"
import {
  CHEAP_PROFILE_MODELS,
  CHEAP_PROFILE_NATIVE_AGENT_NAMES,
  CHEAP_PROFILE_SUBAGENT_CONTEXT_TOKENS,
} from "./cheap-profile-contract"
import {
  CHEAPEST_PROFILE_MODELS,
  CHEAPEST_PROFILE_NATIVE_AGENT_NAMES,
  CHEAPEST_PROFILE_SUBAGENT_CONTEXT_TOKENS,
} from "./cheapest-profile-contract"
import {
  BALANCED_PROFILE_MODELS,
  BALANCED_PROFILE_NATIVE_AGENT_NAMES,
  BALANCED_PROFILE_SUBAGENT_CONTEXT_TOKENS,
} from "./balanced-profile-contract"
import {
  FAST_PROFILE_MODELS,
  FAST_PROFILE_NATIVE_AGENT_NAMES,
} from "./fast-profile-contract"
import {
  MAX_PROFILE_NATIVE_AGENT_NAMES,
  validateMaxProfilePrerequisites,
} from "./max-profile-contract"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"

/**
 * Which launch surface a `github-router claude` session is running under.
 *
 * `"standard"` is every launch today: the ordinary Opus/Sonnet/Haiku lead,
 * the full native-agent roster, every peer persona, and every scoped MCP
*  group (`peers`/`search`/`workers`/`orchestrate`, plus the independently
 *  opted-in `browser`/`fleet`/`first-mate`/`decide` groups under their own
 *  predicates). `"fast"` is the deliberately lean `-m fast` profile: a
 *  Gemini lead, exactly four native agents, the fast-only Oracle,
 *  Artifact/search tools, and optional direct-browser plus browse-worker groups.
 *  `"cheap"` is the cost-lean `-m cheap` variant of `fast`: the same exact
 *  four-agent surface, but the Gemini leader also runs at the 200K default
 *  window (bare slug), every subagent runs at 200K, and the only peer is the
 *  `grok-4.6`/medium Oracle. `"cheap1m"` is the named successor of the
 *  original cheap launch: identical to `cheap` except the Gemini leader keeps
 *  its full 1M window (`[1m]` decoration) and the `astra` peer remains
 *  available next to Oracle. Both cheap variants share the same `CHEAP_*`
 *  contract values; the three gates that differ are the lead slug, the lead
 *  prereq window, and the cheap1m-only `astra` peer. `"cheapest"` is the
 *  all-200K cheapest tier: a Luna/max lead, Luna Explore/GP roles, a Sol/high
 *  reviewer, a Sol/medium Advisor, and a Sol/high Oracle — the lead plans
 *  directly and reviews the final plan with the Advisor (advisory) before
 *  presenting it. Oracle-only peer
 *  set, no `astra` (see `./cheapest-profile-contract`). `"balanced"` is the
 *  most-complex-tasks tier: a Sol/high lead at the 200K default window, a
 *  three-agent surface (no `Plan`: the lead owns planning), and the
 *  Grok/medium Oracle-only peer set (see `./balanced-profile-contract`).
 *
 *  Selected from the RAW `-m` argument (see `resolveLaunchProfile`), never
 *  from the resolved lead model id — so `-m gpt-6-luna` (a direct pin of
 *  the same model the fast profile drives) stays a standard-surface launch,
 *  and only the literal `fast`/`cheap`/`cheap1m`/`cheapest`/`balanced`
 *  aliases narrow the surface.
 */
export type LaunchProfileId =
  | "standard"
  | "fast"
  | "max"
  | "cheap"
  | "cheap1m"
  | "cheapest"
  | "balanced"

/**
 * Everything a launch profile needs to declare about its own surface.
 * `nativeRoster` / `personaAllowlist` / `allowedGroups` are `undefined` (or
 * absent) to mean UNRESTRICTED — the standard profile's shape today — and a
 * concrete `ReadonlySet` to mean a hard allow-list — the fast profile's
 * exact roster. This module only carries the DECLARATION; enforcing it
 * against `tools/list` / `tools/call` / the injected native-agent `.md`
 * files is the MCP route handler's and `codex-mcp-config.ts`'s job.
 */
export interface LaunchProfileDescriptor {
  id: LaunchProfileId
  /** Native Task-subagent names this profile may generate/register.
   *  `undefined` = every agent whose model chain resolves (today's
   *  behavior). A concrete set is a hard allow-list, not a preference. */
  nativeRoster?: ReadonlySet<string>
  /** Peer-persona `toolNameHttp` values this profile may register on the
   *  `peers` MCP group. `undefined` = every persona whose gate passes. */
  personaAllowlist?: ReadonlySet<string>
  /** Scoped MCP server groups this profile may register at all (before any
   *  per-group capability gate). `undefined` = every group whose own opt-in
   *  flag / catalog gate passes, exactly as today. */
  allowedGroups?: ReadonlySet<string>
  /** Whether `peer-review-coordinator` is registered for this profile. */
  hasCoordinator: boolean
}

export const STANDARD_PROFILE: LaunchProfileDescriptor = Object.freeze({
  id: "standard",
  hasCoordinator: true,
})

/**
 * The `-m fast` roster: exactly four native agents (`Explore`, `Plan`,
 * `General-Purpose`, `Reviewer`), the fast-only `oracle` peer
 * tool, no coordinator, and `peers`/`search` plus optional browser and
 * browse-only worker groups. Core workers, `orchestrate`, `decide`, `fleet`,
 * and `first-mate` remain hard denies even when their standard gates pass.
 */
export const FAST_PROFILE: LaunchProfileDescriptor = Object.freeze({
  id: "fast",
  nativeRoster: new Set(FAST_PROFILE_NATIVE_AGENT_NAMES),
  personaAllowlist: new Set(["oracle", "astra"]),
  allowedGroups: new Set(["peers", "search", "workers", "browser"]),
  hasCoordinator: false,
})

/**
 * The `-m cheap1m` roster: the named successor of the original cheap launch.
 * Identical to `cheap` except the Gemini leader keeps its full 1M window
 * (the `-m cheap1m` lead slug is `[1m]`-decorated) and the `astra` peer
 * remains in the persona allowlist next to Oracle. Oracle and Astra run at
 * the 200K default window like every cheap-family role. Hard-denies match
 * fast's: core workers, `orchestrate`, `decide`, `fleet`, and `first-mate`.
 */
export const CHEAP1M_PROFILE: LaunchProfileDescriptor = Object.freeze({
  id: "cheap1m",
  nativeRoster: new Set(CHEAP_PROFILE_NATIVE_AGENT_NAMES),
  personaAllowlist: new Set(["oracle", "astra"]),
  allowedGroups: new Set(["peers", "search", "workers", "browser"]),
  hasCoordinator: false,
})

/**
 * The `-m cheap` roster: the exact `fast` surface and groups, minus the 1M
 * accounting decoration on the LEAD as well (`-m cheap` selects the BARE
 * `gemini-3.8-flash` slug, so the leader runs at the 200K default window
 * too), plus a cheaper `grok-4.6`/medium Oracle and NO `astra` peer.
 * Hard-denies match fast's: core workers, `orchestrate`, `decide`, `fleet`,
 * and `first-mate`.
 */
export const CHEAP_PROFILE: LaunchProfileDescriptor = Object.freeze({
  id: "cheap",
  nativeRoster: new Set(CHEAP_PROFILE_NATIVE_AGENT_NAMES),
  personaAllowlist: new Set(["oracle"]),
  allowedGroups: new Set(["peers", "search", "workers", "browser"]),
  hasCoordinator: false,
})

/**
 * The `-m cheapest` roster: the exact cheap surface and groups, but Luna-led
 * (`gpt-6-luna`/max at the 200K default window), a Sol/medium Advisor, a
 * Sol/high Oracle, and a Sol/high reviewer — and no `Plan` subagent: the lead
 * plans directly and reviews the final plan with the Advisor (advisory)
 * before presenting it. Oracle-only peer set, no
 * `astra`. Hard-denies match fast's: core workers, `orchestrate`, `decide`,
 * `fleet`, and `first-mate`.
 */
export const CHEAPEST_PROFILE: LaunchProfileDescriptor = Object.freeze({
  id: "cheapest",
  nativeRoster: new Set(CHEAPEST_PROFILE_NATIVE_AGENT_NAMES),
  personaAllowlist: new Set(["oracle"]),
  allowedGroups: new Set(["peers", "search", "workers", "browser"]),
  hasCoordinator: false,
})

/**
 * The `-m balanced` roster: the most-complex-tasks tier. A Sol/high lead at
 * the 200K default window, a three-agent surface (`Explore`/
 * `General-Purpose`/`reviewer`, every role at 200K — no `Plan`: the lead
 * owns planning), and the Grok-4.6/medium Oracle-only peer set. Hard-denies
 * match fast's: core workers, `orchestrate`, `decide`, `fleet`, and
 * `first-mate`.
 */
export const BALANCED_PROFILE: LaunchProfileDescriptor = Object.freeze({
  id: "balanced",
  nativeRoster: new Set(BALANCED_PROFILE_NATIVE_AGENT_NAMES),
  personaAllowlist: new Set(["oracle"]),
  allowedGroups: new Set(["peers", "search", "workers", "browser"]),
  hasCoordinator: false,
})

/**
 * The `-m max` profile: Sol/Luna-led, browse-only workers, and explicit
 * cross-lab peer names. The descriptor is a hard projection for bound launch
 * requests; unbound/BYO traffic remains standard because it has no registry
 * entry carrying this allow-list.
 */
export const MAX_PROFILE: LaunchProfileDescriptor = Object.freeze({
  id: "max",
  nativeRoster: new Set(MAX_PROFILE_NATIVE_AGENT_NAMES),
  personaAllowlist: new Set([
    "sol_critic",
    "codex_reviewer",
    "sonnet_reviewer",
    "opus_critic",
    "gemini_critic",
    "gemini_reviewer",
    "grok_critic",
    "grok_reviewer",
  ]),
  allowedGroups: new Set(["peers", "search", "workers", "browser", "decide", "fleet", "first-mate"]),
  hasCoordinator: true,
})

export function profileDescriptor(id: LaunchProfileId): LaunchProfileDescriptor {
  if (id === "fast") return FAST_PROFILE
  if (id === "max") return MAX_PROFILE
  if (id === "cheap1m") return CHEAP1M_PROFILE
  if (id === "cheap") return CHEAP_PROFILE
  if (id === "cheapest") return CHEAPEST_PROFILE
  if (id === "balanced") return BALANCED_PROFILE
  return STANDARD_PROFILE
}

/**
 * Resolve the parsed `-m` argument to a launch profile.
 *
 * Deliberately keyed on the RAW alias string (trimmed, case-insensitive
 * `"fast"`), never on a resolved model id: `resolveLeadSlugArg` maps `fast`
 * to `FAST_LEAD_MODEL` (`./port`) before this is of any use to a caller who
 * only has the resolved id, so callers that already resolved the lead must
 * pass the ORIGINAL `-m` value here, not the resolved one. This is what
 * keeps `-m gpt-6-luna` (a direct pin of the same underlying model) a
 * standard-surface launch — only the literal alias narrows the surface.
 */
export function resolveLaunchProfile(modelArg: string | undefined): LaunchProfileId {
  const arg = modelArg?.trim().toLowerCase()
  if (arg === "fast") return "fast"
  if (arg === "max") return "max"
  if (arg === "cheap1m") return "cheap1m"
  if (arg === "cheap") return "cheap"
  if (arg === "cheapest") return "cheapest"
  if (arg === "balanced") return "balanced"
  return "standard"
}

export function validateMaxProfileLaunch(
  catalog: ModelsResponse | undefined,
): ReturnType<typeof validateMaxProfilePrerequisites> {
  return validateMaxProfilePrerequisites(catalog)
}

export { formatMaxPrerequisiteFailure, MAX_REQUIRED_CONTEXT_TOKENS, MAX_PROFILE_MODELS, MAX_PROFILE_ALLOWED_LEAD_MODEL_IDS } from "./max-profile-contract"

// ---------------------------------------------------------------------------
// Luna driver/Sonnet/Haiku alias registry
// ---------------------------------------------------------------------------

/**
 * Router-owned alias id for the fast profile's Sonnet-tier row
 * (`ANTHROPIC_DEFAULT_SONNET_MODEL`). Never sent upstream — canonicalized to
 * `LUNA_REAL_MODEL_ID` by `canonicalizeAliasModel` before the request
 * reaches Copilot.
 */
export const LUNA_DRIVER_ALIAS_ID = "gh-router-luna-driver-max"

/** Fast Explore alias preserves its high-effort provenance until the
 * authenticated request boundary. Bare Luna remains the max-effort lead and
 * `general-purpose` model. */
export const LUNA_SCOUT_ALIAS_ID = "gh-router-luna-scout-high"

/** Retired Fast aliases remain recognizable only so old running clients fail
 * with an explicit stale-alias error instead of silently changing semantics. */
export const LUNA_IMPLEMENTER_ALIAS_ID = "gh-router-luna-implementer-max"
export const FAST_CRITIC_ALIAS_ID = "gh-router-fast-critic-medium"

/**
 * Cheap-family subagent aliases (`-m cheap`/`-m cheap1m`). Router-owned,
 * non-catalog identities: Claude Code resolves a bare REAL model id against
 * the live catalog and upgrades Task subagents to `[1m]` accounting when the
 * entry advertises >=1M, defeating the cheap family's whole 200K cost lever.
 * An alias matches no catalog entry, so the client holds the 200K default and
 * the proxy canonicalizes to the real id upstream with the alias's fixed
 * effort. `absentEffortDefault` mirrors `CHEAP_PROFILE_NATIVE_EFFORTS` per
 * role (a drift test pins this). Emitted BARE (no `[1m]`) by
 * `buildCheapProfileAgentDefinitions`.
 */
export const CHEAP_EXPLORE_ALIAS_ID = "gh-router-cheap-explore-high"
export const CHEAP_PLAN_ALIAS_ID = "gh-router-cheap-plan-high"
export const CHEAP_GENERAL_PURPOSE_ALIAS_ID = "gh-router-cheap-general-purpose-max"
export const CHEAP_IMPLEMENTER_ALIAS_ID = "gh-router-cheap-implementer-high"
export const CHEAP_REVIEWER_ALIAS_ID = "gh-router-cheap-reviewer-max"

/**
 * Cheapest-profile subagent aliases (`-m cheapest`). Same non-catalog
 * mechanism as the cheap aliases above, with the cheapest roster's own
 * identities and efforts (`CHEAPEST_PROFILE_NATIVE_MODELS` /
 * `CHEAPEST_PROFILE_NATIVE_EFFORTS`, pinned by a drift test). Emitted BARE by
 * `buildCheapestProfileAgentDefinitions`.
 */
export const CHEAPEST_EXPLORE_ALIAS_ID = "gh-router-cheapest-explore-high"
export const CHEAPEST_GENERAL_PURPOSE_ALIAS_ID =
  "gh-router-cheapest-general-purpose-xhigh"
export const CHEAPEST_IMPLEMENTER_ALIAS_ID = "gh-router-cheapest-implementer-max"
export const CHEAPEST_REVIEWER_ALIAS_ID = "gh-router-cheapest-reviewer-high"

/**
 * Balanced-profile subagent aliases (`-m balanced`). Same non-catalog
 * mechanism as the cheap aliases above, with the balanced roster's own
 * identities and efforts (`BALANCED_PROFILE_NATIVE_MODELS` /
 * `BALANCED_PROFILE_NATIVE_EFFORTS`, pinned by a drift test). Emitted BARE by
 * `buildBalancedProfileAgentDefinitions`.
 */
export const BALANCED_EXPLORE_ALIAS_ID = "gh-router-balanced-explore-high"
export const BALANCED_GENERAL_PURPOSE_ALIAS_ID =
  "gh-router-balanced-general-purpose-max"
export const BALANCED_REVIEWER_ALIAS_ID = "gh-router-balanced-reviewer-high"

export const LUNA_SONNET_ALIAS_ID = "gh-router-luna-sonnet-xhigh"

/**
 * Shared browse-dispatcher alias (every pinned profile except max): the
 * `worker-browse` native is an identical thin dispatcher on fast, cheap,
 * cheap1m, cheapest, and balanced, so one router-owned, non-catalog identity
 * serves all five (precedent: the shared `SKILL_*` aliases). Carries the
 * fixed `low` effort until the authenticated request boundary. Emitted BARE
 * (no `[1m]`) by every pinned `build*ProfileAgentDefinitions` worker-browse
 * block, so the dispatcher's own turns run at the 200K default window.
 */
export const BROWSE_LOW_ALIAS_ID = "gh-router-browse-low"

/**
 * Router-owned alias id for the fast profile's Haiku-tier row
 * (`ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL`).
 */
export const LUNA_HAIKU_ALIAS_ID = "gh-router-luna-haiku-high"

/** Max-profile aliases are intentionally separate from the fast aliases. They
 * preserve the fixed max role effort until the authenticated max request
 * boundary and are never valid on standard or fast launches. */
export const MAX_LUNA_HIGH_ALIAS_ID = "gh-router-max-luna-high"
export const MAX_LUNA_MAX_ALIAS_ID = "gh-router-max-luna-max"
/** Max-profile browse-dispatcher alias: same `low`-effort, bare-200K browse
 *  as the shared alias above, but max-isolated (the max preprocessor never
 *  consults the shared alias table, so a shared id would be rejected there). */
export const MAX_BROWSE_LOW_ALIAS_ID = "gh-router-max-browse-low"

/**
 * Pipeline skill aliases (`/gh-gather-context`, `/gh-plan`, `/gh-implement`).
 * Router-owned, non-catalog identities shared by every pinned profile: all
 * skill models run at the 200K DEFAULT window with bare slugs, so the alias
 * only carries the fixed effort until the authenticated request boundary.
 * Emitted BARE (no `[1m]`) wherever skill worker briefs name a model.
 */
export const SKILL_GATHER_CONTEXT_LEAD_ALIAS_ID = "gh-router-skill-gather-context-lead-high"
export const SKILL_GATHER_CONTEXT_EXPLORE_ALIAS_ID = "gh-router-skill-gather-context-explore-high"
export const SKILL_PLAN_LEAD_ALIAS_ID = "gh-router-skill-plan-lead-medium"
export const SKILL_IMPLEMENT_LEAD_ALIAS_ID = "gh-router-skill-implement-lead-max"
export const SKILL_IMPLEMENT_TASK_ALIAS_ID = "gh-router-skill-implement-task-max"
export const SKILL_REVIEW_PASS1_ALIAS_ID = "gh-router-skill-review-pass1-max"
export const SKILL_REVIEW_PASS2_ALIAS_ID = "gh-router-skill-review-pass2-medium"

/** The real Copilot catalog id every Luna alias (including the driver
 *  itself) canonicalizes to. */
export const LUNA_REAL_MODEL_ID = FAST_PROFILE_MODELS.luna

/** The real Copilot catalog id every Sol skill alias canonicalizes to. */
export const SKILL_SOL_REAL_MODEL_ID = FAST_PROFILE_MODELS.plan

const MAX_ALIAS_IDS = new Set([
  MAX_LUNA_HIGH_ALIAS_ID,
  MAX_LUNA_MAX_ALIAS_ID,
  MAX_BROWSE_LOW_ALIAS_ID,
])

export function isMaxModelAlias(id: string): boolean {
  return MAX_ALIAS_IDS.has(stripTrailingOneMSuffix(id).base)
}

export function maxAliasEffort(id: string): Effort | undefined {
  const base = stripTrailingOneMSuffix(id).base
  if (base === MAX_LUNA_HIGH_ALIAS_ID) return "high"
  if (base === MAX_LUNA_MAX_ALIAS_ID) return "max"
  if (base === MAX_BROWSE_LOW_ALIAS_ID) return "low"
  return undefined
}

export function maxAliasModel(id: string): string | undefined {
  return isMaxModelAlias(id) ? LUNA_REAL_MODEL_ID : undefined
}

export function maxAliasWithOneMSuffix(id: string): string {
  const { base } = stripTrailingOneMSuffix(id)
  return `${base}[1m]`
}

export interface ModelAliasDescriptor {
  /** The id as it appears on the wire / in `body.model` before
   *  canonicalization — either a real Luna id, the fast critic alias, or one
   *  of the router-owned tier-alias ids above. */
  aliasId: string
  /** The real catalog id to send upstream. */
  realModel: string
  /** Effort applied ONLY when the request carries neither an explicit
   *  `output_config.effort` nor a `thinking.budget_tokens`. */
  absentEffortDefault: Effort
}

/**
 * The full alias table, keyed by `aliasId`. A simpler model-id-only table is
 * rejected by design: the driver, the Sonnet tier, and the Haiku tier all
 * resolve to the SAME Luna catalog id, while the fast critic alias resolves
 * to Gemini. After early canonicalization a table keyed on the real id could
 * no longer tell which absent-effort default applies. Alias provenance is the
 * minimum discriminator that survives from tier selection through to request
 * preprocessing, which is why canonicalization must happen LAST (in the
 * `/v1/messages` identity preflight), after the effort default has already
 * been read off the alias.
 */
const RETIRED_FAST_ALIAS_IDS = new Set([
  LUNA_IMPLEMENTER_ALIAS_ID,
  FAST_CRITIC_ALIAS_ID,
  // Pre-swap balanced aliases: General-Purpose was Gemini/high and reviewer
  // was Luna/max. Renamed alongside the model swap so stale pinned clients
  // fail loudly as retired instead of resolving with changed semantics.
  "gh-router-balanced-general-purpose-high",
  "gh-router-balanced-reviewer-max",
])

const MODEL_ALIAS_TABLE: ReadonlyMap<string, ModelAliasDescriptor> = new Map([
  [
    LUNA_DRIVER_ALIAS_ID,
    { aliasId: LUNA_DRIVER_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "max" },
  ],
  [
    MAX_LUNA_HIGH_ALIAS_ID,
    { aliasId: MAX_LUNA_HIGH_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "high" },
  ],
  [
    MAX_LUNA_MAX_ALIAS_ID,
    { aliasId: MAX_LUNA_MAX_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "max" },
  ],
  [
    LUNA_SCOUT_ALIAS_ID,
    { aliasId: LUNA_SCOUT_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "high" },
  ],
  [
    LUNA_SONNET_ALIAS_ID,
    { aliasId: LUNA_SONNET_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "xhigh" },
  ],
  [
    LUNA_HAIKU_ALIAS_ID,
    { aliasId: LUNA_HAIKU_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "high" },
  ],
  [
    BROWSE_LOW_ALIAS_ID,
    { aliasId: BROWSE_LOW_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "low" },
  ],
  [
    CHEAP_EXPLORE_ALIAS_ID,
    { aliasId: CHEAP_EXPLORE_ALIAS_ID, realModel: CHEAP_PROFILE_MODELS.explore, absentEffortDefault: "high" },
  ],
  [
    CHEAP_PLAN_ALIAS_ID,
    { aliasId: CHEAP_PLAN_ALIAS_ID, realModel: CHEAP_PROFILE_MODELS.plan, absentEffortDefault: "high" },
  ],
  [
    CHEAP_GENERAL_PURPOSE_ALIAS_ID,
    { aliasId: CHEAP_GENERAL_PURPOSE_ALIAS_ID, realModel: CHEAP_PROFILE_MODELS["General-Purpose"], absentEffortDefault: "max" },
  ],
  [
    CHEAP_IMPLEMENTER_ALIAS_ID,
    { aliasId: CHEAP_IMPLEMENTER_ALIAS_ID, realModel: CHEAP_PROFILE_MODELS["General-Purpose"], absentEffortDefault: "max" },
  ],
  [
    CHEAP_REVIEWER_ALIAS_ID,
    { aliasId: CHEAP_REVIEWER_ALIAS_ID, realModel: CHEAP_PROFILE_MODELS.reviewer, absentEffortDefault: "max" },
  ],
  [
    CHEAPEST_EXPLORE_ALIAS_ID,
    { aliasId: CHEAPEST_EXPLORE_ALIAS_ID, realModel: CHEAPEST_PROFILE_MODELS.explore, absentEffortDefault: "high" },
  ],
  [
    CHEAPEST_GENERAL_PURPOSE_ALIAS_ID,
    { aliasId: CHEAPEST_GENERAL_PURPOSE_ALIAS_ID, realModel: CHEAPEST_PROFILE_MODELS["General-Purpose"], absentEffortDefault: "max" },
  ],
  [
    CHEAPEST_IMPLEMENTER_ALIAS_ID,
    { aliasId: CHEAPEST_IMPLEMENTER_ALIAS_ID, realModel: CHEAPEST_PROFILE_MODELS["General-Purpose"], absentEffortDefault: "max" },
  ],
  [
    CHEAPEST_REVIEWER_ALIAS_ID,
    { aliasId: CHEAPEST_REVIEWER_ALIAS_ID, realModel: CHEAPEST_PROFILE_MODELS.reviewer, absentEffortDefault: "high" },
  ],
  [
    BALANCED_EXPLORE_ALIAS_ID,
    { aliasId: BALANCED_EXPLORE_ALIAS_ID, realModel: BALANCED_PROFILE_MODELS.explore, absentEffortDefault: "high" },
  ],
  [
    BALANCED_GENERAL_PURPOSE_ALIAS_ID,
    { aliasId: BALANCED_GENERAL_PURPOSE_ALIAS_ID, realModel: BALANCED_PROFILE_MODELS["General-Purpose"], absentEffortDefault: "max" },
  ],
  [
    BALANCED_REVIEWER_ALIAS_ID,
    { aliasId: BALANCED_REVIEWER_ALIAS_ID, realModel: BALANCED_PROFILE_MODELS.reviewer, absentEffortDefault: "high" },
  ],
  [
    SKILL_GATHER_CONTEXT_LEAD_ALIAS_ID,
    { aliasId: SKILL_GATHER_CONTEXT_LEAD_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "high" },
  ],
  [
    SKILL_GATHER_CONTEXT_EXPLORE_ALIAS_ID,
    { aliasId: SKILL_GATHER_CONTEXT_EXPLORE_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "high" },
  ],
  [
    SKILL_PLAN_LEAD_ALIAS_ID,
    { aliasId: SKILL_PLAN_LEAD_ALIAS_ID, realModel: SKILL_SOL_REAL_MODEL_ID, absentEffortDefault: "medium" },
  ],
  [
    SKILL_IMPLEMENT_LEAD_ALIAS_ID,
    { aliasId: SKILL_IMPLEMENT_LEAD_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "max" },
  ],
  [
    SKILL_IMPLEMENT_TASK_ALIAS_ID,
    { aliasId: SKILL_IMPLEMENT_TASK_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "max" },
  ],
  [
    SKILL_REVIEW_PASS1_ALIAS_ID,
    { aliasId: SKILL_REVIEW_PASS1_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "max" },
  ],
  [
    SKILL_REVIEW_PASS2_ALIAS_ID,
    { aliasId: SKILL_REVIEW_PASS2_ALIAS_ID, realModel: SKILL_SOL_REAL_MODEL_ID, absentEffortDefault: "medium" },
  ],
])

/**
 * Look up the alias descriptor for a wire-facing model id (with or without
 * a trailing `[1m]` bracket — the bracket is stripped before the table
 * lookup and is orthogonal to alias identity). Returns undefined for any
 * id that isn't one of the registered aliases (including bare `claude-*`
 * ids and every other real Copilot catalog id).
 */
export function resolveModelAlias(id: string): ModelAliasDescriptor | undefined {
  const { base } = stripTrailingOneMSuffix(id)
  return MODEL_ALIAS_TABLE.get(base)
}

export function isRetiredFastModelAlias(id: string): boolean {
  return RETIRED_FAST_ALIAS_IDS.has(stripTrailingOneMSuffix(id).base)
}

/**
 * Strip alias provenance and return the real catalog id to send upstream.
 * Idempotent passthrough for any id that isn't a registered alias (a bare
 * `claude-*` slug, an already-real Copilot id, or anything else) — this is
 * safe to call unconditionally on every `body.model` at the outbound
 * boundary. Preserves a trailing `[1m]` bracket: canonicalization only
 * erases ALIAS identity, not the 1M-context accounting decoration.
 */
export function canonicalizeAliasModel(id: string): string {
  const { base, hadSuffix } = stripTrailingOneMSuffix(id)
  const alias = MODEL_ALIAS_TABLE.get(base)
  if (!alias) return normalizeTrailingOneMSuffix(id)
  return hadSuffix ? `${alias.realModel}[1m]` : alias.realModel
}

/**
 * Effort precedence for an aliased request: explicit `output_config.effort`
 * wins outright; failing that, an explicit `thinking.budget_tokens` bucket
 * wins; failing that, the alias's own `absentEffortDefault` applies. A
 * non-alias id (or one this table doesn't recognize) yields undefined,
 * leaving today's plain thinking-translation path untouched.
 *
 * This function does NOT itself bucket a thinking budget — callers pass the
 * already-bucketed `Effort` (via `bucketEffort` from `./reasoning-effort`)
 * so this stays a pure precedence merge with no tokenizer dependency.
 */
export function resolveEffortWithAliasDefault(params: {
  explicitEffort?: Effort
  thinkingBucketedEffort?: Effort
  aliasId?: string
}): Effort | undefined {
  if (params.explicitEffort) return params.explicitEffort
  if (params.thinkingBucketedEffort) return params.thinkingBucketedEffort
  if (!params.aliasId) return undefined
  return resolveModelAlias(params.aliasId)?.absentEffortDefault
}

// ---------------------------------------------------------------------------
// Fast-profile startup prerequisites
// ---------------------------------------------------------------------------

export interface FastPrerequisiteCheck {
  ok: boolean
  /** Human-readable description of each missing/invalid requirement, empty
   *  when `ok`. Every entry names the model and the specific capability
   *  that was absent so a launch failure is immediately actionable. */
  missing: ReadonlyArray<string>
}

const FAST_REQUIRED_CONTEXT_TOKENS = 1_000_000

function findModel(catalog: ModelsResponse | undefined, id: string): Model | undefined {
  return catalog?.data?.find((m) => m.id === id)
}

function hasToolCalls(model: Model | undefined): boolean {
  return model?.capabilities?.supports?.tool_calls === true
}

function hasContextAtLeast(model: Model | undefined, tokens: number): boolean {
  return (model?.capabilities?.limits?.max_context_window_tokens ?? 0) >= tokens
}

function supportsEffort(model: Model | undefined, effort: Effort): boolean {
  const list = model?.capabilities?.supports?.reasoning_effort
  // Absent metadata fails closed (consistent with `firstPresentInCatalog`'s
  // `requireToolCalls` convention) — an unadvertised effort ladder must not
  // be assumed compatible just because the field is missing.
  return Array.isArray(list) && list.includes(effort)
}

export const FAST_REVIEWER_MIN_PROMPT_TOKENS = 200_000

function supportsEndpoint(model: Model | undefined, endpoint: "chat" | "responses" | "messages"): boolean {
  return model !== undefined && fastEndpointForModel(model) === endpoint
}

function hasUsablePromptMetadata(model: Model | undefined): boolean {
  const prompt = model?.capabilities?.limits?.max_prompt_tokens
  return typeof prompt === "number" && Number.isFinite(prompt) && prompt > 0
}

/**
 * Validate the live Copilot catalog carries every model the fast profile's
 * EXACT roster depends on, with the specific capabilities each assignment
 * needs. These are capability-availability PREREQUISITES for constructing
 * the roster — not an allowlist of models the user may select later in the
 * session — so a partial catalog fails the whole `-m fast` launch rather
 * than silently substituting or dropping an agent.
 *
 * Checks, per the fast-launch-profile design:
 *   - Luna Explore: tool calls, >=1M, high+max, Responses.
 *   - Sol Plan: tool calls, >=1M, high, Responses.
 *   - Sonnet reviewer: tool calls, >=1M, xhigh, Messages, prompt metadata.
 *   - Gemini lead/General-Purpose: tool calls, >=1M, high, chat-completions.
 *   - Opus Oracle: exact Opus 5, >=1M, adaptive/high, Messages, prompt metadata.
 *
 * Pure over the passed-in catalog snapshot so it's unit-testable without
 * `state` — callers pass `state.models` at call time.
 */
export function validateFastProfilePrerequisites(
  catalog: ModelsResponse | undefined,
): FastPrerequisiteCheck {
  const missing: Array<string> = []

  const luna = findModel(catalog, LUNA_REAL_MODEL_ID)
  if (!luna) {
    missing.push(`${LUNA_REAL_MODEL_ID}: absent from the live catalog`)
  } else {
    if (!hasToolCalls(luna)) missing.push(`${LUNA_REAL_MODEL_ID}: does not advertise tool_calls`)
    if (!hasContextAtLeast(luna, FAST_REQUIRED_CONTEXT_TOKENS)) {
      missing.push(`${LUNA_REAL_MODEL_ID}: advertised context window is below 1M`)
    }
    if (!supportsEffort(luna, "high") || !supportsEffort(luna, "max")) {
      missing.push(`${LUNA_REAL_MODEL_ID}: does not advertise both "high" and "max" reasoning effort`)
    }
    if (!supportsEndpoint(luna, "responses")) {
      missing.push(`${LUNA_REAL_MODEL_ID}: does not advertise a supported Responses endpoint`)
    }
  }

  const sol = findModel(catalog, FAST_PROFILE_MODELS.plan)
  if (!sol) {
    missing.push(`${FAST_PROFILE_MODELS.plan}: absent from the live catalog`)
  } else {
    if (!hasToolCalls(sol)) {
      missing.push(`${FAST_PROFILE_MODELS.plan}: does not advertise tool_calls`)
    }
    if (!hasContextAtLeast(sol, FAST_REQUIRED_CONTEXT_TOKENS)) {
      missing.push(`${FAST_PROFILE_MODELS.plan}: advertised context window is below 1M`)
    }
    if (!supportsEffort(sol, "high")) {
      missing.push(`${FAST_PROFILE_MODELS.plan}: does not advertise a "high" reasoning effort`)
    }
    if (!supportsEndpoint(sol, "responses")) {
      missing.push(`${FAST_PROFILE_MODELS.plan}: does not advertise a supported Responses endpoint`)
    }
  }

  const sonnet = findModel(catalog, FAST_PROFILE_MODELS.reviewer)
  if (!sonnet) {
    missing.push(`${FAST_PROFILE_MODELS.reviewer}: absent from the live catalog`)
  } else {
    if (!hasToolCalls(sonnet)) {
      missing.push(`${FAST_PROFILE_MODELS.reviewer}: does not advertise tool_calls`)
    }
    if (!hasContextAtLeast(sonnet, FAST_REQUIRED_CONTEXT_TOKENS)) {
      missing.push(`${FAST_PROFILE_MODELS.reviewer}: advertised context window is below 1M`)
    }
    if (!supportsEffort(sonnet, "xhigh")) {
      missing.push(`${FAST_PROFILE_MODELS.reviewer}: does not advertise an "xhigh" reasoning effort`)
    }
    if (sonnet.capabilities?.supports?.adaptive_thinking !== true) {
      missing.push(`${FAST_PROFILE_MODELS.reviewer}: does not advertise adaptive_thinking`)
    }
    if (!hasUsablePromptMetadata(sonnet)) {
      missing.push(`${FAST_PROFILE_MODELS.reviewer}: no usable max_prompt_tokens metadata`)
    }
    if (!supportsEndpoint(sonnet, "messages")) {
      missing.push(`${FAST_PROFILE_MODELS.reviewer}: does not advertise a supported Messages endpoint`)
    }
  }

  const gemini = findModel(catalog, FAST_PROFILE_MODELS.gemini)
  if (!gemini) {
    missing.push(`${FAST_PROFILE_MODELS.gemini}: absent from the live catalog`)
  } else {
    if (!hasToolCalls(gemini)) {
      missing.push(`${FAST_PROFILE_MODELS.gemini}: does not advertise tool_calls`)
    }
    if (!hasContextAtLeast(gemini, FAST_REQUIRED_CONTEXT_TOKENS)) {
      missing.push(`${FAST_PROFILE_MODELS.gemini}: advertised context window is below 1M`)
    }
    if (!supportsEffort(gemini, "high")) {
      missing.push(`${FAST_PROFILE_MODELS.gemini}: does not advertise a "high" reasoning effort`)
    }
    // Reuse the canonical catalog endpoint resolver. Copilot's live catalog
    // uses bare `/chat/completions`, while fixtures and older snapshots may use
    // `/v1/chat/completions`; an exact check against only one spelling made a
    // fully-capable live catalog fail the whole launch.
    if (!supportsEndpoint(gemini, "chat")) {
      missing.push(
        `${FAST_PROFILE_MODELS.gemini}: does not advertise a supported chat-completions endpoint`,
      )
    }
  }

  const opus = findModel(catalog, FAST_PROFILE_MODELS.oracle)
  if (!opus) {
    missing.push(`${FAST_PROFILE_MODELS.oracle}: absent from the live catalog`)
  } else {
    if (!hasContextAtLeast(opus, FAST_REQUIRED_CONTEXT_TOKENS)) {
      missing.push(`${FAST_PROFILE_MODELS.oracle}: advertised context window is below 1M`)
    }
    if (!supportsEffort(opus, "high")) {
      missing.push(`${FAST_PROFILE_MODELS.oracle}: does not advertise a "high" reasoning effort`)
    }
    if (opus.capabilities?.supports?.adaptive_thinking !== true) {
      missing.push(`${FAST_PROFILE_MODELS.oracle}: does not advertise adaptive_thinking`)
    }
    if (!hasUsablePromptMetadata(opus)) {
      missing.push(`${FAST_PROFILE_MODELS.oracle}: no usable max_prompt_tokens metadata`)
    }
    if (!supportsEndpoint(opus, "messages")) {
      missing.push(`${FAST_PROFILE_MODELS.oracle}: does not advertise a supported Messages endpoint`)
    }
  }

  return { ok: missing.length === 0, missing }
}

/**
 * Format `validateFastProfilePrerequisites`'s failure list into the launch
 * error message: every missing/invalid model, plus the rollback command.
 */
export function formatFastPrerequisiteFailure(missing: ReadonlyArray<string>): string {
  return (
    `github-router claude -m fast requires the following live-catalog capabilities, `
    + `which this account's catalog does not fully provide:\n`
    + missing.map((m) => `  - ${m}`).join("\n")
    + `\n\nFalling back or silently dropping an agent is not supported for the fast `
    + `profile's exact roster. Run plain \`github-router claude\` instead.`
  )
}

// ---------------------------------------------------------------------------
// Cheap-family startup prerequisites
// ---------------------------------------------------------------------------

export interface CheapPrerequisiteCheck {
  ok: boolean
  /** Human-readable description of each missing/invalid requirement, empty
   *  when `ok`. Every entry names the model and the specific capability
   *  that was absent so a launch failure is immediately actionable. */
  missing: ReadonlyArray<string>
}

/** The subagent window floor: every cheap subagent must at least EXCEED the
 *  Claude Code default budget it runs at. Unlike fast, the catalog's real
 *  window is irrelevant to what the client sends (bare slug = 200K either
 *  way); this floor only guarantees the billed model isn't tiny. */
const CHEAP_SUBAGENT_MIN_CONTEXT_TOKENS = CHEAP_PROFILE_SUBAGENT_CONTEXT_TOKENS

/**
 * Shared cheap-family roster prerequisite check, parameterized only by the
 * LEAD's context gate. Both `-m cheap` (200K lead floor) and `-m cheap1m`
 * (1M lead window) validate the EXACT same four-agent roster: the lead gate
 * is the only requirement that differs between the two cheap siblings, and
 * every subagent runs at the 200K default window either way. A non-1M
 * luna/sol/sonnet/grok is acceptable as long as the roster models advertise
 * tool calls, the fixed effort, and a supported endpoint.
 */
function collectCheapPrerequisiteMissing(
  catalog: ModelsResponse | undefined,
  leadGateTokens: number,
  leadGateMessage: (modelId: string) => string,
): Array<string> {
  const missing: Array<string> = []

  const gemini = findModel(catalog, CHEAP_PROFILE_MODELS.lead)
  if (!gemini) {
    missing.push(`${CHEAP_PROFILE_MODELS.lead}: absent from the live catalog`)
  } else {
    if (!hasToolCalls(gemini)) {
      missing.push(`${CHEAP_PROFILE_MODELS.lead}: does not advertise tool_calls`)
    }
    if (!hasContextAtLeast(gemini, leadGateTokens)) {
      missing.push(leadGateMessage(CHEAP_PROFILE_MODELS.lead))
    }
    if (!supportsEffort(gemini, "high")) {
      missing.push(`${CHEAP_PROFILE_MODELS.lead}: does not advertise a "high" reasoning effort`)
    }
    if (!supportsEndpoint(gemini, "chat")) {
      missing.push(
        `${CHEAP_PROFILE_MODELS.lead}: does not advertise a supported chat-completions endpoint`,
      )
    }
  }

  const luna = findModel(catalog, CHEAP_PROFILE_MODELS.explore)
  if (!luna) {
    missing.push(`${CHEAP_PROFILE_MODELS.explore}: absent from the live catalog`)
  } else {
    if (!hasToolCalls(luna)) {
      missing.push(`${CHEAP_PROFILE_MODELS.explore}: does not advertise tool_calls`)
    }
    if (!hasContextAtLeast(luna, CHEAP_SUBAGENT_MIN_CONTEXT_TOKENS)) {
      missing.push(
        `${CHEAP_PROFILE_MODELS.explore}: advertised context window is below the 200K subagent floor`,
      )
    }
    if (!supportsEffort(luna, "high") || !supportsEffort(luna, "max")) {
      missing.push(`${CHEAP_PROFILE_MODELS.explore}: does not advertise both "high" and "max" reasoning effort`)
    }
    if (!supportsEndpoint(luna, "responses")) {
      missing.push(`${CHEAP_PROFILE_MODELS.explore}: does not advertise a supported Responses endpoint`)
    }
  }

  const sol = findModel(catalog, CHEAP_PROFILE_MODELS.plan)
  if (!sol) {
    missing.push(`${CHEAP_PROFILE_MODELS.plan}: absent from the live catalog`)
  } else {
    if (!hasToolCalls(sol)) {
      missing.push(`${CHEAP_PROFILE_MODELS.plan}: does not advertise tool_calls`)
    }
    if (!hasContextAtLeast(sol, CHEAP_SUBAGENT_MIN_CONTEXT_TOKENS)) {
      missing.push(
        `${CHEAP_PROFILE_MODELS.plan}: advertised context window is below the 200K subagent floor`,
      )
    }
    if (!supportsEffort(sol, "high")) {
      missing.push(`${CHEAP_PROFILE_MODELS.plan}: does not advertise a "high" reasoning effort`)
    }
    if (!supportsEndpoint(sol, "responses")) {
      missing.push(`${CHEAP_PROFILE_MODELS.plan}: does not advertise a supported Responses endpoint`)
    }
  }

  const reviewer = findModel(catalog, CHEAP_PROFILE_MODELS.reviewer)
  if (!reviewer) {
    missing.push(`${CHEAP_PROFILE_MODELS.reviewer}: absent from the live catalog`)
  } else {
    if (!hasToolCalls(reviewer)) {
      missing.push(`${CHEAP_PROFILE_MODELS.reviewer}: does not advertise tool_calls`)
    }
    if (!hasContextAtLeast(reviewer, CHEAP_SUBAGENT_MIN_CONTEXT_TOKENS)) {
      missing.push(
        `${CHEAP_PROFILE_MODELS.reviewer}: advertised context window is below the 200K subagent floor`,
      )
    }
    if (!supportsEffort(reviewer, "max")) {
      missing.push(`${CHEAP_PROFILE_MODELS.reviewer}: does not advertise a "max" reasoning effort`)
    }
    if (!supportsEndpoint(reviewer, "responses")) {
      missing.push(`${CHEAP_PROFILE_MODELS.reviewer}: does not advertise a supported Responses endpoint`)
    }
  }

  const grok = findModel(catalog, CHEAP_PROFILE_MODELS.oracle)
  if (!grok) {
    missing.push(`${CHEAP_PROFILE_MODELS.oracle}: absent from the live catalog`)
  } else {
    if (!hasContextAtLeast(grok, CHEAP_SUBAGENT_MIN_CONTEXT_TOKENS)) {
      missing.push(
        `${CHEAP_PROFILE_MODELS.oracle}: advertised context window is below the 200K subagent floor`,
      )
    }
    if (!supportsEffort(grok, "medium")) {
      missing.push(`${CHEAP_PROFILE_MODELS.oracle}: does not advertise a "medium" reasoning effort`)
    }
    if (!hasUsablePromptMetadata(grok)) {
      missing.push(`${CHEAP_PROFILE_MODELS.oracle}: no usable max_prompt_tokens metadata`)
    }
    if (!supportsEndpoint(grok, "responses")) {
      missing.push(`${CHEAP_PROFILE_MODELS.oracle}: does not advertise a supported Responses endpoint`)
    }
  }

  return missing
}

/**
 * Validate the live Copilot catalog for `-m cheap1m` (the named successor of
 * the original cheap launch): the Gemini leader must still advertise 1M, so
 * the lead keeps its full window while every subagent runs at the 200K
 * default. Roster and capability checks are otherwise identical to `cheap`.
 */
export function validateCheap1mProfilePrerequisites(
  catalog: ModelsResponse | undefined,
): CheapPrerequisiteCheck {
  const missing = collectCheapPrerequisiteMissing(
    catalog,
    FAST_REQUIRED_CONTEXT_TOKENS,
    (id) => `${id}: advertised context window is below 1M (leader window)`,
  )
  return { ok: missing.length === 0, missing }
}

/**
 * Validate the live Copilot catalog for `-m cheap`: the Gemini leader runs
 * at the 200K DEFAULT window (bare slug), so the lead only needs to clear
 * the same 200K floor as every subagent — unlike `cheap1m`, which keeps the
 * 1M leader window. Roster and capability checks are otherwise identical.
 */
export function validateCheapProfilePrerequisites(
  catalog: ModelsResponse | undefined,
): CheapPrerequisiteCheck {
  const missing = collectCheapPrerequisiteMissing(
    catalog,
    CHEAP_SUBAGENT_MIN_CONTEXT_TOKENS,
    (id) => `${id}: advertised context window is below the 200K lead floor`,
  )
  return { ok: missing.length === 0, missing }
}

/**
 * Format `validateCheap1mProfilePrerequisites`'s failure list into the launch
 * error message: every missing/invalid model, plus the rollback command.
 */
export function formatCheap1mPrerequisiteFailure(missing: ReadonlyArray<string>): string {
  return (
    `github-router claude -m cheap1m requires the following live-catalog capabilities, `
    + `which this account's catalog does not fully provide:\n`
    + missing.map((m) => `  - ${m}`).join("\n")
    + `\n\nFalling back or silently dropping an agent is not supported for the cheap1m `
    + `profile's exact roster. Run plain \`github-router claude\` instead.`
  )
}

/**
 * Format `validateCheapProfilePrerequisites`'s failure list into the launch
 * error message: every missing/invalid model, plus the rollback command.
 */
export function formatCheapPrerequisiteFailure(missing: ReadonlyArray<string>): string {
  return (
    `github-router claude -m cheap requires the following live-catalog capabilities, `
    + `which this account's catalog does not fully provide:\n`
    + missing.map((m) => `  - ${m}`).join("\n")
    + `\n\nFalling back or silently dropping an agent is not supported for the cheap `
    + `profile's exact roster. Run plain \`github-router claude\` instead.`
  )
}

// ---------------------------------------------------------------------------
// Cheapest-profile startup prerequisites (`-m cheapest`, all-200K tier)
// ---------------------------------------------------------------------------

export interface CheapestPrerequisiteCheck {
  ok: boolean
  /** Human-readable description of each missing/invalid requirement, empty
   *  when `ok`. */
  missing: ReadonlyArray<string>
}

/** The subagent window floor: every cheapest role runs at the 200K default. */
const CHEAPEST_SUBAGENT_MIN_CONTEXT_TOKENS =
  CHEAPEST_PROFILE_SUBAGENT_CONTEXT_TOKENS

/**
 * Validate the live Copilot catalog for `-m cheapest`: Luna lead at the 200K
 * default window, Luna Explore/GP roles, a Sol/high reviewer, a Sol/high
 * Oracle, and a Sol/medium Advisor — all at the 200K default with
 * their fixed efforts and supported endpoints. There is no `Plan` role: the
 * lead plans directly.
 *
 * `opts.peers === false` (the Pi `--no-peers` path) validates the LEAD only:
 * no peer or native-role model is used in that launch, so requiring them
 * would fail a session that cannot consume them. Defaults to full-roster
 * validation (every existing caller, including `claude`, is unaffected).
 */
export function validateCheapestProfilePrerequisites(
  catalog: ModelsResponse | undefined,
  opts: { peers?: boolean } = {},
): CheapestPrerequisiteCheck {
  const peers = opts.peers !== false
  const missing: Array<string> = []

  const luna = findModel(catalog, CHEAPEST_PROFILE_MODELS.lead)
  if (!luna) {
    missing.push(`${CHEAPEST_PROFILE_MODELS.lead}: absent from the live catalog`)
  } else {
    if (!hasToolCalls(luna)) {
      missing.push(`${CHEAPEST_PROFILE_MODELS.lead}: does not advertise tool_calls`)
    }
    if (!hasContextAtLeast(luna, CHEAPEST_SUBAGENT_MIN_CONTEXT_TOKENS)) {
      missing.push(
        `${CHEAPEST_PROFILE_MODELS.lead}: advertised context window is below the 200K subagent floor`,
      )
    }
    if (
      !supportsEffort(luna, "high")
      || !supportsEffort(luna, "max")
      || !supportsEffort(luna, "xhigh")
    ) {
      missing.push(
        `${CHEAPEST_PROFILE_MODELS.lead}: does not advertise "high", "max", and "xhigh" reasoning effort`,
      )
    }
    if (!supportsEndpoint(luna, "responses")) {
      missing.push(`${CHEAPEST_PROFILE_MODELS.lead}: does not advertise a supported Responses endpoint`)
    }
  }

  // Sol Oracle (same id as the reviewer role): the lead's only consultant
  // besides the Advisor. The reviewer block below covers Sol tool-calling;
  // this block covers the Oracle brief's prompt-metadata requirement.
  // Skipped under `peers: false` — a peerless launch consumes neither.
  if (peers) {
    const oracle = findModel(catalog, CHEAPEST_PROFILE_MODELS.oracle)
    if (!oracle) {
      missing.push(`${CHEAPEST_PROFILE_MODELS.oracle}: absent from the live catalog`)
    } else {
      if (!hasContextAtLeast(oracle, CHEAPEST_SUBAGENT_MIN_CONTEXT_TOKENS)) {
        missing.push(
          `${CHEAPEST_PROFILE_MODELS.oracle}: advertised context window is below the 200K subagent floor`,
        )
      }
      if (!supportsEffort(oracle, "high")) {
        missing.push(`${CHEAPEST_PROFILE_MODELS.oracle}: does not advertise a "high" reasoning effort`)
      }
      if (!supportsEndpoint(oracle, "responses")) {
        missing.push(`${CHEAPEST_PROFILE_MODELS.oracle}: does not advertise a supported Responses endpoint`)
      }
      if (!hasUsablePromptMetadata(oracle)) {
        missing.push(`${CHEAPEST_PROFILE_MODELS.oracle}: no usable max_prompt_tokens metadata (Oracle brief)`)
      }
    }

    const reviewer = findModel(catalog, CHEAPEST_PROFILE_MODELS.reviewer)
    if (!reviewer) {
      missing.push(`${CHEAPEST_PROFILE_MODELS.reviewer}: absent from the live catalog`)
    } else {
      if (!hasToolCalls(reviewer)) {
        missing.push(`${CHEAPEST_PROFILE_MODELS.reviewer}: does not advertise tool_calls`)
      }
      if (!hasContextAtLeast(reviewer, CHEAPEST_SUBAGENT_MIN_CONTEXT_TOKENS)) {
        missing.push(
          `${CHEAPEST_PROFILE_MODELS.reviewer}: advertised context window is below the 200K subagent floor`,
        )
      }
      if (!supportsEffort(reviewer, "high")) {
        missing.push(`${CHEAPEST_PROFILE_MODELS.reviewer}: does not advertise a "high" reasoning effort`)
      }
      if (!supportsEndpoint(reviewer, "responses")) {
        missing.push(
          `${CHEAPEST_PROFILE_MODELS.reviewer}: does not advertise a supported Responses endpoint`,
        )
      }
    }
  }

  return { ok: missing.length === 0, missing }
}

/**
 * Format `validateCheapestProfilePrerequisites`'s failure list into the
 * launch error message.
 */
export function formatCheapestPrerequisiteFailure(
  missing: ReadonlyArray<string>,
): string {
  return (
    `github-router claude -m cheapest requires the following live-catalog capabilities, `
    + `which this account's catalog does not fully provide:\n`
    + missing.map((m) => `  - ${m}`).join("\n")
    + `\n\nFalling back or silently dropping an agent is not supported for the cheapest `
    + `profile's exact roster. Run plain \`github-router claude\` instead.`
  )
}

// ---------------------------------------------------------------------------
// Balanced-profile startup prerequisites (`-m balanced`, Sol-led 200K tier)
// ---------------------------------------------------------------------------

export interface BalancedPrerequisiteCheck {
  ok: boolean
  /** Human-readable description of each missing/invalid requirement, empty
   *  when `ok`. */
  missing: ReadonlyArray<string>
}

/** The subagent window floor: every balanced role runs at the 200K default. */
const BALANCED_SUBAGENT_MIN_CONTEXT_TOKENS =
  BALANCED_PROFILE_SUBAGENT_CONTEXT_TOKENS

/**
 * Validate the live Copilot catalog for `-m balanced`: Sol lead at the 200K
 * default window, Luna Explore/General-Purpose roles, a Sol/high reviewer,
 * and a Grok Oracle — all at the 200K default with their
 * fixed efforts and supported endpoints. There is no `Plan` role: the lead
 * owns planning directly.
 *
 * `opts.peers === false` (the Pi `--no-peers` path) validates the LEAD only;
 * see `validateCheapestProfilePrerequisites` for why. Defaults to full-roster
 * validation (every existing caller is unaffected).
 */
export function validateBalancedProfilePrerequisites(
  catalog: ModelsResponse | undefined,
  opts: { peers?: boolean } = {},
): BalancedPrerequisiteCheck {
  const peers = opts.peers !== false
  const missing: Array<string> = []

  const sol = findModel(catalog, BALANCED_PROFILE_MODELS.lead)
  if (!sol) {
    missing.push(`${BALANCED_PROFILE_MODELS.lead}: absent from the live catalog`)
  } else {
    if (!hasToolCalls(sol)) {
      missing.push(`${BALANCED_PROFILE_MODELS.lead}: does not advertise tool_calls`)
    }
    if (!hasContextAtLeast(sol, BALANCED_SUBAGENT_MIN_CONTEXT_TOKENS)) {
      missing.push(
        `${BALANCED_PROFILE_MODELS.lead}: advertised context window is below the 200K subagent floor`,
      )
    }
    if (!supportsEffort(sol, "high")) {
      missing.push(`${BALANCED_PROFILE_MODELS.lead}: does not advertise a "high" reasoning effort`)
    }
    if (!supportsEndpoint(sol, "responses")) {
      missing.push(`${BALANCED_PROFILE_MODELS.lead}: does not advertise a supported Responses endpoint`)
    }
  }

  // Native roles + Oracle are skipped under `peers: false` — a peerless
  // launch consumes only the lead validated above.
  if (peers) {
    const luna = findModel(catalog, BALANCED_PROFILE_MODELS.explore)
    if (!luna) {
      missing.push(`${BALANCED_PROFILE_MODELS.explore}: absent from the live catalog`)
    } else {
      if (!hasToolCalls(luna)) {
        missing.push(`${BALANCED_PROFILE_MODELS.explore}: does not advertise tool_calls`)
      }
      if (!hasContextAtLeast(luna, BALANCED_SUBAGENT_MIN_CONTEXT_TOKENS)) {
        missing.push(
          `${BALANCED_PROFILE_MODELS.explore}: advertised context window is below the 200K subagent floor`,
        )
      }
      if (!supportsEffort(luna, "high") || !supportsEffort(luna, "max")) {
        missing.push(`${BALANCED_PROFILE_MODELS.explore}: does not advertise both "high" and "max" reasoning effort`)
      }
      if (!supportsEndpoint(luna, "responses")) {
        missing.push(`${BALANCED_PROFILE_MODELS.explore}: does not advertise a supported Responses endpoint`)
      }
    }

    const generalPurpose = findModel(catalog, BALANCED_PROFILE_MODELS["General-Purpose"])
    if (!generalPurpose) {
      missing.push(`${BALANCED_PROFILE_MODELS["General-Purpose"]}: absent from the live catalog`)
    } else {
      if (!hasToolCalls(generalPurpose)) {
        missing.push(`${BALANCED_PROFILE_MODELS["General-Purpose"]}: does not advertise tool_calls`)
      }
      if (!hasContextAtLeast(generalPurpose, BALANCED_SUBAGENT_MIN_CONTEXT_TOKENS)) {
        missing.push(
          `${BALANCED_PROFILE_MODELS["General-Purpose"]}: advertised context window is below the 200K subagent floor`,
        )
      }
      if (!supportsEffort(generalPurpose, "max")) {
        missing.push(`${BALANCED_PROFILE_MODELS["General-Purpose"]}: does not advertise a "max" reasoning effort`)
      }
      if (!supportsEndpoint(generalPurpose, "responses")) {
        missing.push(
          `${BALANCED_PROFILE_MODELS["General-Purpose"]}: does not advertise a supported Responses endpoint`,
        )
      }
    }

    const balancedReviewer = findModel(catalog, BALANCED_PROFILE_MODELS.reviewer)
    if (!balancedReviewer) {
      missing.push(`${BALANCED_PROFILE_MODELS.reviewer}: absent from the live catalog`)
    } else {
      if (!hasToolCalls(balancedReviewer)) {
        missing.push(`${BALANCED_PROFILE_MODELS.reviewer}: does not advertise tool_calls`)
      }
      if (!hasContextAtLeast(balancedReviewer, BALANCED_SUBAGENT_MIN_CONTEXT_TOKENS)) {
        missing.push(
          `${BALANCED_PROFILE_MODELS.reviewer}: advertised context window is below the 200K subagent floor`,
        )
      }
      if (!supportsEffort(balancedReviewer, "high")) {
        missing.push(`${BALANCED_PROFILE_MODELS.reviewer}: does not advertise a "high" reasoning effort`)
      }
      if (!supportsEndpoint(balancedReviewer, "responses")) {
        missing.push(
          `${BALANCED_PROFILE_MODELS.reviewer}: does not advertise a supported Responses endpoint`,
        )
      }
    }

    const grok = findModel(catalog, BALANCED_PROFILE_MODELS.oracle)
    if (!grok) {
      missing.push(`${BALANCED_PROFILE_MODELS.oracle}: absent from the live catalog`)
    } else {
      if (!hasContextAtLeast(grok, BALANCED_SUBAGENT_MIN_CONTEXT_TOKENS)) {
        missing.push(
          `${BALANCED_PROFILE_MODELS.oracle}: advertised context window is below the 200K subagent floor`,
        )
      }
      if (!supportsEffort(grok, "medium")) {
        missing.push(`${BALANCED_PROFILE_MODELS.oracle}: does not advertise a "medium" reasoning effort`)
      }
      if (!hasUsablePromptMetadata(grok)) {
        missing.push(`${BALANCED_PROFILE_MODELS.oracle}: no usable max_prompt_tokens metadata`)
      }
      if (!supportsEndpoint(grok, "responses")) {
        missing.push(`${BALANCED_PROFILE_MODELS.oracle}: does not advertise a supported Responses endpoint`)
      }
    }
  }

  return { ok: missing.length === 0, missing }
}

/**
 * Format `validateBalancedProfilePrerequisites`'s failure list into the
 * launch error message.
 */
export function formatBalancedPrerequisiteFailure(
  missing: ReadonlyArray<string>,
): string {
  return (
    `github-router claude -m balanced requires the following live-catalog capabilities, `
    + `which this account's catalog does not fully provide:\n`
    + missing.map((m) => `  - ${m}`).join("\n")
    + `\n\nFalling back or silently dropping an agent is not supported for the balanced `
    + `profile's exact roster. Run plain \`github-router claude\` instead.`
  )
}
