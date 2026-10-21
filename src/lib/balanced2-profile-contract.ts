/**
 * Fixed identities for the literal `github-router claude -m balanced2` profile.
 *
 * Mirror of `balanced-profile-contract.ts` with gpt-5.6-sol → gpt-6.1-sol
 * and grok-4.6 → grok-4.7.
 */

export const BALANCED2_PROFILE_MODELS = Object.freeze({
  lead: "gpt-6.1-sol",
  explore: "gpt-6-luna",
  "General-Purpose": "gpt-6-luna",
  reviewer: "gpt-6.1-sol",
  oracle: "grok-4.7",
  astra: "gpt-6-astra",
} as const)

export const BALANCED2_PROFILE_NATIVE_AGENT_NAMES = [
  "Explore",
  "General-Purpose",
  "reviewer",
] as const

export type Balanced2ProfileNativeAgentName =
  (typeof BALANCED2_PROFILE_NATIVE_AGENT_NAMES)[number]

export const BALANCED2_PROFILE_NATIVE_MODELS: Readonly<
  Record<Balanced2ProfileNativeAgentName, string>
> = Object.freeze({
  Explore: BALANCED2_PROFILE_MODELS.explore,
  "General-Purpose": BALANCED2_PROFILE_MODELS["General-Purpose"],
  reviewer: BALANCED2_PROFILE_MODELS.reviewer,
})

export const BALANCED2_PROFILE_NATIVE_EFFORTS = Object.freeze({
  Explore: "high",
  "General-Purpose": "max",
  reviewer: "high",
} as const)

export const BALANCED2_PROFILE_LEAD_CONTEXT_TOKENS = 200_000 as const
export const BALANCED2_PROFILE_SUBAGENT_CONTEXT_TOKENS = 200_000 as const

export const BALANCED2_PROFILE_LEAD_EFFORT = "medium" as const
export const BALANCED2_PROFILE_ORACLE_MODEL = BALANCED2_PROFILE_MODELS.oracle
export const BALANCED2_PROFILE_ORACLE_EFFORT = "medium" as const

export const BALANCED2_PROFILE_SYNTHESIZED_PEERS = ["oracle"] as const
export type Balanced2ProfileSynthesizedPeer =
  (typeof BALANCED2_PROFILE_SYNTHESIZED_PEERS)[number]

export const BALANCED2_PROFILE_DELEGATION_GRAPH = Object.freeze({
  Explore: Object.freeze([]),
  "General-Purpose": Object.freeze(["reviewer"]),
  reviewer: Object.freeze(["Explore"]),
} as const satisfies Record<
  Balanced2ProfileNativeAgentName,
  ReadonlyArray<Balanced2ProfileNativeAgentName>
>)