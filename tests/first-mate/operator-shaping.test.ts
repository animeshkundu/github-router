import { describe, expect, test } from "bun:test"

import {
  CLOUD_AGENT_SCOPE_NOTE,
  OPERATOR_DENIED_MCP_PREFIXES,
  OPERATOR_DENIED_TOOLS,
  OPERATOR_KEPT_TOOLS,
  OPERATOR_MODE_BANNER,
  assertShapingInstalled,
  operatorPreToolUse,
  shouldDenyOperatorTool,
} from "~/lib/first-mate/operator-shaping"

describe("operator shaping — worker/orchestrate subagent-only boundary", () => {
  test("the exact-name deny list is empty", () => {
    expect([...OPERATOR_DENIED_TOOLS]).toEqual([])
  })

  test("the denied prefixes keep worker/orchestrate MCP tools subagent-only", () => {
    expect([...OPERATOR_DENIED_MCP_PREFIXES]).toEqual(["mcp__workers__", "mcp__orchestrate__"])
    expect(shouldDenyOperatorTool("mcp__workers__implement", true)).toBe(true)
    expect(shouldDenyOperatorTool("mcp__workers__review", true)).toBe(true)
    expect(shouldDenyOperatorTool("mcp__orchestrate__run_workflow", true)).toBe(true)
    expect(shouldDenyOperatorTool("mcp__orchestrate__decompose", true)).toBe(true)
  })

  test("non-operator sessions are unaffected", () => {
    expect(shouldDenyOperatorTool("mcp__workers__implement", false)).toBe(false)
    expect(operatorPreToolUse("mcp__orchestrate__run_workflow", false).block).toBe(false)
  })

  test("Bash and file-authoring tools are allowed in operator mode", () => {
    expect(operatorPreToolUse("Bash", true, {}).block).toBe(false)
    expect(operatorPreToolUse("Bash", true, {}).reason).toBeUndefined()
    expect(operatorPreToolUse("Write", true, {}).block).toBe(false)
    expect(operatorPreToolUse("Edit", true, {}).block).toBe(false)
    expect(operatorPreToolUse("NotebookEdit", true, {}).block).toBe(false)
    expect(operatorPreToolUse("Read", true, {}).block).toBe(false)
    expect(operatorPreToolUse("mcp__first-mate__advance", true, {}).block).toBe(false)
  })

  test("worker/orchestrate blocks carry an actionable reason", () => {
    const workerDecision = operatorPreToolUse("mcp__workers__implement", true)
    expect(workerDecision.block).toBe(true)
    expect(workerDecision.reason).toContain("subagent-only")
    expect(workerDecision.reason).toContain("worker-*")

    const orchestrateDecision = operatorPreToolUse("mcp__orchestrate__run_workflow", true)
    expect(orchestrateDecision.block).toBe(true)
    expect(orchestrateDecision.reason).toContain("local worker/orchestrate MCP tools")
  })

  test("kept-tools documentation includes local escape hatches", () => {
    expect(OPERATOR_KEPT_TOOLS).toContain("Agent")
    expect(OPERATOR_KEPT_TOOLS).toContain("Edit")
    expect(OPERATOR_KEPT_TOOLS).toContain("Write")
    expect(OPERATOR_KEPT_TOOLS).toContain("NotebookEdit")
    expect(OPERATOR_KEPT_TOOLS).toContain("Bash")
    expect(OPERATOR_KEPT_TOOLS.some((tool) => tool.startsWith("mcp__first-mate__"))).toBe(true)
  })

  test("mode banner steers without over-claiming broad tool blocks", () => {
    expect(OPERATOR_MODE_BANNER).toContain("cloud-agent operator")
    expect(OPERATOR_MODE_BANNER).toContain("Delegate product implementation")
    expect(OPERATOR_MODE_BANNER).toContain("Local tools, including file writes and Bash, remain available")
    expect(OPERATOR_MODE_BANNER).toContain("worker/orchestrate MCP calls are subagent-only")
    expect(OPERATOR_MODE_BANNER).not.toMatch(/Bash.*disabled|disabled.*Bash/i)
    expect(OPERATOR_MODE_BANNER).not.toMatch(/file writes.*blocked|blocked.*file writes/i)
    expect(OPERATOR_MODE_BANNER).not.toContain("non-read-only")
  })

  test("cloud-agent scope note documents repo and merge boundaries", () => {
    expect(CLOUD_AGENT_SCOPE_NOTE).toContain("mission-listed repos")
    expect(CLOUD_AGENT_SCOPE_NOTE).toContain("merges")
    expect(CLOUD_AGENT_SCOPE_NOTE).toContain("explicit human approval")
  })

  test("fail-closed assertion still protects the reduced guard injection", () => {
    expect(() => assertShapingInstalled(true, false)).toThrow(/unguarded operator session/)
    expect(() => assertShapingInstalled(true, true)).not.toThrow()
    expect(() => assertShapingInstalled(false, false)).not.toThrow()
  })
})
