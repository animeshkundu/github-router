/**
 * Tests for model-selection threading across the first-mate controller.
 *
 * Two concerns:
 *
 * 1. resolveCloudAgentModel contract — the four behaviors described in the
 *    task-model.ts doc comment (unset → default, absent from populated catalog →
 *    throw, no catalog → passthrough, valid catalog model → normalized).
 *
 * 2. Threading — mission.defaultModel and per-unit UnitRow.model propagate
 *    through every dispatch site to StartTaskInput.model in the startTask POST
 *    body. Tests use the same harness conventions as first-mate-controller.test.ts.
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { advance, type ControllerDeps } from "~/lib/first-mate/controller"
import { DEFAULT_CODEX_MODEL } from "~/lib/port"
import { resolveCloudAgentModel } from "~/lib/first-mate/task-model"
import type { DecisionRecord } from "~/lib/first-mate/decisions"
import type { Mission } from "~/lib/first-mate/registry"
import type { AgentKey, Observed, RepoRef, UnitRow } from "~/lib/first-mate/types"
import { state } from "~/lib/state"

// ---------------------------------------------------------------------------
// resolveModel normalization reads the global catalog; null it out so
// normalization is identity and membership checks are driven purely by the
// INJECTED catalog argument in these tests.
// ---------------------------------------------------------------------------

const originalModels = state.models

beforeEach(() => {
  state.models = undefined
})

afterEach(() => {
  state.models = originalModels
})

// ===========================================================================
// 1. resolveCloudAgentModel contract
// ===========================================================================

test("(a) unset → defaults to gpt-5.6-sol when no catalog is available", () => {
  expect(resolveCloudAgentModel(undefined, null)).toBe(DEFAULT_CODEX_MODEL)
  expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.6-sol")
})

test("(a) unset → defaults to gpt-5.6-sol when the catalog is an empty array", () => {
  // Empty array counts as "no catalog" (ids set is empty → ids === undefined branch).
  expect(resolveCloudAgentModel(undefined, [])).toBe(DEFAULT_CODEX_MODEL)
})

test("(a) unset + populated catalog containing the preferred default → returns the preferred default", () => {
  const catalog = [{ id: "gpt-5.6-sol" }, { id: "gpt-5.4" }]
  expect(resolveCloudAgentModel(undefined, catalog)).toBe("gpt-5.6-sol")
})

test("(a) unset + populated catalog MISSING the preferred default → walks fallback chain", () => {
  // gpt-5.6-sol not in catalog; first available fallback wins.
  expect(resolveCloudAgentModel(undefined, [{ id: "gpt-5.4" }])).toBe("gpt-5.4")
  expect(resolveCloudAgentModel(undefined, [{ id: "gpt-5.3-codex" }])).toBe("gpt-5.3-codex")
})

test("(a) unset + populated catalog with no known fallback → returns the preferred default (best-effort)", () => {
  // Neither the default nor any fallback is in the catalog; still returns the
  // hard-coded default — the dispatch site surfaces availability errors.
  expect(resolveCloudAgentModel(undefined, [{ id: "unknown-model" }])).toBe(DEFAULT_CODEX_MODEL)
})

test("(b) explicit model absent from a populated catalog → throws (never silently substituted)", () => {
  expect(() =>
    resolveCloudAgentModel("gpt-does-not-exist", [{ id: "gpt-5.5" }]),
  ).toThrow(/not in the Copilot catalog/)
})

test("(b) throw message includes both the chosen slug and the resolved slug", () => {
  expect(() =>
    resolveCloudAgentModel("no-such-model", [{ id: "gpt-5.5" }]),
  ).toThrow("no-such-model")
})

test("(c) no catalog (null) → passthrough: explicit choice is returned as-is, no enforcement", () => {
  expect(resolveCloudAgentModel("gpt-5.5", null)).toBe("gpt-5.5")
  expect(resolveCloudAgentModel("gpt-5.4", null)).toBe("gpt-5.4")
})

test("(c) empty array catalog → treated as no-catalog: explicit choice returned without enforcement", () => {
  expect(resolveCloudAgentModel("gpt-5.5", [])).toBe("gpt-5.5")
})

test("(d) valid catalog model → returned (normalized via resolveModel; identity when state.models is unset)", () => {
  // state.models is undefined (set in beforeEach), so resolveModel is identity.
  const catalog = [{ id: "gpt-5.5" }]
  expect(resolveCloudAgentModel("gpt-5.5", catalog)).toBe("gpt-5.5")
})

test("(d) blank / whitespace explicit choice is treated as unspecified (falls back to default)", () => {
  expect(resolveCloudAgentModel("   ", null)).toBe(DEFAULT_CODEX_MODEL)
  expect(resolveCloudAgentModel("", null)).toBe(DEFAULT_CODEX_MODEL)
})

// ===========================================================================
// 2. Threading — model reaches StartTaskInput.model at every dispatch site
//
// Harness adapted from first-mate-controller.test.ts: same mocking shape, same
// sameHandle logic, same helper factories.
// ===========================================================================

const repo: RepoRef = { owner: "octo", name: "repo" }

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "m1",
    goal: "Ship model threading",
    acceptanceCriteria: "Model reaches every dispatch site.",
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

function defaultObserved(row: UnitRow): Observed {
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

interface Harness {
  units: UnitRow[]
  missions: Mission[]
  deps: ControllerDeps
}

function harness(units: UnitRow[], missions: Mission[] = [mission()]): Harness {
  const decisions: DecisionRecord[] = []
  const observations = new Map<string, Observed>()
  let taskCounter = 0
  let issueCounter = 100
  let packetCounter = 0

  function keyFor(row: UnitRow): string {
    return String(row.issue ?? row.taskId)
  }

  const deps = {
    loadAllUnits: mock(async () => units),
    readMissions: mock(async () => missions),
    upsertMission: mock(async (next: Mission) => {
      const index = missions.findIndex((entry) => entry.id === next.id)
      if (index === -1) missions.push(next)
      else missions[index] = next
    }),
    upsertUnit: mock(async (_repo: RepoRef, row: UnitRow) => {
      upsertMemory(units, row)
    }),
    pruneTerminal: mock(async () => {}),
    observeUnit: mock(async (row: UnitRow) =>
      observations.get(keyFor(row)) ?? defaultObserved(row),
    ),
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
    findByKey: mock(async (key: string) =>
      decisions.find((r) => r.decisionKey === key),
    ),
    readDecisions: mock(async () => decisions),
    markAnswered: mock(async (id: string, chosen: string | null, by: "human" | string | null) => {
      const r = decisions.find((e) => e.decisionId === id)
      if (!r) return
      r.status = "answered"
      r.chosenOptionId = chosen
      r.resolvedBy = by
      r.resolvedMs = Date.now()
    }),
    startTask: mock(async () => {
      taskCounter += 1
      return { taskId: `started-${taskCounter}`, state: "queued" }
    }),
    continueTaskOnBranch: mock(async () => ({ taskId: "continue-task", state: "in_progress" as const })),
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
    getPullRequestReviews: mock(async () => [] as Array<{
      author: string
      state: string
      bodyExcerpt: string
      submittedAt?: string
      commitId?: string
      nodeId?: string
    }>),
    dismissPullRequestReview: mock(async () => ({ dismissed: true as const })),
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
    writeDecisionPacketHtml: mock(async (packetId: string) =>
      `/tmp/first-mate/${packetId}.html`,
    ),
  } satisfies ControllerDeps

  return { units, missions, deps }
}

// Helper: extract all startTask call inputs.
function startTaskCalls(h: Harness): Array<{ prompt: string; model?: string; createPullRequest?: boolean }> {
  const mock = h.deps.startTask as unknown as { mock: { calls: unknown[][] } }
  return mock.mock.calls.map((c) => c[1] as { prompt: string; model?: string; createPullRequest?: boolean })
}

// ---------------------------------------------------------------------------
// 2a. Initial dispatch (dispatchUnit via dispatchWave)
// ---------------------------------------------------------------------------

test("initial dispatch: mission defaultModel reaches StartTaskInput.model", async () => {
  const row = unit({
    issue: 10,
    taskId: null,
    provider: "none",
    phase: "plan",
    dispatchMode: "plan",
  })
  const h = harness([row], [mission({ defaultModel: "gpt-5.5" })])

  await advance({}, h.deps)

  const calls = startTaskCalls(h)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.model).toBe("gpt-5.5")
})

test("initial dispatch: per-unit model override beats mission defaultModel", async () => {
  const row = unit({
    issue: 11,
    taskId: null,
    provider: "none",
    phase: "plan",
    dispatchMode: "plan",
    model: "gpt-5.4",
  })
  const h = harness([row], [mission({ defaultModel: "gpt-5.5" })])

  await advance({}, h.deps)

  const calls = startTaskCalls(h)
  expect(calls).toHaveLength(1)
  // Per-unit model takes precedence over the mission default.
  expect(calls[0]!.model).toBe("gpt-5.4")
})

test("initial dispatch: absent model (unit and mission both unset) → DEFAULT_CODEX_MODEL", async () => {
  // Neither unit.model nor mission.defaultModel is set → resolveCloudAgentModel
  // returns DEFAULT_CODEX_MODEL because state.models is undefined (no catalog).
  const row = unit({
    issue: 12,
    taskId: null,
    provider: "none",
    phase: "plan",
    dispatchMode: "plan",
    model: undefined,
  })
  const h = harness([row], [mission({ defaultModel: undefined })])

  await advance({}, h.deps)

  const calls = startTaskCalls(h)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.model).toBe(DEFAULT_CODEX_MODEL)
})

// ---------------------------------------------------------------------------
// 2b. review_plan approve re-dispatch (approve → build)
// ---------------------------------------------------------------------------

test("review_plan approve: mission defaultModel reaches the re-dispatched build task", async () => {
  const row = unit({
    issue: 20,
    taskId: "task-plan",
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "1. Update deps. 2. Add tests.",
    model: undefined,
  })
  const h = harness([row], [mission({ defaultModel: "gpt-5.5" })])

  await advance(
    { modelAnswers: [{ requestId: "m1:20:review_plan", verdict: { decision: "approve" } }] },
    h.deps,
  )

  const buildCalls = startTaskCalls(h).filter((c) => c.createPullRequest === true)
  expect(buildCalls).toHaveLength(1)
  expect(buildCalls[0]!.model).toBe("gpt-5.5")
})

test("review_plan approve: per-unit model override reaches the re-dispatched build task", async () => {
  const row = unit({
    issue: 21,
    taskId: "task-plan2",
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "1. Bump Flask. 2. Migrate tests.",
    model: "gpt-5.4",
  })
  const h = harness([row], [mission({ defaultModel: "gpt-5.5" })])

  await advance(
    { modelAnswers: [{ requestId: "m1:21:review_plan", verdict: { decision: "approve" } }] },
    h.deps,
  )

  const buildCalls = startTaskCalls(h).filter((c) => c.createPullRequest === true)
  expect(buildCalls).toHaveLength(1)
  // Per-unit model (gpt-5.4) wins over the mission default (gpt-5.5).
  expect(buildCalls[0]!.model).toBe("gpt-5.4")
})

// ---------------------------------------------------------------------------
// 2c. review_plan refine re-dispatch
// ---------------------------------------------------------------------------

test("review_plan refine: mission defaultModel reaches the re-dispatched plan task", async () => {
  const row = unit({
    issue: 30,
    taskId: "task-plan3",
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "old plan",
    model: undefined,
  })
  const h = harness([row], [mission({ defaultModel: "gpt-5.5" })])

  await advance(
    {
      modelAnswers: [
        {
          requestId: "m1:30:review_plan",
          verdict: { decision: "refine", instruction: "Add more detail on error handling." },
        },
      ],
    },
    h.deps,
  )

  // refine fires createPullRequest:false
  const refineCalls = startTaskCalls(h).filter((c) => c.createPullRequest === false)
  expect(refineCalls).toHaveLength(1)
  expect(refineCalls[0]!.model).toBe("gpt-5.5")
})

test("review_plan refine: per-unit model override reaches the re-dispatched plan task", async () => {
  const row = unit({
    issue: 31,
    taskId: "task-plan4",
    provider: "completed",
    phase: "plan",
    dispatchMode: "plan",
    planExcerpt: "old plan",
    model: "gpt-5.4",
  })
  const h = harness([row], [mission({ defaultModel: "gpt-5.5" })])

  await advance(
    {
      modelAnswers: [
        {
          requestId: "m1:31:review_plan",
          verdict: { decision: "refine", instruction: "Be more concrete." },
        },
      ],
    },
    h.deps,
  )

  const refineCalls = startTaskCalls(h).filter((c) => c.createPullRequest === false)
  expect(refineCalls).toHaveLength(1)
  expect(refineCalls[0]!.model).toBe("gpt-5.4")
})

// ---------------------------------------------------------------------------
// 2d. decompose answer stamping — UnitRow.model reflects spec.model or mission default
// ---------------------------------------------------------------------------

test("decompose answer: spec.model is stamped onto UnitRow.model (per-unit override)", async () => {
  // Active mission with no units → advance emits a decompose needsModel;
  // apply it immediately in the same call by passing it as a model answer.
  const h = harness([], [mission({ id: "m1", defaultModel: "gpt-5.5" })])

  await advance(
    {
      modelAnswers: [
        {
          requestId: "decompose:m1",
          verdict: {
            units: [{ title: "Implement feature", model: "gpt-5.4" }],
          },
        },
      ],
    },
    h.deps,
  )

  // The last non-intent upsert carries the created unit; filter for units with a title.
  const createdUnit = h.units.find((u) => u.title === "Implement feature")
  expect(createdUnit).toBeDefined()
  // Per-unit spec.model is stamped.
  expect(createdUnit!.model).toBe("gpt-5.4")
})

test("decompose answer: absent spec.model → UnitRow.model inherits mission.defaultModel", async () => {
  const h = harness([], [mission({ id: "m1", defaultModel: "gpt-5.5" })])

  await advance(
    {
      modelAnswers: [
        {
          requestId: "decompose:m1",
          verdict: {
            units: [{ title: "Another task" }], // no model field
          },
        },
      ],
    },
    h.deps,
  )

  const createdUnit = h.units.find((u) => u.title === "Another task")
  expect(createdUnit).toBeDefined()
  // No per-unit override → inherits mission default.
  expect(createdUnit!.model).toBe("gpt-5.5")
})

test("decompose answer: absent spec.model AND absent mission.defaultModel → UnitRow.model is undefined", async () => {
  // The dispatch site resolves undefined → DEFAULT_CODEX_MODEL at dispatch time.
  const h = harness([], [mission({ id: "m1", defaultModel: undefined })])

  await advance(
    {
      modelAnswers: [
        {
          requestId: "decompose:m1",
          verdict: {
            units: [{ title: "Task no model" }],
          },
        },
      ],
    },
    h.deps,
  )

  const createdUnit = h.units.find((u) => u.title === "Task no model")
  expect(createdUnit).toBeDefined()
  // Both absent → undefined stamped; dispatch resolves to DEFAULT_CODEX_MODEL.
  expect(createdUnit!.model).toBeUndefined()
})

test("decompose answer: invalid spec.model throws before any unit is created", async () => {
  // resolveCloudAgentModel is called at decompose INPUT time (before upsertUnit),
  // so a bad model fails fast rather than throwing every dispatch wake.
  // Since state.models is undefined (no catalog), an explicit choice is
  // RETURNED as-is (no enforcement); to trigger a throw we need a non-empty
  // catalog. Inject one via state.models.
  state.models = { data: [{ id: "gpt-5.5" }] } as typeof state.models

  const h = harness([], [mission({ id: "m1" })])

  await advance(
    {
      modelAnswers: [
        {
          requestId: "decompose:m1",
          verdict: {
            units: [{ title: "Bad model task", model: "not-in-catalog" }],
          },
        },
      ],
    },
    h.deps,
  )

  // The per-answer try/catch in applySubmittedAnswers surfaces the error as an
  // applied string; no unit should have been created.
  const createdUnit = h.units.find((u) => u.title === "Bad model task")
  expect(createdUnit).toBeUndefined()
})
