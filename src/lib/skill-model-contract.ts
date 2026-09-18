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
 * Hard execution bounds for the pipeline skills, enforced by the skill
 * bodies (the lead model counts its own dispatches, rounds, and retries).
 *
 * Deliberately count-based only. Output-token caps are NOT listed here:
 * worker tools accept `{prompt, model, thinking, workspace, maxWallClockMs,
 * worktree}` and have no output-token parameter, so such a cap would be
 * unenforced fiction. Wall-clock budgets ARE enforceable via the real
 * `maxWallClockMs` worker arg (honored by `worker-agent/budget.ts`, clamped
 * to the per-call ceiling); the skill bodies instruct the lead to pass them,
 * and `SKILL_WORKER_CONFIGS` in `worker-dispatch.ts` is the single source
 * for those values.
 */
export const SKILL_BOUNDS = Object.freeze({
  gatherContext: Object.freeze({
    maxRounds: 3,
    maxExploreAgentsPerRound: 6,
    maxLexicalSearchesPerRound: 10,
    maxFollowUpReadsPerRound: 5,
  }),
  plan: Object.freeze({
    maxTasks: 20,
    maxParallelGroups: 5,
  }),
  implement: Object.freeze({
    maxConcurrentAgents: 8,
    maxRetriesPerTask: 2,
    maxReviewFixCycles: 2,
  }),
} as const)

/**
 * Skill names for the pipeline, shared by the registry and tests. The first
 * three are the waterfall stages; `gh-swe-pipeline` is the opt-in
 * orchestrator that runs them in strict sequence as a separate command.
 */
export const PIPELINE_SKILL_NAMES = [
  "gh-gather-context",
  "gh-plan",
  "gh-implement",
  "gh-swe-pipeline",
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
