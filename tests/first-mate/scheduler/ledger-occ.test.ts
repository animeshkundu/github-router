import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { RepoRef, UnitRow } from "~/lib/first-mate/types"

const firstMateDir = await fs.mkdtemp(path.join(tmpdir(), "fm-occ-"))

mock.module("~/lib/paths", () => ({
  PATHS: { FIRST_MATE_DIR: firstMateDir },
}))

const {
  readRepoLedgerWithRev,
  commitUnits,
  runFenced,
  currentFenceToken,
  LedgerConflictError,
  LedgerFencedError,
} = await import("~/lib/first-mate/ledger")
const { SchedulerLease } = await import("~/lib/first-mate/scheduler/lease")
const { Outbox } = await import("~/lib/first-mate/scheduler/outbox")

function unit(id: string, repo: RepoRef): UnitRow {
  return {
    missionId: "m1",
    repo,
    issue: null,
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
    title: id,
    id,
  }
}

const ids = (units: UnitRow[]): string[] => units.map((u) => u.id ?? "").sort()

beforeEach(() => {
  // OCC is ON by default now; ensure no stray escape-hatch leaks between tests.
  delete process.env.GH_ROUTER_FM_OCC
})
afterEach(() => {
  delete process.env.GH_ROUTER_FM_OCC
})

describe("ledger OCC / CAS on the shared write path", () => {
  test("single writer with OCC on never rejects a caller (safe for restart)", async () => {
    const repo: RepoRef = { owner: "o", name: "single" }
    // Sequential writes with no expectedRev — mirrors the heartbeat-only runtime.
    for (let i = 0; i < 5; i += 1) {
      const { rev } = await commitUnits(repo, (u) => [...u, unit(`u${i}`, repo)])
      expect(rev).toBe(i + 1)
    }
    expect(ids((await readRepoLedgerWithRev(repo)).units)).toEqual([
      "u0",
      "u1",
      "u2",
      "u3",
      "u4",
    ])
  })

  test("escape hatch (GH_ROUTER_FM_OCC=0) uses legacy behavior and never rejects", async () => {
    process.env.GH_ROUTER_FM_OCC = "0"
    const repo: RepoRef = { owner: "o", name: "off" }
    // A stale expectedRev is IGNORED when OCC is off (legacy behavior).
    const { rev } = await commitUnits(repo, () => [unit("a", repo)], { expectedRev: 999 })
    expect(rev).toBe(1)
    expect(ids((await readRepoLedgerWithRev(repo)).units)).toEqual(["a"])
  })

  test("stale-version write is rejected (CAS) and does not clobber", async () => {
    const repo: RepoRef = { owner: "o", name: "cas" }
    await commitUnits(repo, () => [unit("a", repo)]) // rev 1
    const stale = (await readRepoLedgerWithRev(repo)).rev // 1
    await commitUnits(repo, (u) => [...u, unit("b", repo)]) // concurrent → rev 2

    await expect(
      commitUnits(repo, (u) => [...u, unit("c", repo)], { expectedRev: stale }),
    ).rejects.toBeInstanceOf(LedgerConflictError)

    const after = await readRepoLedgerWithRev(repo)
    expect(after.rev).toBe(2) // no extra write happened
    expect(ids(after.units)).toEqual(["a", "b"]) // c never landed
  })

  test("fencing: the current-token holder wins, a stale token is rejected", async () => {
    const repo: RepoRef = { owner: "o", name: "fence" }
    const lease1 = new SchedulerLease({ dir: firstMateDir, ttlMs: 10_000 })
    const held1 = await lease1.tryAcquire()
    expect(held1).toBeDefined()
    await commitUnits(repo, () => [unit("a", repo)], { fencingToken: held1!.fencingToken })

    await lease1.release()
    const lease2 = new SchedulerLease({ dir: firstMateDir, ttlMs: 10_000 })
    const held2 = await lease2.tryAcquire()
    expect(held2?.fencingToken).toBe(2)

    // The old driver (token 1) has been fenced out.
    await expect(
      commitUnits(repo, (u) => [...u, unit("b", repo)], {
        fencingToken: held1!.fencingToken,
      }),
    ).rejects.toBeInstanceOf(LedgerFencedError)

    // The current holder (token 2) commits.
    await commitUnits(repo, (u) => [...u, unit("b", repo)], {
      fencingToken: held2!.fencingToken,
    })
    expect(ids((await readRepoLedgerWithRev(repo)).units)).toEqual(["a", "b"])
    await lease2.release() // free the shared lease file for later tests
  })

  test("hot-path fencing: runFenced sets the ambient token for every write", async () => {
    const repo: RepoRef = { owner: "o", name: "als" }
    const lease1 = new SchedulerLease({ dir: firstMateDir, ttlMs: 10_000 })
    const held1 = await lease1.tryAcquire()
    expect(held1).toBeDefined()

    // Inside runFenced, commitUnits with NO explicit fencingToken picks up the
    // ambient token — a bare upsert on the hot path is fenced automatically.
    await runFenced(held1!.fencingToken, async () => {
      expect(currentFenceToken()).toBe(held1!.fencingToken)
      await commitUnits(repo, () => [unit("a", repo)])
    })
    expect(currentFenceToken()).toBeUndefined() // scope cleared

    // A second driver steals the lease (bumps the token). The first driver's
    // ambient token is now stale: every write in its scope is rejected — not
    // just the ones that happened to pass an explicit token.
    await lease1.release()
    const lease2 = new SchedulerLease({ dir: firstMateDir, ttlMs: 10_000 })
    const held2 = await lease2.tryAcquire()
    expect(held2!.fencingToken).toBeGreaterThan(held1!.fencingToken)

    await expect(
      runFenced(held1!.fencingToken, async () => {
        await commitUnits(repo, (u) => [...u, unit("b", repo)])
      }),
    ).rejects.toBeInstanceOf(LedgerFencedError)

    // The current holder's scope commits fine.
    await runFenced(held2!.fencingToken, async () => {
      await commitUnits(repo, (u) => [...u, unit("b", repo)])
    })
    expect(ids((await readRepoLedgerWithRev(repo)).units)).toEqual(["a", "b"])

    // An explicit fencingToken still overrides the ambient one.
    await runFenced(held1!.fencingToken, async () => {
      await commitUnits(repo, (u) => [...u, unit("c", repo)], {
        fencingToken: held2!.fencingToken,
      })
    })
    expect(ids((await readRepoLedgerWithRev(repo)).units)).toEqual(["a", "b", "c"])
  })

  test("concurrent commits do not lose updates (cross-process lock)", async () => {
    const repo: RepoRef = { owner: "o", name: "conc" }
    await commitUnits(repo, () => [])
    await Promise.all([
      commitUnits(repo, (u) => [...u, unit("x", repo)]),
      commitUnits(repo, (u) => [...u, unit("y", repo)]),
      commitUnits(repo, (u) => [...u, unit("z", repo)]),
    ])
    const after = await readRepoLedgerWithRev(repo)
    expect(ids(after.units)).toEqual(["x", "y", "z"])
    expect(after.rev).toBe(4) // one empty seed + three appends
  })

  test("stale commit + outbox: a retry does not double-record the side effect", async () => {
    const repo: RepoRef = { owner: "o", name: "combo" }
    const ob = new Outbox({ dir: firstMateDir })
    await commitUnits(repo, () => [unit("a", repo)]) // rev 1
    const stale = (await readRepoLedgerWithRev(repo)).rev
    await commitUnits(repo, (u) => [...u, unit("b", repo)]) // concurrent → rev 2

    const key = "merge:o/combo#c"
    // First attempt: record intent (idempotent), then a stale CAS write fails
    // BEFORE any external effect → no partial ledger write, intent recorded once.
    let conflicted = false
    try {
      await ob.record({ key, kind: "merge" })
      await commitUnits(repo, (u) => [...u, unit("c", repo)], { expectedRev: stale })
    } catch (err) {
      conflicted = err instanceof LedgerConflictError
    }
    expect(conflicted).toBe(true)

    // Retry with the fresh rev; re-recording the same key is a no-op.
    const fresh = (await readRepoLedgerWithRev(repo)).rev
    await ob.record({ key, kind: "merge" })
    await commitUnits(repo, (u) => [...u, unit("c", repo)], { expectedRev: fresh })

    expect((await ob.list()).length).toBe(1) // no double side-effect
    expect(ids((await readRepoLedgerWithRev(repo)).units)).toEqual(["a", "b", "c"])
  })
})
