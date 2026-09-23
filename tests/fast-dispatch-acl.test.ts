import { describe, expect, test } from "bun:test"

import {
  BALANCED_DISPATCH_GRAPH,
  FAST_BROWSE_DISPATCH_AGENT,
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

function expectAllowed(stdin: string, opts?: Parameters<typeof decideFastDispatchGuard>[1]): void {
  expect(decideFastDispatchGuard(stdin, opts).allowed).toBe(true)
}
function expectDenied(stdin: string, opts?: Parameters<typeof decideFastDispatchGuard>[1]): void {
  const result = decideFastDispatchGuard(stdin, opts)
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

  test("Plan and General-Purpose follow the exact graph", () => {
    for (const target of roles) {
      const planAllowed = FAST_DISPATCH_GRAPH.Plan.has(target)
      const gpAllowed = FAST_DISPATCH_GRAPH["General-Purpose"].has(target)
      if (planAllowed) expectAllowed(dispatch(target, "Plan"))
      else expectDenied(dispatch(target, "Plan"))
      if (gpAllowed) expectAllowed(dispatch(target, "General-Purpose"))
      else expectDenied(dispatch(target, "General-Purpose"))
    }
  })

  test("reviewer, Explore, and worker-browse cannot dispatch any native role", () => {
    for (const caller of ["reviewer", "Explore", "worker-browse"]) {
      for (const target of roles) expectDenied(dispatch(target, caller))
    }
  })

  test("balanced graph permits reviewer Explore while matching fast elsewhere", () => {
    expect(BALANCED_DISPATCH_GRAPH).not.toBe(FAST_DISPATCH_GRAPH)
    for (const caller of roles) {
      for (const target of roles) {
        const balancedAllowed = BALANCED_DISPATCH_GRAPH[caller].has(target)
        const fastAllowed = FAST_DISPATCH_GRAPH[caller].has(target)
        if (balancedAllowed) expectAllowed(dispatch(target, caller), { graph: "balanced" })
        else expectDenied(dispatch(target, caller), { graph: "balanced" })
        if (caller === "reviewer" && target === "Explore") {
          expect(balancedAllowed).toBe(true)
          expect(fastAllowed).toBe(false)
        } else if (caller === "Plan") {
          // No Plan role on balanced (the lead owns planning directly): a
          // stale Plan caller identity can invoke nothing.
          expect(balancedAllowed).toBe(false)
        } else {
          expect(balancedAllowed).toBe(fastAllowed)
        }
      }
    }
    // Unknown graph values fall back to the fast graph (fail closed).
    expectDenied(dispatch("Explore", "reviewer"), { graph: "fast" })
    expectDenied(dispatch("Explore", "reviewer"))
  })

  test("Plan is not a dispatch target on the cheapest/balanced rosters", () => {
    // The lead's target gate runs before the graph check: a 3-agent roster
    // filter denies Plan even though the shared caller type still names it.
    expectDenied(dispatch("Plan"), { allowedTargets: ["Explore", "General-Purpose", "reviewer"] })
    expectDenied(dispatch("Plan", "General-Purpose"), {
      graph: "balanced",
      allowedTargets: ["Explore", "General-Purpose", "reviewer"],
    })
  })

  test("balanced reviewer Explore still honors the allowedTargets roster filter", () => {
    // The target gate runs before the graph check: a roster-filtered launch
    // without Explore denies reviewer Explore even on the balanced graph.
    expectDenied(dispatch("Explore", "reviewer"), {
      graph: "balanced",
      allowedTargets: ["Plan", "reviewer"],
    })
    expectAllowed(dispatch("Explore", "reviewer"), {
      graph: "balanced",
      allowedTargets: ["Explore", "Plan", "reviewer"],
    })
  })

  test("supports Task and snake/camel target aliases, but rejects conflicts", () => {
    expectAllowed(payload({ tool_name: "Task", tool_input: { subagent_type: "reviewer" }, agent_type: "General-Purpose" }))
    expectAllowed(payload({ tool_name: "Agent", tool_input: { subagentType: "reviewer" }, agentType: "General-Purpose" }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "reviewer", subagentType: "Explore" } }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: 42 } }))
  })

  test("rejects continuation, resume, and agent-id target selectors", () => {
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "reviewer", resume: "sess-123" } }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "reviewer", resumeSession: "sess-123" } }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "reviewer", agent_id: "agent-123" } }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "reviewer", continuation: true } }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "reviewer", continueSession: "sess-123" } }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "reviewer", targetAgentId: "target-123" } }))
  })

  test("supports optional worker-browse conditional target", () => {
    expectDenied(dispatch(FAST_BROWSE_DISPATCH_AGENT))
    expectAllowed(dispatch(FAST_BROWSE_DISPATCH_AGENT), { allowBrowse: true })
    expectDenied(dispatch(FAST_BROWSE_DISPATCH_AGENT, "Plan"), { allowBrowse: true })
    expectDenied(dispatch(FAST_BROWSE_DISPATCH_AGENT, "General-Purpose"), { allowBrowse: true })
  })

  test("supports allowedTargets restriction option", () => {
    expectAllowed(dispatch("Explore"), { allowedTargets: ["Explore", "Plan"] })
    expectDenied(dispatch("reviewer"), { allowedTargets: ["Explore", "Plan"] })
  })

  test("unknown, id-only, parent-only, and malformed identities deny dispatch", () => {
    expectDenied(dispatch("reviewer", "custom-agent"))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "reviewer" }, agent_id: "id" }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "reviewer" }, parent_tool_use_id: "parent" }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "reviewer" }, agent_type: 42 }))
    expectDenied(payload({ tool_name: "Agent", tool_input: { subagent_type: "reviewer" }, agent_type: "General-Purpose", agentType: "Plan" }))
  })

  test("malformed dispatch payloads fail closed while valid lead markers pass", () => {
    for (const input of ["", "not json", "{}", "[]", JSON.stringify({ tool_name: 42 })]) {
      expectDenied(input)
    }
    expectDenied(JSON.stringify({ tool_name: "Task" }))
    expectAllowed(payload({ tool_name: "Agent", tool_input: { subagent_type: "reviewer" }, agent_type: null, agent_id: null }))
    expectAllowed(payload({ tool_name: "Task", tool_input: { subagent_type: "reviewer" }, parent_tool_use_id: null }))
  })

  test("the recognized dispatch path ignores unrelated ordinary tool names", () => {
    expectAllowed(JSON.stringify({ tool_name: "Read", tool_input: {} }))
  })

  test("nested identity-shaped fields do not grant a caller role", () => {
    expectAllowed(payload({
      tool_name: "Agent",
      tool_input: { subagent_type: "reviewer", agent_type: "reviewer" },
    }))
    expectDenied(payload({
      tool_name: "Agent",
      tool_input: { subagent_type: "reviewer" },
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
