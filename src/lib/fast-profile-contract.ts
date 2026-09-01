/**
 * Fixed identities for the literal `github-router claude -m fast` profile.
 *
 * This module is deliberately dependency-free. Launch validation, request
 * routing, native-agent generation, and the PreToolUse ACL all import the same
 * literals so a role cannot silently mean different things at each boundary.
 */

export const FAST_PROFILE_MODELS = Object.freeze({
  luna: "gpt-5.6-luna",
  sol: "gpt-5.6-sol",
  gemini: "gemini-3.7-flash",
  grok: "grok-4.6",
  opus: "claude-opus-5",
  explore: "gpt-5.6-luna",
  plan: "gpt-5.6-sol",
  "general-purpose": "gpt-5.6-luna",
  implementer: "gemini-3.7-flash",
  reviewer: "grok-4.6",
  advisor: "gemini-3.7-flash",
  oracle: "claude-opus-5",
} as const)

export const FAST_PROFILE_NATIVE_AGENT_NAMES = [
  "Explore",
  "Plan",
  "general-purpose",
  "implementer",
  "reviewer",
] as const

export type FastProfileNativeAgentName =
  (typeof FAST_PROFILE_NATIVE_AGENT_NAMES)[number]

export const FAST_PROFILE_NATIVE_MODELS: Readonly<
  Record<FastProfileNativeAgentName, string>
> = Object.freeze({
  Explore: FAST_PROFILE_MODELS.luna,
  Plan: FAST_PROFILE_MODELS.sol,
  "general-purpose": FAST_PROFILE_MODELS.luna,
  implementer: FAST_PROFILE_MODELS.gemini,
  reviewer: FAST_PROFILE_MODELS.reviewer,
})

export const FAST_PROFILE_NATIVE_EFFORTS = Object.freeze({
  Explore: "high",
  Plan: "high",
  "general-purpose": "max",
  implementer: "high",
  reviewer: "medium",
} as const)

export const FAST_PROFILE_ADVISOR_MODEL = FAST_PROFILE_MODELS.advisor
export const FAST_PROFILE_ADVISOR_CLIENT_MODEL =
  `${FAST_PROFILE_ADVISOR_MODEL}[1m]` as const
export const FAST_PROFILE_ADVISOR_EFFORT = "high" as const
export const FAST_PROFILE_ORACLE_MODEL = FAST_PROFILE_MODELS.oracle
export const FAST_PROFILE_ORACLE_EFFORT = "high" as const

/** Each native role's permitted native-agent targets. The lead gets the roster. */
export const FAST_PROFILE_DELEGATION_GRAPH = Object.freeze({
  Explore: Object.freeze([]),
  Plan: Object.freeze(["Explore", "reviewer"]),
  "general-purpose": Object.freeze(["reviewer"]),
  implementer: Object.freeze(["reviewer"]),
  reviewer: Object.freeze([]),
} as const satisfies Record<
  FastProfileNativeAgentName,
  ReadonlyArray<FastProfileNativeAgentName>
>)
