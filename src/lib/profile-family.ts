/**
 * The `cheapest`/`cheapest2` and `balanced`/`balanced2` launch-profile families.
 *
 * The `-2` aliases are not separate tiers: each is its base profile with a
 * declared set of Sol identities replaced (`cheapest2`: Advisor + Oracle at
 * `gpt-6.1-sol`, Advisor effort `high`; `balanced2`: lead + reviewer at
 * `gpt-6.1-sol`, Oracle `grok-4.7`). Every consumer therefore asks the family
 * helpers below rather than comparing against one literal id, which is what
 * keeps the two siblings from drifting: a check written for `cheapest` covers
 * `cheapest2` by construction instead of needing a parallel branch.
 *
 * This module imports only the four contract modules — never
 * `launch-profile.ts` — so it can be imported from anywhere in `src/lib`
 * without creating a cycle.
 */

import {
  BALANCED_PROFILE_CONTRACT,
} from "./balanced-profile-contract"
import {
  BALANCED2_PROFILE_CONTRACT,
} from "./balanced2-profile-contract"
import {
  CHEAPEST_PROFILE_CONTRACT,
} from "./cheapest-profile-contract"
import {
  CHEAPEST2_PROFILE_CONTRACT,
} from "./cheapest2-profile-contract"

export type CheapestProfileId = "cheapest" | "cheapest2"
export type BalancedProfileId = "balanced" | "balanced2"

export function isCheapestFamily(
  profileId: string | null | undefined,
): profileId is CheapestProfileId {
  return profileId === "cheapest" || profileId === "cheapest2"
}

export function isBalancedFamily(
  profileId: string | null | undefined,
): profileId is BalancedProfileId {
  return profileId === "balanced" || profileId === "balanced2"
}

/**
 * Every FIXED-ROSTER launch profile: `fast`, the cheap pair, and both
 * families. These are the launches whose MCP surface, picker rows,
 * mirror purge and status line the router owns outright.
 *
 * `max` is deliberately absent. It shares some of the same wiring, but it
 * has its own reviewer/roster path rather than the shared fast-style
 * projection, so every call site that includes it says so explicitly.
 */
const PINNED_PROFILE_IDS: ReadonlySet<string> = new Set([
  "fast",
  "cheap",
  "cheap1m",
  "cheapest",
  "cheapest2",
  "balanced",
  "balanced2",
])

export function isPinnedLaunchProfile(
  profileId: string | null | undefined,
): boolean {
  return profileId != null && PINNED_PROFILE_IDS.has(profileId)
}

/** The contract for a cheapest-family profile. Any other id falls back to the
 *  base contract, so a caller that asks for a family contract on a
 *  non-family launch still gets a complete, valid object rather than
 *  `undefined`. */
export function cheapestContractFor(
  profileId: string | null | undefined,
): typeof CHEAPEST_PROFILE_CONTRACT | typeof CHEAPEST2_PROFILE_CONTRACT {
  return profileId === "cheapest2"
    ? CHEAPEST2_PROFILE_CONTRACT
    : CHEAPEST_PROFILE_CONTRACT
}

/** The contract for a balanced-family profile (base fallback, as above). */
export function balancedContractFor(
  profileId: string | null | undefined,
): typeof BALANCED_PROFILE_CONTRACT | typeof BALANCED2_PROFILE_CONTRACT {
  return profileId === "balanced2"
    ? BALANCED2_PROFILE_CONTRACT
    : BALANCED_PROFILE_CONTRACT
}

/**
 * Human-readable model name for prose and descriptors. These strings reach
 * the model's own instructions and the user's terminal, so they are spelled
 * out rather than derived: "GPT-6.1 Sol" is not mechanical from the slug, and
 * an id with no entry (an operator-pinned model) is returned verbatim rather
 * than guessed at.
 */
const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-6-sol": "GPT-6 Sol",
  "gpt-6-luna": "GPT-6 Luna",
  "grok-4.7": "Grok 4.7",
  "grok-4.6": "Grok 4.6",
  "claude-opus-5.5": "Opus 5",
})

export function displayModelName(modelId: string): string {
  return MODEL_DISPLAY_NAMES[modelId] ?? modelId
}

/**
 * The model the cheapest-family prompt rewrite runs on. Both siblings rewrite
 * with their own advisor-tier Sol, so one call site serves both and a future
 * tier only has to change its contract.
 */
export function cheapestRewriteModelFor(
  profileId: string | null | undefined,
): string {
  return cheapestContractFor(profileId).advisorModel
}
