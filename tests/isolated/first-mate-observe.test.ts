import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import type { RepoRef, UnitRow } from "~/lib/first-mate/types"

// Controllable stubs for the agent service/task layer observe.ts calls.
let taskResult: { state: string; branch?: string; prUrl?: string; pr?: number | null; logExcerpt: string } | null
let agentPRs: Array<{ number: number; headSha: string; headRef: string; isDraft: boolean }>
let reviewsFixture: Array<{ author: string; state: string; bodyExcerpt: string; commitId?: string }>
let prStateFixture: (pr: number) => Record<string, unknown>
let diffFixture: { fileCount: number; truncated: boolean }
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
    return prStateFixture(pr)
  }),
  getRequiredChecksForSha: mock(async () => ({
    rollup: "pending" as const,
    checks: [],
    failing: [],
    runningCount: 0,
  })),
  repoHasWorkflows: mock(async () => false),
  getPullRequestReviews: mock(async () => reviewsFixture),
  getPullRequestDiffSummary: mock(async () => ({
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
    fileCount: diffFixture.fileCount,
    truncated: diffFixture.truncated,
  })),
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
  diffFixture = { fileCount: 3, truncated: false }
  prStateFixture = (pr: number) => ({
    number: pr,
    title: "PR",
    isDraft: false,
    state: "OPEN",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    headSha: `head-${pr}`,
    baseRef: "main",
    baseSha: `base-${pr}`,
  })
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

test("ignores a STALE verifier review whose commit predates the current head", async () => {
  taskResult = { state: "completed", branch: "copilot/feat-a", logExcerpt: "" }
  agentPRs = [{ number: 5, headSha: "h5", headRef: "copilot/feat-a", isDraft: false }]
  // getPullRequestState mock returns headSha `head-5`; this review is for an older commit.
  reviewsFixture = [
    { author: "copilot-pull-request-reviewer[bot]", state: "COMMENTED", bodyExcerpt: "old review", commitId: "old-sha" },
  ]

  const observed = await observeUnit(unit({ verifierAssigned: true }))
  expect(observed.verifierReviewed).toBeUndefined()
})

test("counts a verifier review whose commit matches the current head", async () => {
  taskResult = { state: "completed", branch: "copilot/feat-a", logExcerpt: "" }
  agentPRs = [{ number: 5, headSha: "h5", headRef: "copilot/feat-a", isDraft: false }]
  reviewsFixture = [
    { author: "copilot-pull-request-reviewer[bot]", state: "COMMENTED", bodyExcerpt: "fresh review", commitId: "head-5" },
  ]

  const observed = await observeUnit(unit({ verifierAssigned: true }))
  expect(observed.verifierReviewed).toBe(true)
  expect(observed.reviewExcerpt).toContain("fresh review")
})

test("A3: a correlated open PR sets primaryPr and changedFiles", async () => {
  taskResult = { state: "completed", branch: "copilot/feat-a", logExcerpt: "" }
  agentPRs = [{ number: 5, headSha: "h5", headRef: "copilot/feat-a", isDraft: false }]
  diffFixture = { fileCount: 4, truncated: false }

  const observed = await observeUnit(unit())

  expect(observed.primaryPr).toBe(5)
  expect(observed.changedFiles).toBe(4)
  expect(observed.diffTruncated).toBe(false)
  expect(observed.externalMutation).toBeUndefined()
})

test("#12: the correlated primary PR entry carries baseRef/baseSha from getPullRequestState", async () => {
  taskResult = { state: "completed", branch: "copilot/feat-a", logExcerpt: "" }
  agentPRs = [{ number: 5, headSha: "h5", headRef: "copilot/feat-a", isDraft: false }]

  const observed = await observeUnit(unit())

  const primary = observed.prs.find((p) => p.number === 5)
  expect(primary?.baseRef).toBe("main")
  expect(primary?.baseSha).toBe("base-5")
})

test("#12: a non-primary author summary carries no base identity (base is primary-only)", async () => {
  // Two author PRs, branch matches #5 (primary); #9 is a non-primary summary.
  taskResult = { state: "completed", branch: "copilot/feat-a", logExcerpt: "" }
  agentPRs = [
    { number: 9, headSha: "h9", headRef: "copilot/other", isDraft: false },
    { number: 5, headSha: "h5", headRef: "copilot/feat-a", isDraft: false },
  ]

  const observed = await observeUnit(unit())

  const nonPrimary = observed.prs.find((p) => p.number === 9)
  expect(nonPrimary?.baseRef).toBeUndefined()
  expect(nonPrimary?.baseSha).toBeUndefined()
  const primary = observed.prs.find((p) => p.number === 5)
  expect(primary?.baseSha).toBe("base-5")
})

test("A3: an UNCORRELATED merged author PR surfaces merged_uncorrelated and does NOT set primaryPr or a merged artifact", async () => {
  // No branch → author fallback grabs #7, which is actually MERGED (a sibling's
  // squash-merge). It must NOT be adopted as the unit's PR nor marked merged in
  // prs; only surfaced as merged_uncorrelated for human reconciliation.
  taskResult = { state: "completed", logExcerpt: "" } // no branch
  agentPRs = [{ number: 7, headSha: "h7", headRef: "copilot/x", isDraft: false }]
  prStateFixture = (pr) => ({
    number: pr,
    title: "PR",
    isDraft: false,
    state: "MERGED",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    headSha: `head-${pr}`,
    baseRef: "main",
    baseSha: `base-${pr}`,
  })

  const observed = await observeUnit(unit())

  expect(observed.externalMutation).toBe("merged_uncorrelated")
  expect(observed.primaryPr).toBeUndefined()
  expect(observed.prs.some((p) => p.merged || p.state === "MERGED")).toBe(false)
})
