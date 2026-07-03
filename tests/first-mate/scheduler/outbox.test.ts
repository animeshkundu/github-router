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
    expect(r1).toEqual({ done: 1, retried: 0, deadLettered: 0 })
    expect(calls).toBe(1)
    // second pass: nothing pending, executor not called again
    const r2 = await ob.reconcile(exec)
    expect(r2).toEqual({ done: 0, retried: 0, deadLettered: 0 })
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

  test("#4: a transient failure is re-armed and eventually applies (not dropped)", async () => {
    const ob = new Outbox({ dir, nowMs: now })
    await ob.record({ key: "merge-1", kind: "merge" })
    let attempt = 0
    const exec = async (): Promise<ExecOutcome> => {
      attempt += 1
      return attempt === 1 ? "retry" : "done"
    }
    await ob.reconcile(exec) // pass 1: transient failure → failed(attempts=1)
    expect((await ob.list("failed")).length).toBe(1)
    // Immediately re-running does NOT re-drive (backoff not elapsed).
    await ob.reconcile(exec)
    expect(attempt).toBe(1)
    // After backoff, it re-arms and succeeds — the effect is not lost.
    clock.ms += 2000
    const r = await ob.reconcile(exec)
    expect(r.done).toBe(1)
    expect((await ob.list("done")).length).toBe(1)
    expect((await ob.list("failed")).length).toBe(0)
  })

  test("#4: gives up after maxAttempts (dead-letter), stops re-driving", async () => {
    const ob = new Outbox({ dir, nowMs: now })
    await ob.record({ key: "always-fail", kind: "merge" })
    const exec = async (): Promise<ExecOutcome> => "retry"
    for (let i = 0; i < 5; i += 1) {
      await ob.reconcile(exec, { maxAttempts: 3 })
      clock.ms += 100_000 // always past backoff
    }
    const failed = await ob.list("failed")
    expect(failed[0]?.attempts).toBe(3) // capped at the budget, not driven further
    const r = await ob.reconcile(exec, { maxAttempts: 3 })
    expect(r.deadLettered).toBe(1)
  })
})
