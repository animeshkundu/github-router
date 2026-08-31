/**
 * Injected-skill registry: the floor-raising / controller skills the `claude`
 * launcher materializes into the per-launch `CLAUDE_CONFIG_DIR` mirror so the
 * spawned Claude Code session discovers them (`/gh-research`,
 * `/gh-orchestrate`, `/gh-floor-keeper`, `/gh-first-mate`). See
 * `docs/floor-raising-agent-surface.md`.
 */

import { FIRST_MATE_CONDUCT_SKILL } from "./first-mate-conduct-skill"
import { FIRST_MATE_OPERATE_SKILL } from "./first-mate-operate-skill"
import { FIRST_MATE_SETUP_SKILL } from "~/lib/injected-skills/first-mate-setup-skill"
import { FIRST_MATE_SKILL } from "./first-mate-skill"
import { FLOOR_KEEPER_SKILL } from "./floor-keeper-skill"
import { ORCHESTRATE_SKILL } from "./orchestrate-skill"
import { RESEARCH_SKILL } from "./research-skill"
import { WORKER_SKILL } from "./worker-skill"

export { ARTIFACT_REVIEW_SKILL } from "./artifact-review-skill"
export { FIRST_MATE_CONDUCT_SKILL } from "./first-mate-conduct-skill"
export { FIRST_MATE_OPERATE_SKILL } from "./first-mate-operate-skill"
export { FIRST_MATE_SETUP_SKILL } from "~/lib/injected-skills/first-mate-setup-skill"
export { FIRST_MATE_SKILL } from "./first-mate-skill"
export { writeInjectedSkill, type WriteInjectedSkillResult } from "./write"

/** A skill to materialize: `name` is BOTH the frontmatter `name` and the folder
 *  name (the loader enforces folder == name); `md` is the full `SKILL.md`. */
export interface InjectedSkill {
  name: string
  md: string
}

export interface InjectedSkillSelection {
  profileId: "standard" | "fast" | "max"
  workerSkillsActive: boolean
  firstMateEnabled: boolean
}

/** All injected skills, in dependency order (research underpins the others). */
export const INJECTED_SKILLS: ReadonlyArray<InjectedSkill> = [
  RESEARCH_SKILL,
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
  if (selection.profileId === "fast") return []
  if (selection.profileId === "max") {
    return selection.firstMateEnabled
      ? INJECTED_SKILLS.filter((skill) => skill.name.startsWith("gh-first-mate"))
      : []
  }
  if (!selection.workerSkillsActive) return []
  return INJECTED_SKILLS.filter(
    (skill) => selection.firstMateEnabled || !skill.name.startsWith("gh-first-mate"),
  )
}
