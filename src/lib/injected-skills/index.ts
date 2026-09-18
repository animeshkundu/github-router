/**
 * Injected-skill registry: the floor-raising / controller skills the `claude`
 * launcher materializes into the per-launch `CLAUDE_CONFIG_DIR` mirror so the
 * spawned Claude Code session discovers them (`/gh-research`,
 * `/gh-orchestrate`, `/gh-floor-keeper`, `/gh-first-mate`, plus the `--swe`
 * pipeline skills `/gh-gather-context`, `/gh-plan`, `/gh-implement`,
 * `/gh-swe-pipeline`). See `docs/floor-raising-agent-surface.md`.
 */

import { FIRST_MATE_CONDUCT_SKILL } from "./first-mate-conduct-skill"
import { FIRST_MATE_OPERATE_SKILL } from "./first-mate-operate-skill"
import { FIRST_MATE_SETUP_SKILL } from "~/lib/injected-skills/first-mate-setup-skill"
import { FIRST_MATE_SKILL } from "./first-mate-skill"
import { FLOOR_KEEPER_SKILL } from "./floor-keeper-skill"
import { GATHER_CONTEXT_SKILL } from "./gather-context-skill"
import { IMPLEMENT_SKILL } from "./implement-skill"
import { ORCHESTRATE_SKILL } from "./orchestrate-skill"
import { PLAN_SKILL } from "./plan-skill"
import { RESEARCH_SKILL } from "./research-skill"
import { SWE_PIPELINE_SKILL } from "./swe-pipeline-skill"
import { WORKER_SKILL } from "./worker-skill"
import { isPipelineSkillProfile } from "~/lib/skill-model-contract"

export { ARTIFACT_REVIEW_SKILL, buildArtifactReviewSkill } from "./artifact-review-skill"
export { FIRST_MATE_CONDUCT_SKILL } from "./first-mate-conduct-skill"
export { FIRST_MATE_OPERATE_SKILL } from "./first-mate-operate-skill"
export { FIRST_MATE_SETUP_SKILL } from "~/lib/injected-skills/first-mate-setup-skill"
export { FIRST_MATE_SKILL } from "./first-mate-skill"
export { GATHER_CONTEXT_SKILL } from "./gather-context-skill"
export { IMPLEMENT_SKILL } from "./implement-skill"
export { PLAN_SKILL } from "./plan-skill"
export { SWE_PIPELINE_SKILL } from "./swe-pipeline-skill"
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
}

/**
 * Pipeline skills for `--swe` launches on pinned profiles (all 200K default
 * context). The orchestrator (`/gh-swe-pipeline`) runs the other three in
 * strict sequence; the three stages stay individually invokable for users who
 * only want one stage.
 */
export const PIPELINE_SKILLS: ReadonlyArray<InjectedSkill> = [
  GATHER_CONTEXT_SKILL,
  PLAN_SKILL,
  IMPLEMENT_SKILL,
  SWE_PIPELINE_SKILL,
]

/** All injected skills, in dependency order (research underpins the others). */
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
  // The SWE pipeline skills are opt-in via `--swe` on pinned profiles only.
  // Without the flag, pinned profiles get NO pipeline slash commands (just
  // first-mate skills on max when enabled); standard keeps the existing
  // research/orchestrate/worker surface. Standard is intentionally excluded
  // from the pipeline even with the flag.
  if (isPipelineSkillProfile(selection.profileId)) {
    if (!selection.sweEnabled) {
      if (selection.profileId === "max" && selection.firstMateEnabled) {
        return INJECTED_SKILLS.filter((skill) => skill.name.startsWith("gh-first-mate"))
      }
      return []
    }
    if (selection.profileId === "max") {
      const pipeline = PIPELINE_SKILLS.slice()
      if (selection.firstMateEnabled) {
        return [
          ...pipeline,
          ...INJECTED_SKILLS.filter((skill) => skill.name.startsWith("gh-first-mate")),
        ]
      }
      return pipeline
    }
    return PIPELINE_SKILLS.slice()
  }
  if (!selection.workerSkillsActive) return []
  return INJECTED_SKILLS.filter(
    (skill) => selection.firstMateEnabled || !skill.name.startsWith("gh-first-mate"),
  )
}
