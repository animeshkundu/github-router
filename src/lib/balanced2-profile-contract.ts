/**
 * Fixed identities for the literal `github-router claude -m balanced2` profile.
 *
 * `balanced2` is `balanced` with the Sol tier moved from `gpt-5.6-sol` to
 * `gpt-6.1-sol` for the lead and reviewer, and the Oracle moved from
 * `grok-4.6` to `grok-4.7`. Everything else — the Luna `Explore`/
 * `General-Purpose` roles, the bare-slug 200K window, the medium lead effort,
 * the Advisor-free surface, the Oracle-only peer set and the delegation graph
 * (including `reviewer` → `Explore`) — is inherited verbatim.
 *
 * The `astra` slot is inherited unchanged on purpose: it is declarative only on
 * this family (no balanced launch synthesizes an `astra` tool; only `fast` and
 * `cheap1m` do), so the identity has no consumer to alter.
 *
 * Derived from `BALANCED_PROFILE_CONTRACT` by spread rather than copied: a
 * field added to the family later is inherited here automatically, and the
 * declared deltas are the only lines in this file that can drift.
 */

import {
  BALANCED_PROFILE_CONTRACT,
  BALANCED_PROFILE_DELEGATION_GRAPH,
  BALANCED_PROFILE_LEAD_CONTEXT_TOKENS,
  BALANCED_PROFILE_LEAD_EFFORT,
  BALANCED_PROFILE_MODELS,
  BALANCED_PROFILE_NATIVE_AGENT_NAMES,
  BALANCED_PROFILE_NATIVE_EFFORTS,
  BALANCED_PROFILE_ORACLE_EFFORT,
  BALANCED_PROFILE_SUBAGENT_CONTEXT_TOKENS,
  BALANCED_PROFILE_SYNTHESIZED_PEERS,
  type BalancedProfileNativeAgentName,
} from "./balanced-profile-contract"

/** The 6.1 Sol tier that distinguishes this profile's lead/reviewer. */
export const BALANCED2_SOL_MODEL = "gpt-6.1-sol" as const
/** The xAI Oracle that supersedes `balanced`'s Grok 4.6 row. */
export const BALANCED2_ORACLE_MODEL = "grok-4.7" as const

export const BALANCED2_PROFILE_MODELS = Object.freeze({
  ...BALANCED_PROFILE_MODELS,
  lead: BALANCED2_SOL_MODEL,
  reviewer: BALANCED2_SOL_MODEL,
  oracle: BALANCED2_ORACLE_MODEL,
} as const)

export const BALANCED2_PROFILE_NATIVE_AGENT_NAMES =
  BALANCED_PROFILE_NATIVE_AGENT_NAMES

export type Balanced2ProfileNativeAgentName = BalancedProfileNativeAgentName

export const BALANCED2_PROFILE_NATIVE_MODELS: Readonly<
  Record<Balanced2ProfileNativeAgentName, string>
> = Object.freeze({
  Explore: BALANCED2_PROFILE_MODELS.explore,
  "General-Purpose": BALANCED2_PROFILE_MODELS["General-Purpose"],
  reviewer: BALANCED2_PROFILE_MODELS.reviewer,
})

export const BALANCED2_PROFILE_NATIVE_EFFORTS = BALANCED_PROFILE_NATIVE_EFFORTS

export const BALANCED2_PROFILE_LEAD_CONTEXT_TOKENS =
  BALANCED_PROFILE_LEAD_CONTEXT_TOKENS
export const BALANCED2_PROFILE_SUBAGENT_CONTEXT_TOKENS =
  BALANCED_PROFILE_SUBAGENT_CONTEXT_TOKENS
export const BALANCED2_PROFILE_LEAD_EFFORT = BALANCED_PROFILE_LEAD_EFFORT

export const BALANCED2_PROFILE_ORACLE_MODEL = BALANCED2_PROFILE_MODELS.oracle
export const BALANCED2_PROFILE_ORACLE_EFFORT = BALANCED_PROFILE_ORACLE_EFFORT

export const BALANCED2_PROFILE_SYNTHESIZED_PEERS =
  BALANCED_PROFILE_SYNTHESIZED_PEERS
export type Balanced2ProfileSynthesizedPeer =
  (typeof BALANCED2_PROFILE_SYNTHESIZED_PEERS)[number]

export const BALANCED2_PROFILE_DELEGATION_GRAPH =
  BALANCED_PROFILE_DELEGATION_GRAPH

/** The `-m balanced2` aggregate: the base contract with only the Sol
 *  lead/reviewer identities and the Oracle replaced. */
export const BALANCED2_PROFILE_CONTRACT = Object.freeze({
  ...BALANCED_PROFILE_CONTRACT,
  models: BALANCED2_PROFILE_MODELS,
  nativeModels: BALANCED2_PROFILE_NATIVE_MODELS,
  oracleModel: BALANCED2_PROFILE_ORACLE_MODEL,
})

export type Balanced2ProfileContract = typeof BALANCED2_PROFILE_CONTRACT
