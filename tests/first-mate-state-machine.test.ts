import { test, expect } from "bun:test"

import {
  classify,
  isEscalation,
  nextAction,
} from "../src/lib/first-mate/state-machine"
import {
  DEFAULT_POLICY,
  type Observed,
  type UnitRow,
} from "../src/lib/first-mate/types"

function row(overrides: Partial<UnitRow> = {}): UnitRow {
  return {
    missionId: "m1",
    repo: { owner: "o", name: "r" },
    issue: 1,
    pr: null,
    taskId: "t1",
    agent: "copilot",
    botLogin: "copilot-swe-agent",
    dispatchMode: "plan",
    provider: "in_progress",
    phase: "plan",
    artifact: "no_pr",
    validation: "unknown",
    retries: 0,
    dependsOn: [],
    title: "unit",
    ...overrides,
  }
}

function obs(overrides: Partial<Observed> = {}): Observed {
  return { provider: "in_progress", prs: [], ...overrides }
}

const openPr = (headSha = "sha1") => ({
  number: 7,
  headSha,
  isDraft: false,
  state: "OPEN",
})

test("plan-mode completed with plan ready → review_plan", () => {
  const o = obs({ provider: "completed", planReady: true })
  const c = classify(o, row({ dispatchMode: "plan" }))
  expect(c.phase).toBe("plan")
  expect(c.artifact).toBe("no_pr")
  const a = nextAction(c, row({ provider: "completed", dispatchMode: "plan" }), DEFAULT_POLICY)
  expect(a.kind).toBe("ask_model")
  if (a.kind === "ask_model") expect(a.request).toBe("review_plan")
})

test("waiting_for_user → answer_agent_question (macro model)", () => {
  const o = obs({ provider: "waiting_for_user" })
  const c = classify(o, row({ provider: "waiting_for_user" }))
  const a = nextAction(c, row({ provider: "waiting_for_user" }), DEFAULT_POLICY)
  expect(a).toEqual({ kind: "ask_model", request: "answer_agent_question" })
})

test("ci_failed under the cap → author_fix; at the cap → escalate_human", () => {
  const o = obs({ prs: [openPr()], ci: { rollup: "failing" } })
  const c = classify(o, row({ pr: 7, provider: "in_progress" }))
  expect(c.validation).toBe("ci_failed")
  expect(c.phase).toBe("fix")

  const under = nextAction(c, row({ pr: 7, retries: 1 }), DEFAULT_POLICY)
  expect(under).toEqual({ kind: "ask_model", request: "author_fix" })

  const atCap = nextAction(c, row({ pr: 7, retries: 3 }), DEFAULT_POLICY)
  expect(atCap.kind).toBe("escalate_human")
  expect(isEscalation(atCap)).toBe(true)
})

test("changes_requested under the cap → author_fix", () => {
  const o = obs({ prs: [openPr()], reviewDecision: "CHANGES_REQUESTED" })
  const c = classify(o, row({ pr: 7 }))
  expect(c.validation).toBe("changes_requested")
  const a = nextAction(c, row({ pr: 7, retries: 0 }), DEFAULT_POLICY)
  expect(a).toEqual({ kind: "ask_model", request: "author_fix" })
})

test("ci_passed with no verifier → assign a different-lab verifier", () => {
  const o = obs({ prs: [openPr()], ci: { rollup: "passing" } })
  const c = classify(o, row({ pr: 7 }))
  expect(c.validation).toBe("ci_passed")
  const a = nextAction(c, row({ pr: 7, verifierAssigned: false }), DEFAULT_POLICY)
  expect(a.kind).toBe("assign_verifier")
  const after = nextAction(c, row({ pr: 7, verifierAssigned: true }), DEFAULT_POLICY)
  expect(after.kind).toBe("noop")
})

test("floor_passed → escalate for human merge approval (never auto-merges)", () => {
  const o = obs({ prs: [openPr()], ci: { rollup: "passing" }, floor: "passed" })
  const c = classify(o, row({ pr: 7 }))
  expect(c.validation).toBe("floor_passed")
  expect(c.phase).toBe("merge")
  const a = nextAction(c, row({ pr: 7, verifierAssigned: true }), DEFAULT_POLICY)
  expect(a.kind).toBe("escalate_human")
  // The pure function NEVER emits {kind:"merge"} — merge is the engine's
  // approval-gated step, not a transition.
})

test("merged PR → mark_done", () => {
  const o = obs({ prs: [{ number: 7, headSha: "s", isDraft: false, state: "MERGED", merged: true }] })
  const c = classify(o, row({ pr: 7 }))
  expect(c.artifact).toBe("pr_merged")
  expect(c.phase).toBe("done")
  expect(nextAction(c, row({ pr: 7 }), DEFAULT_POLICY).kind).toBe("mark_done")
})

test("multiple PRs from one unit → escalate", () => {
  const o = obs({ prs: [openPr("a"), openPr("b")] })
  const c = classify(o, row({ pr: 7 }))
  expect(c.artifact).toBe("multiple_prs")
  expect(nextAction(c, row({ pr: 7 }), DEFAULT_POLICY).kind).toBe("escalate_human")
})

test("externally closed PR escalates; a controller-cancelled loser is done", () => {
  const o = obs({ prs: [], externalMutation: "closed" })
  const c = classify(o, row({ pr: 7 }))
  expect(c.artifact).toBe("pr_closed")
  expect(nextAction(c, row({ pr: 7 }), DEFAULT_POLICY).kind).toBe("escalate_human")
  expect(
    nextAction(c, row({ pr: 7, cancelledBy: "controller" }), DEFAULT_POLICY).kind,
  ).toBe("mark_done")
})

test("CI running → noop (wait, no model, no human)", () => {
  const o = obs({ prs: [openPr()], ci: { rollup: "pending" } })
  const c = classify(o, row({ pr: 7 }))
  expect(c.validation).toBe("ci_running")
  expect(nextAction(c, row({ pr: 7 }), DEFAULT_POLICY)).toEqual({ kind: "noop" })
})

test("failed / timed_out cloud task → escalate", () => {
  for (const provider of ["failed", "timed_out"] as const) {
    const c = classify(obs({ provider }), row({ provider }))
    expect(nextAction(c, row({ provider }), DEFAULT_POLICY).kind).toBe("escalate_human")
  }
})
