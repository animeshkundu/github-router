import { afterEach, describe, expect, mock, test } from "bun:test"

import { AgentError } from "~/lib/agent/types"
import type { PullRequestState, RequiredChecksSummary } from "~/lib/agent/types"
import { createFirstMateTools, type MergeCloseDeps } from "~/lib/first-mate/tools"
import type { Mission } from "~/lib/first-mate/registry"
import type { UnitRow } from "~/lib/first-mate/types"
import { state } from "~/lib/state"

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

function activeMission(): Mission {
  const now = Date.now()
  return {
    id: "m1",
    goal: "g",
    acceptanceCriteria: "a",
    repos: [{ owner: "octo", name: "repo" }],
    status: "active",
    createdMs: now,
    updatedMs: now,
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
    mergePullRequest: mock(async () => ({ merged: true as const, sha: "mergedsha" })),
    closePullRequest: mock(async () => ({ closed: true as const, state: "CLOSED" })),
    repoHasWorkflows: mock(async () => false),
    getSelfLogin: mock(async () => "octo-bot"),
    readMissions: mock(async () => []),
    loadAllUnits: mock(async () => []),
    ...overrides,
  }
}

function toolOf(name: "merge_pr" | "close_pr", deps: MergeCloseDeps) {
  state.githubAgentToken = "agent-token"
  const tool = createFirstMateTools(deps).find((t) => t.toolNameHttp === name)
  if (tool === undefined) throw new Error(`${name} tool not found`)
  return tool
}

function parsed(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>
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

  test("closes a bot-authored PR", async () => {
    const deps = makeDeps()
    const res = await toolOf("close_pr", deps).handler({ repo: "octo/repo", pr: 7 })
    expect(res.isError).toBeUndefined()
    expect(parsed(res).closed).toBe(true)
    expect(deps.closePullRequest).toHaveBeenCalledWith({ owner: "octo", repo: "repo" }, 7)
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
