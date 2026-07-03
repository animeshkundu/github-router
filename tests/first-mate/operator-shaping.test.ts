import { describe, expect, test } from "bun:test"

import {
  OPERATOR_DENIED_TOOLS,
  OPERATOR_KEPT_TOOLS,
  OPERATOR_MODE_BANNER,
  operatorPreToolUse,
  shouldDenyOperatorTool,
} from "~/lib/first-mate/operator-shaping"

describe("capability shaping — config assertions", () => {
  test("the deny list is exactly the file-authoring tools", () => {
    expect([...OPERATOR_DENIED_TOOLS].sort()).toEqual(["Edit", "NotebookEdit", "Write"])
  })

  test("delegation + read-only tools are preserved", () => {
    expect(OPERATOR_KEPT_TOOLS).toContain("Agent")
    expect(OPERATOR_KEPT_TOOLS).toContain("Bash") // read-only gh
    expect(OPERATOR_KEPT_TOOLS.some((t) => t.startsWith("mcp__first-mate__"))).toBe(true)
  })

  test("in operator mode: file-authoring + local workers are denied", () => {
    expect(shouldDenyOperatorTool("Edit", true)).toBe(true)
    expect(shouldDenyOperatorTool("Write", true)).toBe(true)
    expect(shouldDenyOperatorTool("NotebookEdit", true)).toBe(true)
    expect(shouldDenyOperatorTool("mcp__workers__implement", true)).toBe(true)
    expect(shouldDenyOperatorTool("mcp__workers__review", true)).toBe(true)
  })

  test("in operator mode: delegation + read-only remain allowed", () => {
    expect(shouldDenyOperatorTool("Agent", true)).toBe(false)
    expect(shouldDenyOperatorTool("Bash", true)).toBe(false)
    expect(shouldDenyOperatorTool("Read", true)).toBe(false)
    expect(shouldDenyOperatorTool("mcp__first-mate__advance", true)).toBe(false)
  })

  test("NON-operator sessions are entirely unaffected", () => {
    expect(shouldDenyOperatorTool("Edit", false)).toBe(false)
    expect(shouldDenyOperatorTool("mcp__workers__implement", false)).toBe(false)
  })

  test("PreToolUse decision blocks with an actionable reason", () => {
    const d = operatorPreToolUse("Write", true)
    expect(d.block).toBe(true)
    expect(d.reason).toContain("cloud-agent operator mode")
    expect(operatorPreToolUse("Bash", true).block).toBe(false)
  })

  test("the mode banner names the boundary", () => {
    expect(OPERATOR_MODE_BANNER).toContain("cloud-agent operator")
    expect(OPERATOR_MODE_BANNER).toContain("do NOT hand-code")
  })
})
