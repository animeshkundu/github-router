import { beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  LEASE_LOCK_TTL_MS,
  SchedulerLease,
  currentFencingToken,
  isCurrentFencingToken,
  withLeaseLock,
} from "~/lib/first-mate/scheduler/lease"

let dir: string
let clock: { ms: number }
const now = (): number => clock.ms

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await pred()) return
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await sleep(5)
  }
}

async function readLock(lockPath: string): Promise<string | undefined> {
  try {
    return (await fs.readFile(lockPath, "utf8")).trim()
  } catch {
    return undefined
  }
}

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

  test("B2: N concurrent acquirers on an expired lease → EXACTLY ONE holder, no token collision", async () => {
    const seed = new SchedulerLease({ dir, ttlMs: 1000, nowMs: now })
    expect((await seed.tryAcquire())?.fencingToken).toBe(1)
    clock.ms += 5000 // seed lease has expired

    const racers = Array.from({ length: 6 }, () => new SchedulerLease({ dir, ttlMs: 10_000, nowMs: now }))
    const results = await Promise.all(racers.map((l) => l.tryAcquire()))
    const winners = results.filter((r): r is NonNullable<typeof r> => r !== undefined)

    // The codex collision would let >1 acquirer return the SAME token. O_EXCL
    // serialization means the first steals a fresh live lease and the rest see
    // it live → exactly one winner, and its token is the current fencing token.
    expect(winners.length).toBe(1)
    const finalToken = await currentFencingToken(dir)
    expect(winners[0]?.fencingToken).toBe(finalToken)
    for (const r of racers) {
      const held = r.fencingToken
      if (held === undefined) continue
      expect(await isCurrentFencingToken(held, dir)).toBe(held === finalToken)
    }
  })

  test("withLeaseLock: a stolen-and-recreated lock is NOT unlinked by the original holder's finally (#2)", async () => {
    const file = path.join(dir, "scheduler.lease.json")
    const lockPath = `${file}.lock`
    // A enters the lock. While inside its critical section its lock is broken
    // as stale and re-taken by another driver (modelled by overwriting the lock
    // file with a DIFFERENT owner token, exactly as steal-as-stale + a fresh
    // acquire would). A's finally must leave that lock alone — the lock TTL (10s)
    // is shorter than the lease TTL (30s), so this interleaving is reachable in
    // production and an unconditional unlink would delete the live owner's lock.
    let entered = false
    await withLeaseLock(file, async () => {
      entered = true
      await fs.writeFile(lockPath, "thief-owner-token")
    })
    expect(entered).toBe(true)
    // The thief's lock must survive: A must not have unlinked a lock it no
    // longer owns.
    expect(await readLock(lockPath)).toBe("thief-owner-token")
  })

  test("a stalled holder's finally must not free a live lock → no double-dispatch window (#2)", async () => {
    const file = path.join(dir, "scheduler.lease.json")
    const lockPath = `${file}.lock`
    const events: string[] = []
    const gateA = deferred()
    const gateC = deferred()

    // A acquires the lock and STALLS inside its critical section.
    const aDone = withLeaseLock(file, async () => {
      events.push("A:enter")
      await gateA.promise
      events.push("A:exit")
    })
    await waitFor(async () => (await readLock(lockPath)) !== undefined)
    const aOwner = await readLock(lockPath)
    // A stalled past the lock TTL: its lock is now stealable-as-stale.
    const stale = new Date(Date.now() - LEASE_LOCK_TTL_MS - 1_000)
    await fs.utimes(lockPath, stale, stale)

    // C breaks A's stale lock, acquires a FRESH lock, and also stalls inside.
    const cDone = withLeaseLock(file, async () => {
      events.push("C:enter")
      await gateC.promise
      events.push("C:exit")
    })
    await waitFor(async () => {
      const cur = await readLock(lockPath)
      return cur !== undefined && cur !== aOwner
    })
    const cOwner = await readLock(lockPath)
    expect(cOwner).not.toBe(aOwner)

    // A wakes: its finally runs NOW while C still holds the lock. With the old
    // unconditional unlink it would delete C's lock; the fix leaves it because A
    // no longer owns it.
    gateA.resolve()
    await aDone
    expect(await readLock(lockPath)).toBe(cOwner)

    // D tries to acquire. It MUST block until C releases (mutual exclusion),
    // i.e. D:enter comes strictly AFTER C:exit. With the bug, C's lock is gone,
    // so D would enter concurrently with C — two drivers in the critical section
    // reading the same lease and minting the same fencing token = double dispatch.
    const dDone = withLeaseLock(file, async () => {
      events.push("D:enter")
    })
    await sleep(60) // give a (wrongly) unlocked D the chance to enter
    expect(events).not.toContain("D:enter")

    gateC.resolve()
    await cDone
    await dDone
    expect(events).toEqual(["A:enter", "C:enter", "A:exit", "C:exit", "D:enter"])
  })
})
