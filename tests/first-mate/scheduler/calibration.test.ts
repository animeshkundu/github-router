import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  AuditLog,
  DeadLetterQueue,
  calibrationReport,
  computeCalibration,
} from "~/lib/first-mate/scheduler/calibration"

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "fm-calib-"))
  process.env.GH_ROUTER_FM_TIER1_LIVE = "1" // so wouldAutoAccept can be non-zero
})
afterEach(() => {
  delete process.env.GH_ROUTER_FM_TIER1_LIVE
})

async function writeShadowLog(lines: Array<Record<string, unknown>>): Promise<void> {
  await fs.writeFile(
    path.join(dir, "tier1-shadow.jsonl"),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  )
}

describe("Phase 4 — calibration", () => {
  test("pairs shadow verdicts to lead outcomes per kind and counts agreement", async () => {
    await writeShadowLog([
      { type: "shadow", requestId: "a", kind: "review_plan", wouldVerdict: { decision: "approve" }, confidence: 0.9, novelty: "known", stakes: "low" },
      { type: "outcome", requestId: "a", leadOutcome: { decision: "approve" } }, // agree
      { type: "shadow", requestId: "b", kind: "review_plan", wouldVerdict: { decision: "approve" }, confidence: 0.9, novelty: "known", stakes: "low" },
      { type: "outcome", requestId: "b", leadOutcome: { decision: "refine" } }, // disagree
      { type: "shadow", requestId: "c", kind: "author_fix", wouldVerdict: { instruction: "x" }, confidence: 0.95, novelty: "known", stakes: "low" },
    ])
    const stats = await computeCalibration(dir)
    const rp = stats.find((s) => s.kind === "review_plan")!
    expect(rp.shadowCount).toBe(2)
    expect(rp.pairedCount).toBe(2)
    expect(rp.agreeCount).toBe(1)
    expect(rp.agreeRate).toBe(0.5)
    expect(rp.wouldAutoAccept).toBe(0) // review_plan is not allowlisted
    const af = stats.find((s) => s.kind === "author_fix")!
    expect(af.shadowCount).toBe(1)
    // Post-#7: 0 — decideRoute requires a deterministic verifier (none
    // registered), so even an allowlisted high-confidence verdict escalates.
    expect(af.wouldAutoAccept).toBe(0)
  })

  test("report is stable and human-readable; empty is handled", async () => {
    expect(await calibrationReport(dir)).toContain("no shadow records")
    await writeShadowLog([
      { type: "shadow", requestId: "a", kind: "decompose", wouldVerdict: {}, confidence: 0.9, novelty: "known", stakes: "low" },
    ])
    const rep = await calibrationReport(dir)
    expect(rep).toContain("decompose")
  })

  test("AuditLog appends and lists", async () => {
    const log = new AuditLog({ dir, nowMs: () => 100 })
    await log.append({ event: "dispatched", requestId: "u1", repo: "o/n" })
    await log.append({ event: "auto_answered", requestId: "u2" })
    const events = await log.list()
    expect(events.map((e) => e.event)).toEqual(["dispatched", "auto_answered"])
    expect(events[0]?.atMs).toBe(100)
  })

  test("DeadLetterQueue quarantines a unit after N failures", async () => {
    const dlq = new DeadLetterQueue({ dir, maxFailures: 3 })
    expect((await dlq.recordFailure("u1", "ci red")).dead).toBe(false)
    expect((await dlq.recordFailure("u1", "ci red")).dead).toBe(false)
    const third = await dlq.recordFailure("u1", "ci red")
    expect(third.dead).toBe(true)
    expect(third.failures).toBe(3)
    expect(await dlq.isDead("u1")).toBe(true)
    expect(await dlq.isDead("u2")).toBe(false)
  })
})
