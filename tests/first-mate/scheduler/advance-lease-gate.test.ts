import { beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { advance, type ControllerDeps } from "~/lib/first-mate/controller"
import { SchedulerLease, makeDriveGate } from "~/lib/first-mate/scheduler/lease"

/**
 * Integration for the Phase 1.3 wiring the advance MCP tool uses: advance() with
 * driveGate = makeDriveGate(lease). Proves the lead/heartbeat DEFERS when a
 * daemon holds the shared lease and DRIVES when it is free.
 */

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "fm-lease-gate-"))
})

// Empty-portfolio deps: the drive path is a clean no-op, so `drove` cleanly
// distinguishes driving from deferring. Any GitHub dep call would throw.
function emptyDeps(): ControllerDeps {
  const readonly = (value: unknown) => async (): Promise<unknown> => value
  const boom = (name: string) => async (): Promise<never> => {
    throw new Error(`unexpected drive dep: ${name}`)
  }
  return {
    loadAllUnits: readonly([]),
    readMissions: readonly([]),
    upsertUnit: boom("upsertUnit"),
    pruneTerminal: readonly(undefined),
    observeUnit: boom("observeUnit"),
    classifyPlanReady: boom("classifyPlanReady"),
    classifyQuestionAnswerable: boom("classifyQuestionAnswerable"),
    classifyFixAddressed: boom("classifyFixAddressed"),
    classifyStuck: boom("classifyStuck"),
    verifyAndConsumeApproval: boom("verifyAndConsumeApproval"),
    recordApproval: boom("recordApproval"),
    upsertDecision: boom("upsertDecision"),
    findByKey: boom("findByKey"),
    markAnswered: boom("markAnswered"),
    startTask: boom("startTask"),
    continueTaskOnBranch: boom("continueTaskOnBranch"),
    cancelTask: boom("cancelTask"),
    createIssue: boom("createIssue"),
    resolveAgentActor: boom("resolveAgentActor"),
    resolveAgentRoster: boom("resolveAgentRoster"),
    assignAgent: boom("assignAgent"),
    findAgentPRs: boom("findAgentPRs"),
    getPullRequestState: boom("getPullRequestState"),
    postComment: boom("postComment"),
    submitReview: boom("submitReview"),
    requestReview: boom("requestReview"),
    rerunChecks: boom("rerunChecks"),
    mergePullRequest: boom("mergePullRequest"),
    markReadyForReview: boom("markReadyForReview"),
    buildDecisionPacket: boom("buildDecisionPacket"),
    writeDecisionPacketHtml: boom("writeDecisionPacketHtml"),
  } as unknown as ControllerDeps
}

describe("advance() lease gate (the MCP advance-tool wiring)", () => {
  test("DEFERS when a daemon holds the shared lease", async () => {
    const daemonLease = new SchedulerLease({ dir, ttlMs: 30_000 })
    expect(await daemonLease.tryAcquire()).toBeDefined() // daemon owns it

    const heartbeatLease = new SchedulerLease({ dir, ttlMs: 30_000 })
    const res = await advance({ driveGate: makeDriveGate(heartbeatLease) }, emptyDeps())
    expect(res.drove).toBe(false) // observed-and-deferred, no double-drive
  })

  test("DRIVES when the lease is free (no daemon)", async () => {
    const heartbeatLease = new SchedulerLease({ dir, ttlMs: 30_000 })
    const res = await advance({ driveGate: makeDriveGate(heartbeatLease) }, emptyDeps())
    expect(res.drove).toBe(true) // acquired the lease and drove
  })

  test("takes over once the daemon's lease expires (failover)", async () => {
    // Deterministic clock shared by both leases. Failover is driven by the
    // lease's stored absolute `expiresMs` vs the checking lease's `now`, NOT by
    // wall-clock timing. The prior version used a real 20ms TTL + setTimeout,
    // which raced on slow Windows CI (the daemon lease expired before the first
    // advance() ran, so the "defer" assertion flipped). Advance `now` explicitly.
    let now = 1_000_000
    const clock = (): number => now
    const daemonLease = new SchedulerLease({ dir, ttlMs: 20, nowMs: clock })
    await daemonLease.tryAcquire()
    const heartbeatLease = new SchedulerLease({ dir, ttlMs: 30_000, nowMs: clock })
    // Clock unchanged: the daemon's lease is live → defer.
    expect((await advance({ driveGate: makeDriveGate(heartbeatLease) }, emptyDeps())).drove).toBe(false)
    // Advance past the daemon's 20ms TTL: its lease is now expired → take over.
    now += 40
    expect((await advance({ driveGate: makeDriveGate(heartbeatLease) }, emptyDeps())).drove).toBe(true)
  })

  test("step 2: a deferring advance RETURNS pending needsModel/needsHuman (not empty)", async () => {
    const daemonLease = new SchedulerLease({ dir, ttlMs: 30_000 })
    await daemonLease.tryAcquire() // daemon holds it → heartbeat defers
    const heartbeatLease = new SchedulerLease({ dir, ttlMs: 30_000 })
    const pendingEscalations = async () => ({
      needsModel: [
        {
          requestId: "rp-1",
          kind: "review_plan" as const,
          missionId: "m1",
          repo: { owner: "o", name: "n" },
          issue: null,
          pr: null,
          payload: {},
        },
      ],
      needsHuman: [
        {
          requestId: "h-1",
          decisionId: "d-1",
          missionId: "m1",
          repo: { owner: "o", name: "n" },
          issue: null,
          pr: 7,
          reason: "merge approval",
        },
      ],
    })
    const res = await advance(
      { driveGate: makeDriveGate(heartbeatLease), pendingEscalations },
      emptyDeps(),
    )
    expect(res.drove).toBe(false)
    expect(res.needsModel.map((m) => m.requestId)).toEqual(["rp-1"])
    expect(res.needsHuman.map((h) => h.requestId)).toEqual(["h-1"])
  })
})
