/**
 * Fixed identities for the literal `github-router claude -m cheapest2` profile.
 *
 * `cheapest2` is `cheapest` with the Sol tier moved from `gpt-5.6-sol` to
 * `gpt-6.1-sol` and the Advisor raised to `high`. Everything else — the
 * `gpt-6-luna`/max lead, the Luna subagents, the bare-slug 200K window, the
 * curated 24K Advisor transcript budget, the Oracle-only peer set, the
 * three-agent surface and the delegation graph — is inherited verbatim.
 *
 * Derived from `CHEAPEST_PROFILE_CONTRACT` by spread rather than copied: a
 * field added to the family later is inherited here automatically, and the
 * declared deltas are the only lines in this file that can drift.
 */

import {
  CHEAPEST_PROFILE_ADVISOR_CONTEXT_TOKENS,
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_DEFAULT,
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MAX,
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MIN,
  CHEAPEST_PROFILE_CONTRACT,
  CHEAPEST_PROFILE_DELEGATION_GRAPH,
  CHEAPEST_PROFILE_LEAD_CONTEXT_TOKENS,
  CHEAPEST_PROFILE_LEAD_EFFORT,
  CHEAPEST_PROFILE_MODELS,
  CHEAPEST_PROFILE_NATIVE_AGENT_NAMES,
  CHEAPEST_PROFILE_NATIVE_EFFORTS,
  CHEAPEST_PROFILE_ORACLE_EFFORT,
  CHEAPEST_PROFILE_SUBAGENT_CONTEXT_TOKENS,
  CHEAPEST_PROFILE_SYNTHESIZED_PEERS,
  type CheapestProfileNativeAgentName,
} from "./cheapest-profile-contract"

/** The 6.1 Sol tier that distinguishes this profile from `cheapest`. */
export const CHEAPEST2_SOL_MODEL = "gpt-6.1-sol" as const

export const CHEAPEST2_PROFILE_MODELS = Object.freeze({
  ...CHEAPEST_PROFILE_MODELS,
  advisor: CHEAPEST2_SOL_MODEL,
  oracle: CHEAPEST2_SOL_MODEL,
} as const)

export const CHEAPEST2_PROFILE_NATIVE_AGENT_NAMES =
  CHEAPEST_PROFILE_NATIVE_AGENT_NAMES

export type Cheapest2ProfileNativeAgentName = CheapestProfileNativeAgentName

export const CHEAPEST2_PROFILE_NATIVE_MODELS: Readonly<
  Record<Cheapest2ProfileNativeAgentName, string>
> = Object.freeze({
  Explore: CHEAPEST2_PROFILE_MODELS.explore,
  "General-Purpose": CHEAPEST2_PROFILE_MODELS["General-Purpose"],
  reviewer: CHEAPEST2_PROFILE_MODELS.reviewer,
})

export const CHEAPEST2_PROFILE_NATIVE_EFFORTS = CHEAPEST_PROFILE_NATIVE_EFFORTS

export const CHEAPEST2_PROFILE_LEAD_CONTEXT_TOKENS =
  CHEAPEST_PROFILE_LEAD_CONTEXT_TOKENS
export const CHEAPEST2_PROFILE_SUBAGENT_CONTEXT_TOKENS =
  CHEAPEST_PROFILE_SUBAGENT_CONTEXT_TOKENS
export const CHEAPEST2_PROFILE_LEAD_EFFORT = CHEAPEST_PROFILE_LEAD_EFFORT

export const CHEAPEST2_PROFILE_ADVISOR_MODEL = CHEAPEST2_PROFILE_MODELS.advisor
export const CHEAPEST2_PROFILE_ADVISOR_CLIENT_MODEL =
  CHEAPEST2_PROFILE_MODELS.advisor
export const CHEAPEST2_PROFILE_ADVISOR_CONTEXT_TOKENS =
  CHEAPEST_PROFILE_ADVISOR_CONTEXT_TOKENS
export const CHEAPEST2_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_DEFAULT =
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_DEFAULT
export const CHEAPEST2_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MIN =
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MIN
export const CHEAPEST2_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MAX =
  CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MAX

/**
 * The one non-model delta from `cheapest`: the Advisor runs at `high`. The
 * Claude path already forces `high` on the wire for any cheapest-profile
 * Advisor (`resolveAdvisorEffort`, `fastProfile = true`); this declaration
 * matches the wire and makes the Pi runtime's Advisor `high` too.
 */
export const CHEAPEST2_PROFILE_ADVISOR_EFFORT = "high" as const

export const CHEAPEST2_PROFILE_ORACLE_MODEL = CHEAPEST2_PROFILE_MODELS.oracle
export const CHEAPEST2_PROFILE_ORACLE_EFFORT = CHEAPEST_PROFILE_ORACLE_EFFORT

export const CHEAPEST2_PROFILE_SYNTHESIZED_PEERS =
  CHEAPEST_PROFILE_SYNTHESIZED_PEERS
export type Cheapest2ProfileSynthesizedPeer =
  (typeof CHEAPEST2_PROFILE_SYNTHESIZED_PEERS)[number]

export const CHEAPEST2_PROFILE_DELEGATION_GRAPH =
  CHEAPEST_PROFILE_DELEGATION_GRAPH

/** The `-m cheapest2` aggregate: the base contract with only the Sol
 *  identities and the Advisor effort replaced. */
export const CHEAPEST2_PROFILE_CONTRACT = Object.freeze({
  ...CHEAPEST_PROFILE_CONTRACT,
  models: CHEAPEST2_PROFILE_MODELS,
  nativeModels: CHEAPEST2_PROFILE_NATIVE_MODELS,
  advisorModel: CHEAPEST2_PROFILE_ADVISOR_MODEL,
  advisorClientModel: CHEAPEST2_PROFILE_ADVISOR_CLIENT_MODEL,
  advisorEffort: CHEAPEST2_PROFILE_ADVISOR_EFFORT,
  oracleModel: CHEAPEST2_PROFILE_ORACLE_MODEL,
})

export type Cheapest2ProfileContract = typeof CHEAPEST2_PROFILE_CONTRACT
