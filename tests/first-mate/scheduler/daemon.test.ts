import { beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { SchedulerDaemon, type AdvanceLike } from "~/lib/first-mate/scheduler/daemon"
import { SchedulerLease } from "~/lib/first-mate/scheduler/lease"

let dir: string
let clock: { ms: number }
const now = (): number => clock.ms

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "fm-daemon-"))
  clock = { ms: 1_000_000 }
})

function lease(): SchedulerLease {
  return new SchedulerLease({ dir, ttlMs: 30_000, nowMs: now })
}

describe("SchedulerDaemon.tickOnce", () => {
  test("owns the lease, calls advance, and schedules from nextWakeSeconds (clamped)", async () => {
    let calls = 0
    const advance = async (): Promise<AdvanceLike> => {
      calls += 1
      return { nextWakeSeconds: 120, activeUnits: 1, progressKey: `p${calls}` }
    }
    const d = new SchedulerDaemon({ advance, lease: lease(), nowMs: now })
    const r = await d.tickOnce()
    expect(r.ran).toBe(true)
    expect(calls).toBe(1)
    expect(r.nextDelayMs).toBe(120_000)
  })

  test("clamps nextWakeSeconds into [60,3600]s", async () => {
    const d = new SchedulerDaemon({
      advance: async () => ({ nextWakeSeconds: 5 }),
      lease: lease(),
      nowMs: now,
    })
    expect((await d.tickOnce()).nextDelayMs).toBe(60_000)
  })

  test("idle portfolio (nextWakeSeconds null) backs off to the max", async () => {
    const d = new SchedulerDaemon({
      advance: async () => ({ nextWakeSeconds: null }),
      lease: lease(),
      nowMs: now,
      maxBackoffMs: 300_000,
    })
    expect((await d.tickOnce()).nextDelayMs).toBe(300_000)
  })

  test("advance failure triggers capped exponential backoff", async () => {
    const d = new SchedulerDaemon({
      advance: async () => {
        throw new Error("github down")
      },
      lease: lease(),
      nowMs: now,
      minBackoffMs: 1000,
      maxBackoffMs: 8000,
    })
    expect((await d.tickOnce()).nextDelayMs).toBe(1000) // 1000 * 2^0
    expect((await d.tickOnce()).nextDelayMs).toBe(2000) // 2^1
    expect((await d.tickOnce()).nextDelayMs).toBe(4000) // 2^2
    expect((await d.tickOnce()).nextDelayMs).toBe(8000) // 2^3
    expect((await d.tickOnce()).nextDelayMs).toBe(8000) // capped
  })

  test("does not run advance when another driver holds a live lease", async () => {
    const other = lease()
    await other.tryAcquire() // someone else owns it, live
    let calls = 0
    const d = new SchedulerDaemon({
      advance: async () => {
        calls += 1
        return { nextWakeSeconds: 60 }
      },
      lease: lease(),
      nowMs: now,
    })
    const r = await d.tickOnce()
    expect(r.ran).toBe(false)
    expect(r.reason).toBe("not_owner")
    expect(calls).toBe(0)
  })

  test("stuck-unit watchdog escalates after N no-progress ticks", async () => {
    const escalations: Array<{ cycles: number }> = []
    const d = new SchedulerDaemon({
      advance: async () => ({ nextWakeSeconds: 60, activeUnits: 2, progressKey: "frozen" }),
      lease: lease(),
      nowMs: now,
      stuckThreshold: 3,
      onStuck: (info) => escalations.push({ cycles: info.cycles }),
    })
    // First tick establishes the baseline key; 3 further identical ticks == 3
    // no-progress cycles, so escalation fires on the 4th tick.
    for (let i = 0; i < 4; i += 1) await d.tickOnce()
    expect(escalations.length).toBe(1)
    expect(escalations[0]?.cycles).toBe(3)
  })

  test("watchdog does not escalate while progress advances", async () => {
    let n = 0
    const escalations: number[] = []
    const d = new SchedulerDaemon({
      advance: async () => ({ nextWakeSeconds: 60, activeUnits: 2, progressKey: `step-${n++}` }),
      lease: lease(),
      nowMs: now,
      stuckThreshold: 3,
      onStuck: () => escalations.push(1),
    })
    for (let i = 0; i < 5; i += 1) await d.tickOnce()
    expect(escalations.length).toBe(0)
  })

  test("stop() is a kill switch: releases the lease and halts", async () => {
    const l = lease()
    const d = new SchedulerDaemon({
      advance: async () => ({ nextWakeSeconds: 60 }),
      lease: l,
      nowMs: now,
    })
    await d.tickOnce()
    await d.stop()
    expect(d.isRunning).toBe(false)
    // lease released → a fresh driver can acquire immediately
    const other = new SchedulerLease({ dir, ttlMs: 30_000, nowMs: now })
    expect(await other.tryAcquire()).toBeDefined()
  })
})
