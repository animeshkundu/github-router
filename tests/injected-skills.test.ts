import { describe, expect, test } from "bun:test"

import { ARTIFACT_REVIEW_SKILL, FIRST_MATE_SETUP_SKILL, FIRST_MATE_SKILL, INJECTED_SKILLS, writeInjectedSkill } from "../src/lib/injected-skills"

function frontmatterFor(md: string): string {
  const lines = md.split(/\r?\n/)
  expect(lines[0]).toBe("---")
  const end = lines.findIndex((line, index) => index > 0 && line === "---")
  expect(end).toBeGreaterThan(0)
  return lines.slice(1, end).join("\n")
}

describe("INJECTED_SKILLS", () => {
  test("contains the injected skills with non-empty names and markdown", () => {
    expect(INJECTED_SKILLS.length).toBe(6)
    expect(INJECTED_SKILLS.some((s) => s.name === "gh-worker")).toBe(true)
    expect(INJECTED_SKILLS.some((s) => s.name === "gh-first-mate-scaffold")).toBe(true)
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

  test("scaffold skill documents geared foundation, enhance mode, and no factory files", () => {
    expect(FIRST_MATE_SETUP_SKILL.md).toContain("world-class repo-geared")
    expect(FIRST_MATE_SETUP_SKILL.md).toContain("mode: \"enhance\"")
    expect(FIRST_MATE_SETUP_SKILL.md).toContain("does not seed factory-protocol")
    expect(FIRST_MATE_SETUP_SKILL.md).toContain("detection_overrides")
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
})

describe("writeInjectedSkill", () => {
  test("rejects names that are not lowercase kebab path segments before writing", async () => {
    expect(await writeInjectedSkill("Invalid Name", "x")).toEqual({ written: false })
    expect(await writeInjectedSkill("bad/name", "x")).toEqual({ written: false })
  })
})
