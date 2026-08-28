/**
 * Fixed identities for the literal `github-router claude -m fast` profile.
 *
 * This module is deliberately dependency-free. Launch validation, request
 * routing, native-agent generation, and the PreToolUse ACL all import the same
 * literals so a role cannot silently mean different things at each boundary.
 */

export const FAST_PROFILE_MODELS = Object.freeze({
  luna: "gpt-5.6-luna",
  reviewer: "grok-4.6",
  Plan: "gpt-5.6-sol",
  critic: "gemini-3.7-flash",
  oracle: "claude-opus-5",
} as const)

export const FAST_PROFILE_NATIVE_AGENT_NAMES = [
  "Explore",
  "implementer",
  "reviewer",
  "Plan",
  "critic",
] as const

export type FastProfileNativeAgentName =
  (typeof FAST_PROFILE_NATIVE_AGENT_NAMES)[number]

export const FAST_PROFILE_NATIVE_MODELS: Readonly<
  Record<FastProfileNativeAgentName, string>
> = Object.freeze({
  Explore: FAST_PROFILE_MODELS.luna,
  implementer: FAST_PROFILE_MODELS.luna,
  reviewer: FAST_PROFILE_MODELS.reviewer,
  Plan: FAST_PROFILE_MODELS.Plan,
  critic: FAST_PROFILE_MODELS.critic,
})

export const FAST_PROFILE_NATIVE_EFFORTS = Object.freeze({
  Explore: "high",
  implementer: "max",
  reviewer: "medium",
  Plan: "high",
  critic: "medium",
} as const)

export const FAST_PROFILE_ADVISOR_MODEL = FAST_PROFILE_MODELS.critic
export const FAST_PROFILE_ADVISOR_CLIENT_MODEL =
  `${FAST_PROFILE_ADVISOR_MODEL}[1m]` as const
export const FAST_PROFILE_ADVISOR_EFFORT = "high" as const
export const FAST_PROFILE_ORACLE_MODEL = FAST_PROFILE_MODELS.oracle
export const FAST_PROFILE_ORACLE_EFFORT = "high" as const

/** Each native role's permitted native-agent targets. The lead gets the roster. */
export const FAST_PROFILE_DELEGATION_GRAPH = Object.freeze({
  Explore: Object.freeze([]),
  implementer: Object.freeze(["reviewer", "critic"]),
  reviewer: Object.freeze([]),
  Plan: Object.freeze(["reviewer", "Explore", "critic"]),
  critic: Object.freeze([]),
} as const satisfies Record<
  FastProfileNativeAgentName,
  ReadonlyArray<FastProfileNativeAgentName>
>)
