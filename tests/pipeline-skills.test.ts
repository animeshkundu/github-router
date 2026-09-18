import { describe, expect, test } from "bun:test"

import {
  GATHER_CONTEXT_SKILL,
  IMPLEMENT_SKILL,
  PIPELINE_SKILLS,
  PLAN_SKILL,
  SWE_PIPELINE_SKILL,
} from "../src/lib/injected-skills"
import {
  isPipelineSkillProfile,
  PIPELINE_SKILL_NAMES,
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
  test("exports the three stages plus the swe-pipeline orchestrator with matching frontmatter names", () => {
    expect(PIPELINE_SKILLS.map((s) => s.name)).toEqual([
      "gh-gather-context",
      "gh-plan",
      "gh-implement",
      "gh-swe-pipeline",
    ])
    expect([...PIPELINE_SKILL_NAMES] as Array<string>).toEqual(PIPELINE_SKILLS.map((s) => s.name))
    for (const skill of [GATHER_CONTEXT_SKILL, PLAN_SKILL, IMPLEMENT_SKILL, SWE_PIPELINE_SKILL]) {
      expect(skill.md.startsWith(`---\nname: ${skill.name}\n`)).toBe(true)
    }
  })

  test("stages enforce the strict waterfall with completion markers and entry gates", () => {
    // Gather closes its stage with a marker no downstream stage may start without.
    expect(GATHER_CONTEXT_SKILL.md).toContain(".complete")
    expect(GATHER_CONTEXT_SKILL.md).toMatch(/no downstream stage.*may start until/i)
    // Plan refuses a marker-less brief and supersedes lingering gather dispatches first.
    expect(PLAN_SKILL.md).toContain("Stage gate 0")
    expect(PLAN_SKILL.md).toContain(".complete")
    expect(PLAN_SKILL.md).toMatch(/lingering/i)
    expect(PLAN_SKILL.md).toMatch(/superseded/i)
    expect(PLAN_SKILL.md).toMatch(/explicit user approval/i)
    // Implement refuses a plan without an approval record and supersedes plan dispatches first.
    expect(IMPLEMENT_SKILL.md).toContain("Stage gate 0")
    expect(IMPLEMENT_SKILL.md).toContain(".complete")
    expect(IMPLEMENT_SKILL.md).toMatch(/approval record/i)
    expect(IMPLEMENT_SKILL.md).toMatch(/superseded/i)
  })

  test("stages dispatch only native subagents, never worker-* MCP dispatchers", () => {
    const forbidden = ["worker-explore", "worker-implement", "worker-review", "worker-plan", "worker-test"]
    for (const skill of [GATHER_CONTEXT_SKILL, PLAN_SKILL, IMPLEMENT_SKILL, SWE_PIPELINE_SKILL]) {
      for (const name of forbidden) {
        expect(skill.md).not.toContain(name)
      }
      // Each stage carries the explicit natives-only guard clause.
      expect(skill.md).toMatch(/never worker-\* MCP dispatchers|ONLY native subagents/i)
    }
    // Gather fans out to Explore and verifies with reviewer.
    expect(GATHER_CONTEXT_SKILL.md).toContain('subagent_type Explore')
    expect(GATHER_CONTEXT_SKILL.md).toContain('subagent_type reviewer')
    // Plan dispatches the native Plan subagent for non-trivial work (which
    // self-serves Explore per its delegation graph); trivial asks exit planless.
    expect(PLAN_SKILL.md).toContain('subagent_type Plan')
    expect(PLAN_SKILL.md).toMatch(/trivial/i)
    expect(PLAN_SKILL.md).toMatch(/do not dispatch plan for a trivial ask/i)
    expect(PLAN_SKILL.md).toMatch(/implementation-ready brief/i)
    expect(PLAN_SKILL.md).toMatch(/file:line/i)
    // Implement runs General-Purpose (implementer first on max) and reviews with reviewer.
    expect(IMPLEMENT_SKILL.md).toContain('General-Purpose')
    expect(IMPLEMENT_SKILL.md).toContain('subagent_type reviewer')
    expect(IMPLEMENT_SKILL.md).toContain('implementer')
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

describe("skill bodies carry advisory budgets (Task tool has no maxWallClockMs)", () => {
  test("each stage states minute-scale budgets as self-discipline, not enforced args", () => {
    // Natives run under the Task tool, which accepts no wall-clock parameter:
    // no skill body may instruct passing maxWallClockMs with a value. Mentions
    // that explain the parameter's absence are fine.
    for (const skill of [GATHER_CONTEXT_SKILL, PLAN_SKILL, IMPLEMENT_SKILL, SWE_PIPELINE_SKILL]) {
      expect(skill.md).not.toMatch(/maxWallClockMs \d+/)
      expect(skill.md).not.toMatch(/pass maxWallClockMs/i)
    }
    // Advisory budgets survive as prose: ~3 min gather rounds, ~5 min Plan
    // dispatch and reviews, ~10 min implement tasks.
    expect(GATHER_CONTEXT_SKILL.md).toMatch(/~3 minutes/i)
    expect(PLAN_SKILL.md).toMatch(/~5 minutes/i)
    expect(IMPLEMENT_SKILL.md).toMatch(/~10 minutes/i)
    expect(IMPLEMENT_SKILL.md).toMatch(/~5 minutes/i)
    expect(SWE_PIPELINE_SKILL.md).toMatch(/advisory budgets/i)
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

  test("names the swe-pipeline orchestrator and forbids overlapping stages", () => {
    expect(PIPELINE_SKILLS_AWARENESS).toContain("/gh-swe-pipeline")
    expect(PIPELINE_SKILLS_AWARENESS).toMatch(/strict sequence/i)
    expect(PIPELINE_SKILLS_AWARENESS).toMatch(/never overlap/i)
  })
})
