import type { Effort } from "./reasoning-effort"
import { normalizeTrailingOneMSuffix, stripTrailingOneMSuffix } from "./model-suffix"
import { fastEndpointForModel } from "./fast-endpoint"
import {
  FAST_PROFILE_MODELS,
  FAST_PROFILE_NATIVE_AGENT_NAMES,
} from "./fast-profile-contract"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"

/**
 * Which launch surface a `github-router claude` session is running under.
 *
 * `"standard"` is every launch today: the ordinary Opus/Sonnet/Haiku lead,
 * the full native-agent roster, every peer persona, and every scoped MCP
 * group (`peers`/`search`/`workers`/`orchestrate`, plus the independently
 * opted-in `browser`/`fleet`/`first-mate`/`decide` groups under their own
 * predicates). `"fast"` is the deliberately lean `-m fast` profile: a
 * `gpt-5.6-luna` lead, exactly five native agents, the fast-only Oracle,
 * and only the `peers`/`search` plus independently opted-in `browser` MCP groups.
 *
 * Selected from the RAW `-m` argument (see `resolveLaunchProfile`), never
 * from the resolved lead model id — so `-m gpt-5.6-luna` (a direct pin of
 * the same model the fast profile drives) stays a standard-surface launch,
 * and only the literal `fast` alias narrows the surface.
 */
export type LaunchProfileId = "standard" | "fast"

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
 * The `-m fast` roster: exactly five native agents (`Explore`, `implementer`,
 * `reviewer`, `planner`, `critic`), the fast-only `oracle` peer tool, no coordinator,
 * and only `peers`/`search` plus the ordinary opt-in `browser` group.
 * `workers`/`orchestrate`/`decide`/`fleet`/`first-mate` are hard denies even
 * when their independent standard-profile gates pass.
 */
export const FAST_PROFILE: LaunchProfileDescriptor = Object.freeze({
  id: "fast",
  nativeRoster: new Set(FAST_PROFILE_NATIVE_AGENT_NAMES),
  personaAllowlist: new Set(["oracle"]),
  allowedGroups: new Set(["peers", "search", "browser"]),
  hasCoordinator: false,
})

export function profileDescriptor(id: LaunchProfileId): LaunchProfileDescriptor {
  return id === "fast" ? FAST_PROFILE : STANDARD_PROFILE
}

/**
 * Resolve the parsed `-m` argument to a launch profile.
 *
 * Deliberately keyed on the RAW alias string (trimmed, case-insensitive
 * `"fast"`), never on a resolved model id: `resolveLeadSlugArg` maps `fast`
 * to `FAST_LEAD_MODEL` (`./port`) before this is of any use to a caller who
 * only has the resolved id, so callers that already resolved the lead must
 * pass the ORIGINAL `-m` value here, not the resolved one. This is what
 * keeps `-m gpt-5.6-luna` (a direct pin of the same underlying model) a
 * standard-surface launch — only the literal alias narrows the surface.
 */
export function resolveLaunchProfile(modelArg: string | undefined): LaunchProfileId {
  const arg = modelArg?.trim().toLowerCase()
  return arg === "fast" ? "fast" : "standard"
}

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

/** Fast native-agent alias ids preserve role-specific effort provenance until
 *  the authenticated request boundary. They both canonicalize to Luna, but the
 *  Explore is fixed high while the implementer is fixed max. */
export const LUNA_SCOUT_ALIAS_ID = "gh-router-luna-scout-high"
export const LUNA_IMPLEMENTER_ALIAS_ID = "gh-router-luna-implementer-max"

/** Fast-profile critic alias. It preserves Gemini's fixed medium effort until
 * the authenticated request boundary; bare Gemini remains high for the lead
 * and Advisor traffic. */
export const FAST_CRITIC_ALIAS_ID = "gh-router-fast-critic-medium"

export const LUNA_SONNET_ALIAS_ID = "gh-router-luna-sonnet-xhigh"

/**
 * Router-owned alias id for the fast profile's Haiku-tier row
 * (`ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL`).
 */
export const LUNA_HAIKU_ALIAS_ID = "gh-router-luna-haiku-high"

/** The real Copilot catalog id every Luna alias (including the driver
 *  itself) canonicalizes to. */
export const LUNA_REAL_MODEL_ID = FAST_PROFILE_MODELS.luna

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
const MODEL_ALIAS_TABLE: ReadonlyMap<string, ModelAliasDescriptor> = new Map([
  [
    LUNA_DRIVER_ALIAS_ID,
    { aliasId: LUNA_DRIVER_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "max" },
  ],
  [
    LUNA_SCOUT_ALIAS_ID,
    { aliasId: LUNA_SCOUT_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "high" },
  ],
  [
    LUNA_IMPLEMENTER_ALIAS_ID,
    { aliasId: LUNA_IMPLEMENTER_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "max" },
  ],
  [
    FAST_CRITIC_ALIAS_ID,
    { aliasId: FAST_CRITIC_ALIAS_ID, realModel: FAST_PROFILE_MODELS.critic, absentEffortDefault: "medium" },
  ],
  [
    LUNA_SONNET_ALIAS_ID,
    { aliasId: LUNA_SONNET_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "xhigh" },
  ],
  [
    LUNA_HAIKU_ALIAS_ID,
    { aliasId: LUNA_HAIKU_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "high" },
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

function hasPromptAtLeast(model: Model | undefined, tokens: number): boolean {
  const prompt = model?.capabilities?.limits?.max_prompt_tokens
  return typeof prompt === "number" && Number.isFinite(prompt) && prompt >= tokens
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
 *   - Luna lead/Explore/implementer: tool calls, >=1M, high+max, Responses.
 *   - Sol planner: tool calls, >=1M, high, Responses.
 *   - Grok reviewer: tool calls, medium, Responses, usable prompt metadata.
 *   - Gemini Advisor: >=1M, high, chat-completions.
 *   - Gemini critic: tool calls, >=1M, medium, chat-completions.
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

  const sol = findModel(catalog, FAST_PROFILE_MODELS.planner)
  if (!sol) {
    missing.push(`${FAST_PROFILE_MODELS.planner}: absent from the live catalog`)
  } else {
    if (!hasToolCalls(sol)) {
      missing.push(`${FAST_PROFILE_MODELS.planner}: does not advertise tool_calls`)
    }
    if (!hasContextAtLeast(sol, FAST_REQUIRED_CONTEXT_TOKENS)) {
      missing.push(`${FAST_PROFILE_MODELS.planner}: advertised context window is below 1M`)
    }
    if (!supportsEffort(sol, "high")) {
      missing.push(`${FAST_PROFILE_MODELS.planner}: does not advertise a "high" reasoning effort`)
    }
    if (!supportsEndpoint(sol, "responses")) {
      missing.push(`${FAST_PROFILE_MODELS.planner}: does not advertise a supported Responses endpoint`)
    }
  }

  const grok = findModel(catalog, FAST_PROFILE_MODELS.reviewer)
  if (!grok) {
    missing.push(`${FAST_PROFILE_MODELS.reviewer}: absent from the live catalog`)
  } else {
    if (!hasToolCalls(grok)) {
      missing.push(`${FAST_PROFILE_MODELS.reviewer}: does not advertise tool_calls`)
    }
    if (!supportsEffort(grok, "medium")) {
      missing.push(`${FAST_PROFILE_MODELS.reviewer}: does not advertise a "medium" reasoning effort`)
    }
    if (!hasPromptAtLeast(grok, FAST_REVIEWER_MIN_PROMPT_TOKENS)) {
      missing.push(
        `${FAST_PROFILE_MODELS.reviewer}: advertised max_prompt_tokens is below ${FAST_REVIEWER_MIN_PROMPT_TOKENS}`,
      )
    }
    if (!supportsEndpoint(grok, "responses")) {
      missing.push(`${FAST_PROFILE_MODELS.reviewer}: does not advertise a supported Responses endpoint`)
    }
  }

  const gemini = findModel(catalog, FAST_PROFILE_MODELS.critic)
  if (!gemini) {
    missing.push(`${FAST_PROFILE_MODELS.critic}: absent from the live catalog`)
  } else {
    if (!hasToolCalls(gemini)) {
      missing.push(`${FAST_PROFILE_MODELS.critic}: does not advertise tool_calls for the native critic`)
    }
    if (!hasContextAtLeast(gemini, FAST_REQUIRED_CONTEXT_TOKENS)) {
      missing.push(`${FAST_PROFILE_MODELS.critic}: advertised context window is below 1M`)
    }
    if (!supportsEffort(gemini, "high")) {
      missing.push(`${FAST_PROFILE_MODELS.critic}: does not advertise a "high" reasoning effort for Advisor`)
    }
    if (!supportsEffort(gemini, "medium")) {
      missing.push(`${FAST_PROFILE_MODELS.critic}: does not advertise a "medium" reasoning effort for the native critic`)
    }
    // Reuse the canonical catalog endpoint resolver. Copilot's live catalog
    // uses bare `/chat/completions`, while fixtures and older snapshots may use
    // `/v1/chat/completions`; an exact check against only one spelling made a
    // fully-capable live catalog fail the whole launch.
    if (!supportsEndpoint(gemini, "chat")) {
      missing.push(
        `${FAST_PROFILE_MODELS.critic}: does not advertise a supported chat-completions endpoint`,
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
