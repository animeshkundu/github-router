/**
 * Fixed identities for the literal `github-router claude -m cheap` and
 * `-m cheap1m` cheap-family profiles.
 *
 * A cost-lean sibling of `-m fast`: identical fixed four-agent surface, but
 * every SUBAGENT runs at Claude Code's 200K DEFAULT context window (bare
 * slug, no `[1m]` accounting bracket). `-m cheap` also drives the Gemini
 * LEAD at the same 200K default (bare slug, no `[1m]`) with medium effort,
 * so its only peer is the `grok-4.6`/medium Oracle. `-m cheap1m` is the named successor of the
 * original cheap launch: the leader keeps its full 1M window (`[1m]`) and
 * the `astra` peer (`gpt-6-astra`) remains available next to Oracle — still
 * at the 200K default window and medium effort.
 *
 * This module is deliberately dependency-free, including its own delegation
 * graph literal: the cheap family shares fast's exact authority shape today,
 * but each pinned profile owns its graph so tuning one roster cannot silently
 * retune another. Launch validation, request routing, native-agent
 * generation, and the PreToolUse ACL all import the same literals so a role
 * cannot silently mean different things at each boundary.
 */

export const CHEAP_PROFILE_MODELS = Object.freeze({
  lead: "gemini-3.8-flash",
  explore: "gpt-5.6-luna",
  plan: "gpt-5.6-sol",
  "General-Purpose": "gemini-3.8-flash",
  reviewer: "gpt-5.6-luna",
  advisor: "gpt-5.6-sol",
  oracle: "grok-4.6",
  astra: "gpt-6-astra",
} as const)

export const CHEAP_PROFILE_NATIVE_AGENT_NAMES = [
  "Explore",
  "Plan",
  "General-Purpose",
  "reviewer",
] as const

export type CheapProfileNativeAgentName =
  (typeof CHEAP_PROFILE_NATIVE_AGENT_NAMES)[number]

export const CHEAP_PROFILE_NATIVE_MODELS: Readonly<
  Record<CheapProfileNativeAgentName, string>
> = Object.freeze({
  Explore: CHEAP_PROFILE_MODELS.explore,
  Plan: CHEAP_PROFILE_MODELS.plan,
  "General-Purpose": CHEAP_PROFILE_MODELS["General-Purpose"],
  reviewer: CHEAP_PROFILE_MODELS.reviewer,
})

export const CHEAP_PROFILE_NATIVE_EFFORTS = Object.freeze({
  Explore: "high",
  Plan: "high",
  "General-Purpose": "max",
  reviewer: "max",
} as const)

/**
 * Lead context window (tokens) for `-m cheap`. `-m cheap` deliberately runs
 * the Gemini LEAD at Claude Code's DEFAULT (bare-slug) 200K budget too — the
 * whole point of the 200K cheap launch. The named `-m cheap1m` successor is
 * the one that keeps a 1M leader window (see its consumption site's
 * `FAST_REQUIRED_CONTEXT_TOKENS` gate in `./launch-profile`).
 */
export const CHEAP_PROFILE_LEAD_CONTEXT_TOKENS = 200_000 as const

/**
 * Subagent/peer context window (tokens). The cheap family deliberately runs
 * every non-lead role (and, under `-m cheap`, the lead as well) at Claude
 * Code's DEFAULT (bare-slug) budget — 200K — rather than decorating roles
 * with the `[1m]` accounting suffix, which is exactly what makes the cheap
 * surface cheaper than fast's per-role 1M windows.
 */
export const CHEAP_PROFILE_SUBAGENT_CONTEXT_TOKENS = 200_000 as const

export const CHEAP_PROFILE_ADVISOR_MODEL = CHEAP_PROFILE_MODELS.advisor
/**
 * Client-visible Advisor identity for cheap mode. The BARE slug (no `[1m]`
 * bracket): Claude Code budgets the Advisor tool as a 200K-model and forwards
 * no more than ~200K of the lead's transcript, and the proxy mirrors that with
 * `CHEAP_PROFILE_ADVISOR_CONTEXT_TOKENS`. The upstream Copilot request is the
 * bare id either way (`resolveModel` strips the bracket), so this only changes
 * the context the advisor is allowed to see — the cost lever.
 */
export const CHEAP_PROFILE_ADVISOR_CLIENT_MODEL = CHEAP_PROFILE_MODELS.advisor
/** Advisor context window for cheap mode (tokens). */
export const CHEAP_PROFILE_ADVISOR_CONTEXT_TOKENS =
  CHEAP_PROFILE_SUBAGENT_CONTEXT_TOKENS
export const CHEAP_PROFILE_LEAD_EFFORT = "medium" as const
export const CHEAP_PROFILE_ADVISOR_EFFORT = "medium" as const
export const CHEAP_PROFILE_ORACLE_MODEL = CHEAP_PROFILE_MODELS.oracle
export const CHEAP_PROFILE_ORACLE_EFFORT = "medium" as const
/** Astra identity for the `-m cheap1m` successor only (`-m cheap` has no
 *  astra peer). Runs at the 200K default window and medium effort. */
export const CHEAP_PROFILE_ASTRA_MODEL = CHEAP_PROFILE_MODELS.astra
export const CHEAP_PROFILE_ASTRA_EFFORT = "medium" as const
export const CHEAP_PROFILE_ASTRA_PROMPT_TOKENS =
  CHEAP_PROFILE_SUBAGENT_CONTEXT_TOKENS

/**
 * Synthesized MCP consultant tools specific to the `-m cheap` profile.
 * `-m cheap` exposes only `oracle`; the named `-m cheap1m` successor keeps
 * `astra` as well (declared via `CHEAP1M_PROFILE.personaAllowlist` in
 * `./launch-profile`, not here).
 */
export const CHEAP_PROFILE_SYNTHESIZED_PEERS = ["oracle"] as const
export type CheapProfileSynthesizedPeer =
  (typeof CHEAP_PROFILE_SYNTHESIZED_PEERS)[number]

/** Peer set for the `-m cheap1m` successor (Oracle + Astra). */
export const CHEAP1M_PROFILE_SYNTHESIZED_PEERS = ["oracle", "astra"] as const

/** Each native role's permitted native-agent targets. The lead gets the roster. */
export const CHEAP_PROFILE_DELEGATION_GRAPH = Object.freeze({
  Explore: Object.freeze([]),
  Plan: Object.freeze(["Explore", "reviewer"]),
  "General-Purpose": Object.freeze(["reviewer"]),
  reviewer: Object.freeze([]),
} as const satisfies Record<
  CheapProfileNativeAgentName,
  ReadonlyArray<CheapProfileNativeAgentName>
>)