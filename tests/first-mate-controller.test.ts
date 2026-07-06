import { expect, mock, test } from "bun:test"

import {
  advance,
  addUnitsToMission,
  artifactDate,
  artifactSlug,
  buildPrompt,
  failureSignature,
  planPrompt,
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
import { state } from "~/lib/state"

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

function openPr(
  number = 7,
  headSha = "head-1",
  overrides: Partial<Observed["prs"][number]> = {},
): Observed["prs"][number] {
  return {
    number,
    headSha,
    isDraft: false,
    state: "OPEN",
    baseRef: "main",
    baseSha: `base-${number}`,
    ...overrides,
  }
}

function keyFor(row: UnitRow): string {
  return String(row.issue ?? row.taskId)
}

function sameHandle(a: UnitRow, b: UnitRow): boolean {
  // Mirror the production ledger's sameUnitHandle: match by stable `id` FIRST.
  // The dispatch outbox upserts a unit while taskId is still null (intent), so
  // id-matching is what prevents a duplicate — the harness must model that.
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
    releaseApproval: mock(async (_a: unknown) => {}),
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
    readDecisions: mock(async () => decisions),
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
    submitReview: mock(async () => ({ reviewId: 1, state: "CHANGES_REQUESTED" })),
    requestReview: mock(async () => ({ requested: true as const })),
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

test("review_plan falls back to the raw session log when the classifier extracts an empty planExcerpt", async () => {
  // Reproduces the live smoke bug: getTask retrieved a real 4000-char session
  // log, but the T0 classifier returned planExcerpt:"" (its schema allows it),
  // which used to clobber the log via `?? ` and emit an empty plan_excerpt.
  const row = unit({ provider: "completed", phase: "plan", dispatchMode: "plan" })
  const h = harness([row])
  h.observations.set("1", {
    provider: "completed",
    prs: [],
    logExcerpt: "Progress:\nCloned repo and drafted the dependency upgrade.",
  })
  h.deps.classifyPlanReady = mock(async () => ({ planReady: true, planExcerpt: "" }))

  const result = await advance({}, h.deps)

  expect(h.deps.classifyPlanReady).toHaveBeenCalledTimes(1)
  expect(result.needsModel[0]?.kind).toBe("review_plan")
  expect(result.needsModel[0]?.payload.plan_excerpt).toBe(
    "Progress:\nCloned repo and drafted the dependency upgrade.",
  )
})

test("#10: the FULL session log (not the short classifier excerpt) is stashed on unit.planExcerpt for the build handoff", async () => {
  const fullLog =
    "Plan:\n1. Refactor the adapter\n2. Add a config flag\n3. Wire the flag through the router\n4. Add regression tests\n" +
    "Progress:\nCloned the repo and drafted the full implementation plan across four steps."
  const row = unit({ provider: "completed", phase: "plan", dispatchMode: "plan" })
  const h = harness([row])
  h.observations.set("1", {
    provider: "completed",
    prs: [],
    logExcerpt: fullLog,
  })
  // The classifier returns a SHORT distilled excerpt — a review aid, not the
  // build source. The build handoff must carry the fuller log instead.
  h.deps.classifyPlanReady = mock(async () => ({
    planReady: true,
    planExcerpt: "Refactor the adapter and add a flag.",
  }))

  await advance({}, h.deps)

  expect(row.planExcerpt).toBe(fullLog)
  // And that full plan lands verbatim in the build prompt (no truncation).
  const prompt = buildPrompt({ ...row, planExcerpt: row.planExcerpt }, mission(), "2026-07-05")
  expect(prompt).toContain(fullLog)
  expect(prompt).toContain("Approved plan (authoritative")
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

test("review_plan approve re-dispatches a fresh build task carrying the approved plan", async () => {
  const row = unit({
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "1. Bump Flask to 3.x. 2. Add pyproject.toml.",
  })
  const h = harness([row])
  h.observations.set("1", { provider: "queued", prs: [] })

  await advance(
    { modelAnswers: [{ requestId: "m1:1:review_plan", verdict: { decision: "approve" } }] },
    h.deps,
  )

  // A fresh build task was dispatched (createPullRequest:true) carrying the plan —
  // NOT a followUpTask (the one-shot plan task 405s on follow-up).
  expect(h.deps.followUpTask).not.toHaveBeenCalled()
  const buildCall = (
    h.deps.startTask as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls.find((c) => (c[1] as { createPullRequest?: boolean }).createPullRequest === true)
  expect(buildCall).toBeDefined()
  expect((buildCall![1] as { prompt: string }).prompt).toContain("1. Bump Flask to 3.x.")
  expect(row.dispatchMode).toBe("build")
})

test("review_plan refine re-dispatches a fresh plan task with the feedback and stays in plan", async () => {
  const row = unit({
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "old plan",
  })
  const h = harness([row])
  h.observations.set("1", { provider: "queued", prs: [] })

  await advance(
    {
      modelAnswers: [
        {
          requestId: "m1:1:review_plan",
          verdict: { decision: "refine", instruction: "Cover Python 3.12 too." },
        },
      ],
    },
    h.deps,
  )

  expect(h.deps.followUpTask).not.toHaveBeenCalled()
  const planCall = (
    h.deps.startTask as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls.find((c) => {
    const input = c[1] as { createPullRequest?: boolean; prompt: string }
    return input.createPullRequest === false && input.prompt.includes("Cover Python 3.12 too.")
  })
  expect(planCall).toBeDefined()
  expect(row.dispatchMode).toBe("plan")
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
    retries: 6,
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

test("a no_ci unit with no verifier requests a Copilot code review (assign_verifier)", async () => {
  const row = unit({
    issue: null,
    pr: 5,
    provider: "completed",
    phase: "review",
    dispatchMode: "build",
    verifierAssigned: false,
    branch: "copilot/feat",
  })
  const h = harness([row])
  h.observations.set("task-1", {
    provider: "completed",
    prs: [{ number: 5, headSha: "h5", isDraft: false, state: "OPEN" }],
    ci: { rollup: "none", noCi: true },
  })

  await advance({}, h.deps)

  expect(h.deps.requestReview).toHaveBeenCalledTimes(1)
  const call = (h.deps.requestReview as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
  expect(call[1]).toBe(5)
  expect(String(call[2])).toContain("copilot-pull-request-reviewer[bot]")
  expect(row.verifierAssigned).toBe(true)
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

test("FIX 6: a merge does NOT clobber the PR-open-pinned baseSha with a later live read (fast-forward)", async () => {
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
    baseSha: "pinned-base", // pinned at PR-open
  })
  const h = harness([row])
  h.observations.set("4", {
    provider: "completed",
    prs: [openPr(9, "live-head")],
    ci: { rollup: "passing" },
    floor: "passed",
  })
  // The live PR read reports a fast-forwarded base ("base-9" from the harness
  // default) — different from the pinned value.
  h.deps.verifyAndConsumeApproval = mock(async () => ({ ok: true }))

  await advance({}, h.deps)

  expect(h.deps.mergePullRequest).toHaveBeenCalledTimes(1)
  // Pin-once: the pinned base survives the live read; it is NOT overwritten.
  expect(row.baseSha).toBe("pinned-base")
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
    id: "parent-id",
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
    dependsOn: ["parent-id"],
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
    unit({ missionId: "m1", issue: 31, taskId: null, provider: "none", phase: "plan", dependsOn: ["missing-id"] }),
    unit({ missionId: "m1", issue: 32, taskId: null, provider: "none", phase: "build", blockingDecisionId: "decision-x" }),
    unit({ missionId: "m2", issue: 41, taskId: null, provider: "none", phase: "fix", dependsOn: ["missing-id"] }),
  ]
  const h = harness(rows, missions)
  // The blocked unit's decision must exist (pending) so the start-of-drive
  // reconciliation doesn't treat the block as stale and clear it.
  h.decisions.push({
    decisionId: "decision-x",
    decisionKey: "m1:32:human_decision:fp",
    type: "human_decision",
    status: "pending",
    inputFingerprint: "fp",
    createdMs: 1,
  })

  const result = await advance({}, h.deps)

  expect(result.board).toMatchObject([
    {
      missionId: "m1",
      title: "Mission one",
      status: "active",
      repos: ["octo/repo"],
      counts: { plan: 1, build: 1 },
      blocked: 1,
      summary: { done: 0, failed: 0 },
    },
    {
      missionId: "m2",
      title: "Mission two",
      status: "active",
      repos: ["octo/repo"],
      counts: { fix: 1 },
      blocked: 0,
      summary: { done: 0, failed: 0 },
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
        retries: 6,
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

test("decompose: unit-less mission emits a decompose request, and a decompose answer creates + dispatches units", async () => {
  const m = mission({ id: "m-dec", goal: "Build the widget" })
  const h = harness([], [m])

  // (1) advance on a unit-less mission emits a per-mission decompose request.
  const r1 = await advance({}, h.deps)
  const dec = r1.needsModel.find((x) => x.kind === "decompose")
  expect(dec?.requestId).toBe("decompose:m-dec")
  expect((dec?.payload as Record<string, unknown>).goal).toBe("Build the widget")
  expect(h.units.length).toBe(0) // nothing created yet

  // (2) answering the decompose creates the units — which then dispatch in the
  //     same wake (queued → startTask).
  await advance(
    {
      modelAnswers: [
        {
          requestId: "decompose:m-dec",
          verdict: {
            units: [{ title: "part A" }, { title: "part B", agent: "anthropic" }],
          },
        },
      ],
    },
    h.deps,
  )

  expect(h.units.map((u) => u.title).sort()).toEqual(["part A", "part B"])
  expect(h.units.every((u) => typeof u.id === "string" && u.id.length > 0)).toBe(true)
  expect(h.units.find((u) => u.title === "part B")?.agent).toBe("anthropic")
  // dispatched in the same wake (each got a taskId or issue) — no duplicates.
  expect(h.units.every((u) => u.taskId !== null || u.issue !== null)).toBe(true)
})

test("board exposes non-terminal unit handles and active-only missions by default", async () => {
  const activeUnit = unit({ id: "u-active", issue: 2, pr: 8, model: "gpt-5.5", blockingDecisionId: "decision-7" })
  const doneUnit = unit({ id: "u-done", issue: 3, pr: 9, terminal: true, artifact: "pr_merged" })
  const h = harness([activeUnit, doneUnit], [mission({ id: "m1" }), mission({ id: "m-old", status: "abandoned" })])

  h.decisions.push({
    decisionId: "decision-7",
    decisionKey: "m1:2:human_decision:fp",
    type: "human_decision",
    status: "pending",
    inputFingerprint: "fp",
    createdMs: 1,
  })

  const result = await advance({}, h.deps)

  expect(result.board.map((row) => row.missionId)).toEqual(["m1"])
  expect(result.board[0]?.units).toEqual([
    {
      unitId: "u-active",
      issue: 2,
      pr: 8,
      phase: "plan",
      provider: "in_progress",
      validation: "unknown",
      model: "gpt-5.5",
      blockedReason: "decision-7",
    },
  ])
  expect(result.board[0]?.summary).toEqual({ done: 1, failed: 0 })
})

test("advance includeAll includes inactive missions", async () => {
  const h = harness([], [mission({ id: "m1" }), mission({ id: "m-old", status: "abandoned" })])

  const result = await advance({ includeAll: true }, h.deps)

  expect(result.board.map((row) => row.missionId).sort()).toEqual(["m-old", "m1"])
})

test("addUnitsToMission appends units with local dependency indices", async () => {
  const m = mission({ id: "m-add" })
  const written: UnitRow[] = []
  const created = await addUnitsToMission(
    m,
    [{ title: "first" }, { title: "second", dependsOn: [0], model: "gpt-5.5" }],
    { upsertUnit: mock(async (_repo, row) => { written.push(row) }) },
  )

  expect(created).toBe(2)
  expect(written[1]?.dependsOn).toEqual([written[0]!.id!])
  expect(written[1]?.model).toBe("gpt-5.5")
})

test("addUnitsToMission keeps dependsOn aligned to raw-unit indices when invalid specs are skipped", async () => {
  const m = mission({ id: "m-add" })
  const written: UnitRow[] = []
  const created = await addUnitsToMission(
    m,
    [{ title: "first" }, {}, { title: "third", dependsOn: [0] }],
    { upsertUnit: mock(async (_repo, row) => { written.push(row) }) },
  )

  expect(created).toBe(2)
  expect(written.map((row) => row.title)).toEqual(["first", "third"])
  expect(written[1]?.dependsOn).toEqual([written[0]!.id!])
})

test("advance returns a clamped nextWakeSeconds for active work and null when idle", async () => {
  // Active in-progress unit → the 90s cadence, surfaced as ready-to-use seconds.
  const active = harness([unit({ provider: "in_progress", phase: "plan" })])
  const activeResult = await advance({}, active.deps)
  expect(activeResult.nextWakeAt).not.toBeNull()
  expect(activeResult.nextWakeSeconds).toBe(90)
  expect(activeResult.nextWakeSeconds).toBeGreaterThanOrEqual(60)
  expect(activeResult.nextWakeSeconds).toBeLessThanOrEqual(3600)

  // No units → idle → null on both, the skill's DISARM signal.
  const idle = harness([])
  const idleResult = await advance({}, idle.deps)
  expect(idleResult.nextWakeAt).toBeNull()
  expect(idleResult.nextWakeSeconds).toBeNull()
})

test("advance clamps a long wake cadence into the scheduler's [60, 3600] range", async () => {
  // All-queued/blocked units use the 900s cadence — still within range, but the
  // clamp guarantees any cadence the controller picks is scheduler-safe.
  const h = harness([unit({ provider: "queued", phase: "plan" })])
  const result = await advance({}, h.deps)
  expect(result.nextWakeSeconds).not.toBeNull()
  expect(result.nextWakeSeconds!).toBeGreaterThanOrEqual(60)
  expect(result.nextWakeSeconds!).toBeLessThanOrEqual(3600)
})

test("advance isolates a throwing unit and still sweeps every other mission", async () => {
  // Reproduces the resilience gap: one unit's observe/step throwing used to
  // abort the entire global sweep (no board, no other missions advanced).
  const u1 = unit({ missionId: "m1", issue: 1, taskId: "t1" })
  const u2 = unit({ missionId: "m2", issue: 2, taskId: "t2" })
  const h = harness([u1, u2], [mission({ id: "m1" }), mission({ id: "m2" })])
  const realObserve = h.deps.observeUnit
  h.deps.observeUnit = mock(async (row: UnitRow) => {
    if (row.issue === 1) throw new Error("observe boom")
    return realObserve(row)
  })

  const result = await advance({}, h.deps)

  // The sweep completed: both missions are on the board despite unit 1 failing.
  expect(result.board.map((b) => b.missionId).sort()).toEqual(["m1", "m2"])
  expect(
    result.applied.some((a) => a.includes("error advancing") && a.includes("m1")),
  ).toBe(true)
})

test("advance isolates a throwing model answer instead of aborting the wake", async () => {
  // A failing re-dispatch on approve (or any answer failure) must not nuke the wake.
  const u = unit({ provider: "completed", phase: "plan", dispatchMode: "plan" })
  const h = harness([u])
  h.deps.startTask = mock(async () => {
    throw new Error("startTask 503 (dispatch failed)")
  })

  const result = await advance(
    { modelAnswers: [{ requestId: "m1:1:review_plan", verdict: { decision: "approve" } }] },
    h.deps,
  )

  expect(
    result.applied.some((a) => a.includes("error applying answer") && a.includes("review_plan")),
  ).toBe(true)
  // The wake still produced a board rather than throwing.
  expect(Array.isArray(result.board)).toBe(true)
})

test("dispatch goes through the outbox: intent persisted before startTask, idempotency key + correlation tag sent, intent cleared on success", async () => {
  const row = unit({ provider: "none", taskId: null, phase: "plan", dispatchMode: "plan" })
  const h = harness([row])
  const upsertOrder: string[] = []
  const realUpsert = h.deps.upsertUnit
  h.deps.upsertUnit = mock(async (repo: RepoRef, u: UnitRow) => {
    upsertOrder.push(u.dispatch ? "intent" : "cleared")
    return realUpsert(repo, u)
  })
  let captured: { prompt: string; idempotencyKey?: string } | undefined
  h.deps.startTask = mock(async (_repo: unknown, input: { prompt: string; idempotencyKey?: string }) => {
    captured = input
    return { taskId: "task-new", state: "queued" }
  })

  await advance({}, h.deps)

  expect(captured?.idempotencyKey).toBeTruthy()
  expect(captured?.prompt).toContain(`fm-dispatch:${captured?.idempotencyKey}`)
  // The intent was persisted BEFORE the result (outbox ordering).
  expect(upsertOrder[0]).toBe("intent")
  expect(row.dispatch).toBeUndefined()
  expect(row.taskId).toBe("task-new")
})

test("an interrupted dispatch (intent set, no taskId) escalates to a human and never re-dispatches", async () => {
  const row = unit({
    provider: "none",
    taskId: null,
    dispatch: { id: "corr-1", requestedMs: 1, attempts: 1 },
  })
  const h = harness([row])

  const result = await advance({}, h.deps)

  expect(h.deps.startTask).not.toHaveBeenCalled()
  expect(result.needsHuman.some((r) => r.reason.includes("dispatch interrupted"))).toBe(true)
})

test("a startTask response with no taskId leaves the intent pending (no auto-retry into a duplicate)", async () => {
  const row = unit({ provider: "none", taskId: null, phase: "plan", dispatchMode: "plan" })
  const h = harness([row])
  h.deps.startTask = mock(async () => ({ taskId: "", state: "unknown" }))

  await advance({}, h.deps)

  // Ambiguous empty id → intent stays pending (recovery escalates next wake),
  // and the unit was dispatched exactly once (not blindly retried).
  expect(row.dispatch).toBeDefined()
  expect(row.taskId).toBeNull()
  expect((h.deps.startTask as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1)
})

test("decompose resolves dependsOn indices to sibling unit ids and gates dispatch on merge (#18)", async () => {
  const m = mission({ id: "m-dep", repos: [repo] })
  const h = harness([], [m])

  await advance(
    {
      modelAnswers: [
        {
          requestId: "decompose:m-dep",
          verdict: {
            units: [{ title: "coverage" }, { title: "migrate", dependsOn: [0] }],
          },
        },
      ],
    },
    h.deps,
  )

  const coverage = h.units.find((u) => u.title === "coverage")!
  const migrate = h.units.find((u) => u.title === "migrate")!
  // The index-0 dependency resolved to coverage's stable id (not an issue number).
  expect(coverage.id).toBeTruthy()
  expect(migrate.dependsOn).toEqual([coverage.id!])
  // coverage (no deps) dispatched; migrate is gated until coverage MERGES.
  expect(coverage.taskId).not.toBeNull()
  expect(migrate.taskId).toBeNull()
})

test("merge-gate un-drafts a draft PR (via node id) before merging (#17)", async () => {
  const row = unit({
    issue: 7,
    pr: 7,
    provider: "in_progress",
    phase: "merge",
    dispatchMode: "build",
    validation: "floor_passed",
    floorSha: "head-7",
    verifierAssigned: true,
  })
  const h = harness([row])
  h.observations.set("7", {
    provider: "in_progress",
    prs: [openPr(7, "head-7")],
    prNodeId: "PR_node_7",
  })
  // A draft PR that is otherwise merge-ready.
  h.deps.getPullRequestState = mock(async (_repo: { owner: string; repo: string }, pr: number) => ({
    number: pr,
    title: "PR",
    isDraft: true,
    state: "OPEN",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    headSha: "head-7",
    baseRef: "main",
    baseSha: "base-7",
    nodeId: "PR_node_7",
  }))
  h.deps.findByKey = mock(async () => ({ decisionId: "dec-merge" }) as never)
  h.deps.verifyAndConsumeApproval = mock(async () => ({ ok: true }))

  await advance(
    { humanDecisions: [{ requestId: "dec-merge", choice: "approve" }] },
    h.deps,
  )

  expect(h.deps.markReadyForReview).toHaveBeenCalledWith("PR_node_7")
  expect(h.deps.mergePullRequest).toHaveBeenCalledTimes(1)
})

test("#5: dispatch persists taskId + clears intent BEFORE settling the outbox", async () => {
  const row = unit({
    provider: "none",
    taskId: null,
    phase: "plan",
    dispatchMode: "plan",
    issue: 5,
  })
  const h = harness([row])
  const events: string[] = []
  const origUpsert = h.deps.upsertUnit
  h.deps.upsertUnit = mock(async (r: RepoRef, u: UnitRow) => {
    if (u.taskId !== null && u.dispatch === undefined) events.push("persist:dispatched")
    else if (u.dispatch !== undefined) events.push("persist:intent")
    await origUpsert(r, u)
  })
  h.deps.dispatchOutbox = {
    record: mock(async () => {
      events.push("outbox:record")
      return {}
    }),
    markDone: mock(async () => {
      events.push("outbox:markDone")
    }),
  }

  await advance({}, h.deps)

  // Intent is recorded (ledger + outbox) before the side effect; then the
  // dispatched-state ledger write (taskId set, intent cleared) MUST land before
  // the outbox is settled — so a crash never leaves outbox=done + ledger=pending.
  const persistIdx = events.indexOf("persist:dispatched")
  const markDoneIdx = events.indexOf("outbox:markDone")
  expect(persistIdx).toBeGreaterThanOrEqual(0)
  expect(markDoneIdx).toBeGreaterThan(persistIdx)
  expect(events.indexOf("outbox:record")).toBeLessThan(persistIdx)
  expect(events.indexOf("persist:intent")).toBeLessThan(events.indexOf("outbox:record"))
})

test("#1 (cutover): answer-driven dispatch does NOT startTask when the lease renewal fails (expired/stolen)", async () => {
  const row = unit({
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "1. Do the thing.",
  })
  const h = harness([row])
  h.observations.set("1", { provider: "queued", prs: [] })

  const result = await advance(
    {
      modelAnswers: [{ requestId: "m1:1:review_plan", verdict: { decision: "approve" } }],
      renewLease: async () => false, // lease lost/expired mid-flight
    },
    h.deps,
  )

  // The irreversible build dispatch is aborted BEFORE startTask AND before any
  // intent is persisted, so no stuck intent wedges a retry — the next wake
  // re-asks and re-dispatches cleanly. The failure is audited.
  expect(h.deps.startTask).not.toHaveBeenCalled()
  expect(row.dispatch).toBeUndefined()
  expect(row.dispatchMode).toBe("plan") // never flipped to build
  expect(
    result.applied.some((a) => a.includes("error applying answer") && a.includes("review_plan")),
  ).toBe(true)
})

test("#1 (cutover): a SUCCESSFUL lease renewal lets the answer-driven dispatch proceed", async () => {
  const row = unit({
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "1. Do the thing.",
  })
  const h = harness([row])
  h.observations.set("1", { provider: "queued", prs: [] })
  const renew = mock(async () => true)

  await advance(
    {
      modelAnswers: [{ requestId: "m1:1:review_plan", verdict: { decision: "approve" } }],
      renewLease: renew,
    },
    h.deps,
  )

  expect(renew).toHaveBeenCalled()
  const buildCall = (
    h.deps.startTask as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls.find((c) => (c[1] as { createPullRequest?: boolean }).createPullRequest === true)
  expect(buildCall).toBeDefined()
  expect(row.dispatchMode).toBe("build")
})

test("#3 (replay guard): a redelivered review_plan answer with a dispatch intent already set does NOT start a second task", async () => {
  const row = unit({
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "1. Do the thing.",
    dispatch: { id: "dispatch:octo/repo#unit@1", requestedMs: 1, attempts: 1 },
  })
  const h = harness([row])
  h.observations.set("1", { provider: "completed", prs: [] })

  await advance(
    { modelAnswers: [{ requestId: "m1:1:review_plan", verdict: { decision: "approve" } }] },
    h.deps,
  )

  expect(h.deps.startTask).not.toHaveBeenCalled()
  // The pending intent is preserved — recovery, not a re-dispatch, resolves it,
  // and `attempt` is NOT bumped.
  expect(row.dispatch?.id).toBe("dispatch:octo/repo#unit@1")
})

test("#3 (replay guard): a review_plan answer is ignored once the unit has left the plan-review state (covers refine replay)", async () => {
  // A redelivered approve/refine (e.g. a re-drained inbox entry after a
  // crash-before-ack) must not re-dispatch: a successor task has already moved
  // the provider off "completed".
  const row = unit({
    provider: "queued",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "1. Do the thing.",
  })
  const h = harness([row])
  h.observations.set("1", { provider: "queued", prs: [] })

  await advance(
    {
      modelAnswers: [
        { requestId: "m1:1:review_plan", verdict: { decision: "refine", instruction: "again" } },
      ],
    },
    h.deps,
  )

  expect(h.deps.startTask).not.toHaveBeenCalled()
})

test("#4a: a merge throw restores the approval (retryable) and does NOT mark the unit terminal", async () => {
  const row = unit({
    issue: 7,
    pr: 7,
    provider: "completed",
    phase: "merge",
    artifact: "pr_open",
    validation: "floor_passed",
    dispatchMode: "build",
    floorSha: "head-7",
  })
  const h = harness([row])
  h.observations.set("7", {
    provider: "completed",
    prs: [openPr(7, "head-7")],
    ci: { rollup: "passing" },
    floor: "passed",
  })
  h.deps.verifyAndConsumeApproval = mock(async () => ({ ok: true }))
  h.deps.mergePullRequest = mock(async () => {
    throw new Error("merge 503")
  })

  await advance({}, h.deps)

  expect(h.deps.verifyAndConsumeApproval).toHaveBeenCalledTimes(1)
  expect(h.deps.mergePullRequest).toHaveBeenCalledTimes(1)
  // The single-use approval is RESTORED so a later wake can retry rather than
  // silently losing the human's Approve.
  expect(h.deps.releaseApproval).toHaveBeenCalledTimes(1)
  expect(h.deps.releaseApproval).toHaveBeenCalledWith({
    repo: { owner: "octo", name: "repo" },
    pr: 7,
    headSha: "head-7",
  })
  expect(row.terminal ?? false).toBe(false)
  expect(row.artifact).not.toBe("pr_merged")
})

test("#4a: an already-MERGED PR is reconciled as success without calling merge again", async () => {
  const row = unit({
    issue: 7,
    pr: 7,
    provider: "completed",
    phase: "merge",
    artifact: "pr_open",
    validation: "floor_passed",
    dispatchMode: "build",
  })
  const h = harness([row])
  h.observations.set("7", {
    provider: "completed",
    prs: [openPr(7, "head-7")],
    floor: "passed",
  })
  h.deps.getPullRequestState = mock(async (_r: { owner: string; repo: string }, pr: number) => ({
    number: pr,
    title: "PR",
    isDraft: false,
    state: "MERGED",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    headSha: `head-${pr}`,
    baseRef: "main",
    baseSha: `base-${pr}`,
  }))

  const result = await advance({}, h.deps)

  // Reconciled as success (a prior 5xx that actually merged) — no second merge,
  // no approval consumed, so a restored approval can never be double-spent.
  expect(h.deps.mergePullRequest).not.toHaveBeenCalled()
  expect(h.deps.verifyAndConsumeApproval).not.toHaveBeenCalled()
  expect(row.terminal).toBe(true)
  expect(row.artifact).toBe("pr_merged")
  expect(result.applied.some((a) => a.includes("already-merged"))).toBe(true)
})

test("#4b: a recordApproval failure aborts before clearing the block or answering the decision", async () => {
  const row = unit({
    issue: 7,
    pr: 7,
    provider: "in_progress",
    phase: "merge",
    validation: "floor_passed",
    verifierAssigned: true,
    blockingDecisionId: "dec-rec",
  })
  const h = harness([row])
  h.deps.findByKey = mock(async () => ({ decisionId: "dec-rec" }) as never)
  // The decision must exist (pending) so reconciliation leaves the block intact
  // when recordApproval fails — the invariant under test.
  h.decisions.push({
    decisionId: "dec-rec",
    decisionKey: "req-rec",
    type: "merge_approval",
    status: "pending",
    inputFingerprint: "fp",
    createdMs: 1,
  })
  h.deps.recordApproval = mock(async () => {
    throw new Error("ledger 503")
  })

  const result = await advance(
    { humanDecisions: [{ requestId: "req-rec", choice: "approve" }] },
    h.deps,
  )

  expect(h.deps.recordApproval).toHaveBeenCalledTimes(1)
  // The human's Approve is not lost: the decision stays un-answered and the unit
  // stays blocked for a clean re-enqueued retry.
  expect(h.deps.markAnswered).not.toHaveBeenCalled()
  expect(row.blockingDecisionId).toBe("dec-rec")
  expect(result.applied.some((a) => a.includes("error applying decision"))).toBe(true)
})

// ---------------------------------------------------------------------------
// Commit A friction fixes: A1 (blocked-observe), A2 (retry cap), A3 (spurious
// done), A4 (draft verifier), A5 (stale-review dismiss), A6 (empty-PR guard),
// and the reconciliation sweep.
// ---------------------------------------------------------------------------

function pending(decisionId: string, type: string): DecisionRecord {
  return {
    decisionId,
    decisionKey: `key-${decisionId}`,
    type,
    status: "pending",
    inputFingerprint: "fp",
    createdMs: 1,
  }
}

const mergedPr = (number: number, headSha: string): Observed["prs"][number] => ({
  number,
  headSha,
  isDraft: false,
  state: "MERGED",
  merged: true,
})

test("A1: a blocked merge_approval whose pinned PR merged out-of-band reconciles to floor_passed done", async () => {
  const row = unit({
    issue: 7,
    pr: 7,
    provider: "in_progress",
    phase: "merge",
    validation: "floor_passed",
    verifierAssigned: true,
    headSha: "head-7",
    floorSha: "head-7",
    blockingDecisionId: "dec-m",
  })
  const h = harness([row])
  h.decisions.push(pending("dec-m", "merge_approval"))
  h.observations.set("7", {
    provider: "in_progress",
    prs: [mergedPr(7, "head-7")],
    externalMutation: "merged",
  })

  await advance({}, h.deps)

  expect(row.terminal).toBe(true)
  expect(row.artifact).toBe("pr_merged")
  expect(row.validation).toBe("floor_passed")
  expect(row.blockingDecisionId).toBeNull()
  expect(h.deps.markAnswered).toHaveBeenCalledWith("dec-m", "superseded_external_merge", "external")
  // A blocked unit never runs classify/execute — no review side effects.
  expect(h.deps.requestReview).not.toHaveBeenCalled()
})

test("A1: a blocked merge_approval merged at a head PAST the floor verdict is NOT laundered into floor_passed", async () => {
  const row = unit({
    issue: 12,
    pr: 12,
    provider: "in_progress",
    phase: "merge",
    validation: "floor_passed",
    verifierAssigned: true,
    headSha: "new-head",
    floorSha: "old-verified-head",
    blockingDecisionId: "dec-stale",
  })
  const h = harness([row])
  h.decisions.push(pending("dec-stale", "merge_approval"))
  h.observations.set("12", {
    provider: "in_progress",
    prs: [mergedPr(12, "new-head")],
    externalMutation: "merged",
  })

  await advance({}, h.deps)

  // Merged at new-head, but the floor verdict was for old-verified-head → the
  // verified state is stale; record the honest unverified merge, never launder.
  expect(row.terminal).toBe(true)
  expect(row.validation).toBe("external_merge_unverified")
  expect(row.validation).not.toBe("floor_passed")
})

test("A1: a blocked retry-cap (human_decision) unit merged out-of-band is external_merge_unverified, NOT floor_passed", async () => {
  const row = unit({
    issue: 8,
    pr: 8,
    provider: "in_progress",
    phase: "fix",
    validation: "ci_failed",
    headSha: "head-8",
    blockingDecisionId: "dec-h",
  })
  const h = harness([row])
  h.decisions.push(pending("dec-h", "human_decision"))
  h.observations.set("8", {
    provider: "in_progress",
    prs: [mergedPr(8, "head-8")],
    externalMutation: "merged",
  })

  await advance({}, h.deps)

  expect(row.terminal).toBe(true)
  expect(row.artifact).toBe("pr_merged")
  expect(row.validation).toBe("external_merge_unverified")
  expect(row.validation).not.toBe("floor_passed")
  expect(h.deps.markAnswered).toHaveBeenCalledWith(
    "dec-h",
    "superseded_external_merge_unverified",
    "external",
  )
})

test("A1: an uncorrelated external merge on a blocked unit does NOT mark it done", async () => {
  const row = unit({
    issue: 9,
    pr: null,
    provider: "in_progress",
    blockingDecisionId: "dec-u",
  })
  const h = harness([row])
  h.decisions.push(pending("dec-u", "human_decision"))
  h.observations.set("9", {
    provider: "in_progress",
    prs: [],
    externalMutation: "merged_uncorrelated",
  })

  await advance({}, h.deps)

  expect(row.terminal ?? false).toBe(false)
  expect(row.blockingDecisionId).toBe("dec-u")
  expect(h.deps.markAnswered).not.toHaveBeenCalled()
})

test("A1: a blocked unit whose PR was closed out-of-band reconciles to cancelled_external_close", async () => {
  const row = unit({
    issue: 10,
    pr: 10,
    provider: "in_progress",
    headSha: "head-10",
    blockingDecisionId: "dec-c",
  })
  const h = harness([row])
  h.decisions.push(pending("dec-c", "human_decision"))
  h.observations.set("10", {
    provider: "in_progress",
    prs: [{ number: 10, headSha: "head-10", isDraft: false, state: "CLOSED" }],
    externalMutation: "closed",
  })

  await advance({}, h.deps)

  expect(row.terminal).toBe(true)
  expect(row.artifact).toBe("pr_closed")
  expect(row.validation).toBe("cancelled_external_close")
  expect(h.deps.markAnswered).toHaveBeenCalledWith("dec-c", "cancelled_external_close", "external")
})

test("A1: a benign blocked unit stays blocked with no side effects", async () => {
  const row = unit({
    issue: 11,
    pr: 11,
    provider: "in_progress",
    validation: "floor_passed",
    blockingDecisionId: "dec-b",
  })
  const h = harness([row])
  h.decisions.push(pending("dec-b", "merge_approval"))
  h.observations.set("11", { provider: "in_progress", prs: [openPr(11, "head-11")] })

  await advance({}, h.deps)

  expect(row.terminal ?? false).toBe(false)
  expect(row.blockingDecisionId).toBe("dec-b")
  expect(h.deps.requestReview).not.toHaveBeenCalled()
  expect(h.deps.submitReview).not.toHaveBeenCalled()
  expect(h.deps.markAnswered).not.toHaveBeenCalled()
})

test("A2: retries reset only when the failure signature changes; a head-move with the same signature does not reset", async () => {
  const obsSame: Observed = {
    provider: "completed",
    prs: [openPr(7, "new-head")],
    ci: { rollup: "failing" },
  }
  const sameSig = failureSignature(obsSame)
  const rowSame = unit({
    issue: 2,
    pr: 7,
    taskId: "task-2",
    provider: "completed",
    phase: "fix",
    dispatchMode: "build",
    retries: 3,
    headSha: "old-head",
    lastFailSig: sameSig,
  })
  const h1 = harness([rowSame])
  h1.observations.set("2", obsSame)

  await advance({}, h1.deps)
  // Same failure recurring — even though the head moved — does NOT reset.
  expect(rowSame.retries).toBe(3)

  const rowDiff = unit({
    issue: 3,
    pr: 8,
    taskId: "task-3",
    provider: "completed",
    phase: "fix",
    dispatchMode: "build",
    retries: 3,
    headSha: "h8",
    lastFailSig: "ci=passing|review=none|floor=none|findings=x",
  })
  const h2 = harness([rowDiff])
  h2.observations.set("3", { provider: "completed", prs: [openPr(8, "h8")], ci: { rollup: "failing" } })

  await advance({}, h2.deps)
  // A different (new) failure is genuine progress → reset to 0.
  expect(rowDiff.retries).toBe(0)
})

test("A2: applying an author_fix answer increments both retries and totalFixes and stamps the sentinel", async () => {
  const row = unit({
    issue: 5,
    pr: 10,
    taskId: "task-5",
    provider: "in_progress",
    phase: "fix",
    retries: 2,
    totalFixes: 4,
  })
  const h = harness([row])
  h.observations.set("5", { provider: "in_progress", prs: [openPr(10, "h10")], ci: { rollup: "failing" } })

  await advance(
    { modelAnswers: [{ requestId: "m1:5:author_fix", verdict: { instruction: "fix it" } }] },
    h.deps,
  )

  expect(row.totalFixes).toBe(5)
  expect(row.retries).toBe(3)
  const call = (h.deps.submitReview as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
  expect(String(call[3])).toContain("first-mate-review:")
})

test("A2: a unit at the total-fix hard cap escalates even under the per-failure cap", async () => {
  const row = unit({
    issue: 4,
    pr: 9,
    taskId: "task-4",
    provider: "completed",
    phase: "fix",
    dispatchMode: "build",
    retries: 0,
    totalFixes: 10,
  })
  const h = harness([row])
  h.observations.set("4", { provider: "completed", prs: [openPr(9, "h9")], ci: { rollup: "failing" } })

  const result = await advance({}, h.deps)

  expect(result.needsModel).toHaveLength(0)
  expect(result.needsHuman).toHaveLength(1)
  expect(row.blockingDecisionId).toBeTruthy()
})

test("author_fix mentions @copilot on the same branch (alongside the formal verdict) when an open PR exists", async () => {
  const row = unit({
    issue: 5,
    pr: 10,
    taskId: "task-5",
    provider: "in_progress",
    phase: "fix",
    headSha: "h10",
    retries: 1,
    totalFixes: 1,
  })
  const h = harness([row])
  h.observations.set("5", { provider: "in_progress", prs: [openPr(10, "h10")], ci: { rollup: "failing" } })

  await advance(
    { modelAnswers: [{ requestId: "m1:5:author_fix", verdict: { instruction: "fix the failing test" } }] },
    h.deps,
  )

  const mention = h.deps.mentionCopilot as unknown as { mock: { calls: unknown[][] } }
  expect(mention.mock.calls).toHaveLength(1)
  const call = mention.mock.calls[0]!
  expect(call[1]).toBe(10) // pr number
  expect(String(call[2])).toContain("fix the failing test")
  // The formal REQUEST_CHANGES verdict still rides alongside the mention.
  expect(h.deps.submitReview).toHaveBeenCalled()
  // Head SHA recorded at mention time; one-outstanding-per-PR bookkeeping.
  expect(row.copilotMentionSha).toBe("h10")
  expect(row.copilotComments).toBe(1)
})

test("author_fix falls back to the review-only steer when the head has NOT advanced past the last @copilot mention", async () => {
  const row = unit({
    issue: 5,
    pr: 10,
    taskId: "task-5",
    provider: "in_progress",
    phase: "fix",
    headSha: "h10",
    copilotMentionSha: "h10",
    copilotComments: 1,
    retries: 1,
    totalFixes: 1,
  })
  const h = harness([row])
  h.observations.set("5", { provider: "in_progress", prs: [openPr(10, "h10")], ci: { rollup: "failing" } })

  await advance(
    { modelAnswers: [{ requestId: "m1:5:author_fix", verdict: { instruction: "still failing" } }] },
    h.deps,
  )

  // Mention already outstanding (head unchanged) → no fresh @copilot comment,
  // but the formal REQUEST_CHANGES steer still fires (the fresh-dispatch fallback).
  expect(h.deps.mentionCopilot).not.toHaveBeenCalled()
  expect(h.deps.submitReview).toHaveBeenCalled()
  expect(row.copilotComments).toBe(1) // unchanged
})

test("author_fix re-mentions @copilot once the head advances past the prior mention", async () => {
  const row = unit({
    issue: 5,
    pr: 10,
    taskId: "task-5",
    provider: "in_progress",
    phase: "fix",
    headSha: "h11",
    copilotMentionSha: "h10",
    copilotComments: 1,
    retries: 1,
    totalFixes: 1,
  })
  const h = harness([row])
  h.observations.set("5", { provider: "in_progress", prs: [openPr(10, "h11")], ci: { rollup: "failing" } })

  await advance(
    { modelAnswers: [{ requestId: "m1:5:author_fix", verdict: { instruction: "another pass" } }] },
    h.deps,
  )

  expect(h.deps.mentionCopilot).toHaveBeenCalledTimes(1)
  expect(row.copilotMentionSha).toBe("h11")
  expect(row.copilotComments).toBe(2)
})

test("author_fix escalates to a human (no steer) when the per-mission fix-cycle budget is exhausted", async () => {
  const row = unit({
    issue: 5,
    pr: 10,
    taskId: "task-5",
    provider: "in_progress",
    phase: "fix",
    headSha: "h10",
    fixCycles: 2,
    retries: 1,
    totalFixes: 1,
  })
  const h = harness([row], [mission({ maxFixCycles: 2 })])
  h.observations.set("5", { provider: "in_progress", prs: [openPr(10, "h10")], ci: { rollup: "failing" } })

  const result = await advance(
    { modelAnswers: [{ requestId: "m1:5:author_fix", verdict: { instruction: "fix" } }] },
    h.deps,
  )

  // At the cap: STOP iterating — no mention, no review — and escalate to a human.
  expect(h.deps.mentionCopilot).not.toHaveBeenCalled()
  expect(h.deps.submitReview).not.toHaveBeenCalled()
  expect(result.needsHuman.length).toBeGreaterThanOrEqual(1)
  expect(row.blockingDecisionId).toBeTruthy()
})

test("author_fix escalates when the per-mission @copilot comment budget is exhausted", async () => {
  const row = unit({
    issue: 5,
    pr: 10,
    taskId: "task-5",
    provider: "in_progress",
    phase: "fix",
    headSha: "h11",
    copilotMentionSha: "h10", // head advanced → a fresh mention would be attempted
    copilotComments: 3,
    retries: 1,
    totalFixes: 1,
  })
  const h = harness([row], [mission({ maxCopilotComments: 3 })])
  h.observations.set("5", { provider: "in_progress", prs: [openPr(10, "h11")], ci: { rollup: "failing" } })

  const result = await advance(
    { modelAnswers: [{ requestId: "m1:5:author_fix", verdict: { instruction: "fix" } }] },
    h.deps,
  )

  expect(h.deps.mentionCopilot).not.toHaveBeenCalled()
  expect(result.needsHuman.length).toBeGreaterThanOrEqual(1)
  expect(row.blockingDecisionId).toBeTruthy()
})

test("A3: an uncorrelated merged PR does not mark the unit done, so its dependents stay gated", async () => {
  const dep = unit({ id: "depA", issue: 1, taskId: "task-A", provider: "in_progress", title: "A" })
  const child = unit({
    id: "childB",
    issue: 2,
    taskId: null,
    provider: "none",
    dependsOn: ["depA"],
    title: "B",
  })
  const h = harness([dep, child])
  h.observations.set("1", { provider: "in_progress", prs: [], externalMutation: "merged_uncorrelated" })

  await advance({}, h.deps)

  expect(dep.terminal ?? false).toBe(false)
  expect(dep.artifact).not.toBe("pr_merged")
  expect(child.taskId).toBeNull()
})

test("A3: depsSatisfied rejects a dependency marked pr_merged with pr:null", async () => {
  const dep = unit({
    id: "dep",
    issue: 1,
    taskId: "task-1",
    terminal: true,
    artifact: "pr_merged",
    pr: null,
    phase: "done",
    provider: "completed",
  })
  const child = unit({
    id: "child",
    issue: 2,
    taskId: null,
    provider: "none",
    dependsOn: ["dep"],
    title: "child",
  })
  const h = harness([dep, child])

  await advance({}, h.deps)

  expect(child.taskId).toBeNull()
})

test("A3: a correlated primaryPr is adopted as unit.pr even in the multi-PR case", async () => {
  const row = unit({ issue: 1, pr: null, taskId: "task-1", provider: "in_progress" })
  const h = harness([row])
  h.observations.set("1", {
    provider: "in_progress",
    prs: [openPr(5, "h5"), openPr(6, "h6")],
    primaryPr: 5,
  })

  await advance({}, h.deps)

  expect(row.pr).toBe(5)
})

test("A4: a draft PR is marked ready for review before the verifier is requested", async () => {
  const row = unit({
    issue: null,
    pr: 5,
    taskId: "task-1",
    provider: "completed",
    phase: "review",
    dispatchMode: "build",
    verifierAssigned: false,
    branch: "copilot/feat",
  })
  const h = harness([row])
  h.observations.set("task-1", {
    provider: "completed",
    prs: [{ number: 5, headSha: "h5", isDraft: true, state: "OPEN" }],
    ci: { rollup: "none", noCi: true },
    prNodeId: "PR_5",
  })

  await advance({}, h.deps)

  expect(h.deps.markReadyForReview).toHaveBeenCalledWith("PR_5")
  expect(h.deps.requestReview).toHaveBeenCalledTimes(1)
})

test("A4: a non-draft PR is not marked ready before the verifier", async () => {
  const row = unit({
    issue: null,
    pr: 5,
    taskId: "task-1",
    provider: "completed",
    phase: "review",
    dispatchMode: "build",
    verifierAssigned: false,
    branch: "copilot/feat",
  })
  const h = harness([row])
  h.observations.set("task-1", {
    provider: "completed",
    prs: [{ number: 5, headSha: "h5", isDraft: false, state: "OPEN" }],
    ci: { rollup: "none", noCi: true },
  })

  await advance({}, h.deps)

  expect(h.deps.markReadyForReview).not.toHaveBeenCalled()
  expect(h.deps.requestReview).toHaveBeenCalledTimes(1)
})

test("A5: dismisses only first-mate's own stale review; a human CHANGES_REQUESTED survives", async () => {
  const row = unit({ issue: 1, pr: 7, taskId: "task-1", provider: "in_progress", headSha: "head-new" })
  const h = harness([row])
  h.observations.set("1", {
    provider: "in_progress",
    prs: [openPr(7, "head-new")],
    reviewDecision: "CHANGES_REQUESTED",
  })
  const dismissed = new Set<string>()
  const allReviews = [
    { author: "copilot", state: "CHANGES_REQUESTED", bodyExcerpt: "old <!-- first-mate-review:1 -->", commitId: "head-old", nodeId: "R_fm" },
    { author: "human", state: "CHANGES_REQUESTED", bodyExcerpt: "I disagree", commitId: "head-old", nodeId: "R_human" },
    { author: "copilot", state: "CHANGES_REQUESTED", bodyExcerpt: "at head <!-- first-mate-review:1 -->", commitId: "head-new", nodeId: "R_fm_athead" },
  ]
  h.deps.getPullRequestReviews = mock(async () => allReviews.filter((r) => !dismissed.has(r.nodeId)))
  h.deps.dismissPullRequestReview = mock(async (nodeId: string) => {
    dismissed.add(nodeId)
    return { dismissed: true as const }
  })

  await advance({}, h.deps)

  // Only the stale (commit != head) sentinel-stamped review is dismissed.
  expect([...dismissed]).toEqual(["R_fm"])
})

test("A5: after dismissing a stale own review, a human APPROVE is preserved (no author_fix)", async () => {
  const row = unit({
    issue: 1,
    pr: 7,
    taskId: "task-1",
    provider: "in_progress",
    headSha: "head-new",
    verifierAssigned: false,
  })
  const h = harness([row])
  h.observations.set("1", {
    provider: "in_progress",
    prs: [openPr(7, "head-new")],
    ci: { rollup: "passing" },
    reviewDecision: "CHANGES_REQUESTED",
  })
  const dismissed = new Set<string>()
  const allReviews = [
    { author: "copilot", state: "CHANGES_REQUESTED", bodyExcerpt: "stale <!-- first-mate-review:1 -->", commitId: "head-old", nodeId: "R_fm" },
    { author: "human", state: "APPROVED", bodyExcerpt: "lgtm", commitId: "head-new", nodeId: "R_h" },
  ]
  h.deps.getPullRequestReviews = mock(async () => allReviews.filter((r) => !dismissed.has(r.nodeId)))
  h.deps.dismissPullRequestReview = mock(async (nodeId: string) => {
    dismissed.add(nodeId)
    return { dismissed: true as const }
  })

  await advance({}, h.deps)

  // reviewDecision recomputed to APPROVED → ci_passed → assign_verifier, NOT the
  // changes_requested → author_fix path (which would post a REQUEST_CHANGES).
  expect([...dismissed]).toEqual(["R_fm"])
  expect(h.deps.requestReview).toHaveBeenCalledTimes(1)
  expect(h.deps.submitReview).not.toHaveBeenCalled()
})

test("A5: GH_ROUTER_FM_AUTO_DISMISS=0 disables the dismiss step", async () => {
  process.env.GH_ROUTER_FM_AUTO_DISMISS = "0"
  try {
    const row = unit({ issue: 1, pr: 7, taskId: "task-1", provider: "in_progress", headSha: "head-new" })
    const h = harness([row])
    h.observations.set("1", {
      provider: "in_progress",
      prs: [openPr(7, "head-new")],
      reviewDecision: "CHANGES_REQUESTED",
    })
    h.deps.getPullRequestReviews = mock(async () => [
      { author: "copilot", state: "CHANGES_REQUESTED", bodyExcerpt: "old <!-- first-mate-review:1 -->", commitId: "head-old", nodeId: "R_fm" },
    ])

    await advance({}, h.deps)

    expect(h.deps.dismissPullRequestReview).not.toHaveBeenCalled()
  } finally {
    delete process.env.GH_ROUTER_FM_AUTO_DISMISS
  }
})

test("A6/#12: an in-progress empty PR that just pushed does NOT escalate (head moved resets the counter)", async () => {
  const row = unit({
    issue: 1,
    pr: 7,
    taskId: "task-1",
    provider: "in_progress",
    phase: "build",
    dispatchMode: "build",
    headSha: "old-head",
    baseRef: "main",
    baseSha: "base-7",
    emptyObservations: 2,
  })
  const h = harness([row])
  h.observations.set("1", {
    provider: "in_progress",
    prs: [openPr(7, "new-head")], // head advanced since last wake
    ci: { rollup: "pending" },
    changedFiles: 0,
    diffTruncated: false,
  })

  const result = await advance({}, h.deps)

  expect(result.needsHuman).toHaveLength(0)
  // head moved → progress → counter reset to 0, then +1 for this empty observation.
  expect(row.emptyObservations).toBe(1)
})

test("A6/#12: a completed genuinely-empty PR escalates immediately (terminal), even after a provider-change reset", async () => {
  const row = unit({
    issue: 1,
    pr: 7,
    taskId: "task-1",
    provider: "in_progress", // was in progress last wake
    phase: "build",
    dispatchMode: "build",
    headSha: "h7",
    baseRef: "main",
    baseSha: "base-7",
    emptyObservations: 0,
  })
  const h = harness([row])
  h.observations.set("1", {
    provider: "completed", // now terminal
    prs: [openPr(7, "h7")],
    ci: { rollup: "passing" },
    changedFiles: 0,
    diffTruncated: false,
  })

  const result = await advance({}, h.deps)

  expect(result.needsHuman).toHaveLength(1)
  expect(result.needsHuman[0]?.reason).toContain("finished but its pull request has no changes")
})

test("A6/#12: a completed empty DRAFT PR still escalates (draft suppression dropped; task-state decides)", async () => {
  const row = unit({
    issue: 1,
    pr: 7,
    taskId: "task-1",
    provider: "completed",
    phase: "build",
    dispatchMode: "build",
    headSha: "h7",
    baseRef: "main",
    baseSha: "base-7",
    prIsDraft: true,
    emptyObservations: 0,
  })
  const h = harness([row])
  h.observations.set("1", {
    provider: "completed",
    prs: [openPr(7, "h7", { isDraft: true })],
    changedFiles: 0,
    diffTruncated: false,
  })

  const result = await advance({}, h.deps)

  expect(result.needsHuman).toHaveLength(1)
  expect(result.needsHuman[0]?.reason).toContain("finished but its pull request has no changes")
})

test("A6/#12: a hung in-progress empty PR (head frozen) escalates via the observation-cap fallback with a distinct reason", async () => {
  const row = unit({
    issue: 1,
    pr: 7,
    taskId: "task-1",
    provider: "in_progress", // never terminal — but stuck
    phase: "build",
    dispatchMode: "build",
    headSha: "h7", // matches observation → no head movement
    baseRef: "main",
    baseSha: "base-7",
    emptyObservations: 2, // one below the cap
  })
  const h = harness([row])
  h.observations.set("1", {
    provider: "in_progress",
    prs: [openPr(7, "h7")],
    ci: { rollup: "pending" },
    changedFiles: 0,
    diffTruncated: false,
  })

  const result = await advance({}, h.deps)

  expect(row.emptyObservations).toBe(3)
  expect(result.needsHuman).toHaveLength(1)
  expect(result.needsHuman[0]?.reason).toContain("head has not advanced")
})

test("A6/#12 (FIX 4): a TERMINAL empty PR escalates even with NO resolved base (a finished 0-change task IS empty)", async () => {
  const row = unit({
    issue: 1,
    pr: 7,
    taskId: "task-1",
    provider: "completed",
    phase: "build",
    dispatchMode: "build",
    headSha: "h7",
    emptyObservations: 5,
  })
  const h = harness([row])
  h.observations.set("1", {
    provider: "completed",
    prs: [openPr(7, "h7", { baseRef: undefined, baseSha: undefined })],
    changedFiles: 0,
    diffTruncated: false,
  })

  const result = await advance({}, h.deps)

  expect(result.needsHuman).toHaveLength(1)
  expect(result.needsHuman[0]?.reason).toContain("finished but its pull request has no changes")
})

test("A6/#12 (FIX 4): a NON-terminal stuck empty PR with NO resolved base does NOT escalate (transient-0 defense)", async () => {
  const row = unit({
    issue: 1,
    pr: 7,
    taskId: "task-1",
    provider: "in_progress", // NOT terminal → stuck fallback, which still needs a base
    phase: "build",
    dispatchMode: "build",
    headSha: "h7",
    emptyObservations: 5,
  })
  const h = harness([row])
  h.observations.set("1", {
    provider: "in_progress",
    prs: [openPr(7, "h7", { baseRef: undefined, baseSha: undefined })],
    ci: { rollup: "pending" },
    changedFiles: 0,
    diffTruncated: false,
  })

  const result = await advance({}, h.deps)

  expect(result.needsHuman).toHaveLength(0)
})

test("A6/#12 (FIX 3): a flapping provider status (queued↔in_progress) does NOT reset the stuck counter", async () => {
  const row = unit({
    issue: 1,
    pr: 7,
    taskId: "task-1",
    provider: "queued", // last wake was queued
    phase: "build",
    dispatchMode: "build",
    headSha: "h7", // frozen head → no real progress
    baseRef: "main",
    baseSha: "base-7",
    emptyObservations: 2, // one below the cap
  })
  const h = harness([row])
  h.observations.set("1", {
    provider: "in_progress", // provider FLAPPED (queued → in_progress); NOT progress
    prs: [openPr(7, "h7")],
    ci: { rollup: "pending" },
    changedFiles: 0,
    diffTruncated: false,
  })

  const result = await advance({}, h.deps)

  // Provider-status change is no longer a reset signal → counter climbs to the cap.
  expect(row.emptyObservations).toBe(3)
  expect(result.needsHuman).toHaveLength(1)
  expect(result.needsHuman[0]?.reason).toContain("head has not advanced")
})

test("A6/#12: a PR with real changes resets the empty counter and persists the observed base", async () => {
  const row = unit({
    issue: 1,
    pr: 7,
    taskId: "task-1",
    provider: "in_progress",
    phase: "build",
    dispatchMode: "build",
    headSha: "h7",
    emptyObservations: 2,
    verifierAssigned: false,
  })
  const h = harness([row])
  h.observations.set("1", {
    provider: "in_progress",
    prs: [openPr(7, "h7")],
    ci: { rollup: "passing" },
    changedFiles: 4,
    diffTruncated: false,
  })

  await advance({}, h.deps)

  expect(row.emptyObservations).toBe(0)
  // updateUnitFromObservedPrs pins the observed base identity on the unit.
  expect(row.baseSha).toBe("base-7")
  expect(row.baseRef).toBe("main")
})

test("A6/#12: a terminal task whose diff is not yet visible does NOT escalate as empty (changedFiles undefined ≠ 0)", async () => {
  const row = unit({
    issue: 1,
    pr: 7,
    taskId: "task-1",
    provider: "completed",
    phase: "build",
    dispatchMode: "build",
    headSha: "h7",
    baseRef: "main",
    baseSha: "base-7",
    emptyObservations: 2,
  })
  const h = harness([row])
  h.observations.set("1", {
    provider: "completed",
    prs: [openPr(7, "h7")],
    ci: { rollup: "passing" },
    // changedFiles intentionally omitted — the diff summary wasn't fetched.
  })

  const result = await advance({}, h.deps)

  expect(result.needsHuman).toHaveLength(0)
  // Not a certain empty → counter untouched (neither incremented nor reset).
  expect(row.emptyObservations).toBe(2)
})

test("A6/#12 (FIX 3): a flaky/missing provider status is NOT a progress signal — a frozen-head empty PR still reaches the cap", async () => {
  const row = unit({
    issue: 1,
    pr: 7,
    taskId: "task-1",
    provider: "in_progress",
    phase: "build",
    dispatchMode: "build",
    headSha: "h7",
    baseRef: "main",
    baseSha: "base-7",
    emptyObservations: 2, // one below the cap
  })
  const h = harness([row])
  h.observations.set("1", {
    provider: "none", // provider read flaked out / unknown this wake
    prs: [openPr(7, "h7")],
    changedFiles: 0,
    diffTruncated: false,
  })

  const result = await advance({}, h.deps)

  // A provider-status change (in_progress → none) is no longer treated as
  // progress: with the head frozen the empty counter climbs to the cap and the
  // stuck fallback escalates, rather than being reset forever by flapping.
  expect(row.emptyObservations).toBe(3)
  expect(result.needsHuman).toHaveLength(1)
  expect(result.needsHuman[0]?.reason).toContain("head has not advanced")
})

test("A6: a truncated empty summary does NOT count toward the empty cap, and changes reset it", async () => {
  const truncated = unit({
    issue: 1,
    pr: 7,
    taskId: "task-1",
    provider: "completed",
    phase: "review",
    dispatchMode: "build",
    headSha: "h7",
    baseRef: "main",
    baseSha: "base-7",
    emptyObservations: 2,
    verifierAssigned: false,
  })
  const h1 = harness([truncated])
  h1.observations.set("1", {
    provider: "completed",
    prs: [openPr(7, "h7")],
    ci: { rollup: "passing" },
    changedFiles: 0,
    diffTruncated: true,
  })
  const r1 = await advance({}, h1.deps)
  // A truncated 0 is not a certain empty → no escalation, counter untouched.
  expect(r1.needsHuman).toHaveLength(0)
  expect(truncated.emptyObservations).toBe(2)

  const withChanges = unit({
    issue: 2,
    pr: 8,
    taskId: "task-2",
    provider: "completed",
    phase: "review",
    dispatchMode: "build",
    headSha: "h8",
    baseRef: "main",
    baseSha: "base-8",
    emptyObservations: 2,
    verifierAssigned: false,
  })
  const h2 = harness([withChanges])
  h2.observations.set("2", {
    provider: "completed",
    prs: [openPr(8, "h8")],
    ci: { rollup: "passing" },
    changedFiles: 4,
    diffTruncated: false,
  })
  await advance({}, h2.deps)
  expect(withChanges.emptyObservations).toBe(0)
})

test("reconcile: a blockingDecisionId pointing at an absent decision is cleared", async () => {
  const row = unit({
    issue: 1,
    pr: 7,
    taskId: "task-1",
    provider: "in_progress",
    blockingDecisionId: "ghost",
  })
  const h = harness([row])
  h.observations.set("1", { provider: "in_progress", prs: [openPr(7, "h7")], ci: { rollup: "pending" } })

  await advance({}, h.deps)

  expect(row.blockingDecisionId).toBeNull()
})

test("reconcile: a terminal unit still holding a pending decision gets it answered", async () => {
  const row = unit({
    issue: 1,
    pr: 7,
    taskId: "task-1",
    terminal: true,
    phase: "done",
    artifact: "pr_merged",
    provider: "completed",
    blockingDecisionId: "dec-t",
  })
  const h = harness([row])
  h.decisions.push(pending("dec-t", "merge_approval"))

  await advance({}, h.deps)

  expect(h.deps.markAnswered).toHaveBeenCalledWith("dec-t", "reconciled_terminal", "system")
  expect(row.blockingDecisionId).toBeNull()
})

// --- cloud-agent model selection (mission.defaultModel → unit.model → dispatch) ---

function startTaskModels(h: Harness): Array<string | undefined> {
  return (h.deps.startTask as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
    (c) => (c[1] as { model?: string }).model,
  )
}

test("initial dispatch sends the default gpt-5.5 model when neither unit nor mission specifies one", async () => {
  state.models = undefined // no catalog → deterministic default
  const eligible = unit({ issue: 22, taskId: null, provider: "none", title: "eligible" })
  const h = harness([eligible])

  await advance({ maxInFlightPerProvider: 1 }, h.deps)

  expect(eligible.taskId).toBe("started-1")
  expect(startTaskModels(h)).toEqual(["gpt-5.5"])
})

test("initial dispatch uses the mission defaultModel when the unit has no override", async () => {
  state.models = undefined
  const eligible = unit({ issue: 23, taskId: null, provider: "none", title: "eligible" })
  const h = harness([eligible], [mission({ defaultModel: "gpt-5.4" })])

  await advance({ maxInFlightPerProvider: 1 }, h.deps)

  expect(startTaskModels(h)).toEqual(["gpt-5.4"])
})

test("initial dispatch — the per-unit model overrides the mission default", async () => {
  state.models = undefined
  const eligible = unit({
    issue: 24,
    taskId: null,
    provider: "none",
    title: "eligible",
    model: "gpt-5.3-codex",
  })
  const h = harness([eligible], [mission({ defaultModel: "gpt-5.4" })])

  await advance({ maxInFlightPerProvider: 1 }, h.deps)

  expect(startTaskModels(h)).toEqual(["gpt-5.3-codex"])
})

test("approve→build re-dispatch carries the resolved model (mission default here)", async () => {
  state.models = undefined
  const row = unit({
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "1. do the thing.",
  })
  const h = harness([row], [mission({ defaultModel: "gpt-5.4" })])
  h.observations.set("1", { provider: "queued", prs: [] })

  await advance(
    { modelAnswers: [{ requestId: "m1:1:review_plan", verdict: { decision: "approve" } }] },
    h.deps,
  )

  const buildCall = (
    h.deps.startTask as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls.find((c) => (c[1] as { createPullRequest?: boolean }).createPullRequest === true)
  expect(buildCall).toBeDefined()
  expect((buildCall![1] as { model?: string }).model).toBe("gpt-5.4")
})

test("refine→plan re-dispatch carries the resolved model (unit override here)", async () => {
  state.models = undefined
  const row = unit({
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "old plan",
    model: "gpt-5.3-codex",
  })
  const h = harness([row], [mission({ defaultModel: "gpt-5.4" })])
  h.observations.set("1", { provider: "queued", prs: [] })

  await advance(
    {
      modelAnswers: [
        {
          requestId: "m1:1:review_plan",
          verdict: { decision: "refine", instruction: "Add more detail." },
        },
      ],
    },
    h.deps,
  )

  const planCall = (
    h.deps.startTask as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls.find(
    (c) => (c[1] as { createPullRequest?: boolean }).createPullRequest === false,
  )
  expect(planCall).toBeDefined()
  expect((planCall![1] as { model?: string }).model).toBe("gpt-5.3-codex")
})

test("decompose stamps unit.model from the spec, else the mission default, else undefined", async () => {
  state.models = undefined
  const m = mission({ id: "m-mdl", goal: "Build it", defaultModel: "gpt-5.4" })
  const h = harness([], [m])

  await advance(
    {
      modelAnswers: [
        {
          requestId: "decompose:m-mdl",
          verdict: {
            units: [
              { title: "with override", model: "gpt-5.3-codex" },
              { title: "inherits mission default" },
            ],
          },
        },
      ],
    },
    h.deps,
  )

  const withOverride = h.units.find((u) => u.title === "with override")
  const inherited = h.units.find((u) => u.title === "inherits mission default")
  expect(withOverride?.model).toBe("gpt-5.3-codex")
  expect(inherited?.model).toBe("gpt-5.4")
})

test("catalog present: a bad-model unit leaves no dispatch residue and does not abort the wave", async () => {
  // #4 — the model-selection tests above all run with state.models=undefined, so
  // resolveCloudAgentModel's throw path (explicit-invalid model + live catalog)
  // was NEVER exercised through dispatchWithOutbox. With a populated catalog the
  // per-unit model resolves BEFORE the dispatch intent is persisted (#1), so a
  // bad model throws with ZERO durable residue while the valid sibling dispatches.
  const savedModels = state.models
  // @ts-expect-error - partial model data for testing
  state.models = { object: "list", data: [{ id: "gpt-5.5" }, { id: "gpt-5.4" }] }
  try {
    const good = unit({ issue: 30, taskId: null, provider: "none", title: "good", model: "gpt-5.4" })
    const bad = unit({
      issue: 31,
      taskId: null,
      provider: "none",
      title: "bad",
      model: "gpt-does-not-exist",
    })
    const h = harness([good, bad])

    const result = await advance({ maxInFlightPerProvider: 5 }, h.deps)

    // (a) the valid-model unit still dispatches — a bad sibling doesn't abort the wave.
    expect(good.taskId).toBe("started-1")
    expect(startTaskModels(h)).toEqual(["gpt-5.4"])

    // (b) the invalid-model unit leaves NO durable residue: no dangling dispatch
    //     intent, still undispatched, and no false-orphan "dispatch interrupted"
    //     human escalation on the next wake.
    expect(bad.dispatch).toBeUndefined()
    expect(bad.taskId).toBeNull()
    expect(bad.provider).toBe("none")
    expect(result.needsHuman.some((r) => r.reason.includes("dispatch interrupted"))).toBe(false)
  } finally {
    state.models = savedModels
  }
})

test("catalog present: decompose with an invalid explicit unit model fails fast (no units created)", async () => {
  // #2 — an invalid per-unit model in a decompose spec is validated at INPUT time
  // (before any unit is created), so it never persists a unit that would throw
  // every wake at dispatch. The applySubmittedAnswers per-answer catch surfaces
  // the actionable message; no partial units land.
  const savedModels = state.models
  // @ts-expect-error - partial model data for testing
  state.models = { object: "list", data: [{ id: "gpt-5.5" }] }
  try {
    const m = mission({ id: "m-bad", goal: "Build it" })
    const h = harness([], [m])

    const result = await advance(
      {
        modelAnswers: [
          {
            requestId: "decompose:m-bad",
            verdict: { units: [{ title: "bad model", model: "gpt-nope" }] },
          },
        ],
      },
      h.deps,
    )

    expect(h.units.length).toBe(0) // validation threw before any upsertUnit
    expect(result.applied.some((a) => a.includes("not in the Copilot catalog"))).toBe(true)
  } finally {
    state.models = savedModels
  }
})

test("soft plan gate: a passing plan review auto-dispatches build with NO needsHuman", async () => {
  const row = unit({
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "1. Bump Flask to 3.x. 2. Add pyproject.toml.",
  })
  const h = harness([row], [mission({ planGate: "soft" })])
  h.observations.set("1", { provider: "queued", prs: [] })

  const result = await advance(
    { modelAnswers: [{ requestId: "m1:1:review_plan", verdict: { decision: "approve" } }] },
    h.deps,
  )

  // Passing review under a soft gate advances straight to build — same as hard —
  // and never surfaces a human decision.
  const buildCall = (
    h.deps.startTask as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls.find((c) => (c[1] as { createPullRequest?: boolean }).createPullRequest === true)
  expect(buildCall).toBeDefined()
  expect((buildCall![1] as { prompt: string }).prompt).toContain("1. Bump Flask to 3.x.")
  expect(row.dispatchMode).toBe("build")
  expect(result.needsHuman).toHaveLength(0)
})

test("soft plan gate: a rejecting plan review escalates to a human and does NOT re-dispatch a plan task", async () => {
  const row = unit({
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "old plan",
  })
  const h = harness([row], [mission({ planGate: "soft" })])
  h.observations.set("1", { provider: "completed", prs: [] })

  const result = await advance(
    {
      modelAnswers: [
        {
          requestId: "m1:1:review_plan",
          verdict: { decision: "refine", instruction: "This plan is wrong." },
        },
      ],
    },
    h.deps,
  )

  // Escalated to a human decision carrying the reviewer feedback.
  expect(result.needsHuman.length).toBeGreaterThanOrEqual(1)
  const human = result.needsHuman.find((r) => r.reason.includes("plan review rejected"))
  expect(human).toBeDefined()
  expect(human!.reason).toContain("This plan is wrong.")
  expect(row.blockingDecisionId).toBeDefined()
  // No plan-refine task was dispatched (the human is now in the loop).
  expect(h.deps.startTask).not.toHaveBeenCalled()
  // And the unit is blocked, so the sweep did not re-emit a review_plan.
  expect(result.needsModel.some((r) => r.kind === "review_plan")).toBe(false)
})

test("hard plan gate (default): a rejecting review re-dispatches a plan task, no human escalation", async () => {
  const row = unit({
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "old plan",
  })
  // Default mission() has no planGate → treated as hard.
  const h = harness([row])
  h.observations.set("1", { provider: "queued", prs: [] })

  const result = await advance(
    {
      modelAnswers: [
        {
          requestId: "m1:1:review_plan",
          verdict: { decision: "refine", instruction: "Cover Python 3.12 too." },
        },
      ],
    },
    h.deps,
  )

  const planCall = (
    h.deps.startTask as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls.find((c) => {
    const input = c[1] as { createPullRequest?: boolean; prompt: string }
    return input.createPullRequest === false && input.prompt.includes("Cover Python 3.12 too.")
  })
  expect(planCall).toBeDefined()
  expect(row.dispatchMode).toBe("plan")
  expect(result.needsHuman).toHaveLength(0)
})

test("planPrompt instructs writing durable research + plan artifacts under docs/", () => {
  const prompt = planPrompt(
    unit({ title: "Upgrade Flask to 3.x" }),
    mission(),
    "2026-07-05",
  )
  const slug = artifactSlug(unit({ title: "Upgrade Flask to 3.x" }))
  expect(slug).toBe("upgrade-flask-to-3-x")
  expect(prompt).toContain(`docs/research/2026-07-05-${slug}.md`)
  expect(prompt).toContain(`docs/plans/2026-07-05-${slug}.md`)
})

test("buildPrompt instructs reading the committed plan and updating LEARNINGS.md", () => {
  const row = unit({ title: "Upgrade Flask to 3.x", planExcerpt: "step 1" })
  const prompt = buildPrompt(row, mission(), "2026-07-05")
  const slug = artifactSlug(row)
  expect(prompt).toContain(`docs/plans/2026-07-05-${slug}.md`)
  expect(prompt).toContain(`docs/research/2026-07-05-${slug}.md`)
  expect(prompt).toContain("LEARNINGS.md")
})

test("scoped drive counts the per-provider cap over ALL missions (not just the scoped set)", async () => {
  // FIX 3: a mission-scoped advance must honor the GLOBAL per-provider cap. m2
  // has a copilot task already in flight; a scoped drive on m1 (cap=1) must NOT
  // dispatch m1's undispatched copilot unit — otherwise two scoped drives could
  // each reach the cap and blow through 2x the intended global concurrency.
  const inflightM2 = unit({
    missionId: "m2",
    issue: 50,
    taskId: "t-m2",
    provider: "in_progress",
    phase: "build",
    title: "m2 inflight",
  })
  const pendingM1 = unit({
    missionId: "m1",
    issue: 51,
    taskId: null,
    provider: "none",
    phase: "plan",
    title: "m1 pending",
  })
  const h = harness([inflightM2, pendingM1], [mission({ id: "m1" }), mission({ id: "m2" })])

  await advance({ missionId: "m1", maxInFlightPerProvider: 1 }, h.deps)

  // The global cap is already saturated by m2's in-flight copilot task, so m1's
  // unit stays undispatched. (Counting only scopedUnits would have seen 0 and
  // dispatched it — the 2x-over-cap bug.)
  expect(pendingM1.taskId).toBeNull()
  expect(pendingM1.provider).toBe("none")
  expect(h.deps.startTask).not.toHaveBeenCalled()
})

test("build reuses the plan's persisted artifact date across a day boundary", async () => {
  // FIX 5: the plan task stamps unit.artifactDateStr; the build task must reuse
  // that SAME date so both reference the same docs/plans/<date>-<slug>.md, even
  // when the build happens on a later calendar day.
  const planDate = "2020-01-01"
  const row = unit({
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "1. Do the thing.",
    artifactDateStr: planDate,
    title: "widget refactor",
  })
  const h = harness([row])
  h.observations.set("1", { provider: "queued", prs: [] })

  await advance(
    { modelAnswers: [{ requestId: "m1:1:review_plan", verdict: { decision: "approve" } }] },
    h.deps,
  )

  const buildCall = (
    h.deps.startTask as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls.find((c) => (c[1] as { createPullRequest?: boolean }).createPullRequest === true)
  expect(buildCall).toBeDefined()
  const prompt = (buildCall![1] as { prompt: string }).prompt
  expect(prompt).toContain(`docs/plans/${planDate}-`)
  // Must NOT drift to today's date.
  expect(prompt).not.toContain(`docs/plans/${artifactDate(Date.now())}-`)
})


test("genuine orphan open same-bot PR escalates after the observation threshold", async () => {
  const row = unit({
    id: "u-open",
    provider: "in_progress",
    pr: 7,
    taskId: "task-open",
    dispatchMode: "build",
    phase: "build",
    openUncorrelatedObservations: { pr: 47, count: 2 },
  })
  const h = harness([row])
  h.observations.set("1", {
    provider: "in_progress",
    prs: [openPr(7)],
    externalMutation: "open_uncorrelated",
    externalPr: 47,
  })

  const result = await advance({}, h.deps)

  expect(result.needsHuman.some((request) => request.reason.includes("uncorrelated open same-bot PR #47"))).toBe(true)
  expect(row.pr).toBe(7)
  expect(row.terminal).not.toBe(true)
  expect(h.deps.mergePullRequest).not.toHaveBeenCalled()
})

test("fresh dispatched unit with no PR does not stall on an unrelated open same-bot PR", async () => {
  const fresh = unit({ id: "fresh", issue: 1, provider: "in_progress", pr: null, taskId: "task-fresh", dispatchMode: "build", phase: "build" })
  const sibling = unit({ id: "sibling", issue: 2, provider: "in_progress", pr: 47, taskId: "task-sibling", dispatchMode: "build", phase: "build" })
  const h = harness([fresh, sibling])
  h.observations.set("1", {
    provider: "in_progress",
    prs: [],
    externalMutation: "open_uncorrelated",
    externalPr: 47,
  })

  const result = await advance({}, h.deps)

  expect(result.needsHuman.some((request) => request.reason.includes("uncorrelated open same-bot PR #47"))).toBe(false)
  expect(fresh.blockingDecisionId).toBeUndefined()
  expect(fresh.openUncorrelatedObservations).toBeUndefined()
  expect(fresh.pr).toBeNull()
  expect(fresh.terminal).not.toBe(true)
})

test("unit-id marker conflict on an open same-bot PR escalates immediately", async () => {
  const owner = unit({ id: "owner", issue: 1, provider: "in_progress", pr: 7, taskId: "task-owner", dispatchMode: "build", phase: "build" })
  const observer = unit({ id: "observer", issue: 2, provider: "in_progress", pr: 8, taskId: "task-observer", dispatchMode: "build", phase: "build" })
  const h = harness([owner, observer])
  h.observations.set("2", {
    provider: "in_progress",
    prs: [openPr(8)],
    externalMutation: "open_uncorrelated",
    externalPr: 47,
    externalPrUnitIdMarker: "owner",
  })

  const result = await advance({}, h.deps)

  expect(result.needsHuman.some((request) => request.reason.includes("uncorrelated open same-bot PR #47"))).toBe(true)
  expect(observer.blockingDecisionId).toBeDefined()
})

test("live PR reconcile terminalizes a stale-open unit whose known PR is closed", async () => {
  const row = unit({ pr: 42, provider: "in_progress", artifact: "pr_open", dispatchMode: "build", phase: "build" })
  const h = harness([row])
  h.observations.set("1", {
    provider: "in_progress",
    prs: [openPr(42, "head-42", { state: "CLOSED", baseSha: "base-42" })],
  })

  await advance({}, h.deps)

  expect(row.terminal).toBe(true)
  expect(row.artifact).toBe("pr_closed")
  expect(row.validation).toBe("cancelled_external_close")
})

test("live PR reconcile terminalizes a stale-open unit whose known PR is merged", async () => {
  const row = unit({ pr: 44, provider: "in_progress", artifact: "pr_open", dispatchMode: "build", phase: "build" })
  const h = harness([row])
  h.observations.set("1", {
    provider: "in_progress",
    prs: [openPr(44, "head-44", { state: "MERGED", merged: true, baseSha: "base-44" })],
  })

  await advance({}, h.deps)

  expect(row.terminal).toBe(true)
  expect(row.artifact).toBe("pr_merged")
  expect(row.validation).toBe("external_merge_unverified")
})

test("open known PR is fetched once per wake through observe-driven reconcile", async () => {
  const row = unit({ pr: 50, provider: "in_progress", artifact: "pr_open", dispatchMode: "build", phase: "build" })
  const h = harness([row])
  h.observations.set("1", { provider: "in_progress", prs: [openPr(50, "head-50")] })

  await advance({}, h.deps)

  expect(h.deps.getPullRequestState).not.toHaveBeenCalled()
})

test("addUnitsToMission skips duplicate goalHash units", async () => {
  const m = mission({ id: "m-dupe", goal: "same goal" })
  const existing = unit({ missionId: "m-dupe", title: "Same title", goalHash: "preexisting" })
  existing.goalHash = (await import("~/lib/first-mate/controller")).unitGoalHash(m, "Same title", repo)
  const written: UnitRow[] = []

  const created = await addUnitsToMission(
    m,
    [{ title: "Same title" }, { title: "Same title" }, { title: "Different title" }],
    { upsertUnit: mock(async (_repo, row) => { written.push(row) }) },
    [existing],
  )

  expect(created).toBe(1)
  expect(written.map((row) => row.title)).toEqual(["Different title"])
})

test("PR body unit-id marker correlates and binds the PR without branch", async () => {
  const { primaryPrNumber } = await import("~/lib/first-mate/observe")
  const result = primaryPrNumber(
    unit({ id: "unit-marker", pr: null, branch: null }),
    null,
    [{ number: 55, headSha: "head-55", headRef: "unknown", isDraft: false, unitIdMarker: "unit-marker" }],
  )

  expect(result).toEqual({ number: 55, correlated: true })
})

test("second build unit is not dispatched while a build is already active for the same mission", async () => {
  const active = unit({ id: "active-build", issue: 1, taskId: "build-task", dispatchMode: "build", provider: "in_progress", phase: "build" })
  const queued = unit({ id: "queued-build", issue: 2, taskId: null, dispatchMode: "build", provider: "none", phase: "build" })
  const h = harness([active, queued])

  await advance({ maxInFlightPerProvider: 5 }, h.deps)

  expect(queued.taskId).toBeNull()
  expect(h.deps.startTask).not.toHaveBeenCalled()
})

test("plan units still dispatch in parallel while a build is active", async () => {
  const active = unit({ id: "active-build", issue: 1, taskId: "build-task", dispatchMode: "build", provider: "in_progress", phase: "build" })
  const plan = unit({ id: "queued-plan", issue: 2, taskId: null, dispatchMode: "plan", provider: "none", phase: "plan" })
  const h = harness([active, plan])

  await advance({ maxInFlightPerProvider: 5 }, h.deps)

  expect(plan.taskId).toBe("started-1")
  expect(h.deps.startTask).toHaveBeenCalledTimes(1)
})
