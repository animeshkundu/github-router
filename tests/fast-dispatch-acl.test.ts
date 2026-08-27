import { describe, expect, test } from "bun:test"

import {
  FAST_DISPATCH_GRAPH,
  FAST_DISPATCH_TOOL_MATCHER,
  FAST_NATIVE_AGENT_NAMES,
  decideFastDispatchGuard,
  fastDispatchDenyOutput,
} from "~/lib/fast-dispatch-acl"

const roles = [...FAST_NATIVE_AGENT_NAMES]
const payload = (input: Record<string, unknown>): string => JSON.stringify(input)
const dispatch = (target: string, caller?: string, extra?: Record<string, unknown>): string =>
  payload({
    tool_name: "Agent",
    tool_input: { subagent_type: target },
    ...(caller === undefined ? {} : { agent_type: caller }),
    ...extra,
  })

function expectAllowed(stdin: string): void {
  expect(decideFastDispatchGuard(stdin).allowed).toBe(true)
}
function expectDenied(stdin: string): void {
  const result = decideFastDispatchGuard(stdin)
  expect(result.allowed).toBe(false)
  expect(result.verdict).toBe("deny")
  expect(result.reason).toBeString()
}

describe("fast native dispatch ACL", () => {
  test("recognizes both dispatch tool names with an anchored matcher", () => {
    const re = new RegExp(FAST_DISPATCH_TOOL_MATCHER)
    expect(re.test("Task")).toBe(true)
    expect(re.test("Agent")).toBe(true)
    expect(re.test("TaskExtra")).toBe(false)
    expect(re.test("Read")).toBe(false)
  })

  test("lead may invoke every fast native role", () => {
    for (const target of roles) expectAllowed(dispatch(target))
    for (const target of roles) expectAllowed(dispatch(target, undefined, { agent_type: null, agent_id: null }))
  })

  test("planner and implementer follow the exact graph", () => {
    for (const target of roles) {
      const plannerAllowed = FAST_DISPATCH_GRAPH.planner.has(target)
      const implementerAllowed = FAST_DISPATCH_GRAPH.implementer.has(target)
      if (plannerAllowed) expectAllowed(dispatch(target, "planner"))
      else expectDenied(dispatch(target, "planner"))
      if (implementerAllowed) expectAllowed(dispatch(target, "implementer"))
      else expectDenied(dispatch(target, "implementer"))
    }
  })

  test("reviewer, scout, and critic cannot dispatch any native role", () => {
    for (const caller of ["reviewer", "scout", "critic"]) {
      for (const target of roles) expectDenied(dispatch(target, caller))
    }
  })

  test("supports Task and snake/camel target aliases, but rejects conflicts", () => {
    expectAllowed(payload({ tool_name: "Task", tool_input: { subagent_type: "critic" }, agent_type: "implementer" }))
    expectAllowed(payload({ tool_name: "Agent", tool_input: { subagentType: "critic" }, agentType: "implementer" }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "critic", subagentType: "scout" } }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: 42 } }))
  })

  test("unknown, id-only, parent-only, and malformed identities deny dispatch", () => {
    expectDenied(dispatch("critic", "custom-agent"))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "critic" }, agent_id: "id" }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "critic" }, parent_tool_use_id: "parent" }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "critic" }, agent_type: 42 }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "critic" }, agent_type: "implementer", agentType: "planner" }))
  })

  test("malformed dispatch payloads fail closed while valid lead markers pass", () => {
    for (const input of ["", "not json", "{}", "[]", JSON.stringify({ tool_name: 42 })]) {
      expectDenied(input)
    }
    expectDenied(JSON.stringify({ tool_name: "Task" }))
    expectAllowed(payload({ tool_name: "Agent", tool_input: { subagent_type: "critic" }, agent_type: null, agent_id: null }))
    expectAllowed(payload({ tool_name: "Task", tool_input: { subagent_type: "critic" }, parent_tool_use_id: null }))
  })

  test("the recognized dispatch path ignores unrelated ordinary tool names", () => {
    expectAllowed(JSON.stringify({ tool_name: "Read", tool_input: {} }))
  })

  test("nested identity-shaped fields do not grant a caller role", () => {
    expectAllowed(payload({
      tool_name: "Agent",
      tool_input: { subagent_type: "critic", agent_type: "reviewer" },
    }))
    expectDenied(payload({
      tool_name: "Agent",
      tool_input: { subagent_type: "critic" },
      agent_type: "reviewer",
    }))
  })

  test("deny output follows Claude Code PreToolUse protocol", () => {
    const parsed = JSON.parse(fastDispatchDenyOutput("nope"))
    expect(parsed.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "nope",
    })
  })
})
