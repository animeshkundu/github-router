import { describe, expect, test } from "bun:test"

import {
  CLOUD_AGENT_SCOPE_NOTE,
  OPERATOR_DENIED_MCP_PREFIXES,
  OPERATOR_DENIED_TOOLS,
  OPERATOR_KEPT_TOOLS,
  assertShapingInstalled,
  operatorPreToolUse,
  shouldDenyOperatorTool,
} from "~/lib/first-mate/operator-shaping"

describe("operator shaping — worker/orchestrate subagent-only boundary", () => {
  test("the exact-name deny list is empty", () => {
    expect([...OPERATOR_DENIED_TOOLS]).toEqual([])
  })

  test("the denied prefixes keep main-operator worker/orchestrate MCP calls subagent-only", () => {
    expect([...OPERATOR_DENIED_MCP_PREFIXES]).toEqual(["mcp__workers__", "mcp__orchestrate__"])
    expect(shouldDenyOperatorTool("mcp__workers__implement", true)).toBe(true)
    expect(shouldDenyOperatorTool("mcp__workers__review", true)).toBe(true)
    expect(shouldDenyOperatorTool("mcp__orchestrate__run_workflow", true)).toBe(true)
    expect(shouldDenyOperatorTool("mcp__orchestrate__decompose", true)).toBe(true)
  })

  test("matching worker dispatcher subagents may call their own worker tools", () => {
    expect(operatorPreToolUse("mcp__workers__explore", true, { agent_type: "worker-explore" }).block).toBe(false)
    expect(operatorPreToolUse("mcp__workers__implement", true, { agent_type: "worker-implement" }).block).toBe(false)
    expect(operatorPreToolUse("mcp__workers__review", true, { agent_type: "worker-review" }).block).toBe(false)
    expect(operatorPreToolUse("mcp__workers__plan", true, { agent_type: "worker-plan" }).block).toBe(false)
    expect(operatorPreToolUse("mcp__workers__test", true, { agent_type: "worker-test" }).block).toBe(false)
    expect(operatorPreToolUse("mcp__workers__browse", true, { agent_type: "worker-browse" }).block).toBe(false)
  })

  test("non-dispatcher callers remain blocked from worker MCP tools", () => {
    expect(operatorPreToolUse("mcp__workers__review", true).block).toBe(true)
    expect(operatorPreToolUse("mcp__workers__review", true, { agent_type: "worker-plan" }).block).toBe(true)
    expect(operatorPreToolUse("mcp__workers__review", true, { agent_type: "general-purpose" }).block).toBe(true)
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
