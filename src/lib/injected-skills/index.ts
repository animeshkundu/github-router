/**
 * Injected-skill registry: the floor-raising / controller skills the `claude`
 * launcher materializes into the per-launch `CLAUDE_CONFIG_DIR` mirror so the
 * spawned Claude Code session discovers them (`/gh-research`,
 * `/gh-orchestrate`, `/gh-floor-keeper`, `/gh-first-mate`). See
 * `docs/floor-raising-agent-surface.md`.
 */

import { FIRST_MATE_SKILL } from "./first-mate-skill"
import { FLOOR_KEEPER_SKILL } from "./floor-keeper-skill"
import { ORCHESTRATE_SKILL } from "./orchestrate-skill"
import { RESEARCH_SKILL } from "./research-skill"

export { ARTIFACT_REVIEW_SKILL } from "./artifact-review-skill"
export { writeInjectedSkill, type WriteInjectedSkillResult } from "./write"

/** A skill to materialize: `name` is BOTH the frontmatter `name` and the folder
 *  name (the loader enforces folder == name); `md` is the full `SKILL.md`. */
export interface InjectedSkill {
  name: string
  md: string
}

/** All injected skills, in dependency order (research underpins the others). */
export const INJECTED_SKILLS: ReadonlyArray<InjectedSkill> = [
  RESEARCH_SKILL,
  ORCHESTRATE_SKILL,
  FLOOR_KEEPER_SKILL,
  FIRST_MATE_SKILL,
]
