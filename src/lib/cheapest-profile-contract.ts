/**
 * Fixed identities for the literal `github-router claude -m cheapest` profile.
 *
 * The cheapest all-200K tier: a `gpt-6-luna`/max LEAD at Claude Code's
 * DEFAULT (bare-slug) 200K window, every subagent at the same 200K default,
 * a `gpt-5.6-sol`/medium Advisor (bare slug), and a `gpt-5.6-sol`/high
 * primary Oracle. Oracle-only peer set (no `astra`) and a three-agent
 * surface (`Explore`/`General-Purpose`/`reviewer` — no `Plan`): the lead
 * plans directly and reviews the final plan with the Advisor (advisory)
 * before presenting it.
 *
 * The "200K window" here is enforced client-side by the launcher-seeded
 * `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` (see `getClaudeCodeEnvVars`), not by
 * the bare slugs alone: every row maps via `behavesAs` onto a known Claude
 * model whose client-side profile is native-1M.
 *
 * This module is deliberately dependency-free, including its own delegation
 * graph literal: each pinned profile owns its graph so tuning one roster
 * cannot silently retune another.
 */

export const CHEAPEST_PROFILE_MODELS = Object.freeze({
  lead: "gpt-6-luna",
  explore: "gpt-6-luna",
  "General-Purpose": "gpt-6-luna",
  reviewer: "gpt-6-luna",
  advisor: "gpt-5.6-sol",
  oracle: "gpt-5.6-sol",
} as const)

export const CHEAPEST_PROFILE_NATIVE_AGENT_NAMES = [
  "Explore",
  "General-Purpose",
  "reviewer",
] as const

export type CheapestProfileNativeAgentName =
  (typeof CHEAPEST_PROFILE_NATIVE_AGENT_NAMES)[number]

export const CHEAPEST_PROFILE_NATIVE_MODELS: Readonly<
  Record<CheapestProfileNativeAgentName, string>
> = Object.freeze({
  Explore: CHEAPEST_PROFILE_MODELS.explore,
  "General-Purpose": CHEAPEST_PROFILE_MODELS["General-Purpose"],
  reviewer: CHEAPEST_PROFILE_MODELS.reviewer,
})

export const CHEAPEST_PROFILE_NATIVE_EFFORTS = Object.freeze({
  Explore: "high",
  "General-Purpose": "max",
  reviewer: "max",
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

/**
 * Curated-transcript token budget for the cheapest Advisor (the protégé
 * consult). Unlike every other advisor profile, the cheapest lead CURATES the
 * window: the proxy renders a small, tool-aware transcript and the lead's
 * pre-call brief (`<caller_context>`) leads, so the advisor reads signal
 * rather than a 200K dump of raw tool output.
 *
 * This is deliberately much smaller than the 200K client budget: the point is
 * to bound advisor read cost and focus attention, not to maximize context.
 * Default 24K, clamped to [16K, 32K], overridable via
 * `GH_ROUTER_ADVISOR_TRANSCRIPT_TOKENS` (see `resolveCheapestAdvisorTranscriptTokens`).
 */
export const CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_DEFAULT = 24_000 as const
export const CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MIN = 16_000 as const
export const CHEAPEST_PROFILE_ADVISOR_TRANSCRIPT_TOKENS_MAX = 32_000 as const

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
 *  There is no `Plan` role: the lead plans directly (reviewing the final plan
 *  with the Advisor before presenting it) and the cheapest planner's heavy
 *  use of `Explore` and `General-Purpose` is prompt-level guidance in its
 *  agent definition, not a graph change. */
export const CHEAPEST_PROFILE_DELEGATION_GRAPH = Object.freeze({
  Explore: Object.freeze([]),
  "General-Purpose": Object.freeze(["reviewer"]),
  reviewer: Object.freeze([]),
} as const satisfies Record<
  CheapestProfileNativeAgentName,
  ReadonlyArray<CheapestProfileNativeAgentName>
>)
