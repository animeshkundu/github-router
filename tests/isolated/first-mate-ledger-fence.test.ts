import { describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { RepoRef, UnitRow } from "~/lib/first-mate/types"

const firstMateDir = await fs.mkdtemp(path.join(tmpdir(), "fm-fence-recheck-"))

mock.module("~/lib/paths", () => ({
  PATHS: { FIRST_MATE_DIR: firstMateDir },
}))

// Scriptable fencing checker: each call shifts the next scripted boolean off
// `fenceScript`; when empty it defaults to true. This lets a test make the FIRST
// check (top of tryCasWrite) pass and a LATER check (immediately before the
// physical write) fail — proving the write is gated by a re-check, not just the
// initial one. (Isolated test file → mock.module runs in its own process.)
let fenceScript: boolean[] = []
mock.module("~/lib/first-mate/scheduler/lease", () => ({
  isCurrentFencingToken: async (): Promise<boolean> =>
    fenceScript.length > 0 ? fenceScript.shift()! : true,
  currentFencingToken: async (): Promise<number> => 1,
}))

const { commitUnits, readRepoLedgerWithRev, LedgerFencedError } = await import(
  "~/lib/first-mate/ledger"
)

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

describe("#4 — fencing is re-checked immediately before the physical write", () => {
  test("a lease rotation AFTER the top check but before the write aborts the write (no lost update)", async () => {
    const repo: RepoRef = { owner: "o", name: "recheck" }
    // Seed (no fencing token → isCurrentFencingToken is not consulted).
    await commitUnits(repo, () => [unit("a", repo)])
    expect((await readRepoLedgerWithRev(repo)).rev).toBe(1)

    // check#1 (top of tryCasWrite) → true (still current), pre-write re-check →
    // false (the lease rotated in the window). The write must be rejected.
    fenceScript = [true, false]
    await expect(
      commitUnits(repo, (u) => [...u, unit("b", repo)], { fencingToken: 1 }),
    ).rejects.toBeInstanceOf(LedgerFencedError)

    // No lost update: "b" never landed and the rev did not advance.
    const after = await readRepoLedgerWithRev(repo)
    expect(ids(after.units)).toEqual(["a"])
    expect(after.rev).toBe(1)
    // Both checks were consumed → the write path performs the SECOND check.
    expect(fenceScript.length).toBe(0)
  })

  test("a token that stays current through the write commits normally", async () => {
    const repo: RepoRef = { owner: "o", name: "stays" }
    fenceScript = [] // always current
    await commitUnits(repo, () => [unit("a", repo)], { fencingToken: 1 })
    await commitUnits(repo, (u) => [...u, unit("b", repo)], { fencingToken: 1 })
    expect(ids((await readRepoLedgerWithRev(repo)).units)).toEqual(["a", "b"])
  })

  test("a stale token at the TOP check still fails fast", async () => {
    const repo: RepoRef = { owner: "o", name: "topfail" }
    await commitUnits(repo, () => [unit("a", repo)])
    fenceScript = [false] // rejected at the first check
    await expect(
      commitUnits(repo, (u) => [...u, unit("b", repo)], { fencingToken: 1 }),
    ).rejects.toBeInstanceOf(LedgerFencedError)
    expect(ids((await readRepoLedgerWithRev(repo)).units)).toEqual(["a"])
  })
})
