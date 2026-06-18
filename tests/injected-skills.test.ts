import { describe, expect, test } from "bun:test"

import { INJECTED_SKILLS, writeInjectedSkill } from "../src/lib/injected-skills"

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

describe("writeInjectedSkill", () => {
  test("rejects names that are not lowercase kebab path segments before writing", async () => {
    expect(await writeInjectedSkill("Invalid Name", "x")).toEqual({ written: false })
    expect(await writeInjectedSkill("bad/name", "x")).toEqual({ written: false })
  })
})
