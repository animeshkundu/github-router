/**
 * Universal skill model contract for the `/gh-gather-context`, `/gh-plan`,
 * and `/gh-implement` pipeline skills.
 *
 * ALL roles run at the 200K DEFAULT context window (bare slugs, no `[1m]`
 * accounting bracket) on every profile. This module is deliberately
 * dependency-free so profile contracts, launch validation, worker dispatch,
 * and the injected skill bodies can all import the same literals without
 * cycles.
 *
 * Model choices (per pipeline design):
 *   - gatherContext lead + explore agents: Luna, high effort
 *   - plan lead: Sol, medium effort
 *   - implement lead + task agents: Luna, max effort
 *   - review pass 1: Luna, max effort
 *   - review pass 2 (major issues only): Sol, medium effort
 */

export const SKILL_LUNA_MODEL_ID = "gpt-5.6-luna" as const
export const SKILL_SOL_MODEL_ID = "gpt-5.6-sol" as const

export const SKILL_MODELS = Object.freeze({
  gatherContext: Object.freeze({
    lead: SKILL_LUNA_MODEL_ID,
    exploreAgent: SKILL_LUNA_MODEL_ID,
    leadEffort: "high",
    agentEffort: "high",
  }),
  plan: Object.freeze({
    lead: SKILL_SOL_MODEL_ID,
    leadEffort: "medium",
  }),
  implement: Object.freeze({
    lead: SKILL_LUNA_MODEL_ID,
    taskAgent: SKILL_LUNA_MODEL_ID,
    leadEffort: "max",
    agentEffort: "max",
  }),
  review: Object.freeze({
    pass1: Object.freeze({ model: SKILL_LUNA_MODEL_ID, effort: "max" }),
    pass2: Object.freeze({ model: SKILL_SOL_MODEL_ID, effort: "medium" }),
  }),
} as const)

export type SkillModelRole =
  | "gather-context-lead"
  | "gather-context-explore"
  | "plan-lead"
  | "implement-lead"
  | "implement-task"
  | "review-pass1"
  | "review-pass2"

/**
 * Hard execution bounds for the pipeline skills. The skill bodies enforce
 * these; the worker dispatcher mirrors them for timeout/budget wiring.
 */
export const SKILL_BOUNDS = Object.freeze({
  gatherContext: Object.freeze({
    maxRounds: 3,
    maxExploreAgentsPerRound: 6,
    maxLexicalSearchesPerRound: 10,
    maxFollowUpReadsPerRound: 5,
    exploreAgentTimeoutMs: 180_000,
    exploreAgentMaxOutputTokens: 50_000,
  }),
  plan: Object.freeze({
    maxTasks: 20,
    maxParallelGroups: 5,
    maxContextTokens: 150_000,
  }),
  implement: Object.freeze({
    maxConcurrentAgents: 8,
    maxRetriesPerTask: 2,
    maxReviewFixCycles: 2,
    taskAgentTimeoutMs: 600_000,
    taskAgentMaxOutputTokens: 80_000,
  }),
} as const)

/** Skill names for the pipeline, shared by the registry and tests. */
export const PIPELINE_SKILL_NAMES = [
  "gh-gather-context",
  "gh-plan",
  "gh-implement",
] as const

export type PipelineSkillName = (typeof PIPELINE_SKILL_NAMES)[number]

/**
 * Profiles that receive the pipeline skills. Every pinned profile gets
 * them; `standard` is intentionally excluded (it keeps the existing
 * research/orchestrate/worker surface).
 */
export const PIPELINE_SKILL_PROFILES = [
  "fast",
  "max",
  "cheap",
  "cheap1m",
  "cheapest",
  "balanced",
] as const

export type PipelineSkillProfile = (typeof PIPELINE_SKILL_PROFILES)[number]

export function isPipelineSkillProfile(
  profileId: string,
): profileId is PipelineSkillProfile {
  return (PIPELINE_SKILL_PROFILES as ReadonlyArray<string>).includes(profileId)
}
