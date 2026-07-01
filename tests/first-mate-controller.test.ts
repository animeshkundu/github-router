import { expect, mock, test } from "bun:test"

import {
  advance,
  type ControllerDeps,
} from "~/lib/first-mate/controller"
import type { DecisionRecord } from "~/lib/first-mate/decisions"
import type { Mission } from "~/lib/first-mate/registry"
import type {
  AgentKey,
  Observed,
  RepoRef,
  UnitRow,
} from "~/lib/first-mate/types"

const repo: RepoRef = { owner: "octo", name: "repo" }

type TestObserved = Observed & {
  planExcerpt?: string
  failureSummary?: string
  question?: string
  runId?: number
  prNodeId?: string
}

interface Harness {
  units: UnitRow[]
  missions: Mission[]
  decisions: DecisionRecord[]
  observations: Map<string, TestObserved>
  deps: ControllerDeps
}

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
    taskId: "task-1",
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

function openPr(number = 7, headSha = "head-1"): Observed["prs"][number] {
  return { number, headSha, isDraft: false, state: "OPEN" }
}

function keyFor(row: UnitRow): string {
  return String(row.issue ?? row.taskId)
}

function sameHandle(a: UnitRow, b: UnitRow): boolean {
  return (
    a.repo.owner === b.repo.owner &&
    a.repo.name === b.repo.name &&
    a.missionId === b.missionId &&
    ((b.issue !== null && a.issue === b.issue) ||
      (b.taskId !== null && a.taskId === b.taskId))
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

function defaultObserved(row: UnitRow): TestObserved {
  return {
    provider: row.provider,
    prs:
      row.pr === null
        ? []
        : [openPr(row.pr, row.headSha ?? `head-${row.pr}`)],
  }
}

function actor(key: AgentKey) {
  return { login: `${key}-bot`, botId: `BOT_${key}` }
}

function harness(
  units: UnitRow[],
  missions: Mission[] = [mission()],
): Harness {
  const decisions: DecisionRecord[] = []
  const observations = new Map<string, TestObserved>()
  let taskCounter = 0
  let issueCounter = 100
  let packetCounter = 0

  const deps = {
    loadAllUnits: mock(async () => units),
    readMissions: mock(async () => missions),
    upsertUnit: mock(async (_repo: RepoRef, row: UnitRow) => {
      upsertMemory(units, row)
    }),
    pruneTerminal: mock(async (_repo: RepoRef) => {}),
    observeUnit: mock(async (row: UnitRow) =>
      observations.get(keyFor(row)) ?? defaultObserved(row),
    ),
    classifyPlanReady: mock(async (_logExcerpt: string) => null),
    classifyQuestionAnswerable: mock(
      async (_question: string, _acceptanceCriteria: string) => null,
    ),
    classifyFixAddressed: mock(
      async (_failureSummary: string, _latestLogExcerpt: string) => null,
    ),
    classifyStuck: mock(async (_logExcerpt: string) => null),
    verifyAndConsumeApproval: mock(
      async (_args: {
        repo: RepoRef
        pr: number
        liveHeadSha: string
        liveBaseSha?: string
      }) => ({ ok: false, reason: "no_approval" }),
    ),
    recordApproval: mock(async (_a: unknown) => {}),
    upsertDecision: mock(async (record: DecisionRecord) => {
      const index = decisions.findIndex(
        (entry) =>
          entry.decisionId === record.decisionId ||
          entry.decisionKey === record.decisionKey,
      )
      if (index === -1) decisions.push(record)
      else decisions[index] = record
    }),
    findByKey: mock(async (decisionKey: string) =>
      decisions.find((record) => record.decisionKey === decisionKey),
    ),
    markAnswered: mock(
      async (
        decisionId: string,
        chosenOptionId: string | null,
        resolvedBy: "human" | string | null,
      ) => {
        const record = decisions.find((entry) => entry.decisionId === decisionId)
        if (record === undefined) return
        record.status = "answered"
        record.chosenOptionId = chosenOptionId
        record.resolvedBy = resolvedBy
        record.resolvedMs = Date.now()
      },
    ),
    startTask: mock(async () => {
      taskCounter += 1
      return { taskId: `started-${taskCounter}`, state: "queued" }
    }),
    followUpTask: mock(
      async (_repo: { owner: string; repo: string }, _taskId: string, _prompt: string) => ({
        ok: true as const,
      }),
    ),
    cancelTask: mock(async () => ({ cancelled: true as const })),
    createIssue: mock(async () => {
      issueCounter += 1
      return {
        number: issueCounter,
        nodeId: `ISSUE_${issueCounter}`,
        url: `https://github.test/issues/${issueCounter}`,
      }
    }),
    resolveAgentActor: mock(
      async (_repo: { owner: string; repo: string }, key: AgentKey) => actor(key),
    ),
    resolveAgentRoster: mock(async () =>
      new Map<AgentKey, ReturnType<typeof actor>>([
        ["copilot", actor("copilot")],
        ["anthropic", actor("anthropic")],
        ["openai", actor("openai")],
      ]),
    ),
    assignAgent: mock(async () => ({ assigned: true as const, via: "graphql" as const })),
    findAgentPRs: mock(async () => []),
    getPullRequestState: mock(
      async (_repo: { owner: string; repo: string }, pr: number) => ({
        number: pr,
        title: "PR",
        isDraft: false,
        state: "OPEN",
        mergeable: "MERGEABLE",
        reviewDecision: null,
        headSha: `head-${pr}`,
        baseRef: "main",
        baseSha: `base-${pr}`,
      }),
    ),
    submitReview: mock(async () => ({ reviewId: 1, state: "CHANGES_REQUESTED" })),
    rerunChecks: mock(async () => ({ rerun: true as const })),
    mergePullRequest: mock(async () => ({ merged: true as const, sha: "merge-sha" })),
    markReadyForReview: mock(async () => ({ ready: true as const })),
    buildDecisionPacket: mock(() => {
      packetCounter += 1
      return {
        html: `<html>packet-${packetCounter}</html>`,
        packetId: `packet-${packetCounter}`,
        decisionId: `decision-${packetCounter}`,
      }
    }),
    writeDecisionPacketHtml: mock(async (packetId: string, _html: string) =>
      `/tmp/first-mate/${packetId}.html`,
    ),
  } satisfies ControllerDeps

  return { units, missions, decisions, observations, deps }
}

test("completed plan-mode unit emits a review_plan model request with plan excerpt", async () => {
  const row = unit({ provider: "completed", phase: "plan", dispatchMode: "plan" })
  const h = harness([row])
  h.observations.set("1", {
    provider: "completed",
    prs: [],
    planReady: true,
    planExcerpt: "1. Update controller. 2. Add tests.",
  })

  const result = await advance({}, h.deps)

  expect(result.needsModel).toHaveLength(1)
  expect(result.needsModel[0]).toMatchObject({
    requestId: "m1:1:review_plan",
    kind: "review_plan",
    missionId: "m1",
    issue: 1,
  })
  expect(result.needsModel[0]?.payload.plan_excerpt).toBe(
    "1. Update controller. 2. Add tests.",
  )
  expect(h.deps.classifyPlanReady).not.toHaveBeenCalled()
})

test("human merge-approve records an approval bound to the engine-fetched live head/base", async () => {
  const row = unit({
    issue: 7,
    pr: 7,
    provider: "in_progress",
    phase: "merge",
    validation: "floor_passed",
    verifierAssigned: true,
    blockingDecisionId: "dec-merge",
  })
  const h = harness([row])
  h.deps.findByKey = mock(async () => ({ decisionId: "dec-merge" }) as never)

  await advance(
    { humanDecisions: [{ requestId: "req-merge", choice: "approve" }] },
    h.deps,
  )

  expect(h.deps.recordApproval).toHaveBeenCalledTimes(1)
  const arg = (h.deps.recordApproval as unknown as { mock: { calls: unknown[][] } })
    .mock.calls[0]![0] as Record<string, unknown>
  // The engine binds head/base from its OWN getPullRequestState read, not from
  // anything the model supplied.
  expect(arg).toMatchObject({
    decisionId: "dec-merge",
    pr: 7,
    headSha: "head-7",
    baseSha: "base-7",
  })
})

test("forged judge_review on a unit not in verification is ignored (no floor_passed)", async () => {
  const row = unit({
    issue: 5,
    pr: 5,
    provider: "in_progress",
    validation: "ci_running",
    verifierAssigned: false,
  })
  const h = harness([row])
  h.observations.set("5", {
    provider: "in_progress",
    prs: [{ number: 5, headSha: "h5", isDraft: false, state: "OPEN" }],
    ci: { rollup: "pending" },
  })

  await advance(
    { modelAnswers: [{ requestId: "m1:5:judge_review", verdict: { pass: true } }] },
    h.deps,
  )

  // The forged verdict must NOT have fabricated a floor pass.
  expect(row.floorSha ?? null).toBeNull()
  expect(row.validation).not.toBe("floor_passed")
})

test("merge approval is refused when the head moved since the floor verdict (stale)", async () => {
  const row = unit({
    issue: 7,
    pr: 7,
    provider: "in_progress",
    phase: "merge",
    validation: "floor_passed",
    verifierAssigned: true,
    floorSha: "old-verified-sha",
    blockingDecisionId: "dec-stale",
  })
  const h = harness([row])
  h.deps.findByKey = mock(async () => ({ decisionId: "dec-stale" }) as never)
  // getPullRequestState mock returns headSha `head-7`, which != floorSha.

  await advance(
    { humanDecisions: [{ requestId: "req-stale", choice: "approve" }] },
    h.deps,
  )

  // Head moved since the verdict → no approval recorded → no merge possible.
  expect(h.deps.recordApproval).not.toHaveBeenCalled()
})

test("merge approval is refused for a unit that is not floor_passed", async () => {
  const row = unit({
    issue: 8,
    pr: 8,
    provider: "in_progress",
    validation: "ci_passed",
    blockingDecisionId: "dec-notfloor",
  })
  const h = harness([row])
  h.deps.findByKey = mock(async () => ({ decisionId: "dec-notfloor" }) as never)

  await advance(
    { humanDecisions: [{ requestId: "req-notfloor", choice: "approve" }] },
    h.deps,
  )

  expect(h.deps.recordApproval).not.toHaveBeenCalled()
})

test("review_plan approve answer follows up and flips the unit to build", async () => {
  const row = unit({ provider: "completed", phase: "plan", dispatchMode: "plan" })
  const h = harness([row])
  h.observations.set("1", { provider: "completed", prs: [] })

  await advance(
    {
      modelAnswers: [
        { requestId: "m1:1:review_plan", verdict: { decision: "approve" } },
      ],
    },
    h.deps,
  )

  expect(h.deps.followUpTask).toHaveBeenCalledTimes(1)
  expect(h.deps.followUpTask).toHaveBeenCalledWith(
    { owner: "octo", repo: "repo" },
    "task-1",
    expect.stringContaining("implement"),
  )
  expect(row.phase).toBe("build")
  expect(row.dispatchMode).toBe("build")
})

test("ci_failed asks the model under retry cap and escalates to human at cap", async () => {
  const underCap = unit({
    issue: 2,
    pr: 7,
    taskId: "task-2",
    provider: "completed",
    phase: "fix",
    dispatchMode: "build",
    retries: 1,
  })
  const h1 = harness([underCap])
  h1.observations.set("2", {
    provider: "completed",
    prs: [openPr(7)],
    ci: { rollup: "failing" },
    failureSummary: "unit tests failed",
  })

  const resultUnderCap = await advance({}, h1.deps)

  expect(resultUnderCap.needsModel).toHaveLength(1)
  expect(resultUnderCap.needsModel[0]).toMatchObject({
    requestId: "m1:2:author_fix",
    kind: "author_fix",
  })
  expect(resultUnderCap.needsModel[0]?.payload.failure_summary).toBe(
    "unit tests failed",
  )
  expect(resultUnderCap.needsHuman).toHaveLength(0)

  const atCap = unit({
    issue: 3,
    pr: 8,
    taskId: "task-3",
    provider: "completed",
    phase: "fix",
    dispatchMode: "build",
    retries: 3,
  })
  const h2 = harness([atCap])
  h2.observations.set("3", {
    provider: "completed",
    prs: [openPr(8, "head-8")],
    ci: { rollup: "failing" },
  })

  const resultAtCap = await advance({}, h2.deps)

  expect(resultAtCap.needsModel).toHaveLength(0)
  expect(resultAtCap.needsHuman).toHaveLength(1)
  expect(resultAtCap.needsHuman[0]?.packetHtmlPath).toBe("/tmp/first-mate/packet-1.html")
  expect(atCap.blockingDecisionId).toBe("decision-1")
})

test("floor_passed with valid approval merges and marks the unit terminal", async () => {
  const row = unit({
    issue: 4,
    pr: 9,
    taskId: "task-4",
    provider: "completed",
    phase: "merge",
    artifact: "pr_open",
    validation: "floor_passed",
    dispatchMode: "build",
    headSha: "old-head",
  })
  const h = harness([row])
  h.observations.set("4", {
    provider: "completed",
    prs: [openPr(9, "live-head")],
    ci: { rollup: "passing" },
    floor: "passed",
  })
  h.deps.verifyAndConsumeApproval = mock(async () => ({ ok: true }))

  const result = await advance({}, h.deps)

  expect(h.deps.mergePullRequest).toHaveBeenCalledTimes(1)
  expect(h.deps.mergePullRequest).toHaveBeenCalledWith(
    { owner: "octo", repo: "repo" },
    { pr: 9, expectedHeadSha: "head-9" },
  )
  expect(row.terminal).toBe(true)
  expect(row.phase).toBe("done")
  expect(row.artifact).toBe("pr_merged")
  expect(result.needsHuman).toHaveLength(0)
})

test("floor_passed without approval emits a merge packet and does not merge", async () => {
  const row = unit({
    issue: 5,
    pr: 10,
    taskId: "task-5",
    provider: "completed",
    phase: "merge",
    artifact: "pr_open",
    validation: "floor_passed",
    dispatchMode: "build",
  })
  const h = harness([row])
  h.observations.set("5", {
    provider: "completed",
    prs: [openPr(10, "head-10")],
    ci: { rollup: "passing" },
    floor: "passed",
  })

  const result = await advance({}, h.deps)

  expect(h.deps.mergePullRequest).not.toHaveBeenCalled()
  expect(result.needsHuman).toHaveLength(1)
  expect(result.needsHuman[0]).toMatchObject({
    decisionId: "decision-1",
    reason: "ready to merge — approval required",
    packetHtmlPath: "/tmp/first-mate/packet-1.html",
  })
  expect(h.decisions[0]?.type).toBe("merge_approval")
})

test("dispatch wave respects provider cap and does not dispatch children of unmerged parents", async () => {
  const inFlight = unit({
    issue: 11,
    taskId: "task-11",
    provider: "in_progress",
    agent: "copilot",
  })
  const capped = unit({
    issue: 12,
    taskId: null,
    provider: "none",
    agent: "copilot",
    title: "capped",
  })
  const parent = unit({
    issue: 20,
    taskId: "task-20",
    provider: "completed",
    terminal: true,
    artifact: "pr_open",
    phase: "done",
  })
  const child = unit({
    issue: 21,
    taskId: null,
    provider: "none",
    agent: "anthropic",
    dependsOn: [20],
    title: "child",
  })
  const eligible = unit({
    issue: 22,
    taskId: null,
    provider: "none",
    agent: "openai",
    title: "eligible",
  })
  const h = harness([inFlight, capped, parent, child, eligible])
  h.observations.set("11", { provider: "in_progress", prs: [] })

  await advance({ maxInFlightPerProvider: 1 }, h.deps)

  expect(capped.taskId).toBeNull()
  expect(child.taskId).toBeNull()
  expect(eligible.taskId).toBe("started-1")
  expect(h.deps.startTask).toHaveBeenCalledTimes(1)
  expect(h.deps.resolveAgentActor).toHaveBeenCalledWith(
    { owner: "octo", repo: "repo" },
    "openai",
  )
})

test("board groups counts by mission and reports blocked units", async () => {
  const missions = [
    mission({ id: "m1", goal: "Mission one" }),
    mission({ id: "m2", goal: "Mission two" }),
  ]
  const rows = [
    unit({ missionId: "m1", issue: 31, taskId: null, provider: "none", phase: "plan", dependsOn: [999] }),
    unit({ missionId: "m1", issue: 32, taskId: null, provider: "none", phase: "build", blockingDecisionId: "decision-x" }),
    unit({ missionId: "m2", issue: 41, taskId: null, provider: "none", phase: "fix", dependsOn: [999] }),
  ]
  const h = harness(rows, missions)

  const result = await advance({}, h.deps)

  expect(result.board).toEqual([
    {
      missionId: "m1",
      title: "Mission one",
      repos: ["octo/repo"],
      counts: { plan: 1, build: 1 },
      blocked: 1,
    },
    {
      missionId: "m2",
      title: "Mission two",
      repos: ["octo/repo"],
      counts: { fix: 1 },
      blocked: 0,
    },
  ])
})

test("topK caps model and human requests independently", async () => {
  const rows: UnitRow[] = []
  const h = harness(rows)

  for (let index = 0; index < 4; index += 1) {
    const issue = 50 + index
    rows.push(
      unit({
        issue,
        taskId: `task-${issue}`,
        provider: "completed",
        dispatchMode: "plan",
        phase: "plan",
        title: `plan-${index}`,
      }),
    )
    h.observations.set(String(issue), {
      provider: "completed",
      prs: [],
      planReady: true,
      planExcerpt: `plan excerpt ${index}`,
    })
  }

  for (let index = 0; index < 4; index += 1) {
    const issue = 60 + index
    const pr = 80 + index
    rows.push(
      unit({
        issue,
        pr,
        taskId: `task-${issue}`,
        provider: "completed",
        dispatchMode: "build",
        phase: "fix",
        retries: 3,
        title: `fix-${index}`,
      }),
    )
    h.observations.set(String(issue), {
      provider: "completed",
      prs: [openPr(pr, `head-${pr}`)],
      ci: { rollup: "failing" },
    })
  }

  const result = await advance({ topK: 2 }, h.deps)

  expect(result.needsModel).toHaveLength(2)
  expect(result.needsHuman).toHaveLength(2)
  expect(result.needsModel.map((request) => request.requestId)).toEqual([
    "m1:50:review_plan",
    "m1:51:review_plan",
  ])
  expect(result.needsHuman.map((request) => request.decisionId)).toEqual([
    "decision-1",
    "decision-2",
  ])
})
