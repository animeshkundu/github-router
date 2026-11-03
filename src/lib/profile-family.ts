/**
 * The `cheapest`/`cheapest2`/`cheaplocal` and `balanced`/`balanced2`
 * launch-profile families.
 *
 * The `-2` aliases are not separate tiers: each is its base profile with a
 * declared set of Sol identities replaced (`cheapest2`: Advisor + Oracle at
 * `gpt-6.1-sol`, Advisor effort `high`; `balanced2`: lead + reviewer at
 * `gpt-6.1-sol`, Oracle `grok-4.7`). Every consumer therefore asks the family
 * helpers below rather than comparing against one literal id, which is what
 * keeps the siblings from drifting: a check written for `cheapest` covers
 * `cheapest2` by construction instead of needing a parallel branch.
 *
 * `cheaplocal` is a third cheapest sibling, not a local-family member: its lead
 * and natives stay on Copilot and only its two consultants move to the local
 * endpoint. It joins the family because every lead/native/window decision is
 * identical to `cheapest`; the transport difference rides on the contract's
 * `consultTransport`, so consumers branch on data rather than on this id.
 *
 * This module imports only the five contract modules — never
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
import {
  CHEAPLOCAL_PROFILE_CONTRACT,
} from "./cheaplocal-profile-contract"
import {
  LOCAL_PROFILE_CONTRACT,
  LOCAL2_PROFILE_CONTRACT,
} from "./local-profile-contract"

export type CheapestProfileId = "cheapest" | "cheapest2" | "cheaplocal"
export type BalancedProfileId = "balanced" | "balanced2"
export type LocalProfileId = "local" | "local2"

export function isCheapestFamily(
  profileId: string | null | undefined,
): profileId is CheapestProfileId {
  return (
    profileId === "cheapest"
    || profileId === "cheapest2"
    || profileId === "cheaplocal"
  )
}

/** The one cheapest sibling whose consultants leave Copilot. The predicate
 *  form matters at call sites that must EXCLUDE the id: Pi rejects it, and a
 *  plain `boolean` would leave `CheapestProfileId` intact after the refusal. */
export function isCheaplocalProfile(
  profileId: string | null | undefined,
): profileId is "cheaplocal" {
  return profileId === "cheaplocal"
}

export function isBalancedFamily(
  profileId: string | null | undefined,
): profileId is BalancedProfileId {
  return profileId === "balanced" || profileId === "balanced2"
}

export function isLocalFamily(
  profileId: string | null | undefined,
): profileId is LocalProfileId {
  return profileId === "local" || profileId === "local2"
}

/**
 * Every FIXED-ROSTER launch profile: `fast`, the cheap pair, the three cheapest
 * siblings, the balanced pair, and the local pair. These are the launches whose
 * MCP surface, picker rows, mirror purge and status line the router owns
 * outright.
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
  "cheaplocal",
  "balanced",
  "balanced2",
  "local",
  "local2",
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
):
  | typeof CHEAPEST_PROFILE_CONTRACT
  | typeof CHEAPEST2_PROFILE_CONTRACT
  | typeof CHEAPLOCAL_PROFILE_CONTRACT {
  if (profileId === "cheapest2") return CHEAPEST2_PROFILE_CONTRACT
  if (profileId === "cheaplocal") return CHEAPLOCAL_PROFILE_CONTRACT
  return CHEAPEST_PROFILE_CONTRACT
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
 * The contract for a local-family profile (base fallback, as above).
 *
 * Local is a THIRD family, not a cheapest sibling: its egress and model ids
 * differ while its prose is inherited. `cheapestContractFor` is never the
 * accessor for it, precisely because that function would hand back a Copilot
 * model id for a launch that must never name one.
 */
export function localContractFor(
  profileId: string | null | undefined,
): typeof LOCAL_PROFILE_CONTRACT | typeof LOCAL2_PROFILE_CONTRACT {
  return profileId === "local2"
    ? LOCAL2_PROFILE_CONTRACT
    : LOCAL_PROFILE_CONTRACT
}

/**
 * The `local2` contract including its Advisor block.
 *
 * A dedicated accessor rather than a widening of `localContractFor`: the base
 * local contract has NO advisor fields at the type level (Advisor-free by
 * design), so reading `localContractFor(id).advisorModel` is a type error on
 * the union. Every advisor site therefore has to name `local2` to reach this
 * function — which is exactly the property the contract's doc asks for.
 */
export function local2AdvisorContract(): typeof LOCAL2_PROFILE_CONTRACT {
  return LOCAL2_PROFILE_CONTRACT
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
 * The model the cheapest-family prompt rewrite runs on.
 *
 * Read from `rewriteModel`, NOT `advisorModel`: the rewrite is always a Copilot
 * dispatch, so a sibling whose consultants moved to the local endpoint must not
 * hand a local slug to it. One call site serves every member and a future tier
 * only has to change its contract.
 */
export function cheapestRewriteModelFor(
  profileId: string | null | undefined,
): string {
  return cheapestContractFor(profileId).rewriteModel
}
