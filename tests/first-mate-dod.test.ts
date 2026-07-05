import { expect, mock, test } from "bun:test"

import { DOD_TEXT, renderDod } from "~/lib/first-mate/dod"
import { advance, type ControllerDeps } from "~/lib/first-mate/controller"
import type { DecisionRecord } from "~/lib/first-mate/decisions"
import type { Mission } from "~/lib/first-mate/registry"
import type { AgentKey, RepoRef, UnitRow } from "~/lib/first-mate/types"

// ─── DOD_TEXT content assertions ─────────────────────────────────────────────

test("DOD_TEXT contains the verbatim-output requirement", () => {
  expect(DOD_TEXT).toContain("ACTUAL verbatim output")
})

test("DOD_TEXT contains the would-fail-without requirement", () => {
  expect(DOD_TEXT).toContain("would fail without the change")
})

test("DOD_TEXT forbids stubbing/skipping tests", () => {
  expect(DOD_TEXT).toContain("Do NOT stub, skip, or disable")
})

test("DOD_TEXT forbids silent scope reduction", () => {
  expect(DOD_TEXT).toContain("Do NOT silently reduce scope")
})

test("DOD_TEXT requires edge-case and error-path coverage", () => {
  expect(DOD_TEXT).toContain("edge cases and error paths")
})

test("DOD_TEXT requires updating learnings/ADR/changelog docs", () => {
  expect(DOD_TEXT).toContain("leave the repo better for the next agent")
})

// ─── renderDod ────────────────────────────────────────────────────────────────

test("renderDod includes the acceptance criteria block", () => {
  const out = renderDod(["All tests pass.", "No regressions."])
  expect(out).toContain("Acceptance criteria to verify:")
  expect(out).toContain("All tests pass.")
  expect(out).toContain("No regressions.")
})

test("renderDod includes DOD_TEXT", () => {
  const out = renderDod(["Tests pass."])
  expect(out).toContain("Definition of Done")
  expect(out).toContain("ACTUAL verbatim output")
})

test("renderDod with empty criteria omits the AC block but still includes DOD_TEXT", () => {
  const out = renderDod([])
  expect(out).not.toContain("Acceptance criteria to verify:")
  expect(out).toContain("Definition of Done")
})

// ─── Harness helpers (mirrors first-mate-controller.test.ts) ─────────────────

const repo: RepoRef = { owner: "octo", name: "repo" }

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "m1",
    goal: "Ship first mate",
    acceptanceCriteria: "Tests pass and behavior matches the design.",
    houseRules: "Use TypeScript.",
    priority: 1,
    repos: [repo],
    status: "active",
    createdMs: 1,
    updatedMs: 2,
    ...overrides,
  }
}

function unit(overrides: Partial<UnitRow> = {}): UnitRow {
  return {
    missionId: "m1",
    repo,
    issue: 1,
    pr: null,
    taskId: null,
    agent: "copilot",
    botLogin: "",
    dispatchMode: "plan",
    provider: "none",
    phase: "plan",
    artifact: "no_pr",
    validation: "unknown",
    retries: 0,
    dependsOn: [],
    title: "unit",
    ...overrides,
  }
}

function actor(key: AgentKey) {
  return { login: `${key}-bot`, botId: `BOT_${key}` }
}

function sameHandle(a: UnitRow, b: UnitRow): boolean {
  return (
    (b.id != null && a.id === b.id) ||
    (a.repo.owner === b.repo.owner &&
      a.repo.name === b.repo.name &&
      a.missionId === b.missionId &&
      ((b.issue !== null && a.issue === b.issue) ||
        (b.taskId !== null && a.taskId === b.taskId)))
  )
}

function upsertMemory(units: UnitRow[], next: UnitRow): void {
  const index = units.findIndex((row) => sameHandle(row, next))
  if (index === -1) {
    units.push(next)
  } else {
    units[index] = next
  }
}

function harness(units: UnitRow[], missions: Mission[] = [mission()]) {
  const decisions: DecisionRecord[] = []
  let taskCounter = 0

  const deps = {
    loadAllUnits: mock(async () => units),
    readMissions: mock(async () => missions),
    upsertUnit: mock(async (_repo: RepoRef, row: UnitRow) => { upsertMemory(units, row) }),
    pruneTerminal: mock(async (_repo: RepoRef) => {}),
    observeUnit: mock(async (row: UnitRow) => ({ provider: row.provider, prs: [] })),
    classifyPlanReady: mock(async () => null),
    classifyQuestionAnswerable: mock(async () => null),
    classifyFixAddressed: mock(async () => null),
    classifyStuck: mock(async () => null),
    verifyAndConsumeApproval: mock(async () => ({ ok: false, reason: "no_approval" })),
    recordApproval: mock(async () => {}),
    upsertDecision: mock(async (record: DecisionRecord) => {
      const i = decisions.findIndex((e) => e.decisionId === record.decisionId || e.decisionKey === record.decisionKey)
      if (i === -1) decisions.push(record)
      else decisions[i] = record
    }),
    findByKey: mock(async (key: string) => decisions.find((r) => r.decisionKey === key)),
    markAnswered: mock(async (id: string, choice: string | null, by: "human" | string | null) => {
      const r = decisions.find((e) => e.decisionId === id)
      if (!r) return
      r.status = "answered"
      r.chosenOptionId = choice
      r.resolvedBy = by
      r.resolvedMs = Date.now()
    }),
    startTask: mock(async () => { taskCounter += 1; return { taskId: `t-${taskCounter}`, state: "queued" } }),
    followUpTask: mock(async () => ({ ok: true as const })),
    cancelTask: mock(async () => ({ cancelled: true as const })),
    createIssue: mock(async () => ({ number: 200, nodeId: "I200", url: "https://gh/200" })),
    resolveAgentActor: mock(async (_r: unknown, key: AgentKey) => actor(key)),
    resolveAgentRoster: mock(async () => new Map<AgentKey, ReturnType<typeof actor>>([
      ["copilot", actor("copilot")],
      ["anthropic", actor("anthropic")],
      ["openai", actor("openai")],
    ])),
    assignAgent: mock(async () => ({ assigned: true as const, via: "graphql" as const })),
    findAgentPRs: mock(async () => []),
    getPullRequestState: mock(async (_r: unknown, pr: number) => ({
      number: pr, title: "PR", isDraft: false, state: "OPEN",
      mergeable: "MERGEABLE", reviewDecision: null,
      headSha: `head-${pr}`, baseRef: "main", baseSha: `base-${pr}`,
    })),
    postComment: mock(async () => ({ url: "https://gh/c/1" })),
    mentionCopilot: mock(async () => ({ url: "https://gh/c/copilot" })),
    getPullRequestReviews: mock(
      async (_repo: { owner: string; repo: string }, _pr: number) =>
        [] as Array<{
          author: string
          state: string
          bodyExcerpt: string
          submittedAt?: string
          commitId?: string
          nodeId?: string
        }>,
    ),
    dismissPullRequestReview: mock(async (_nodeId: string, _message?: string) => ({
      dismissed: true as const,
    })),
    getSelfLogin: mock(async () => "octo-bot"),
    releaseApproval: mock(async (_a: unknown) => {}),
    readDecisions: mock(async () => decisions),
    submitReview: mock(async () => ({ reviewId: 1, state: "CHANGES_REQUESTED" })),
    requestReview: mock(async () => ({ requested: true as const })),
    rerunChecks: mock(async () => ({ rerun: true as const })),
    mergePullRequest: mock(async () => ({ merged: true as const, sha: "sha" })),
    markReadyForReview: mock(async () => ({ ready: true as const })),
    buildDecisionPacket: mock(() => ({ html: "<html>p</html>", packetId: "p1", decisionId: "d1" })),
    writeDecisionPacketHtml: mock(async (id: string) => `/tmp/${id}.html`),
  } satisfies ControllerDeps

  return { units, missions, decisions, deps }
}

// ─── planPrompt includes DoD ──────────────────────────────────────────────────

test("planPrompt includes the DoD block (Definition of Done header)", async () => {
  const row = unit()
  const h = harness([row])

  await advance({}, h.deps)

  const calls = (h.deps.startTask as unknown as { mock: { calls: unknown[][] } }).mock.calls
  expect(calls.length).toBeGreaterThan(0)
  const prompt = (calls[0]![1] as { prompt: string }).prompt
  expect(prompt).toContain("Definition of Done")
})

test("planPrompt includes the acceptance criteria restatement", async () => {
  const row = unit()
  const h = harness([row])

  await advance({}, h.deps)

  const calls = (h.deps.startTask as unknown as { mock: { calls: unknown[][] } }).mock.calls
  const prompt = (calls[0]![1] as { prompt: string }).prompt
  expect(prompt).toContain("Acceptance criteria to verify:")
  expect(prompt).toContain("Tests pass and behavior matches the design.")
})

test("planPrompt includes the ACTUAL verbatim output requirement", async () => {
  const row = unit()
  const h = harness([row])

  await advance({}, h.deps)

  const calls = (h.deps.startTask as unknown as { mock: { calls: unknown[][] } }).mock.calls
  const prompt = (calls[0]![1] as { prompt: string }).prompt
  expect(prompt).toContain("ACTUAL verbatim output")
})

// ─── buildPrompt includes DoD ─────────────────────────────────────────────────

test("buildPrompt includes the DoD block when plan is approved", async () => {
  const row = unit({
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "1. Add the feature. 2. Add tests.",
    issue: 42,
    taskId: "task-42",
  })
  const h = harness([row])
  h.deps.observeUnit = mock(async () => ({ provider: "completed", prs: [], planReady: true, planExcerpt: "1. Add the feature." }))

  // First advance: emits review_plan needsModel request (does not dispatch a build yet)
  await advance({}, h.deps)

  // Second advance: relay approval → dispatches build task
  await advance(
    { modelAnswers: [{ requestId: "m1:42:review_plan", verdict: { decision: "approve" } }] },
    h.deps,
  )

  const allCalls = (h.deps.startTask as unknown as { mock: { calls: unknown[][] } }).mock.calls
  const buildCall = allCalls.find((c) => (c[1] as { createPullRequest?: boolean }).createPullRequest === true)
  expect(buildCall).toBeDefined()
  const prompt = (buildCall![1] as { prompt: string }).prompt
  expect(prompt).toContain("Definition of Done")
  expect(prompt).toContain("Acceptance criteria to verify:")
  expect(prompt).toContain("Tests pass and behavior matches the design.")
})
