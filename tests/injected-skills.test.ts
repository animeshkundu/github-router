import { describe, expect, test } from "bun:test"

import { ARTIFACT_REVIEW_SKILL, INJECTED_SKILLS, writeInjectedSkill } from "../src/lib/injected-skills"

function frontmatterFor(md: string): string {
  const lines = md.split(/\r?\n/)
  expect(lines[0]).toBe("---")
  const end = lines.findIndex((line, index) => index > 0 && line === "---")
  expect(end).toBeGreaterThan(0)
  return lines.slice(1, end).join("\n")
}

describe("INJECTED_SKILLS", () => {
  test("contains the three injected skills with non-empty names and markdown", () => {
    expect(INJECTED_SKILLS.length).toBe(3)
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

describe("ARTIFACT_REVIEW_SKILL (tab-gated, not in INJECTED_SKILLS)", () => {
  test("has matching kebab name + description and references only real artifact tools", () => {
    expect(ARTIFACT_REVIEW_SKILL.name).toBe("gh-artifact-review")
    expect(INJECTED_SKILLS.some((s) => s.name === ARTIFACT_REVIEW_SKILL.name)).toBe(false)
    const lines = frontmatterFor(ARTIFACT_REVIEW_SKILL.md).split(/\r?\n/)
    expect(lines).toContain(`name: ${ARTIFACT_REVIEW_SKILL.name}`)
    expect(lines.some((line) => /^description:\s*\S/.test(line))).toBe(true)
    const tokens = ARTIFACT_REVIEW_SKILL.md.match(/mcp__peers__artifact_[a-z]+/g) ?? []
    for (const t of tokens) {
      expect(["mcp__peers__artifact_open", "mcp__peers__artifact_poll", "mcp__peers__artifact_reply", "mcp__peers__artifact_end"]).toContain(t)
    }
  })
})

describe("writeInjectedSkill", () => {
  test("rejects names that are not lowercase kebab path segments before writing", async () => {
    expect(await writeInjectedSkill("Invalid Name", "x")).toEqual({ written: false })
    expect(await writeInjectedSkill("bad/name", "x")).toEqual({ written: false })
  })
})
