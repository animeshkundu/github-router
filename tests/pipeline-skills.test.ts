import { describe, expect, test } from "bun:test"

import {
  GATHER_CONTEXT_SKILL,
  IMPLEMENT_SKILL,
  PIPELINE_SKILLS,
  PLAN_SKILL,
} from "../src/lib/injected-skills"
import {
  isPipelineSkillProfile,
  PIPELINE_SKILL_PROFILES,
  SKILL_BOUNDS,
  SKILL_LUNA_MODEL_ID,
  SKILL_MODELS,
  SKILL_SOL_MODEL_ID,
} from "../src/lib/skill-model-contract"
import {
  resolveModelAlias,
  SKILL_GATHER_CONTEXT_EXPLORE_ALIAS_ID,
  SKILL_GATHER_CONTEXT_LEAD_ALIAS_ID,
  SKILL_IMPLEMENT_LEAD_ALIAS_ID,
  SKILL_IMPLEMENT_TASK_ALIAS_ID,
  SKILL_PLAN_LEAD_ALIAS_ID,
  SKILL_REVIEW_PASS1_ALIAS_ID,
  SKILL_REVIEW_PASS2_ALIAS_ID,
} from "../src/lib/launch-profile"
import { PIPELINE_SKILLS_AWARENESS } from "../src/lib/claude-md-injection"
import { SKILL_WORKER_CONFIGS } from "../src/lib/worker-dispatch"

describe("pipeline skills registry", () => {
  test("exports three pipeline skills with matching frontmatter names", () => {
    expect(PIPELINE_SKILLS.map((s) => s.name)).toEqual([
      "gh-gather-context",
      "gh-plan",
      "gh-implement",
    ])
    for (const skill of [GATHER_CONTEXT_SKILL, PLAN_SKILL, IMPLEMENT_SKILL]) {
      expect(skill.md.startsWith(`---\nname: ${skill.name}\n`)).toBe(true)
    }
  })

  test("covers every pinned profile and excludes standard", () => {
    expect([...PIPELINE_SKILL_PROFILES].sort()).toEqual(
      ["balanced", "cheap", "cheap1m", "cheapest", "fast", "max"].sort() as Array<
        (typeof PIPELINE_SKILL_PROFILES)[number]
      >,
    )
    for (const profile of PIPELINE_SKILL_PROFILES) {
      expect(isPipelineSkillProfile(profile)).toBe(true)
    }
    expect(isPipelineSkillProfile("standard")).toBe(false)
  })
})

describe("skill model contract (all 200K default)", () => {
  test("pins Luna high for gather, Sol medium for plan, Luna max for implement", () => {
    expect(SKILL_MODELS.gatherContext.lead).toBe(SKILL_LUNA_MODEL_ID)
    expect(SKILL_MODELS.gatherContext.exploreAgent).toBe(SKILL_LUNA_MODEL_ID)
    expect(SKILL_MODELS.gatherContext.leadEffort).toBe("high")
    expect(SKILL_MODELS.plan.lead).toBe(SKILL_SOL_MODEL_ID)
    expect(SKILL_MODELS.plan.leadEffort).toBe("medium")
    expect(SKILL_MODELS.implement.lead).toBe(SKILL_LUNA_MODEL_ID)
    expect(SKILL_MODELS.implement.taskAgent).toBe(SKILL_LUNA_MODEL_ID)
    expect(SKILL_MODELS.implement.leadEffort).toBe("max")
    expect(SKILL_MODELS.review.pass1.model).toBe(SKILL_LUNA_MODEL_ID)
    expect(SKILL_MODELS.review.pass2.model).toBe(SKILL_SOL_MODEL_ID)
    // Bare slugs only: no 1M accounting bracket anywhere in the contract.
    for (const id of [SKILL_LUNA_MODEL_ID, SKILL_SOL_MODEL_ID]) {
      expect(id).not.toContain("[1m]")
    }
  })

  test("bounds gather workers and implement workers with counts only", () => {
    expect(SKILL_BOUNDS.gatherContext.maxRounds).toBe(3)
    expect(SKILL_BOUNDS.gatherContext.maxExploreAgentsPerRound).toBe(6)
    expect(SKILL_BOUNDS.implement.maxConcurrentAgents).toBe(8)
    expect(SKILL_BOUNDS.implement.maxRetriesPerTask).toBe(2)
    expect(SKILL_BOUNDS.implement.maxReviewFixCycles).toBe(2)
    expect(SKILL_BOUNDS.plan.maxTasks).toBe(20)
    // No output-token caps anywhere: worker tools have no output-token
    // parameter, so such caps would be unenforced. Wall-clock budgets live
    // in SKILL_WORKER_CONFIGS and are passed as the real maxWallClockMs arg.
    expect("exploreAgentMaxOutputTokens" in SKILL_BOUNDS.gatherContext).toBe(false)
    expect("taskAgentMaxOutputTokens" in SKILL_BOUNDS.implement).toBe(false)
    expect("maxContextTokens" in SKILL_BOUNDS.plan).toBe(false)
  })
})

describe("skill model aliases (200K bare, effort pinned)", () => {
  test("resolve to bare Luna/Sol ids with the right absent-effort defaults", () => {
    const cases: Array<[string, string, string]> = [
      [SKILL_GATHER_CONTEXT_LEAD_ALIAS_ID, SKILL_LUNA_MODEL_ID, "high"],
      [SKILL_GATHER_CONTEXT_EXPLORE_ALIAS_ID, SKILL_LUNA_MODEL_ID, "high"],
      [SKILL_PLAN_LEAD_ALIAS_ID, SKILL_SOL_MODEL_ID, "medium"],
      [SKILL_IMPLEMENT_LEAD_ALIAS_ID, SKILL_LUNA_MODEL_ID, "max"],
      [SKILL_IMPLEMENT_TASK_ALIAS_ID, SKILL_LUNA_MODEL_ID, "max"],
      [SKILL_REVIEW_PASS1_ALIAS_ID, SKILL_LUNA_MODEL_ID, "max"],
      [SKILL_REVIEW_PASS2_ALIAS_ID, SKILL_SOL_MODEL_ID, "medium"],
    ]
    for (const [alias, real, effort] of cases) {
      expect(resolveModelAlias(alias)?.realModel).toBe(real)
      expect(resolveModelAlias(alias)?.absentEffortDefault).toBe(
        effort as "high" | "medium" | "max",
      )
      expect(resolveModelAlias(`${alias}[1m]`)?.realModel).toBe(real)
      expect(alias).not.toContain("[1m]")
    }
  })
})

describe("skill worker configs (reuse existing dispatchers)", () => {
  test("map to guard-compatible dispatchers with worktree only for implement", () => {
    expect(SKILL_WORKER_CONFIGS["gather-context-explore"].dispatcher).toBe("explore")
    expect(SKILL_WORKER_CONFIGS["gather-context-explore"].worktree).toBe(false)
    expect(SKILL_WORKER_CONFIGS["implement-task"].dispatcher).toBe("implement")
    expect(SKILL_WORKER_CONFIGS["implement-task"].worktree).toBe(true)
    expect(SKILL_WORKER_CONFIGS["review-pass1"].dispatcher).toBe("review")
    expect(SKILL_WORKER_CONFIGS["review-pass2"].dispatcher).toBe("review")
    expect(SKILL_WORKER_CONFIGS["gather-context-explore"].timeoutMs).toBe(180_000)
    expect(SKILL_WORKER_CONFIGS["implement-task"].timeoutMs).toBe(600_000)
    expect(SKILL_WORKER_CONFIGS["review-pass1"].timeoutMs).toBe(300_000)
    expect(SKILL_WORKER_CONFIGS["review-pass2"].timeoutMs).toBe(300_000)
    for (const config of Object.values(SKILL_WORKER_CONFIGS)) {
      expect(config.modelAlias.startsWith("gh-router-skill-")).toBe(true)
      expect(config.timeoutMs).toBeGreaterThan(0)
      // No maxOutputTokens field: unenforceable (no such worker arg).
      expect("maxOutputTokens" in config).toBe(false)
    }
  })
})

describe("skill bodies wire timeouts via the real maxWallClockMs arg", () => {
  test("every worker dispatch names maxWallClockMs with the config value", () => {
    expect(GATHER_CONTEXT_SKILL.md).toContain("maxWallClockMs 180000")
    expect(GATHER_CONTEXT_SKILL.md).toContain("maxWallClockMs 300000")
    expect(PLAN_SKILL.md).toContain("maxWallClockMs 180000")
    expect(IMPLEMENT_SKILL.md).toContain("maxWallClockMs 600000")
    expect(IMPLEMENT_SKILL.md).toContain("maxWallClockMs 300000")
  })
})

describe("CLAUDE.md pipeline awareness", () => {
  test("names all three skills with when-to-use guidance", () => {
    expect(PIPELINE_SKILLS_AWARENESS).toContain("/gh-gather-context")
    expect(PIPELINE_SKILLS_AWARENESS).toContain("/gh-plan")
    expect(PIPELINE_SKILLS_AWARENESS).toContain("/gh-implement")
    expect(PIPELINE_SKILLS_AWARENESS).toContain("200K")
    expect(PIPELINE_SKILLS_AWARENESS).toMatch(/before planning/i)
    expect(PIPELINE_SKILLS_AWARENESS).toMatch(/approval/i)
  })
})
