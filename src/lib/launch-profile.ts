import type { Effort } from "./reasoning-effort"
import { pickEndpoint } from "~/services/copilot/endpoint"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"

/**
 * Which launch surface a `github-router claude` session is running under.
 *
 * `"standard"` is every launch today: the ordinary Opus/Sonnet/Haiku lead,
 * the full native-agent roster, every peer persona, and every scoped MCP
 * group (`peers`/`search`/`workers`/`orchestrate`, plus the independently
 * opted-in `browser`/`fleet`/`first-mate`/`decide` groups under their own
 * predicates). `"fast"` is the deliberately lean `-m fast` profile: a
 * `gpt-5.6-luna` lead, exactly three native agents, one peer persona, and
 * only the `peers`/`search` MCP groups.
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
 * The `-m fast` roster, per the fast-launch-profile design: exactly three
 * native agents (`scout`, `implementer-fast`, `reviewer-fast`), one peer
 * persona (`gemini_critic`), no coordinator, and only the `peers`/`search`
 * scoped MCP groups — `workers`/`orchestrate` are hard denies for this
 * profile (see `docs/default-models.md` "fast launch profile" once landed).
 * Independently opted-in groups (`browser`/`fleet`/`first-mate`) and the
 * catalog-gated `decide` group are NOT narrowed here — they stay under
 * their own predicates regardless of profile.
 */
export const FAST_PROFILE: LaunchProfileDescriptor = Object.freeze({
  id: "fast",
  nativeRoster: new Set(["scout", "implementer-fast", "reviewer-fast"]),
  personaAllowlist: new Set(["gemini_critic"]),
  allowedGroups: new Set(["peers", "search"]),
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

export const LUNA_SONNET_ALIAS_ID = "gh-router-luna-sonnet-xhigh"

/**
 * Router-owned alias id for the fast profile's Haiku-tier row
 * (`ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL`).
 */
export const LUNA_HAIKU_ALIAS_ID = "gh-router-luna-haiku-high"

/** The real Copilot catalog id every Luna alias (including the driver
 *  itself) canonicalizes to. */
export const LUNA_REAL_MODEL_ID = "gpt-5.6-luna"

export interface ModelAliasDescriptor {
  /** The id as it appears on the wire / in `body.model` before
   *  canonicalization — either the real Luna id (the driver) or one of the
   *  router-owned tier-alias ids above. */
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
 * resolve to the SAME Luna catalog id, so after early canonicalization a
 * table keyed on the real id could no longer tell which absent-effort
 * default applies. Alias provenance — which of the three ids the request
 * actually carried — is the minimum discriminator that survives from tier
 * selection through to request preprocessing, which is why canonicalization
 * must happen LAST (in the `/v1/messages` identity preflight), after the
 * effort default has already been read off the alias.
 */
const MODEL_ALIAS_TABLE: ReadonlyMap<string, ModelAliasDescriptor> = new Map([
  [
    LUNA_DRIVER_ALIAS_ID,
    { aliasId: LUNA_DRIVER_ALIAS_ID, realModel: LUNA_REAL_MODEL_ID, absentEffortDefault: "max" },
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
 * id that isn't one of the three registered aliases (including the bare
 * `claude-*` ids and every other real Copilot catalog id).
 */
export function resolveModelAlias(id: string): ModelAliasDescriptor | undefined {
  const bare = id.replace(/\[1m\]$/i, "")
  return MODEL_ALIAS_TABLE.get(bare)
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
  const bracket = /\[1m\]$/i.test(id) ? "[1m]" : ""
  const bare = bracket ? id.slice(0, -bracket.length) : id
  const alias = MODEL_ALIAS_TABLE.get(bare)
  return alias ? `${alias.realModel}${bracket}` : id
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

/**
 * Validate the live Copilot catalog carries every model the fast profile's
 * EXACT roster depends on, with the specific capabilities each assignment
 * needs. These are capability-availability PREREQUISITES for constructing
 * the roster — not an allowlist of models the user may select later in the
 * session — so a partial catalog fails the whole `-m fast` launch rather
 * than silently substituting or dropping an agent.
 *
 * Checks, per the fast-launch-profile design:
 *   - `gpt-5.6-luna` (the lead/driver): tool_calls + >=1M context.
 *   - `grok-4.6` (reviewer-fast): tool_calls + `medium` in its effort
 *     ladder + a usable `max_prompt_tokens` (so the derived safe-review
 *     window guard has something to size against).
 *   - `gemini-3.7-flash` (gemini_critic + Advisor): tool_calls + >=1M
 *     context + `high` in its effort ladder + a supported chat-completions
 *     endpoint (bare or `/v1`-prefixed) in `supported_endpoints`.
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
  }

  const grok = findModel(catalog, "grok-4.6")
  if (!grok) {
    missing.push("grok-4.6: absent from the live catalog")
  } else {
    if (!hasToolCalls(grok)) missing.push("grok-4.6: does not advertise tool_calls")
    if (!supportsEffort(grok, "medium")) {
      missing.push("grok-4.6: does not advertise a \"medium\" reasoning effort")
    }
    const maxPromptTokens = grok.capabilities?.limits?.max_prompt_tokens
    if (typeof maxPromptTokens !== "number" || !(maxPromptTokens > 0)) {
      missing.push("grok-4.6: no usable max_prompt_tokens metadata")
    }
  }

  const gemini = findModel(catalog, "gemini-3.7-flash")
  if (!gemini) {
    missing.push("gemini-3.7-flash: absent from the live catalog")
  } else {
    if (!hasToolCalls(gemini)) missing.push("gemini-3.7-flash: does not advertise tool_calls")
    if (!hasContextAtLeast(gemini, FAST_REQUIRED_CONTEXT_TOKENS)) {
      missing.push("gemini-3.7-flash: advertised context window is below 1M")
    }
    if (!supportsEffort(gemini, "high")) {
      missing.push("gemini-3.7-flash: does not advertise a \"high\" reasoning effort")
    }
    // Reuse the canonical catalog endpoint resolver. Copilot's live catalog
    // uses bare `/chat/completions`, while fixtures and older snapshots may use
    // `/v1/chat/completions`; an exact check against only one spelling made a
    // fully-capable live catalog fail the whole launch.
    if (pickEndpoint(gemini) !== "chat") {
      missing.push(
        "gemini-3.7-flash: does not advertise a supported chat-completions endpoint",
      )
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
