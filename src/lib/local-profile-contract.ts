/**
 * Fixed identities for the literal `github-router claude -m local` and
 * `-m local2` launch profiles.
 *
 * Both profiles route the MAIN agent loop at a locally running model server
 * instead of Copilot, so their model ids are the three Anthropic tier names the
 * server itself resolves (`opus` / `sonnet` / `haiku`) rather than catalog
 * slugs. Nothing here assumes which stack is serving them, what else its model
 * list contains, or that any capability beyond "Claude Code works with it" is
 * present.
 *
 * Everything that is NOT a model identity is inherited from
 * `CHEAPEST_PROFILE_CONTRACT` by reference rather than copied: the roster
 * (`Explore` / `General-Purpose` / `reviewer`, no `Plan`), the delegation graph,
 * the per-role efforts, the synthesized peer set and the 200K windows are the
 * cheapest profile's, so "the prompts are the same as cheapest" holds by
 * construction and cannot drift one file away from the prose that describes it.
 *
 * Declared deltas only:
 *   - `models` / `nativeModels` — the local tier ids.
 *   - `oracleModel` — the LEAD tier (`opus`), and `consultTransport: "local"`.
 *     The Oracle is a consult the lead makes, and on this profile it is a consult
 *     of the SAME endpoint the lead already talks to: `local` may bill no Copilot
 *     model at all, so pinning its consultant to a Copilot slug (which is what
 *     `local2` still does) would make the role unavailable by construction. The
 *     transport field is what every consumer branches on, so the one local
 *     profile whose consult is billed keeps `"copilot"` while this one does not.
 *   - NO `leadEffort`. The launcher seeds `CLAUDE_CODE_EFFORT_LEVEL` for the
 *     cheapest family, and we know nothing about the local server's effort
 *     ladder, so the client's own picker decides. The type-level absence is
 *     what stops a future edit from seeding one by accident.
 *   - NO advisor fields on `local`: that profile is Advisor-free by design,
 *     exactly like `balanced`. `local2` adds them back.
 */

import {
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_DEFAULT,
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MAX,
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MIN,
  CHEAPEST_PROFILE_DELEGATION_GRAPH,
  CHEAPEST_PROFILE_NATIVE_AGENT_NAMES,
  CHEAPEST_PROFILE_NATIVE_EFFORTS,
  CHEAPEST_PROFILE_ORACLE_EFFORT,
  CHEAPEST_PROFILE_SUBAGENT_CONTEXT_TOKENS,
  CHEAPEST_PROFILE_SYNTHESIZED_PEERS,
  type CheapestProfileNativeAgentName,
} from "./cheapest-profile-contract"
import { CHEAPEST2_SOL_MODEL } from "./cheapest2-profile-contract"

/**
 * The three ids the local endpoint resolves. Claude Code's `/model` picker and
 * its tier env vars speak these names, and the server maps each onto whatever
 * it actually has loaded, so the proxy never learns (or guesses) a real model
 * slug.
 */
export const LOCAL_PROFILE_TIER_MODELS = Object.freeze({
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
} as const)

export const LOCAL_PROFILE_MODELS = Object.freeze({
  lead: LOCAL_PROFILE_TIER_MODELS.opus,
  explore: LOCAL_PROFILE_TIER_MODELS.haiku,
  "General-Purpose": LOCAL_PROFILE_TIER_MODELS.sonnet,
  reviewer: LOCAL_PROFILE_TIER_MODELS.opus,
  /**
   * The lead tier: a local consult of the endpoint the lead already uses.
   *
   * This is the one place where the "an oracle is a Copilot consult" default is
   * deliberately not taken. `local` may bill no Copilot model at all, so a
   * Copilot-served Oracle would not be an expensive consultant — it would be an
   * unreachable role, and the launch would advertise a tool whose every call is
   * refused by the egress policy. `local2` keeps the inherited Copilot slug
   * (see `LOCAL2_PROFILE_CONTRACT`), which is what makes the two profiles
   * differ by transport rather than by tier name.
   */
  oracle: LOCAL_PROFILE_TIER_MODELS.opus,
} as const)

export const LOCAL_PROFILE_NATIVE_AGENT_NAMES = CHEAPEST_PROFILE_NATIVE_AGENT_NAMES

export type LocalProfileNativeAgentName = CheapestProfileNativeAgentName

export const LOCAL_PROFILE_NATIVE_MODELS: Readonly<
  Record<LocalProfileNativeAgentName, string>
> = Object.freeze({
  Explore: LOCAL_PROFILE_MODELS.explore,
  "General-Purpose": LOCAL_PROFILE_MODELS["General-Purpose"],
  reviewer: LOCAL_PROFILE_MODELS.reviewer,
})

/**
 * Per-role efforts are the cheapest profile's verbatim. They ride on the
 * subagent `.md` frontmatter, which is a prompt-level preference the local
 * server may ignore; the LEAD effort is deliberately NOT seeded (see above).
 */
export const LOCAL_PROFILE_NATIVE_EFFORTS = CHEAPEST_PROFILE_NATIVE_EFFORTS

/** 200K: enforced client-side by `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`. */
export const LOCAL_PROFILE_LEAD_CONTEXT_TOKENS = 200_000 as const
export const LOCAL_PROFILE_SUBAGENT_CONTEXT_TOKENS =
  CHEAPEST_PROFILE_SUBAGENT_CONTEXT_TOKENS

export const LOCAL_PROFILE_ORACLE_MODEL = LOCAL_PROFILE_MODELS.oracle
export const LOCAL_PROFILE_ORACLE_EFFORT = CHEAPEST_PROFILE_ORACLE_EFFORT

export const LOCAL_PROFILE_SYNTHESIZED_PEERS = CHEAPEST_PROFILE_SYNTHESIZED_PEERS
export type LocalProfileSynthesizedPeer =
  (typeof LOCAL_PROFILE_SYNTHESIZED_PEERS)[number]

export const LOCAL_PROFILE_DELEGATION_GRAPH = CHEAPEST_PROFILE_DELEGATION_GRAPH

/**
 * Every fixed identity for `-m local` in one frozen aggregate.
 *
 * `local2` derives from this by spread, adding only its Advisor block.
 */
export const LOCAL_PROFILE_CONTRACT = Object.freeze({
  models: LOCAL_PROFILE_MODELS,
  tierModels: LOCAL_PROFILE_TIER_MODELS,
  nativeAgentNames: LOCAL_PROFILE_NATIVE_AGENT_NAMES,
  nativeModels: LOCAL_PROFILE_NATIVE_MODELS,
  nativeEfforts: LOCAL_PROFILE_NATIVE_EFFORTS,
  leadContextTokens: LOCAL_PROFILE_LEAD_CONTEXT_TOKENS,
  subagentContextTokens: LOCAL_PROFILE_SUBAGENT_CONTEXT_TOKENS,
  oracleModel: LOCAL_PROFILE_ORACLE_MODEL,
  oracleEffort: LOCAL_PROFILE_ORACLE_EFFORT,
  synthesizedPeers: LOCAL_PROFILE_SYNTHESIZED_PEERS,
  delegationGraph: LOCAL_PROFILE_DELEGATION_GRAPH,
  /**
   * The consultant here is served by the local endpoint, not Copilot.
   *
   * This field, not the profile id, is what the Oracle descriptor, the catalog
   * gate, the dispatch branch and the Pi agent-file emitter branch on, so a
   * future member can move its consult without touching those sites. `local2`
   * overrides it back to `"copilot"` together with the Sol slug, because its
   * Advisor is billed and must stay inside the `{sol, luna}` ceiling.
   */
  consultTransport: "local" as const,
})

export type LocalProfileContract = typeof LOCAL_PROFILE_CONTRACT

/**
 * The `-m local2` Advisor: `gpt-6.1-sol` on Copilot, `high`, at the cheapest
 * family's default window and curated ("small digest") transcript budget.
 *
 * The lead turn stays local and free; only the Advisor consult is billed.
 */
export const LOCAL2_PROFILE_ADVISOR_MODEL = CHEAPEST2_SOL_MODEL
export const LOCAL2_PROFILE_ADVISOR_CLIENT_MODEL = CHEAPEST2_SOL_MODEL
export const LOCAL2_PROFILE_ADVISOR_CONTEXT_TOKENS =
  LOCAL_PROFILE_SUBAGENT_CONTEXT_TOKENS
export const LOCAL2_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_DEFAULT =
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_DEFAULT
export const LOCAL2_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MIN =
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MIN
export const LOCAL2_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MAX =
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MAX

/** Matches `cheapest2`: the curated protégé consult runs its advisor at `high`. */
export const LOCAL2_PROFILE_ADVISOR_EFFORT = "high" as const

/**
 * The `-m local2` aggregate: the local contract plus the curated Advisor.
 *
 * The advisor fields are present HERE and absent from `LOCAL_PROFILE_CONTRACT`
 * on purpose, so every advisor call site has to name the profile it is serving
 * instead of inheriting one by accident.
 */
export const LOCAL2_PROFILE_CONTRACT = Object.freeze({
  ...LOCAL_PROFILE_CONTRACT,
  /**
   * `local2`'s consultants stay BILLED, so this profile has to undo both of the
   * base contract's local-consult declarations. The Oracle keeps the inherited
   * Copilot slug and the transport says so; the Advisor block below is Copilot
   * for the same reason. Without these two overrides the spread would silently
   * move the Advisor onto the local endpoint and the `{sol, luna}` egress
   * ceiling would never be exercised.
   */
  models: { ...LOCAL_PROFILE_MODELS, oracle: CHEAPEST2_SOL_MODEL } as const,
  oracleModel: CHEAPEST2_SOL_MODEL,
  consultTransport: "copilot" as const,
  advisorModel: LOCAL2_PROFILE_ADVISOR_MODEL,
  advisorClientModel: LOCAL2_PROFILE_ADVISOR_CLIENT_MODEL,
  advisorContextTokens: LOCAL2_PROFILE_ADVISOR_CONTEXT_TOKENS,
  advisorTranscriptTokensDefault:
    LOCAL2_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_DEFAULT,
  advisorTranscriptTokensMin: LOCAL2_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MIN,
  advisorTranscriptTokensMax: LOCAL2_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MAX,
  advisorEffort: LOCAL2_PROFILE_ADVISOR_EFFORT,
})

export type Local2ProfileContract = typeof LOCAL2_PROFILE_CONTRACT

/** The local lead slug, used by the child-env/tier-row wiring. */
export const LOCAL_PROFILE_LEAD_MODEL = LOCAL_PROFILE_MODELS.lead
