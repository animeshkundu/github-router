/**
 * Fixed identities for the literal `github-router claude -m cheapest` profile.
 *
 * The cheapest all-200K tier: a `gpt-6-luna`/max LEAD at Claude Code's
 * DEFAULT (bare-slug) 200K window, every subagent at the same 200K default,
 * a `gpt-6-sol`/medium Advisor (bare slug), and a `gpt-6-sol`/high
 * primary Oracle. Oracle-only peer set (no `astra`), same exact four-agent
 * surface and authority structure as the cheap family.
 *
 * This module is deliberately dependency-free, including its own delegation
 * graph literal: cheapest shares the cheap family's authority shape today,
 * but each pinned profile owns its graph so tuning one roster cannot silently
 * retune another.
 */

export const CHEAPEST_PROFILE_MODELS = Object.freeze({
  lead: "gpt-6-luna",
  explore: "gpt-6-luna",
  plan: "gpt-6-sol",
  "General-Purpose": "gpt-6-luna",
  reviewer: "gpt-6-sol",
  advisor: "gpt-6-sol",
  oracle: "gpt-6-sol",
} as const)

export const CHEAPEST_PROFILE_NATIVE_AGENT_NAMES = [
  "Explore",
  "Plan",
  "General-Purpose",
  "reviewer",
] as const

export type CheapestProfileNativeAgentName =
  (typeof CHEAPEST_PROFILE_NATIVE_AGENT_NAMES)[number]

export const CHEAPEST_PROFILE_NATIVE_MODELS: Readonly<
  Record<CheapestProfileNativeAgentName, string>
> = Object.freeze({
  Explore: CHEAPEST_PROFILE_MODELS.explore,
  Plan: CHEAPEST_PROFILE_MODELS.plan,
  "General-Purpose": CHEAPEST_PROFILE_MODELS["General-Purpose"],
  reviewer: CHEAPEST_PROFILE_MODELS.reviewer,
})

export const CHEAPEST_PROFILE_NATIVE_EFFORTS = Object.freeze({
  Explore: "high",
  Plan: "high",
  "General-Purpose": "max",
  reviewer: "high",
} as const)

/**
 * Lead context window (tokens) for `-m cheapest`. The Luna LEAD runs at
 * Claude Code's DEFAULT (bare-slug) 200K budget — the whole point of the
 * cheapest launch is that no role carries `[1m]` accounting.
 */
export const CHEAPEST_PROFILE_LEAD_CONTEXT_TOKENS = 200_000 as const

/**
 * Subagent/peer context window (tokens). Every non-lead role (and the lead
 * as well) runs at Claude Code's DEFAULT (bare-slug) budget — 200K.
 */
export const CHEAPEST_PROFILE_SUBAGENT_CONTEXT_TOKENS = 200_000 as const

export const CHEAPEST_PROFILE_ADVISOR_MODEL = CHEAPEST_PROFILE_MODELS.advisor
/**
 * Client-visible Advisor identity for cheapest mode. The BARE Sol slug
 * (no `[1m]` bracket): Claude Code budgets the Advisor tool as a 200K-model
 * and forwards no more than ~200K of the lead's transcript, and the proxy
 * mirrors that with `CHEAPEST_PROFILE_ADVISOR_CONTEXT_TOKENS`.
 */
export const CHEAPEST_PROFILE_ADVISOR_CLIENT_MODEL =
  CHEAPEST_PROFILE_MODELS.advisor
/** Advisor context window for cheapest mode (tokens). */
export const CHEAPEST_PROFILE_ADVISOR_CONTEXT_TOKENS =
  CHEAPEST_PROFILE_SUBAGENT_CONTEXT_TOKENS
export const CHEAPEST_PROFILE_ADVISOR_EFFORT = "medium" as const
export const CHEAPEST_PROFILE_ORACLE_MODEL = CHEAPEST_PROFILE_MODELS.oracle
export const CHEAPEST_PROFILE_ORACLE_EFFORT = "high" as const

/**
 * Synthesized MCP consultant tools for `-m cheapest`: Oracle only, like
 * `-m cheap` (never `astra`).
 */
export const CHEAPEST_PROFILE_SYNTHESIZED_PEERS = ["oracle"] as const
export type CheapestProfileSynthesizedPeer =
  (typeof CHEAPEST_PROFILE_SYNTHESIZED_PEERS)[number]

/** Each native role's permitted native-agent targets. The lead gets the roster.
 *  `Plan` may invoke `Explore` and `reviewer`; the cheapest planner's heavy
 *  use of `Explore` and `General-Purpose` is prompt-level guidance in its
 *  agent definition, not a graph change. */
export const CHEAPEST_PROFILE_DELEGATION_GRAPH = Object.freeze({
  Explore: Object.freeze([]),
  Plan: Object.freeze(["Explore", "reviewer"]),
  "General-Purpose": Object.freeze(["reviewer"]),
  reviewer: Object.freeze([]),
} as const satisfies Record<
  CheapestProfileNativeAgentName,
  ReadonlyArray<CheapestProfileNativeAgentName>
>)
