import { describe, expect, test } from "bun:test"

import { INJECTED_SKILLS } from "../src/lib/injected-skills"

const REAL_MCP_TOOLS = new Set([
  "mcp__search__code",
  "mcp__search__web",
  "mcp__workers__explore",
  "mcp__workers__plan",
  "mcp__workers__implement",
  "mcp__workers__test",
  "mcp__workers__review",
  "mcp__peers__codex_critic",
  "mcp__peers__codex_reviewer",
  "mcp__peers__gemini_critic",
  "mcp__peers__gemini_reviewer",
  "mcp__peers__opus_critic",
  "mcp__orchestrate__decompose",
  "mcp__orchestrate__verify_workflow",
  "mcp__orchestrate__run_workflow",
  "mcp__orchestrate__attest_step",
])

describe("injected skills MCP tool drift guard", () => {
  test("every referenced mcp__<group>__<tool> token is a real allowlisted tool", () => {
    const offenders: string[] = []

    for (const skill of INJECTED_SKILLS) {
      const tokens = skill.md.match(/mcp__[a-z]+__[a-z_]+/g) ?? []
      for (const token of tokens) {
        if (!REAL_MCP_TOOLS.has(token)) offenders.push(`${skill.name}: ${token}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
