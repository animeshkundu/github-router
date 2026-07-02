import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import type { RepoRef, UnitRow } from "~/lib/first-mate/types"

// Controllable stubs for the agent service/task layer observe.ts calls.
let taskResult: { state: string; branch?: string; prUrl?: string; pr?: number | null; logExcerpt: string } | null
let agentPRs: Array<{ number: number; headSha: string; headRef: string; isDraft: boolean }>
let reviewsFixture: Array<{ author: string; state: string; bodyExcerpt: string }>
const prStateCalls: number[] = []

mock.module("~/lib/agent/tasks", () => ({
  getTask: mock(async () => {
    if (taskResult === null) throw new Error("no task")
    return { taskId: "t1", ...taskResult }
  }),
}))

mock.module("~/lib/agent/service", () => ({
  COPILOT_REVIEWER_LOGIN: "copilot-pull-request-reviewer[bot]",
  findAgentPRs: mock(async () => agentPRs),
  getPullRequestState: mock(async (_repo: RepoRef, pr: number) => {
    prStateCalls.push(pr)
    return {
      number: pr,
      title: "PR",
      isDraft: false,
      state: "OPEN",
      mergeable: "MERGEABLE",
      reviewDecision: null,
      headSha: `head-${pr}`,
      baseRef: "main",
      baseSha: `base-${pr}`,
    }
  }),
  getRequiredChecksForSha: mock(async () => ({
    rollup: "pending" as const,
    checks: [],
    failing: [],
    runningCount: 0,
  })),
  repoHasWorkflows: mock(async () => false),
  getPullRequestReviews: mock(async () => reviewsFixture),
}))

const { observeUnit } = await import("~/lib/first-mate/observe")

const repo: RepoRef = { owner: "octo", name: "repo" }

function unit(overrides: Partial<UnitRow> = {}): UnitRow {
  return {
    missionId: "m1",
    repo,
    issue: null,
    pr: null,
    taskId: "task-1",
    agent: "copilot",
    botLogin: "copilot-swe-agent",
    dispatchMode: "build",
    provider: "in_progress",
    phase: "build",
    artifact: "no_pr",
    validation: "unknown",
    retries: 0,
    dependsOn: [],
    title: "unit",
    ...overrides,
  }
}

beforeEach(() => {
  taskResult = { state: "completed", logExcerpt: "" }
  agentPRs = []
  reviewsFixture = []
  prStateCalls.length = 0
})

afterEach(() => {
  prStateCalls.length = 0
})

test("correlates the branch-matching PR for a task-based unit (issue:null)", async () => {
  taskResult = { state: "completed", branch: "copilot/feat-a", logExcerpt: "" }
  agentPRs = [
    { number: 9, headSha: "h9", headRef: "copilot/other", isDraft: false },
    { number: 5, headSha: "h5", headRef: "copilot/feat-a", isDraft: false },
  ]

  const observed = await observeUnit(unit())

  // The branch-matched PR (#5) is the primary — not the first author PR (#9).
  expect(prStateCalls).toEqual([5])
  expect(observed.prs.some((p) => p.number === 5)).toBe(true)
})

test("does NOT mis-attribute an unrelated same-bot PR when the branch has no PR yet", async () => {
  taskResult = { state: "completed", branch: "copilot/feat-a", logExcerpt: "" }
  // A different copilot PR exists, but not for this unit's branch.
  agentPRs = [{ number: 1, headSha: "h1", headRef: "copilot/scaffold", isDraft: true }]

  const observed = await observeUnit(unit())

  // Known branch, no branch match → no primary PR fetched (PR isn't open yet).
  expect(prStateCalls).toEqual([])
  expect(observed.prs.every((p) => p.number !== 1 || p.state === "OPEN")).toBe(true)
})

test("falls back to the first author-matched PR only when the branch is unknown", async () => {
  taskResult = { state: "completed", logExcerpt: "" } // no branch
  agentPRs = [{ number: 7, headSha: "h7", headRef: "copilot/x", isDraft: false }]

  await observeUnit(unit())

  expect(prStateCalls).toEqual([7])
})

test("surfaces the Copilot verifier review (verifierReviewed + findings) once it lands", async () => {
  taskResult = { state: "completed", branch: "copilot/feat-a", logExcerpt: "" }
  agentPRs = [{ number: 5, headSha: "h5", headRef: "copilot/feat-a", isDraft: false }]
  reviewsFixture = [
    { author: "someone-else", state: "COMMENTED", bodyExcerpt: "ignore me" },
    { author: "copilot-pull-request-reviewer[bot]", state: "COMMENTED", bodyExcerpt: "PR overview: LGTM with 2 nits" },
  ]

  const observed = await observeUnit(unit({ verifierAssigned: true }))

  expect(observed.verifierReviewed).toBe(true)
  expect(observed.reviewExcerpt).toContain("LGTM with 2 nits")
})

test("no verifier review surfaced before one is assigned", async () => {
  taskResult = { state: "completed", branch: "copilot/feat-a", logExcerpt: "" }
  agentPRs = [{ number: 5, headSha: "h5", headRef: "copilot/feat-a", isDraft: false }]
  reviewsFixture = [{ author: "copilot-pull-request-reviewer[bot]", state: "COMMENTED", bodyExcerpt: "x" }]

  const observed = await observeUnit(unit({ verifierAssigned: false }))
  expect(observed.verifierReviewed).toBeUndefined()
})
