/**
 * Tests for the missionId-scoped advance() filter.
 *
 * Verifies:
 *   (a) advance({ missionId: A }) drives/dispatches only mission A and leaves
 *       mission B untouched.
 *   (b) advance() with no missionId is behaviorally unchanged — both missions
 *       are swept.
 */
import { expect, mock, test } from "bun:test"

import { advance, type ControllerDeps } from "~/lib/first-mate/controller"
import type { DecisionRecord } from "~/lib/first-mate/decisions"
import type { Mission } from "~/lib/first-mate/registry"
import type { AgentKey, Observed, RepoRef, UnitRow } from "~/lib/first-mate/types"

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const repoA: RepoRef = { owner: "acme", name: "alpha" }
const repoB: RepoRef = { owner: "acme", name: "beta" }

function makeMission(id: string, repo: RepoRef, overrides: Partial<Mission> = {}): Mission {
  return {
    id,
    goal: `Goal for ${id}`,
    acceptanceCriteria: "Tests pass.",
    repos: [repo],
    status: "active",
    createdMs: 1,
    updatedMs: 2,
    ...overrides,
  }
}

function makeUnit(missionId: string, repo: RepoRef, issue: number, overrides: Partial<UnitRow> = {}): UnitRow {
  return {
    missionId,
    repo,
    issue,
    pr: null,
    taskId: `task-${issue}`,
    agent: "copilot",
    botLogin: "copilot-swe-agent",
    dispatchMode: "plan",
    provider: "in_progress",
    phase: "plan",
    artifact: "no_pr",
    validation: "unknown",
    retries: 0,
    dependsOn: [],
    title: `Unit ${issue}`,
    ...overrides,
  }
}

function actor(key: AgentKey) {
  return { login: `${key}-bot`, botId: `BOT_${key}` }
}

/**
 * Minimal harness: two missions (mA on repoA, mB on repoB) with one active
 * unit each. The unit for mA is `completed` so it will emit a model request
 * when observed (review_plan); the unit for mB stays in_progress (no-op).
 * startTask is mocked but should NOT be called for either during an observe-
 * only pass — we only test which units advance() VISITS.
 */
function buildHarness() {
  const missionA = makeMission("mA", repoA)
  const missionB = makeMission("mB", repoB)

  const unitA = makeUnit("mA", repoA, 1, {
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
  })
  const unitB = makeUnit("mB", repoB, 2, {
    provider: "in_progress",
    phase: "plan",
  })

  const allUnits: UnitRow[] = [unitA, unitB]
  const allMissions: Mission[] = [missionA, missionB]
  const decisions: DecisionRecord[] = []

  let taskCounter = 0
  let packetCounter = 0

  const deps: ControllerDeps = {
    loadAllUnits: mock(async () => allUnits),
    readMissions: mock(async () => allMissions),
    upsertMission: mock(async (next: Mission) => {
      const index = allMissions.findIndex((entry) => entry.id === next.id)
      if (index === -1) allMissions.push(next)
      else allMissions[index] = next
    }),
    upsertUnit: mock(async (_repo: RepoRef, row: UnitRow) => {
      const index = allUnits.findIndex(
        (u) =>
          u.missionId === row.missionId &&
          u.repo.owner === row.repo.owner &&
          u.repo.name === row.repo.name &&
          (row.issue !== null ? u.issue === row.issue : u.taskId === row.taskId),
      )
      if (index === -1) allUnits.push(row)
      else allUnits[index] = row
    }),
    pruneTerminal: mock(async () => {}),
    observeUnit: mock(async (row: UnitRow): Promise<Observed> => ({
      provider: row.provider,
      prs: [],
      // Completed plan units expose planReady so the controller emits review_plan.
      planReady: row.provider === "completed" && row.phase === "plan",
      logExcerpt: row.provider === "completed" ? "Plan for " + row.missionId : undefined,
    })),
    classifyPlanReady: mock(async () => null),
    classifyQuestionAnswerable: mock(async () => null),
    classifyFixAddressed: mock(async () => null),
    classifyStuck: mock(async () => null),
    verifyAndConsumeApproval: mock(async () => ({ ok: false, reason: "no_approval" })),
    recordApproval: mock(async () => {}),
    releaseApproval: mock(async () => {}),
    upsertDecision: mock(async (record: DecisionRecord) => {
      const index = decisions.findIndex(
        (e) => e.decisionId === record.decisionId || e.decisionKey === record.decisionKey,
      )
      if (index === -1) decisions.push(record)
      else decisions[index] = record
    }),
    findByKey: mock(async (key: string) => decisions.find((d) => d.decisionKey === key)),
    readDecisions: mock(async () => decisions),
    markAnswered: mock(
      async (
        decisionId: string,
        chosenOptionId: string | null,
        resolvedBy: "human" | string | null,
      ) => {
        const record = decisions.find((e) => e.decisionId === decisionId)
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
    continueTaskOnBranch: mock(async () => ({ taskId: "continue-task", state: "in_progress" as const })),
    cancelTask: mock(async () => ({ cancelled: true as const })),
    createIssue: mock(async () => ({
      number: 200,
      nodeId: "ISSUE_200",
      url: "https://github.test/issues/200",
    })),
    resolveAgentActor: mock(async (_repo, key: AgentKey) => actor(key)),
    resolveAgentRoster: mock(async () =>
      new Map<AgentKey, ReturnType<typeof actor>>([
        ["copilot", actor("copilot")],
        ["anthropic", actor("anthropic")],
        ["openai", actor("openai")],
      ]),
    ),
    assignAgent: mock(async () => ({ assigned: true as const, via: "graphql" as const })),
    findAgentPRs: mock(async () => []),
    getPullRequestState: mock(async (_repo, pr: number) => ({
      number: pr,
      title: "PR",
      isDraft: false,
      state: "OPEN",
      mergeable: "MERGEABLE",
      reviewDecision: null,
      headSha: `head-${pr}`,
      baseRef: "main",
      baseSha: `base-${pr}`,
    })),
    postComment: mock(async () => ({ url: "https://gh/c/1" })),
    mentionCopilot: mock(async () => ({ url: "https://gh/c/copilot" })),
    getPullRequestReviews: mock(async () => []),
    dismissPullRequestReview: mock(async () => ({ dismissed: true as const })),
    getSelfLogin: mock(async () => "first-mate-bot"),
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
    writeDecisionPacketHtml: mock(async (packetId: string) => `/tmp/${packetId}.html`),
  } satisfies ControllerDeps

  return { deps, allUnits, allMissions, unitA, unitB }
}

// ---------------------------------------------------------------------------
// (a) Scoped advance: only mission A is driven
// ---------------------------------------------------------------------------

test("advance({ missionId: A }) observes and drives only mission A's unit", async () => {
  const { deps } = buildHarness()

  const result = await advance({ missionId: "mA" }, deps)

  // Mission A's completed plan unit should emit a review_plan request.
  const modelReqs = result.needsModel
  expect(modelReqs.length).toBeGreaterThanOrEqual(1)
  expect(modelReqs.every((r) => r.missionId === "mA")).toBe(true)

  // Mission B's unit is in_progress — it should appear NOWHERE in needsModel.
  const bReqs = modelReqs.filter((r) => r.missionId === "mB")
  expect(bReqs).toHaveLength(0)

  // The board should only contain mission A.
  expect(result.board.every((row) => row.missionId === "mA")).toBe(true)

  // observeUnit was called for unitA but NOT for unitB.
  const observeCalls = (deps.observeUnit as ReturnType<typeof mock>).mock.calls
  const observedMissions = new Set(
    (observeCalls as Array<[UnitRow]>).map(([row]) => row.missionId),
  )
  expect(observedMissions.has("mA")).toBe(true)
  expect(observedMissions.has("mB")).toBe(false)

  // upsertUnit was called only for unitA's repo, not unitB's.
  const upsertCalls = (deps.upsertUnit as ReturnType<typeof mock>).mock.calls
  const upsertedRepos = (upsertCalls as Array<[RepoRef, UnitRow]>).map(
    ([_repo, row]) => row.missionId,
  )
  expect(upsertedRepos.every((mid) => mid === "mA")).toBe(true)

  // startTask must not have been called (no undispatched eligible units in this scenario).
  expect((deps.startTask as ReturnType<typeof mock>).mock.calls).toHaveLength(0)

  // Prove drove returned true.
  expect(result.drove).toBe(true)
})

test("advance({ missionId: B }) drives only mission B and leaves mission A untouched", async () => {
  const { deps } = buildHarness()

  const result = await advance({ missionId: "mB" }, deps)

  // Mission A should not appear in the board or model requests.
  expect(result.board.every((row) => row.missionId === "mB")).toBe(true)
  expect(result.needsModel.every((r) => r.missionId === "mB")).toBe(true)

  // observeUnit should only have been called for mB's unit (in_progress → no request emitted).
  const observeCalls = (deps.observeUnit as ReturnType<typeof mock>).mock.calls
  const observedMissions = new Set(
    (observeCalls as Array<[UnitRow]>).map(([row]) => row.missionId),
  )
  expect(observedMissions.has("mB")).toBe(true)
  expect(observedMissions.has("mA")).toBe(false)
})

test("advance({ missionId: A }) decompose request emitted only for A when A has no units", async () => {
  const { deps, allUnits } = buildHarness()

  // Remove unitA so mission A has no units — should emit a decompose request.
  const filtered = allUnits.filter((u) => u.missionId !== "mA")
  ;(deps.loadAllUnits as ReturnType<typeof mock>).mockImplementation(async () => filtered)

  const result = await advance({ missionId: "mA" }, deps)

  const decomposeReqs = result.needsModel.filter((r) => r.kind === "decompose")
  expect(decomposeReqs).toHaveLength(1)
  expect(decomposeReqs[0]?.missionId).toBe("mA")

  // No decompose for mB even though mB also has no units in the scoped view.
  const bDecompose = result.needsModel.filter((r) => r.missionId === "mB")
  expect(bDecompose).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// (b) Global advance (no missionId) sweeps both missions
// ---------------------------------------------------------------------------

test("advance() with no missionId sweeps both missions", async () => {
  const { deps } = buildHarness()

  const result = await advance({}, deps)

  // Board should contain both missions.
  const boardMissions = new Set(result.board.map((row) => row.missionId))
  expect(boardMissions.has("mA")).toBe(true)
  expect(boardMissions.has("mB")).toBe(true)

  // Mission A's completed plan unit must have emitted a model request.
  const aReqs = result.needsModel.filter((r) => r.missionId === "mA")
  expect(aReqs.length).toBeGreaterThanOrEqual(1)
  expect(aReqs[0]?.kind).toBe("review_plan")

  // observeUnit was called for both missions' units.
  const observeCalls = (deps.observeUnit as ReturnType<typeof mock>).mock.calls
  const observedMissions = new Set(
    (observeCalls as Array<[UnitRow]>).map(([row]) => row.missionId),
  )
  expect(observedMissions.has("mA")).toBe(true)
  expect(observedMissions.has("mB")).toBe(true)
})

test("advance() global decompose emits for both missions when neither has units", async () => {
  const { deps } = buildHarness()

  // Both missions have no units.
  ;(deps.loadAllUnits as ReturnType<typeof mock>).mockImplementation(async () => [])

  const result = await advance({}, deps)

  const decomposeReqs = result.needsModel.filter((r) => r.kind === "decompose")
  const decomposedMissions = new Set(decomposeReqs.map((r) => r.missionId))
  expect(decomposedMissions.has("mA")).toBe(true)
  expect(decomposedMissions.has("mB")).toBe(true)
})

test("scoped advance with unknown missionId produces an empty board and no requests", async () => {
  const { deps } = buildHarness()

  const result = await advance({ missionId: "nonexistent" }, deps)

  expect(result.board).toHaveLength(0)
  expect(result.needsModel).toHaveLength(0)
  expect(result.needsHuman).toHaveLength(0)
  expect(result.drove).toBe(true)
})
