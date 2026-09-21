/**
 * Fixed identities for the literal `github-router claude -m balanced` profile.
 *
 * The most-complex-tasks tier: a `gpt-5.6-sol`/medium LEAD at Claude Code's
 * DEFAULT (bare-slug) 200K window, every subagent at the same 200K default,
 * and a `grok-4.6`/medium primary Oracle. Advisor-free by design: no Advisor
 * model, tool, or prose is wired for this profile. Oracle-only peer set
 * (no `astra`) and the same four-agent surface as the cheap family minus
 * `implementer`, except the `reviewer` may invoke `Explore` for targeted
 * discovery (search-first, then delegate).
 *
 * Delegation policy is lead-owns-by-default: the lead plans, implements,
 * and verifies itself, delegating FREELY to the Luna-powered `Explore` and
 * `General-Purpose` roles, and to `Plan`/`reviewer` ONLY when genuinely
 * needed (complex sequencing / behavior-changing review).
 *
 * This module is deliberately dependency-free, including its own delegation
 * graph literal: balanced shares cheap's authority shape today, but each
 * pinned profile owns its graph so tuning one roster cannot silently retune
 * another. The PreToolUse ACL reads each profile's own graph.
 */

export const BALANCED_PROFILE_MODELS = Object.freeze({
  lead: "gpt-5.6-sol",
  explore: "gpt-5.6-luna",
  plan: "gpt-5.6-sol",
  "General-Purpose": "gpt-5.6-luna",
  reviewer: "gemini-3.8-flash",
  oracle: "grok-4.6",
  astra: "gpt-6-astra",
} as const)

export const BALANCED_PROFILE_NATIVE_AGENT_NAMES = [
  "Explore",
  "Plan",
  "General-Purpose",
  "reviewer",
] as const

export type BalancedProfileNativeAgentName =
  (typeof BALANCED_PROFILE_NATIVE_AGENT_NAMES)[number]

export const BALANCED_PROFILE_NATIVE_MODELS: Readonly<
  Record<BalancedProfileNativeAgentName, string>
> = Object.freeze({
  Explore: BALANCED_PROFILE_MODELS.explore,
  Plan: BALANCED_PROFILE_MODELS.plan,
  "General-Purpose": BALANCED_PROFILE_MODELS["General-Purpose"],
  reviewer: BALANCED_PROFILE_MODELS.reviewer,
})

export const BALANCED_PROFILE_NATIVE_EFFORTS = Object.freeze({
  Explore: "high",
  Plan: "high",
  "General-Purpose": "max",
  reviewer: "high",
} as const)

/**
 * Lead context window (tokens) for `-m balanced`. The Sol LEAD runs at
 * Claude Code's DEFAULT (bare-slug) 200K budget — the whole point of the
 * balanced launch is frontier reasoning without any `[1m]` accounting.
 */
export const BALANCED_PROFILE_LEAD_CONTEXT_TOKENS = 200_000 as const

/**
 * Subagent/peer context window (tokens). Every non-lead role (and the lead
 * as well) runs at Claude Code's DEFAULT (bare-slug) budget — 200K.
 */
export const BALANCED_PROFILE_SUBAGENT_CONTEXT_TOKENS = 200_000 as const

export const BALANCED_PROFILE_LEAD_EFFORT = "medium" as const
export const BALANCED_PROFILE_ORACLE_MODEL = BALANCED_PROFILE_MODELS.oracle
export const BALANCED_PROFILE_ORACLE_EFFORT = "medium" as const

/**
 * Synthesized MCP consultant tools for `-m balanced`: Oracle only, like
 * `-m cheap` (never `astra`).
 */
export const BALANCED_PROFILE_SYNTHESIZED_PEERS = ["oracle"] as const
export type BalancedProfileSynthesizedPeer =
  (typeof BALANCED_PROFILE_SYNTHESIZED_PEERS)[number]

/** Each native role's permitted native-agent targets. The lead gets the roster.
 * Unlike the fast/cheap graphs, the balanced `reviewer` may invoke `Explore`
 * for targeted discovery: the Gemini-backed reviewer narrows scope with
 * search first, then delegates scoped evidence questions rather than
 * sweeping the repository itself. */
export const BALANCED_PROFILE_DELEGATION_GRAPH = Object.freeze({
  Explore: Object.freeze([]),
  Plan: Object.freeze(["Explore", "reviewer"]),
  "General-Purpose": Object.freeze(["reviewer"]),
  reviewer: Object.freeze(["Explore"]),
} as const satisfies Record<
  BalancedProfileNativeAgentName,
  ReadonlyArray<BalancedProfileNativeAgentName>
>)
