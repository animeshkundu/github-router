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
    followUpTask: boom("followUpTask"),
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
    const daemonLease = new SchedulerLease({ dir, ttlMs: 20, nowMs: () => Date.now() })
    await daemonLease.tryAcquire()
    const heartbeatLease = new SchedulerLease({ dir, ttlMs: 30_000 })
    // Immediately: daemon holds it → defer.
    expect((await advance({ driveGate: makeDriveGate(heartbeatLease) }, emptyDeps())).drove).toBe(false)
    // After the short TTL: heartbeat can acquire → drive.
    await new Promise((r) => setTimeout(r, 40))
    expect((await advance({ driveGate: makeDriveGate(heartbeatLease) }, emptyDeps())).drove).toBe(true)
  })
})
