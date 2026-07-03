import { beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Outbox, type ExecOutcome } from "~/lib/first-mate/scheduler/outbox"

let dir: string
let clock: { ms: number }
const now = (): number => clock.ms

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "fm-outbox-"))
  clock = { ms: 1_000_000 }
})

describe("Outbox", () => {
  test("record is idempotent by key", async () => {
    const ob = new Outbox({ dir, nowMs: now })
    const first = await ob.record({ key: "merge:o/n#1@sha", kind: "merge" })
    const second = await ob.record({ key: "merge:o/n#1@sha", kind: "merge" })
    expect(first.status).toBe("pending")
    expect(second.createdMs).toBe(first.createdMs)
    expect((await ob.list()).length).toBe(1)
  })

  test("reconcile settles a successful side effect exactly once", async () => {
    const ob = new Outbox({ dir, nowMs: now })
    await ob.record({ key: "k1", kind: "dispatch" })
    let calls = 0
    const exec = async (): Promise<ExecOutcome> => {
      calls += 1
      return "done"
    }
    const r1 = await ob.reconcile(exec)
    expect(r1).toEqual({ done: 1, retried: 0 })
    expect(calls).toBe(1)
    // second pass: nothing pending, executor not called again
    const r2 = await ob.reconcile(exec)
    expect(r2).toEqual({ done: 0, retried: 0 })
    expect(calls).toBe(1)
    expect((await ob.list("done")).length).toBe(1)
  })

  test("an 'already applied' outcome maps to done (poison-pill avoidance)", async () => {
    const ob = new Outbox({ dir, nowMs: now })
    await ob.record({ key: "merge-again", kind: "merge" })
    // Simulate GitHub 409/422: the PR was merged on a prior crashed tick.
    const r = await ob.reconcile(async () => "already")
    expect(r.done).toBe(1)
    expect((await ob.list("pending")).length).toBe(0)
  })

  test("retry keeps the entry pending and increments attempts", async () => {
    const ob = new Outbox({ dir, nowMs: now })
    await ob.record({ key: "flaky", kind: "dispatch" })
    await ob.reconcile(async () => "retry")
    const failed = await ob.list("failed")
    expect(failed.length).toBe(1)
    expect(failed[0]?.attempts).toBe(1)
    expect(failed[0]?.lastError).toBeDefined()
  })

  test("a thrown executor error is caught and recorded, not propagated", async () => {
    const ob = new Outbox({ dir, nowMs: now })
    await ob.record({ key: "boom", kind: "dispatch" })
    const r = await ob.reconcile(async () => {
      throw new Error("network blip")
    })
    expect(r.retried).toBe(1)
    const failed = await ob.list("failed")
    expect(failed[0]?.lastError).toContain("network blip")
  })

  test("intent survives a process crash (durable across instances)", async () => {
    const before = new Outbox({ dir, nowMs: now })
    await before.record({ key: "durable-1", kind: "merge" })
    // New instance on the same dir == a fresh process after a crash.
    const after = new Outbox({ dir, nowMs: now })
    const pending = await after.list("pending")
    expect(pending.map((e) => e.key)).toEqual(["durable-1"])
  })
})
