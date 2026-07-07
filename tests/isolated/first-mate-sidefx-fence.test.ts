import { describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const firstMateDir = await fs.mkdtemp(path.join(tmpdir(), "fm-sidefx-fence-"))

mock.module("~/lib/paths", () => ({
  PATHS: { FIRST_MATE_DIR: firstMateDir },
}))

// Controllable ambient-lease check (isolated file → mock.module is process-local).
let leaseCurrent = true
mock.module("~/lib/first-mate/scheduler/lease", () => ({
  isCurrentFencingToken: async (): Promise<boolean> => leaseCurrent,
  currentFencingToken: async (): Promise<number> => (leaseCurrent ? 7 : 8),
}))

const { assertFenceHeld } = await import("~/lib/first-mate/controller")
const { runFenced } = await import("~/lib/first-mate/ledger")

describe("#8 — external side effects are gated behind the ambient fencing lease", () => {
  test("inside a fenced scope whose lease was stolen, the guard throws (effect is skipped)", async () => {
    leaseCurrent = false
    await runFenced(7, async () => {
      await expect(assertFenceHeld("submitReview")).rejects.toThrow(/lease lost/i)
    })
  })

  test("inside a fenced scope we still hold, the guard passes (effect proceeds)", async () => {
    leaseCurrent = true
    await runFenced(7, async () => {
      await expect(assertFenceHeld("requestReview")).resolves.toBeUndefined()
    })
  })

  test("outside any fenced scope the guard is a no-op (tests / tools / non-daemon lead)", async () => {
    leaseCurrent = false // even a 'stale' lease is irrelevant with no ambient token
    await expect(assertFenceHeld("postComment")).resolves.toBeUndefined()
  })
})
