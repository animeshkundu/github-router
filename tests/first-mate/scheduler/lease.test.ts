import { beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  SchedulerLease,
  currentFencingToken,
  isCurrentFencingToken,
} from "~/lib/first-mate/scheduler/lease"

let dir: string
let clock: { ms: number }
const now = (): number => clock.ms

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "fm-lease-"))
  clock = { ms: 1_000_000 }
})

describe("SchedulerLease", () => {
  test("acquires a free lease and starts the fencing token at 1", async () => {
    const a = new SchedulerLease({ dir, ttlMs: 1000, nowMs: now })
    const held = await a.tryAcquire()
    expect(held?.fencingToken).toBe(1)
    expect(a.fencingToken).toBe(1)
    expect(await currentFencingToken(dir)).toBe(1)
  })

  test("does not steal a live lease held by someone else", async () => {
    const a = new SchedulerLease({ dir, ttlMs: 1000, nowMs: now })
    const b = new SchedulerLease({ dir, ttlMs: 1000, nowMs: now })
    expect(await a.tryAcquire()).toBeDefined()
    expect(await b.tryAcquire()).toBeUndefined()
    expect(b.fencingToken).toBeUndefined()
  })

  test("renew extends expiry without bumping the fencing token", async () => {
    const a = new SchedulerLease({ dir, ttlMs: 1000, nowMs: now })
    await a.tryAcquire()
    clock.ms += 500
    const renewed = await a.renew()
    expect(renewed?.fencingToken).toBe(1)
    expect(renewed?.expiresMs).toBe(clock.ms + 1000)
  })

  test("an expired lease can be stolen and the fencing token strictly increases", async () => {
    const a = new SchedulerLease({ dir, ttlMs: 1000, nowMs: now })
    const b = new SchedulerLease({ dir, ttlMs: 1000, nowMs: now })
    await a.tryAcquire()
    expect(await isCurrentFencingToken(1, dir)).toBe(true)
    clock.ms += 2000 // a's lease has expired
    const stolen = await b.tryAcquire()
    expect(stolen?.fencingToken).toBe(2)
    // a is now fenced out: its token 1 is no longer current.
    expect(await isCurrentFencingToken(1, dir)).toBe(false)
    expect(await isCurrentFencingToken(2, dir)).toBe(true)
    // a's renew must fail — it lost ownership.
    expect(await a.renew()).toBeUndefined()
  })

  test("release expires the lease so another driver can take it", async () => {
    const a = new SchedulerLease({ dir, ttlMs: 10_000, nowMs: now })
    const b = new SchedulerLease({ dir, ttlMs: 10_000, nowMs: now })
    await a.tryAcquire()
    expect(await b.tryAcquire()).toBeUndefined()
    await a.release()
    const held = await b.tryAcquire()
    expect(held?.fencingToken).toBe(2)
  })

  test("renew after a steal FAILS and never regresses the fencing token (#1)", async () => {
    const a = new SchedulerLease({ dir, ttlMs: 1000, nowMs: now })
    const b = new SchedulerLease({ dir, ttlMs: 1000, nowMs: now })
    expect((await a.tryAcquire())?.fencingToken).toBe(1)
    // A's lease lapses; B steals it -> token advances to 2.
    clock.ms += 2000
    expect((await b.tryAcquire())?.fencingToken).toBe(2)
    // A (unaware) tries to renew: it MUST fail (owner changed), and MUST NOT
    // write token 1 back over B's token 2 (the monotonicity/clobber invariant).
    expect(await a.renew()).toBeUndefined()
    expect(await currentFencingToken(dir)).toBe(2) // never regressed to 1
    // B still holds and can renew at its own token.
    expect((await b.renew())?.fencingToken).toBe(2)
    expect(await currentFencingToken(dir)).toBe(2)
  })
})
