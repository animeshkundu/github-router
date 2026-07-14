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
  "mcp__first-mate__start_mission",
  "mcp__first-mate__advance",
  "mcp__first-mate__board",
  "mcp__first-mate__mission_status",
  "mcp__first-mate__abandon_mission",
  "mcp__first-mate__add_units",
  "mcp__first-mate__scaffold_repo",
  "mcp__first-mate__read_strategy",
  "mcp__first-mate__write_strategy",
  // browser group (registered under --browse); referenced by the greatness definition (Pillar D)
  "mcp__browser__list_tabs",
  "mcp__browser__open_tab",
  "mcp__browser__close_tab",
  "mcp__browser__navigate",
  "mcp__browser__read_page",
  "mcp__browser__scroll",
  "mcp__browser__screenshot",
  "mcp__browser__keyboard",
  "mcp__browser__wait",
  "mcp__browser__eval_js",
  "mcp__browser__download",
  "mcp__browser__mouse",
  "mcp__browser__drag",
  "mcp__browser__type",
  "mcp__browser__diagnostics",
  "mcp__browser__find",
  "mcp__browser__act",
  "mcp__browser__observe",
  "mcp__browser__extract",
])

describe("injected skills MCP tool drift guard", () => {
  test("every referenced mcp__<group>__<tool> token is a real allowlisted tool", () => {
    const offenders: string[] = []

    for (const skill of INJECTED_SKILLS) {
      const tokens = skill.md.match(/mcp__[a-z-]+__[a-z_]+/g) ?? []
      for (const token of tokens) {
        if (!REAL_MCP_TOOLS.has(token)) offenders.push(`${skill.name}: ${token}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
