import { describe, expect, test } from "bun:test"

import { advance, type ControllerDeps } from "~/lib/first-mate/controller"
import type { Mission } from "~/lib/first-mate/registry"
import type { RepoRef, UnitRow } from "~/lib/first-mate/types"

const repo: RepoRef = { owner: "o", name: "gate" }

const mission: Mission = {
  id: "m1",
  goal: "g",
  acceptanceCriteria: "ac",
  repos: [repo],
  status: "active",
  createdMs: 1,
  updatedMs: 1,
}

function unit(): UnitRow {
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
    title: "t",
    id: "u1",
  }
}

/**
 * Fake ControllerDeps that counts calls. loadAllUnits/readMissions are the only
 * deps the observe-only path touches; the rest throw if the drive path is
 * (wrongly) taken while deferring.
 */
function fakeDeps(units: UnitRow[]): { deps: ControllerDeps; calls: Record<string, number> } {
  const calls: Record<string, number> = {}
  const bump = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1
  }
  const readonly =
    (name: string, value: unknown) =>
    async (): Promise<unknown> => {
      bump(name)
      return value
    }
  const mutating =
    (name: string) =>
    async (): Promise<never> => {
      bump(name)
      throw new Error(`drive dep ${name} called while deferring`)
    }
  const deps = {
    loadAllUnits: readonly("loadAllUnits", units),
    readMissions: readonly("readMissions", [mission]),
    upsertUnit: mutating("upsertUnit"),
    pruneTerminal: mutating("pruneTerminal"),
    observeUnit: mutating("observeUnit"),
    classifyPlanReady: mutating("classifyPlanReady"),
    classifyQuestionAnswerable: mutating("classifyQuestionAnswerable"),
    classifyFixAddressed: mutating("classifyFixAddressed"),
    classifyStuck: mutating("classifyStuck"),
    verifyAndConsumeApproval: mutating("verifyAndConsumeApproval"),
    recordApproval: mutating("recordApproval"),
    upsertDecision: mutating("upsertDecision"),
    findByKey: mutating("findByKey"),
    markAnswered: mutating("markAnswered"),
    startTask: mutating("startTask"),
    followUpTask: mutating("followUpTask"),
    cancelTask: mutating("cancelTask"),
    createIssue: mutating("createIssue"),
    resolveAgentActor: mutating("resolveAgentActor"),
    resolveAgentRoster: mutating("resolveAgentRoster"),
    assignAgent: mutating("assignAgent"),
    findAgentPRs: mutating("findAgentPRs"),
    getPullRequestState: mutating("getPullRequestState"),
    postComment: mutating("postComment"),
    submitReview: mutating("submitReview"),
    requestReview: mutating("requestReview"),
    rerunChecks: mutating("rerunChecks"),
    mergePullRequest: mutating("mergePullRequest"),
    markReadyForReview: mutating("markReadyForReview"),
    buildDecisionPacket: mutating("buildDecisionPacket"),
    writeDecisionPacketHtml: mutating("writeDecisionPacketHtml"),
  } as unknown as ControllerDeps
  return { deps, calls }
}

describe("Phase 1.3 — driveGate on advance()", () => {
  test("a non-holder observes-and-defers: returns the board, drives nothing", async () => {
    const { deps, calls } = fakeDeps([unit()])
    const res = await advance({ driveGate: () => false }, deps)
    expect(res.drove).toBe(false)
    expect(res.board.length).toBe(1)
    expect(res.board[0]?.counts.plan).toBe(1)
    expect(res.needsModel).toEqual([])
    expect(res.needsHuman).toEqual([])
    // No drive/mutating dep was touched — only the two read deps.
    expect(calls.upsertUnit ?? 0).toBe(0)
    expect(calls.observeUnit ?? 0).toBe(0)
    expect(calls.startTask ?? 0).toBe(0)
    expect(calls.assignAgent ?? 0).toBe(0)
    expect(calls.loadAllUnits).toBeGreaterThan(0)
  })

  test("an async driveGate is awaited", async () => {
    const { deps } = fakeDeps([unit()])
    const res = await advance({ driveGate: async () => false }, deps)
    expect(res.drove).toBe(false)
  })

  test("holder drives (empty portfolio → takes the drive path, no GitHub deps hit)", async () => {
    // No units → the drive path runs to completion without touching GitHub deps
    // (a mutating dep would throw). drove:true distinguishes it from the defer path.
    const { deps } = fakeDeps([])
    const res = await advance({ driveGate: () => true }, deps)
    expect(res.drove).toBe(true)
    expect(Array.isArray(res.board)).toBe(true)
  })

  test("#3 mid-sweep: a lost lease stops the dispatch wave before any side effect", async () => {
    // An undispatched unit would be dispatched — but renewLease reports the lease
    // was lost, so the wave stops BEFORE the irreversible startTask. No mutating
    // dep (startTask/upsertUnit) is touched; drove is still true.
    const { deps, calls } = fakeDeps([unit()])
    const res = await advance(
      { driveGate: () => true, renewLease: async () => false },
      deps,
    )
    expect(res.drove).toBe(true)
    expect(calls.startTask ?? 0).toBe(0)
    expect(calls.upsertUnit ?? 0).toBe(0)
    expect(res.applied.some((a) => a.includes("drive lease lost mid-sweep"))).toBe(true)
  })
})
