import { describe, expect, test } from "bun:test"

import {
  FAST_DISPATCH_GRAPH,
  FAST_DISPATCH_TOOL_MATCHER,
  FAST_NATIVE_AGENT_NAMES,
  decideFastDispatchGuard,
  fastDispatchAllowOutput,
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

  test("Plan and implementer follow the exact graph", () => {
    for (const target of roles) {
      const planAllowed = FAST_DISPATCH_GRAPH.Plan.has(target)
      const implementerAllowed = FAST_DISPATCH_GRAPH.implementer.has(target)
      if (planAllowed) expectAllowed(dispatch(target, "Plan"))
      else expectDenied(dispatch(target, "Plan"))
      if (implementerAllowed) expectAllowed(dispatch(target, "implementer"))
      else expectDenied(dispatch(target, "implementer"))
    }
  })

  test("lowercase planner is rejected as both target and caller", () => {
    expectDenied(dispatch("planner"))
    expectDenied(dispatch("critic", "planner"))
  })

  test("reviewer, Explore, and critic cannot dispatch any native role", () => {
    for (const caller of ["reviewer", "Explore", "critic"]) {
      for (const target of roles) expectDenied(dispatch(target, caller))
    }
  })

  test("supports Task and snake/camel target aliases, but rejects conflicts", () => {
    expectAllowed(payload({ tool_name: "Task", tool_input: { subagent_type: "critic" }, agent_type: "implementer" }))
    expectAllowed(payload({ tool_name: "Agent", tool_input: { subagentType: "critic" }, agentType: "implementer" }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "critic", subagentType: "Explore" } }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: 42 } }))
  })

  test("unknown, id-only, parent-only, and malformed identities deny dispatch", () => {
    expectDenied(dispatch("critic", "custom-agent"))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "critic" }, agent_id: "id" }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "critic" }, parent_tool_use_id: "parent" }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "critic" }, agent_type: 42 }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "critic" }, agent_type: "implementer", agentType: "Plan" }))
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

  test("allowed dispatch clones input and removes only the model override", () => {
    const originalInput = {
      subagent_type: "Plan",
      prompt: "review this",
      model: "sonnet",
      isolation: "worktree",
      future: { keep: true },
    }
    const hook = {
      tool_name: "Agent",
      tool_input: originalInput,
    }
    const decision = decideFastDispatchGuard(hook)
    expect(decision.updatedInput).toEqual({
      subagent_type: "Plan",
      prompt: "review this",
      isolation: "worktree",
      future: { keep: true },
    })
    expect(originalInput.model).toBe("sonnet")
    expect(Object.hasOwn(originalInput, "model")).toBe(true)
  })

  test("ordinary tools are never rewritten", () => {
    expect(decideFastDispatchGuard({
      tool_name: "Read",
      tool_input: { model: "keep-me", file_path: "x" },
    }).updatedInput).toBeUndefined()
  })

  test("allow output follows Claude Code PreToolUse rewrite protocol", () => {
    const parsed = JSON.parse(fastDispatchAllowOutput({
      subagent_type: "Explore",
      prompt: "find it",
    }))
    expect(parsed.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { subagent_type: "Explore", prompt: "find it" },
    })
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
