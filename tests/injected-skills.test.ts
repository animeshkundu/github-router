import { describe, expect, test } from "bun:test"

import { ARTIFACT_REVIEW_SKILL, buildArtifactReviewSkill, buildGatherContextSkill, buildOrchestrateSkill, buildResearchSkill, FIRST_MATE_CONDUCT_SKILL, FIRST_MATE_OPERATE_SKILL, FIRST_MATE_SETUP_SKILL, FIRST_MATE_SKILL, getInjectedSkills, getPipelineSkills, INJECTED_SKILLS, injectedSkillsForLaunch, SWE_PIPELINE_SKILL, writeInjectedSkill } from "../src/lib/injected-skills"
import { CONDENSED_OPERATING_SEQUENCE, DEFINITION_OF_GREATNESS } from "../src/lib/first-mate/operating-protocol"

function frontmatterFor(md: string): string {
  const lines = md.split(/\r?\n/)
  expect(lines[0]).toBe("---")
  const end = lines.findIndex((line, index) => index > 0 && line === "---")
  expect(end).toBeGreaterThan(0)
  return lines.slice(1, end).join("\n")
}

function descriptionFor(md: string): string {
  const frontmatter = frontmatterFor(md)
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]
  expect(description).toBeDefined()
  return description ?? ""
}

describe("INJECTED_SKILLS", () => {
  test("contains the injected skills with non-empty names and markdown", () => {
    expect(INJECTED_SKILLS.length).toBe(11)
    expect(INJECTED_SKILLS.some((s) => s.name === "gh-worker")).toBe(true)
    expect(INJECTED_SKILLS.some((s) => s.name === "gh-gather-context")).toBe(true)
    expect(INJECTED_SKILLS.some((s) => s.name === "gh-plan")).toBe(true)
    expect(INJECTED_SKILLS.some((s) => s.name === "gh-implement")).toBe(true)
    expect(INJECTED_SKILLS.some((s) => s.name === "gh-first-mate-scaffold")).toBe(true)
    expect(INJECTED_SKILLS.some((s) => s.name === "gh-first-mate-operate")).toBe(true)
    expect(INJECTED_SKILLS.some((s) => s.name === "gh-first-mate-conduct")).toBe(true)
    for (const skill of INJECTED_SKILLS) {
      expect(skill.name.length).toBeGreaterThan(0)
      expect(skill.md.length).toBeGreaterThan(0)
    }
  })

  test("each skill frontmatter name exactly matches the registry name and includes a description", () => {
    for (const skill of INJECTED_SKILLS) {
      const frontmatter = frontmatterFor(skill.md)
      const lines = frontmatter.split(/\r?\n/)
      expect(lines).toContain(`name: ${skill.name}`)
      expect(lines.some((line) => /^description:\s*\S/.test(line))).toBe(true)
    }
  })

  test("each injected skill description stays concise, third-person, and triggerable", () => {
    for (const skill of [...INJECTED_SKILLS, ARTIFACT_REVIEW_SKILL]) {
      const description = descriptionFor(skill.md)
      expect(description.length).toBeLessThanOrEqual(1024)
      expect(description).not.toMatch(/^(?:I|You)\s/)
      expect(description).toMatch(/use when|use whenever|when the user|before/i)
    }
  })

  test("selects router-owned skills only for standard launches", () => {
    const standard = injectedSkillsForLaunch({
      profileId: "standard",
      workerSkillsActive: true,
      firstMateEnabled: false,
    })
    expect(standard.map((skill) => skill.name)).toEqual([
      "gh-research",
      "gh-gather-context",
      "gh-plan",
      "gh-implement",
      "gh-orchestrate",
      "gh-floor-keeper",
      "gh-worker",
    ])

    const standardWithFirstMate = injectedSkillsForLaunch({
      profileId: "standard",
      workerSkillsActive: true,
      firstMateEnabled: true,
      searchEnabled: true,
    })
    expect(standardWithFirstMate).toEqual(INJECTED_SKILLS)

    // Pinned profiles get the pipeline skills only with --swe (all 200K
    // default), including the /gh-swe-pipeline orchestrator. Without --swe
    // they get nothing (first-mate only on max when enabled).
    expect(injectedSkillsForLaunch({
      profileId: "fast",
      workerSkillsActive: true,
      firstMateEnabled: true,
      sweEnabled: true,
    }).map((skill) => skill.name)).toEqual([
      "gh-gather-context",
      "gh-plan",
      "gh-implement",
      "gh-swe-pipeline",
    ])

    for (const profileId of ["cheap", "cheap1m", "cheapest", "balanced"] as const) {
      expect(injectedSkillsForLaunch({
        profileId,
        workerSkillsActive: false,
        firstMateEnabled: false,
        sweEnabled: true,
      }).map((skill) => skill.name)).toEqual([
        "gh-gather-context",
        "gh-plan",
        "gh-implement",
        "gh-swe-pipeline",
      ])
    }

    // --swe absent (or explicitly false): no pipeline slash commands.
    for (const profileId of ["fast", "cheap", "cheap1m", "cheapest", "balanced"] as const) {
      expect(injectedSkillsForLaunch({
        profileId,
        workerSkillsActive: false,
        firstMateEnabled: false,
      })).toEqual([])
      expect(injectedSkillsForLaunch({
        profileId,
        workerSkillsActive: false,
        firstMateEnabled: false,
        sweEnabled: false,
      })).toEqual([])
    }

    const max = injectedSkillsForLaunch({
      profileId: "max",
      workerSkillsActive: true,
      firstMateEnabled: true,
      sweEnabled: true,
    })
    expect(max.map((skill) => skill.name)).toEqual([
      "gh-gather-context",
      "gh-plan",
      "gh-implement",
      "gh-swe-pipeline",
      "gh-first-mate",
      "gh-first-mate-scaffold",
      "gh-first-mate-operate",
      "gh-first-mate-conduct",
    ])
    expect(max.map((skill) => skill.name)).not.toEqual(expect.arrayContaining([
      "gh-research",
      "gh-orchestrate",
      "gh-floor-keeper",
      "gh-worker",
    ]))
    expect(injectedSkillsForLaunch({
      profileId: "max",
      workerSkillsActive: true,
      firstMateEnabled: false,
      sweEnabled: true,
    }).map((skill) => skill.name)).toEqual([
      "gh-gather-context",
      "gh-plan",
      "gh-implement",
      "gh-swe-pipeline",
    ])
    // Max without --swe keeps first-mate skills but drops the pipeline.
    expect(injectedSkillsForLaunch({
      profileId: "max",
      workerSkillsActive: true,
      firstMateEnabled: true,
    }).map((skill) => skill.name)).toEqual([
      "gh-first-mate",
      "gh-first-mate-scaffold",
      "gh-first-mate-operate",
      "gh-first-mate-conduct",
    ])
    expect(injectedSkillsForLaunch({
      profileId: "max",
      workerSkillsActive: true,
      firstMateEnabled: false,
    })).toEqual([])

    expect(injectedSkillsForLaunch({
      profileId: "standard",
      workerSkillsActive: false,
      firstMateEnabled: true,
    })).toEqual([])
  })
})

describe("gh-swe-pipeline orchestrator (--swe only, separate command)", () => {
  test("frontmatter name matches the registry name and the description is triggerable", () => {
    expect(SWE_PIPELINE_SKILL.name).toBe("gh-swe-pipeline")
    expect(SWE_PIPELINE_SKILL.md.startsWith(`---\nname: ${SWE_PIPELINE_SKILL.name}\n`)).toBe(true)
    const description = descriptionFor(SWE_PIPELINE_SKILL.md)
    expect(description.length).toBeLessThanOrEqual(1024)
    expect(description).not.toMatch(/^(?:I|You)\s/)
    expect(description).toMatch(/use when|use whenever|when the user|before/i)
  })

  test("enforces the strict waterfall: no overlapping stages, supersede-then-advance", () => {
    expect(SWE_PIPELINE_SKILL.md).toContain("WATERFALL ONLY")
    expect(SWE_PIPELINE_SKILL.md).toContain(".complete")
    expect(SWE_PIPELINE_SKILL.md).toMatch(/explicit approval/i)
    expect(SWE_PIPELINE_SKILL.md).toMatch(/superseded/i)
    expect(SWE_PIPELINE_SKILL.md).toMatch(/never worker-\* MCP dispatchers/i)
  })
})

describe("first-mate skills", () => {
  test("codifies foundation-first, scoped work, and best-model merge discipline", () => {
    expect(FIRST_MATE_SKILL.md).toContain("Foundation-first mandate")
    expect(FIRST_MATE_SKILL.md).toContain("Before the first build wave")
    expect(FIRST_MATE_SKILL.md).toContain("Well-scoped, testable work items succeed")
    expect(FIRST_MATE_SKILL.md).toContain("never cheap out on plan/judge/merge")
    expect(FIRST_MATE_SKILL.md).toContain("dependsOn` entries are 0-based indices")
    expect(FIRST_MATE_SKILL.md).toContain("Direct `mcp__workers__*` / `mcp__orchestrate__*` calls are subagent-only")
    expect(FIRST_MATE_SKILL.md).toContain("Local tools (Edit/Write/Bash")
  })

  test("casts the local operator as the CEO who drives verified work out of the cloud-agent team", () => {
    expect(FIRST_MATE_SKILL.md).toContain("You are the CEO")
    expect(FIRST_MATE_SKILL.md).toContain("/gh-first-mate-operate")
    expect(FIRST_MATE_OPERATE_SKILL.md).toContain("You are the CEO")
    expect(FIRST_MATE_OPERATE_SKILL.md).toContain("Drive the team")
    // The team is the cloud agents; the CEO does not write the product code.
    expect(FIRST_MATE_OPERATE_SKILL.md).toContain("do not write the product code")
  })

  test("scaffold skill documents geared foundation, enhance mode, and no factory files", () => {
    expect(FIRST_MATE_SETUP_SKILL.md).toContain("repo-geared foundation")
    expect(FIRST_MATE_SETUP_SKILL.md).toContain("mode: \"enhance\"")
    expect(FIRST_MATE_SETUP_SKILL.md).toContain("does not seed factory-protocol")
    expect(FIRST_MATE_SETUP_SKILL.md).toContain("detection_overrides")
  })

  test("operate skill is the operator CEO/CTO/CPO protocol and shares the SSOT operating sequence", () => {
    expect(FIRST_MATE_OPERATE_SKILL.name).toBe("gh-first-mate-operate")
    expect(FIRST_MATE_OPERATE_SKILL.md).toContain("CEO + CTO + CPO")
    expect(FIRST_MATE_OPERATE_SKILL.md).toContain("externally verifiable")
    // Single source of truth: the operator skill embeds the SAME condensed sequence
    // the scaffolded playbook (buildPlaybook) emits, so the two surfaces can't drift.
    expect(FIRST_MATE_OPERATE_SKILL.md).toContain(CONDENSED_OPERATING_SEQUENCE)
    // And the greatness bar, shared with the conductor + scaffold.
    expect(FIRST_MATE_OPERATE_SKILL.md).toContain(DEFINITION_OF_GREATNESS)
  })

  test("conduct skill is the fleet conductor, owns the heartbeat, and shares the SSOT greatness bar", () => {
    expect(FIRST_MATE_CONDUCT_SKILL.name).toBe("gh-first-mate-conduct")
    expect(FIRST_MATE_CONDUCT_SKILL.md).toContain("fleet conductor")
    expect(FIRST_MATE_CONDUCT_SKILL.md).toContain("[fm-heartbeat]") // the single shared heartbeat marker
    // Re-hydrates each fresh per-repo CEO from the durable strategy store.
    expect(FIRST_MATE_CONDUCT_SKILL.md).toContain("mcp__first-mate__read_strategy")
    expect(FIRST_MATE_CONDUCT_SKILL.md).toContain("mcp__first-mate__write_strategy")
    // SSOT: the greatness bar is embedded from operating-protocol, shared across surfaces.
    expect(FIRST_MATE_CONDUCT_SKILL.md).toContain(DEFINITION_OF_GREATNESS)
  })
})

describe("ARTIFACT_REVIEW_SKILL (tab-gated, not in INJECTED_SKILLS)", () => {
  test("has matching kebab name + description and references only real artifact tools", () => {
    expect(ARTIFACT_REVIEW_SKILL.name).toBe("gh-artifact-review")
    expect(INJECTED_SKILLS.some((s) => s.name === ARTIFACT_REVIEW_SKILL.name)).toBe(false)
    const lines = frontmatterFor(ARTIFACT_REVIEW_SKILL.md).split(/\r?\n/)
    expect(lines).toContain(`name: ${ARTIFACT_REVIEW_SKILL.name}`)
    expect(lines.some((line) => /^description:\s*\S/.test(line))).toBe(true)
    const tokens = ARTIFACT_REVIEW_SKILL.md.match(/mcp__peers__artifact_[a-z]+/g) ?? []
    for (const t of tokens) {
      expect([
        "mcp__peers__artifact_open",
        "mcp__peers__artifact_update",
        "mcp__peers__artifact_refresh",
        "mcp__peers__artifact_await",
        "mcp__peers__artifact_dismiss",
        "mcp__peers__artifact_reply",
        "mcp__peers__artifact_end",
        "mcp__peers__artifact_poll",
      ]).toContain(t)
    }
  })

  test("buildArtifactReviewSkill uses custom peersKey correctly", () => {
    const custom = buildArtifactReviewSkill("gh-router-peers-2")
    expect(custom.name).toBe("gh-artifact-review")
    expect(custom.md).toContain("mcp__gh-router-peers-2__artifact_open")
    expect(custom.md).toContain("mcp__gh-router-peers-2__artifact_await")
    expect(custom.md).not.toContain("mcp__peers__artifact_")
  })
})

describe("writeInjectedSkill", () => {
  test("rejects names that are not lowercase kebab path segments before writing", async () => {
    expect(await writeInjectedSkill("Invalid Name", "x")).toEqual({ written: false })
    expect(await writeInjectedSkill("bad/name", "x")).toEqual({ written: false })
  })
})

describe("search-gated skill text (--search)", () => {
  test("research skill is semantic-first when enabled, lexical-only when disabled", () => {
    const on = buildResearchSkill(true)
    expect(on.name).toBe("gh-research")
    expect(on.md).toContain("Use mcp__search__code semantically first to find concepts and likely files.")
    expect(on.md).toContain("Then use mcp__search__code lexically for exact symbols")
    const off = buildResearchSkill(false)
    expect(off.name).toBe("gh-research")
    expect(off.md).toContain("Use mcp__search__code lexically for exact symbols, filenames, errors, routes, flags, and config keys.")
    expect(off.md).not.toContain("semantically")
    expect(off.md).not.toContain("semantic-to-lexical")
  })

  test("gather-context skill is semantic-first when enabled, lexical-only when disabled", () => {
    const on = buildGatherContextSkill(true)
    expect(on.md).toContain("Run semantic search first for concepts, then lexical for symbols")
    expect(on.md).toContain("Maximum searches per round: 10.")
    const off = buildGatherContextSkill(false)
    expect(off.md).toContain("Run lexical search first, in parallel, in a single turn.")
    expect(off.md).toContain("Maximum lexical searches per round: 10.")
    expect(off.md).not.toMatch(/semantically|semantic search first/i)
  })

  test("orchestrate skill names semantic follow-ups only when enabled", () => {
    const on = buildOrchestrateSkill(true)
    expect(on.md).toContain("semantic for concepts, lexical for exact symbols")
    const off = buildOrchestrateSkill(false)
    expect(off.md).toContain("mcp__search__code for focused follow-ups")
    expect(off.md).not.toContain("semantic")
  })

  test("getInjectedSkills/getPipelineSkills match the launch flag", () => {
    expect(getInjectedSkills(true).length).toBe(11)
    expect(getInjectedSkills(false).length).toBe(11)
    expect(getPipelineSkills(true).map((s) => s.name)).toEqual([
      "gh-gather-context",
      "gh-plan",
      "gh-implement",
      "gh-swe-pipeline",
    ])
    const onResearch = getInjectedSkills(true).find((s) => s.name === "gh-research")!
    const offResearch = getInjectedSkills(false).find((s) => s.name === "gh-research")!
    expect(onResearch.md).toContain("semantically first")
    expect(offResearch.md).not.toContain("semantically")
  })

  test("cheapest/balanced pipeline skills plan lead-direct with no Plan dispatch", () => {
    for (const profileId of ["cheapest", "balanced"] as const) {
      const skills = injectedSkillsForLaunch({
        profileId,
        workerSkillsActive: false,
        firstMateEnabled: false,
        sweEnabled: true,
      })
      const plan = skills.find((s) => s.name === "gh-plan")!
      expect(plan.md).not.toContain("subagent_type Plan")
      expect(plan.md).toContain("the lead plans directly")
      const implement = skills.find((s) => s.name === "gh-implement")!
      expect(implement.md).not.toContain("Plan dispatches")
      const pipeline = skills.find((s) => s.name === "gh-swe-pipeline")!
      expect(pipeline.md).not.toContain("Plan subagents")
      expect(pipeline.md).not.toContain("native Plan subagent")
    }
    // Cheapest reviews the final plan with the Advisor; balanced has no
    // Advisor surface, so it must not name one.
    const cheapestPlan = injectedSkillsForLaunch({
      profileId: "cheapest",
      workerSkillsActive: false,
      firstMateEnabled: false,
      sweEnabled: true,
    }).find((s) => s.name === "gh-plan")!
    expect(cheapestPlan.md).toContain("Review the final plan with the Advisor")
    const balancedPlan = injectedSkillsForLaunch({
      profileId: "balanced",
      workerSkillsActive: false,
      firstMateEnabled: false,
      sweEnabled: true,
    }).find((s) => s.name === "gh-plan")!
    expect(balancedPlan.md).not.toContain("`advisor`")
    expect(balancedPlan.md).not.toContain("Review the final plan")
    // Fast keeps the native Plan dispatch.
    const fastPlan = injectedSkillsForLaunch({
      profileId: "fast",
      workerSkillsActive: false,
      firstMateEnabled: false,
      sweEnabled: true,
    }).find((s) => s.name === "gh-plan")!
    expect(fastPlan.md).toContain("subagent_type Plan")
  })

  test("injectedSkillsForLaunch preserves all four backend combinations", () => {
    const on = injectedSkillsForLaunch({
      profileId: "standard",
      workerSkillsActive: true,
      firstMateEnabled: false,
      searchEnabled: true,
    })
    const off = injectedSkillsForLaunch({
      profileId: "standard",
      workerSkillsActive: true,
      firstMateEnabled: false,
      searchEnabled: false,
    })
    expect(on.map((s) => s.name)).toEqual(off.map((s) => s.name))
    const localResearch = on.find((s) => s.name === "gh-research")!.md
    expect(localResearch).toContain("semantically first")
    expect(localResearch).toContain("local ColBERT")
    expect(localResearch).not.toContain("Bluebird")
    expect(off.find((s) => s.name === "gh-research")!.md).not.toContain("semantically")
    // Absent flag defaults to lexical-only.
    const absent = injectedSkillsForLaunch({
      profileId: "standard",
      workerSkillsActive: true,
      firstMateEnabled: false,
    })
    expect(absent.find((s) => s.name === "gh-research")!.md).not.toContain("semantically")

    const bluebirdOnly = injectedSkillsForLaunch({
      profileId: "standard",
      workerSkillsActive: true,
      firstMateEnabled: false,
      searchEnabled: false,
      bluebirdEnabled: true,
    })
    const bluebirdResearch = bluebirdOnly.find((s) => s.name === "gh-research")!.md
    expect(bluebirdResearch).toContain("semantically first")
    expect(bluebirdResearch).toContain("Bluebird")
    expect(bluebirdResearch).not.toContain("local ColBERT")

    const both = injectedSkillsForLaunch({
      profileId: "standard",
      workerSkillsActive: true,
      firstMateEnabled: false,
      searchEnabled: true,
      bluebirdEnabled: true,
    })
    const bothResearch = both.find((s) => s.name === "gh-research")!.md
    expect(bothResearch).toContain("Bluebird")
    expect(bothResearch).not.toContain("local ColBERT")
  })
})
