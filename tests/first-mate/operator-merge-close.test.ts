import { afterEach, describe, expect, mock, test } from "bun:test"

import { AgentError } from "~/lib/agent/types"
import type { PullRequestState, RequiredChecksSummary } from "~/lib/agent/types"
import { createFirstMateTools, type MergeCloseDeps } from "~/lib/first-mate/tools"
import { upsertUnit as realUpsertUnit } from "~/lib/first-mate/ledger"
import type { DecisionRecord } from "~/lib/first-mate/decisions"
import type { Mission } from "~/lib/first-mate/registry"
import type { RepoRef, UnitRow } from "~/lib/first-mate/types"
import { state } from "~/lib/state"
import { firstText, type McpToolResult } from "~/lib/attachments"

/**
 * Workstream D — operator merge_pr/close_pr tools. These verify the SAFE-merge
 * envelope: a head guard (live head must equal the reviewed head), ownership
 * scope (agent-authored OR active-mission repo, else explicit allow_unowned),
 * and the pre-merge safety gate (OPEN, not draft, MERGEABLE, CI green). Deps are
 * injected so the gate is driven deterministically without live GitHub.
 */

const savedToken = state.githubAgentToken

afterEach(() => {
  state.githubAgentToken = savedToken
})

function prState(overrides: Partial<PullRequestState> = {}): PullRequestState {
  return {
    number: 7,
    title: "Fix things",
    isDraft: false,
    state: "OPEN",
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    headSha: "reviewedsha",
    baseRef: "main",
    baseSha: "basesha",
    authorLogin: "octo-bot",
    nodeId: "PR_node",
    ...overrides,
  }
}

function checks(overrides: Partial<RequiredChecksSummary> = {}): RequiredChecksSummary {
  return { rollup: "passing", checks: [], failing: [], runningCount: 0, ...overrides }
}

function activeMission(overrides: Partial<Mission> = {}): Mission {
  const now = Date.now()
  return {
    id: "m1",
    goal: "g",
    acceptanceCriteria: "a",
    repos: [{ owner: "octo", name: "repo" }],
    status: "active",
    createdMs: now,
    updatedMs: now,
    ...overrides,
  }
}

function unit(overrides: Partial<UnitRow> = {}): UnitRow {
  return {
    missionId: "m1",
    repo: { owner: "octo", name: "repo" },
    issue: 1,
    pr: 7,
    taskId: "task-1",
    agent: "copilot",
    botLogin: "copilot-swe-agent",
    dispatchMode: "plan",
    provider: "in_progress",
    phase: "plan",
    artifact: "pr_open",
    validation: "unknown",
    retries: 0,
    dependsOn: [],
    title: "unit",
    ...overrides,
  }
}

function makeDeps(overrides: Partial<MergeCloseDeps> = {}): MergeCloseDeps {
  return {
    getPullRequestState: mock(async () => prState()),
    getRequiredChecksForSha: mock(async () => checks()),
    getPullRequestDiffSummary: mock(async () => ({ files: [{ path: "src/a.ts", additions: 1, deletions: 0, status: "modified" }], totalAdditions: 1, totalDeletions: 0, fileCount: 1, truncated: false })),
    mergePullRequest: mock(async () => ({ merged: true as const, sha: "mergedsha" })),
    closePullRequest: mock(async () => ({ closed: true as const, state: "CLOSED" })),
    markReadyForReview: mock(async () => ({ ready: true as const })),
    repoHasWorkflows: mock(async () => false),
    getSelfLogin: mock(async () => "octo-bot"),
    readMissions: mock(async () => []),
    loadAllUnits: mock(async () => []),
    upsertMission: mock(async () => undefined),
    upsertUnit: mock(async () => undefined) as typeof realUpsertUnit,
    markAnswered: mock(async () => undefined),
    readDecisions: mock(async () => [] as DecisionRecord[]),
    ...overrides,
  }
}

function toolOf(name: "merge_pr" | "close_pr" | "mark_ready" | "abandon_mission" | "add_units", deps: MergeCloseDeps) {
  state.githubAgentToken = "agent-token"
  const tool = createFirstMateTools(deps).find((t) => t.toolNameHttp === name)
  if (tool === undefined) throw new Error(`${name} tool not found`)
  return tool
}

function parsed(res: McpToolResult): Record<string, unknown> {
  return JSON.parse(firstText(res)) as Record<string, unknown>
}

describe("merge_pr", () => {
  test("rejects a moved head (live != expected)", async () => {
    const deps = makeDeps({ getPullRequestState: mock(async () => prState({ headSha: "movedsha" })) })
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
    })
    expect(res.isError).toBe(true)
    const body = parsed(res)
    expect((body.error as { code: string }).code).toBe("HEAD_MOVED")
    expect(deps.mergePullRequest).not.toHaveBeenCalled()
  })

  test("refuses a draft PR with the reason", async () => {
    const deps = makeDeps({ getPullRequestState: mock(async () => prState({ isDraft: true })) })
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
    })
    expect(res.isError).toBe(true)
    expect((parsed(res).error as { message: string }).message).toContain("draft")
    expect(deps.mergePullRequest).not.toHaveBeenCalled()
  })

  test("refuses a CONFLICTING (non-mergeable) PR", async () => {
    const deps = makeDeps({ getPullRequestState: mock(async () => prState({ mergeable: "CONFLICTING" })) })
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
    })
    expect(res.isError).toBe(true)
    expect((parsed(res).error as { message: string }).message).toContain("mergeable")
    expect(deps.mergePullRequest).not.toHaveBeenCalled()
  })

  test("refuses a red-CI PR naming the failing check", async () => {
    const deps = makeDeps({
      getRequiredChecksForSha: mock(async () => checks({ rollup: "failing", failing: [{ name: "unit-tests" }] })),
    })
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
    })
    expect(res.isError).toBe(true)
    const msg = (parsed(res).error as { message: string }).message
    expect(msg).toContain("failing")
    expect(msg).toContain("unit-tests")
    expect(deps.mergePullRequest).not.toHaveBeenCalled()
  })

  test("refuses an unowned PR without allow_unowned", async () => {
    const deps = makeDeps({
      getPullRequestState: mock(async () => prState({ authorLogin: "random-human" })),
      getSelfLogin: mock(async () => "octo-bot"),
      readMissions: mock(async () => []),
    })
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
    })
    expect(res.isError).toBe(true)
    expect((parsed(res).error as { code: string }).code).toBe("UNOWNED_PR")
    expect(deps.mergePullRequest).not.toHaveBeenCalled()
  })

  test("refuses when mergeability stays UNKNOWN after polling", async () => {
    const deps = makeDeps({ getPullRequestState: mock(async () => prState({ mergeable: null })) })
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
    })
    expect(res.isError).toBe(true)
    expect((parsed(res).error as { message: string }).message).toContain("UNKNOWN")
    expect(deps.mergePullRequest).not.toHaveBeenCalled()
  })

  test("refuses to merge an empty PR", async () => {
    const deps = makeDeps({
      getPullRequestDiffSummary: mock(async () => ({ files: [], totalAdditions: 0, totalDeletions: 0, fileCount: 0, truncated: false })),
    })
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
    })
    expect(res.isError).toBe(true)
    expect((parsed(res).error as { message: string }).message).toContain("empty diff")
    expect(deps.mergePullRequest).not.toHaveBeenCalled()
  })

  test("merges a clean bot-authored PR passing expected_head_sha", async () => {
    const deps = makeDeps()
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
      method: "squash",
    })
    expect(res.isError).toBeUndefined()
    const body = parsed(res)
    expect(body.merged).toBe(true)
    expect(body.sha).toBe("mergedsha")
    expect(deps.mergePullRequest).toHaveBeenCalledWith(
      { owner: "octo", repo: "repo" },
      { pr: 7, expectedHeadSha: "reviewedsha", method: "squash" },
    )
  })

  test("merges a clean PR owned via a CORRELATED first-mate unit (non-bot author)", async () => {
    const deps = makeDeps({
      getPullRequestState: mock(async () => prState({ authorLogin: "Copilot" })),
      getSelfLogin: mock(async () => "octo-bot"),
      readMissions: mock(async () => [activeMission()]),
      loadAllUnits: mock(async () => [unit({ pr: 7 })]),
    })
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
    })
    expect(res.isError).toBeUndefined()
    expect(parsed(res).merged).toBe(true)
    expect(deps.mergePullRequest).toHaveBeenCalledTimes(1)
  })

  test("FIX 2 — a HUMAN PR in an active-mission repo with NO correlated unit is NOT owned", async () => {
    // An active mission targeting the repo must NOT confer ownership over a
    // human's PR — only a unit with unit.pr === thisPr does.
    const deps = makeDeps({
      getPullRequestState: mock(async () => prState({ authorLogin: "random-human" })),
      getSelfLogin: mock(async () => "octo-bot"),
      readMissions: mock(async () => [activeMission()]),
      loadAllUnits: mock(async () => [unit({ pr: 99 })]), // a different PR
    })
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
    })
    expect(res.isError).toBe(true)
    expect((parsed(res).error as { code: string }).code).toBe("UNOWNED_PR")
    expect(deps.mergePullRequest).not.toHaveBeenCalled()
  })

  test("FIX 1 — refuses to merge when CI is indeterminate (rollup none + workflow probe error)", async () => {
    const deps = makeDeps({
      getRequiredChecksForSha: mock(async () => checks({ rollup: "none" })),
      repoHasWorkflows: mock(async () => {
        throw new AgentError("UPSTREAM", "probe failed")
      }),
    })
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
    })
    expect(res.isError).toBe(true)
    expect((parsed(res).error as { message: string }).message).toContain("indeterminate")
    expect(deps.mergePullRequest).not.toHaveBeenCalled()
  })

  test("FIX 1 — refuses to merge a red LEGACY-status PR (rollup failing surfaced by getRequiredChecksForSha)", async () => {
    const deps = makeDeps({
      getRequiredChecksForSha: mock(async () =>
        checks({ rollup: "failing", failing: [{ name: "ci/circleci" }] }),
      ),
    })
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
    })
    expect(res.isError).toBe(true)
    const msg = (parsed(res).error as { message: string }).message
    expect(msg).toContain("failing")
    expect(msg).toContain("ci/circleci")
    expect(deps.mergePullRequest).not.toHaveBeenCalled()
  })


  test("does not false-block when the diff heuristic test count decreases", async () => {
    const row = unit({ pr: 7, baselineTestCount: 2 })
    const deps = makeDeps({
      loadAllUnits: mock(async () => [row]),
      readMissions: mock(async () => [activeMission()]),
      getPullRequestDiffSummary: mock(async () => ({
        files: [{ path: "tests/foo.test.ts", additions: 1, deletions: 0, status: "modified" }],
        totalAdditions: 1,
        totalDeletions: 0,
        fileCount: 1,
        truncated: false,
      })),
    })
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
    })

    expect(res.isError).toBeUndefined()
    expect(parsed(res).merged).toBe(true)
    expect(deps.mergePullRequest).toHaveBeenCalledTimes(1)
  })


  test("skips test-count ratchet comparison when diff file list is truncated", async () => {
    const row = unit({ pr: 7, baselineTestCount: 2 })
    const deps = makeDeps({
      loadAllUnits: mock(async () => [row]),
      readMissions: mock(async () => [activeMission()]),
      getPullRequestDiffSummary: mock(async () => ({
        files: [{ path: "src/only-visible.ts", additions: 1, deletions: 0, status: "modified" }],
        totalAdditions: 10,
        totalDeletions: 2,
        fileCount: 51,
        truncated: true,
      })),
    })
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
    })

    expect(res.isError).toBeUndefined()
    expect(parsed(res).merged).toBe(true)
    expect(deps.mergePullRequest).toHaveBeenCalledTimes(1)
  })

  test("refuses docs-only diff for a build unit requiring code and tests", async () => {
    const row = unit({ pr: 7, dispatchMode: "build", title: "change code and tests" })
    const deps = makeDeps({
      loadAllUnits: mock(async () => [row]),
      readMissions: mock(async () => [activeMission({ acceptanceCriteria: "Must include code and tests." })]),
      getPullRequestDiffSummary: mock(async () => ({
        files: [{ path: "docs/plan.md", additions: 3, deletions: 0, status: "modified" }],
        totalAdditions: 3,
        totalDeletions: 0,
        fileCount: 1,
        truncated: false,
      })),
    })
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
    })

    expect(res.isError).toBe(true)
    expect((parsed(res).error as { message: string }).message).toContain("docs-only")
    expect(deps.mergePullRequest).not.toHaveBeenCalled()
  })

  test("refuses CI-less merge when the mission requires CI", async () => {
    const row = unit({ pr: 7 })
    const deps = makeDeps({
      loadAllUnits: mock(async () => [row]),
      readMissions: mock(async () => [activeMission({ ciRequired: true })]),
      getRequiredChecksForSha: mock(async () => checks({ rollup: "none" })),
      repoHasWorkflows: mock(async () => false),
    })
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
    })

    expect(res.isError).toBe(true)
    expect((parsed(res).error as { message: string }).message).toContain("requires CI")
    expect(deps.mergePullRequest).not.toHaveBeenCalled()
  })

  test("merges an unowned PR when allow_unowned is set", async () => {
    const deps = makeDeps({
      getPullRequestState: mock(async () => prState({ authorLogin: "random-human" })),
      readMissions: mock(async () => []),
    })
    const res = await toolOf("merge_pr", deps).handler({
      repo: "octo/repo",
      pr: 7,
      expected_head_sha: "reviewedsha",
      allow_unowned: true,
    })
    expect(res.isError).toBeUndefined()
    expect(parsed(res).merged).toBe(true)
  })
})

describe("mission unit tools", () => {
  test("abandon_mission updates the mission and terminalizes live units", async () => {
    const m = activeMission()
    const row = unit({ terminal: false })
    const deps = makeDeps({ readMissions: mock(async () => [m]), loadAllUnits: mock(async () => [row]) })
    const res = await toolOf("abandon_mission", deps).handler({ mission_id: "m1", reason: "paused" })
    expect(res.isError).toBeUndefined()
    expect(parsed(res).abandoned).toBe(true)
    expect(deps.upsertMission).toHaveBeenCalledWith(expect.objectContaining({ id: "m1", status: "abandoned" }))
    expect(row.terminal).toBe(true)
    expect(row.blockingDecisionId).toBeNull()
    expect(deps.upsertUnit).toHaveBeenCalledWith({ owner: "octo", name: "repo" }, row)
  })


  test("abandon_mission refuses to convert a done mission to abandoned", async () => {
    const m = activeMission({ status: "done" })
    const deps = makeDeps({ readMissions: mock(async () => [m]), loadAllUnits: mock(async () => []) })
    const res = await toolOf("abandon_mission", deps).handler({ mission_id: "m1", reason: "nope" })

    expect(res.isError).toBe(true)
    expect((parsed(res).error as { code: string }).code).toBe("MISSION_TERMINAL")
    expect(deps.upsertMission).not.toHaveBeenCalled()
  })

  test("abandon_mission answers pending durable decisions before clearing blocks", async () => {
    const m = activeMission()
    const row = unit({ terminal: false, blockingDecisionId: "decision-1" })
    const decisions: DecisionRecord[] = [{
      decisionId: "decision-1",
      decisionKey: "k",
      type: "human_decision",
      status: "pending",
      packetId: "p",
      inputFingerprint: "f",
      options: [{ id: "abandon" }],
      createdMs: 1,
    }]
    const deps = makeDeps({
      readMissions: mock(async () => [m]),
      loadAllUnits: mock(async () => [row]),
      readDecisions: mock(async () => decisions),
    })
    const res = await toolOf("abandon_mission", deps).handler({ mission_id: "m1", reason: "paused" })

    expect(res.isError).toBeUndefined()
    expect(deps.markAnswered).toHaveBeenCalledWith("decision-1", "abandoned", "system")
    expect(row.blockingDecisionId).toBeNull()
  })

  test("add_units appends units to an active mission", async () => {
    const m = activeMission()
    const written: UnitRow[] = []
    const deps = makeDeps({
      readMissions: mock(async () => [m]),
      upsertUnit: mock(async (_repo: RepoRef, row: UnitRow) => { written.push(row) }) as typeof realUpsertUnit,
    })
    const res = await toolOf("add_units", deps).handler({
      mission_id: "m1",
      units: [{ title: "A" }, { title: "B", dependsOn: [0], agent: "anthropic" }],
    })
    expect(res.isError).toBeUndefined()
    expect(parsed(res).added).toBe(2)
    expect(written.map((row) => row.title)).toEqual(["A", "B"])
    expect(written[1]?.dependsOn).toEqual([written[0]!.id!])
    expect(written[1]?.agent).toBe("anthropic")
  })
})

describe("mark_ready", () => {
  test("marks an owned draft PR ready for review", async () => {
    const deps = makeDeps({
      getPullRequestState: mock(async () => prState({ isDraft: true, nodeId: "PR_node_7" })),
    })
    const res = await toolOf("mark_ready", deps).handler({ repo: "octo/repo", pr: 7 })

    expect(res.isError).toBeUndefined()
    expect(parsed(res)).toMatchObject({ ready: true, alreadyReady: false })
    expect(deps.markReadyForReview).toHaveBeenCalledWith("PR_node_7")
  })

  test("refuses an unowned draft PR without allow_unowned", async () => {
    const deps = makeDeps({
      getPullRequestState: mock(async () => prState({ authorLogin: "random-human", isDraft: true })),
      readMissions: mock(async () => []),
    })
    const res = await toolOf("mark_ready", deps).handler({ repo: "octo/repo", pr: 7 })

    expect(res.isError).toBe(true)
    expect((parsed(res).error as { code: string }).code).toBe("UNOWNED_PR")
    expect(deps.markReadyForReview).not.toHaveBeenCalled()
  })

  test("marks an unowned draft PR ready only with allow_unowned", async () => {
    const deps = makeDeps({
      getPullRequestState: mock(async () => prState({ authorLogin: "random-human", isDraft: true, nodeId: "PR_node_7" })),
      readMissions: mock(async () => []),
    })
    const res = await toolOf("mark_ready", deps).handler({ repo: "octo/repo", pr: 7, allow_unowned: true })

    expect(res.isError).toBeUndefined()
    expect(parsed(res)).toMatchObject({ ready: true, alreadyReady: false })
    expect(deps.markReadyForReview).toHaveBeenCalledWith("PR_node_7")
  })
})

describe("close_pr", () => {
  test("refuses an unowned PR without allow_unowned", async () => {
    const deps = makeDeps({
      getPullRequestState: mock(async () => prState({ authorLogin: "random-human" })),
      readMissions: mock(async () => []),
    })
    const res = await toolOf("close_pr", deps).handler({ repo: "octo/repo", pr: 7 })
    expect(res.isError).toBe(true)
    expect((parsed(res).error as { code: string }).code).toBe("UNOWNED_PR")
    expect(deps.closePullRequest).not.toHaveBeenCalled()
  })

  test("closes a bot-authored PR and marks correlated units terminal", async () => {
    const row = unit({ pr: 7, terminal: false })
    const deps = makeDeps({ loadAllUnits: mock(async () => [row]) })
    const res = await toolOf("close_pr", deps).handler({ repo: "octo/repo", pr: 7 })
    expect(res.isError).toBeUndefined()
    expect(parsed(res).closed).toBe(true)
    expect(row.terminal).toBe(true)
    expect(row.artifact).toBe("pr_closed")
    expect(row.validation).toBe("cancelled_external_close")
    expect(deps.upsertUnit).toHaveBeenCalledWith({ owner: "octo", name: "repo" }, row)
    expect(deps.closePullRequest).toHaveBeenCalledWith({ owner: "octo", repo: "repo" }, 7)
  })


  test("close_pr answers pending durable decisions before clearing correlated unit blocks", async () => {
    const row = unit({ pr: 7, terminal: false, blockingDecisionId: "decision-close" })
    const decisions: DecisionRecord[] = [{
      decisionId: "decision-close",
      decisionKey: "k",
      type: "human_decision",
      status: "pending",
      packetId: "p",
      inputFingerprint: "f",
      options: [{ id: "continue" }],
      createdMs: 1,
    }]
    const deps = makeDeps({
      loadAllUnits: mock(async () => [row]),
      readDecisions: mock(async () => decisions),
    })
    const res = await toolOf("close_pr", deps).handler({ repo: "octo/repo", pr: 7 })

    expect(res.isError).toBeUndefined()
    expect(deps.markAnswered).toHaveBeenCalledWith("decision-close", "closed_pr", "system")
    expect(row.blockingDecisionId).toBeNull()
  })

  test("refuses to close an already-merged PR", async () => {
    const deps = makeDeps({ getPullRequestState: mock(async () => prState({ state: "MERGED" })) })
    const res = await toolOf("close_pr", deps).handler({ repo: "octo/repo", pr: 7 })
    expect(res.isError).toBe(true)
    expect((parsed(res).error as { code: string }).code).toBe("ALREADY_MERGED")
    expect(deps.closePullRequest).not.toHaveBeenCalled()
  })

  test("closes an unowned PR when allow_unowned is set", async () => {
    const deps = makeDeps({
      getPullRequestState: mock(async () => prState({ authorLogin: "random-human" })),
      readMissions: mock(async () => []),
    })
    const res = await toolOf("close_pr", deps).handler({ repo: "octo/repo", pr: 7, allow_unowned: true })
    expect(res.isError).toBeUndefined()
    expect(parsed(res).closed).toBe(true)
    expect(deps.closePullRequest).toHaveBeenCalledTimes(1)
  })
})
