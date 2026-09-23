/**
 * Fixed identities for the literal `github-router claude -m fast` profile.
 *
 * This module is deliberately dependency-free. Launch validation, request
 * routing, native-agent generation, and the PreToolUse ACL all import the same
 * literals so a role cannot silently mean different things at each boundary.
 */

export const FAST_PROFILE_MODELS = Object.freeze({
  luna: "gpt-6-luna",
  sol: "gpt-6-sol",
  gemini: "gemini-3.8-flash",
  grok: "grok-4.6",
  opus: "claude-opus-5.5",
  sonnet: "claude-sonnet-5",
  lead: "gemini-3.8-flash",
  explore: "gpt-6-luna",
  plan: "gpt-6-sol",
  "General-Purpose": "gemini-3.8-flash",
  reviewer: "claude-sonnet-5",
  advisor: "gpt-6-sol",
  oracle: "claude-opus-5.5",
  astra: "gpt-6-astra",
} as const)

export const FAST_PROFILE_NATIVE_AGENT_NAMES = [
  "Explore",
  "Plan",
  "General-Purpose",
  "reviewer",
] as const

export type FastProfileNativeAgentName =
  (typeof FAST_PROFILE_NATIVE_AGENT_NAMES)[number]

export const FAST_PROFILE_NATIVE_MODELS: Readonly<
  Record<FastProfileNativeAgentName, string>
> = Object.freeze({
  Explore: FAST_PROFILE_MODELS.luna,
  Plan: FAST_PROFILE_MODELS.sol,
  "General-Purpose": FAST_PROFILE_MODELS.gemini,
  reviewer: FAST_PROFILE_MODELS.reviewer,
})

export const FAST_PROFILE_NATIVE_EFFORTS = Object.freeze({
  Explore: "high",
  Plan: "high",
  "General-Purpose": "high",
  reviewer: "xhigh",
} as const)

export const FAST_PROFILE_ADVISOR_MODEL = FAST_PROFILE_MODELS.advisor
export const FAST_PROFILE_ADVISOR_CLIENT_MODEL =
  `${FAST_PROFILE_ADVISOR_MODEL}[1m]` as const
export const FAST_PROFILE_ADVISOR_EFFORT = "high" as const
export const FAST_PROFILE_ORACLE_MODEL = FAST_PROFILE_MODELS.oracle
export const FAST_PROFILE_ORACLE_EFFORT = "high" as const
export const FAST_PROFILE_ASTRA_MODEL = FAST_PROFILE_MODELS.astra
export const FAST_PROFILE_ASTRA_EFFORT = "high" as const
export const FAST_PROFILE_ASTRA_PROMPT_TOKENS = 200_000 as const

/** Synthesized MCP consultant tools specific to the fast profile. */
export const FAST_PROFILE_SYNTHESIZED_PEERS = ["oracle", "astra"] as const
export type FastProfileSynthesizedPeer = (typeof FAST_PROFILE_SYNTHESIZED_PEERS)[number]

/** Each native role's permitted native-agent targets. The lead gets the roster. */
export const FAST_PROFILE_DELEGATION_GRAPH = Object.freeze({
  Explore: Object.freeze([]),
  Plan: Object.freeze(["Explore", "reviewer"]),
  "General-Purpose": Object.freeze(["reviewer"]),
  reviewer: Object.freeze([]),
} as const satisfies Record<
  FastProfileNativeAgentName,
  ReadonlyArray<FastProfileNativeAgentName>
>)
