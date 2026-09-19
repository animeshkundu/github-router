/**
 * Injected-skill registry: the floor-raising / controller skills the `claude`
 * launcher materializes into the per-launch `CLAUDE_CONFIG_DIR` mirror so the
 * spawned Claude Code session discovers them (`/gh-research`,
 * `/gh-orchestrate`, `/gh-floor-keeper`, `/gh-first-mate`, plus the `--swe`
 * pipeline skills `/gh-gather-context`, `/gh-plan`, `/gh-implement`,
 * `/gh-swe-pipeline`). See `docs/floor-raising-agent-surface.md`.
 */

import { buildFirstMateConductSkill, FIRST_MATE_CONDUCT_SKILL } from "./first-mate-conduct-skill"
import { buildFirstMateOperateSkill, FIRST_MATE_OPERATE_SKILL } from "./first-mate-operate-skill"
import { buildFirstMateSetupSkill, FIRST_MATE_SETUP_SKILL } from "~/lib/injected-skills/first-mate-setup-skill"
import { buildFirstMateSkill, FIRST_MATE_SKILL } from "./first-mate-skill"
import { buildFloorKeeperSkill, FLOOR_KEEPER_SKILL } from "./floor-keeper-skill"
import { buildGatherContextSkill, GATHER_CONTEXT_SKILL } from "./gather-context-skill"
import { buildImplementSkill, IMPLEMENT_SKILL } from "./implement-skill"
import { buildOrchestrateSkill, ORCHESTRATE_SKILL } from "./orchestrate-skill"
import { buildPlanSkill, PLAN_SKILL } from "./plan-skill"
import { buildResearchSkill, RESEARCH_SKILL } from "./research-skill"
import { buildSwePipelineSkill, SWE_PIPELINE_SKILL } from "./swe-pipeline-skill"
import { buildWorkerSkill, WORKER_SKILL } from "./worker-skill"
import { isPipelineSkillProfile } from "~/lib/skill-model-contract"

export { ARTIFACT_REVIEW_SKILL, buildArtifactReviewSkill } from "./artifact-review-skill"
export { buildFirstMateConductSkill, FIRST_MATE_CONDUCT_SKILL } from "./first-mate-conduct-skill"
export { buildFirstMateOperateSkill, FIRST_MATE_OPERATE_SKILL } from "./first-mate-operate-skill"
export { buildFirstMateSetupSkill, FIRST_MATE_SETUP_SKILL } from "~/lib/injected-skills/first-mate-setup-skill"
export { buildFirstMateSkill, FIRST_MATE_SKILL } from "./first-mate-skill"
export { buildFloorKeeperSkill, FLOOR_KEEPER_SKILL } from "./floor-keeper-skill"
export { buildGatherContextSkill, GATHER_CONTEXT_SKILL } from "./gather-context-skill"
export { buildImplementSkill, IMPLEMENT_SKILL } from "./implement-skill"
export { buildOrchestrateSkill, ORCHESTRATE_SKILL } from "./orchestrate-skill"
export { buildPlanSkill, PLAN_SKILL } from "./plan-skill"
export { buildResearchSkill, RESEARCH_SKILL } from "./research-skill"
export { buildSwePipelineSkill, SWE_PIPELINE_SKILL } from "./swe-pipeline-skill"
export { buildWorkerSkill, WORKER_SKILL } from "./worker-skill"
export { writeInjectedSkill, type WriteInjectedSkillResult } from "./write"

/** A skill to materialize: `name` is BOTH the frontmatter `name` and the folder
 *  name (the loader enforces folder == name); `md` is the full `SKILL.md`. */
export interface InjectedSkill {
  name: string
  md: string
}

export interface InjectedSkillSelection {
  profileId: "standard" | "fast" | "cheap" | "cheap1m" | "cheapest" | "balanced" | "max"
  workerSkillsActive: boolean
  firstMateEnabled: boolean
  /**
   * Whether the `--swe` flag was supplied. The pipeline skills (including the
   * `/gh-swe-pipeline` orchestrator) are injected ONLY when this is true AND
   * the profile is a pipeline skill profile. Without it, pinned profiles get
   * no pipeline slash commands and no pipeline awareness text.
   */
  sweEnabled?: boolean
  /**
   * Whether ColBERT semantic code search is enabled for this launch
   * (`--search` / `GH_ROUTER_ENABLE_SEMANTIC_SEARCH=1`). When true the
   * research/gather/orchestrate skills describe semantic-first discovery;
   * when false/absent they describe lexical-only discovery and never name
   * semantic search.
   */
  searchEnabled?: boolean
}

/**
 * Build the pipeline skills for `--swe` launches on pinned profiles (all
 * 200K default context). The orchestrator (`/gh-swe-pipeline`) runs the
 * other three in strict sequence; the three stages stay individually
 * invokable for users who only want one stage.
 */
export function getPipelineSkills(searchEnabled: boolean): ReadonlyArray<InjectedSkill> {
  return [
    buildGatherContextSkill(searchEnabled),
    buildPlanSkill(searchEnabled),
    buildImplementSkill(searchEnabled),
    buildSwePipelineSkill(searchEnabled),
  ]
}

/**
 * Pipeline skills for `--swe` launches on pinned profiles (all 200K default
 * context). The orchestrator (`/gh-swe-pipeline`) runs the other three in
 * strict sequence; the three stages stay individually invokable for users who
 * only want one stage.
 *
 * @deprecated Prefer `getPipelineSkills(searchEnabled)` so the skill text
 * matches the launch's search capability. Kept for callers without a flag
 * concept (tests, drift audits); built with semantic search enabled.
 */
export const PIPELINE_SKILLS: ReadonlyArray<InjectedSkill> = [
  GATHER_CONTEXT_SKILL,
  PLAN_SKILL,
  IMPLEMENT_SKILL,
  SWE_PIPELINE_SKILL,
]

/**
 * Build all injected skills in dependency order (research underpins the
 * others), with search guidance matched to the launch's search capability.
 */
export function getInjectedSkills(searchEnabled: boolean): ReadonlyArray<InjectedSkill> {
  return [
    buildResearchSkill(searchEnabled),
    buildGatherContextSkill(searchEnabled),
    buildPlanSkill(searchEnabled),
    buildImplementSkill(searchEnabled),
    buildOrchestrateSkill(searchEnabled),
    buildFloorKeeperSkill(searchEnabled),
    buildWorkerSkill(searchEnabled),
    buildFirstMateSkill(searchEnabled),
    buildFirstMateSetupSkill(searchEnabled),
    buildFirstMateOperateSkill(searchEnabled),
    buildFirstMateConductSkill(searchEnabled),
  ]
}

/**
 * All injected skills, in dependency order (research underpins the others).
 *
 * @deprecated Prefer `getInjectedSkills(searchEnabled)` so the skill text
 * matches the launch's search capability. Kept for callers without a flag
 * concept (tests, drift audits); built with semantic search enabled.
 */
export const INJECTED_SKILLS: ReadonlyArray<InjectedSkill> = [
  RESEARCH_SKILL,
  GATHER_CONTEXT_SKILL,
  PLAN_SKILL,
  IMPLEMENT_SKILL,
  ORCHESTRATE_SKILL,
  FLOOR_KEEPER_SKILL,
  WORKER_SKILL,
  FIRST_MATE_SKILL,
  FIRST_MATE_SETUP_SKILL,
  FIRST_MATE_OPERATE_SKILL,
  FIRST_MATE_CONDUCT_SKILL,
]

export function injectedSkillsForLaunch(
  selection: InjectedSkillSelection,
): ReadonlyArray<InjectedSkill> {
  const searchEnabled = selection.searchEnabled === true
  const allSkills = getInjectedSkills(searchEnabled)
  const pipelineSkills = getPipelineSkills(searchEnabled)
  // The SWE pipeline skills are opt-in via `--swe` on pinned profiles only.
  // Without the flag, pinned profiles get NO pipeline slash commands (just
  // first-mate skills on max when enabled); standard keeps the existing
  // research/orchestrate/worker surface. Standard is intentionally excluded
  // from the pipeline even with the flag.
  if (isPipelineSkillProfile(selection.profileId)) {
    if (!selection.sweEnabled) {
      if (selection.profileId === "max" && selection.firstMateEnabled) {
        return allSkills.filter((skill) => skill.name.startsWith("gh-first-mate"))
      }
      return []
    }
    if (selection.profileId === "max") {
      const pipeline = pipelineSkills.slice()
      if (selection.firstMateEnabled) {
        return [
          ...pipeline,
          ...allSkills.filter((skill) => skill.name.startsWith("gh-first-mate")),
        ]
      }
      return pipeline
    }
    return pipelineSkills.slice()
  }
  if (!selection.workerSkillsActive) return []
  return allSkills.filter(
    (skill) => selection.firstMateEnabled || !skill.name.startsWith("gh-first-mate"),
  )
}
