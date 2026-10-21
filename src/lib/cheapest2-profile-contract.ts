/**
 * Fixed identities for the literal `github-router claude -m cheapest2` profile.
 *
 * The cheapest2 all-200K tier: a `gpt-6-luna`/max LEAD at Claude Code's
 * DEFAULT (bare-slug) 200K window, every subagent at the same 200K default,
 * a `gpt-6.1-sol`/high Advisor (bare slug), and a `gpt-6.1-sol`/high
 * primary Oracle. Oracle-only peer set (no `astra`) and a three-agent
 * surface (`Explore`/`General-Purpose`/`reviewer` — no `Plan`): the lead
 * plans directly and reviews the final plan with the Advisor (advisory)
 * before presenting it.
 *
 * Mirror of `cheapest-profile-contract.ts` with gpt-5.6-sol → gpt-6.1-sol
 * and advisor effort medium → high.
 */

export const CHEAPEST2_PROFILE_MODELS = Object.freeze({
  lead: "gpt-6-luna",
  explore: "gpt-6-luna",
  "General-Purpose": "gpt-6-luna",
  reviewer: "gpt-6-luna",
  advisor: "gpt-6.1-sol",
  oracle: "gpt-6.1-sol",
} as const)

export const CHEAPEST2_PROFILE_NATIVE_AGENT_NAMES = [
  "Explore",
  "General-Purpose",
  "reviewer",
] as const

export type Cheapest2ProfileNativeAgentName =
  (typeof CHEAPEST2_PROFILE_NATIVE_AGENT_NAMES)[number]

export const CHEAPEST2_PROFILE_NATIVE_MODELS: Readonly<
  Record<Cheapest2ProfileNativeAgentName, string>
> = Object.freeze({
  Explore: CHEAPEST2_PROFILE_MODELS.explore,
  "General-Purpose": CHEAPEST2_PROFILE_MODELS["General-Purpose"],
  reviewer: CHEAPEST2_PROFILE_MODELS.reviewer,
})

export const CHEAPEST2_PROFILE_NATIVE_EFFORTS = Object.freeze({
  Explore: "high",
  "General-Purpose": "max",
  reviewer: "max",
} as const)

export const CHEAPEST2_PROFILE_LEAD_CONTEXT_TOKENS = 200_000 as const
export const CHEAPEST2_PROFILE_SUBAGENT_CONTEXT_TOKENS = 200_000 as const

export const CHEAPEST2_PROFILE_ADVISOR_MODEL = CHEAPEST2_PROFILE_MODELS.advisor
export const CHEAPEST2_PROFILE_ADVISOR_CLIENT_MODEL =
  CHEAPEST2_PROFILE_MODELS.advisor
export const CHEAPEST2_PROFILE_ADVISOR_CONTEXT_TOKENS =
  CHEAPEST2_PROFILE_SUBAGENT_CONTEXT_TOKENS
export const CHEAPEST2_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_DEFAULT = 24_000 as const
export const CHEAPEST2_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MIN = 16_000 as const
export const CHEAPEST2_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MAX = 32_000 as const
export const CHEAPEST2_PROFILE_ADVISOR_EFFORT = "high" as const
export const CHEAPEST2_PROFILE_ORACLE_MODEL = CHEAPEST2_PROFILE_MODELS.oracle
export const CHEAPEST2_PROFILE_ORACLE_EFFORT = "high" as const

export const CHEAPEST2_PROFILE_SYNTHESIZED_PEERS = ["oracle"] as const
export type Cheapest2ProfileSynthesizedPeer =
  (typeof CHEAPEST2_PROFILE_SYNTHESIZED_PEERS)[number]

export const CHEAPEST2_PROFILE_DELEGATION_GRAPH = Object.freeze({
  Explore: Object.freeze([]),
  "General-Purpose": Object.freeze(["reviewer"]),
  reviewer: Object.freeze([]),
} as const satisfies Record<
  Cheapest2ProfileNativeAgentName,
  ReadonlyArray<Cheapest2ProfileNativeAgentName>
>)