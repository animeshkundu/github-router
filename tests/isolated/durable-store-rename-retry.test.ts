import { describe, expect, mock, test } from "bun:test"
import fsSync from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Windows `fs.rename` over an existing destination transiently fails with
 * EPERM / EBUSY / EACCES whenever anything else holds the target open for a
 * moment — antivirus, the search indexer, a backup agent. Nothing is actually
 * wrong; the handle closes microseconds later.
 *
 * This was not theoretical. `tests/isolated/first-mate-ledger.test.ts` failed
 * a full-suite run with exactly this, on the mission ledger:
 *
 *   EPERM: operation not permitted, rename
 *     '...\octo__alpha.json.tmp.29688.01ab3a8c' -> '...\octo__alpha.json'
 *
 * and passed on its own immediately after. The tempting read is "flaky test".
 * The correct read is that `writeJsonSecure` is the durable write for mission
 * ledgers and decisions, so an unretried rename means one badly-timed AV scan
 * throws out of a state write on the project's primary platform. The test was
 * reporting a production bug.
 *
 * This file drives the retry deterministically rather than hoping to catch a
 * real AV race: `fs.rename` is stubbed to fail N times and then succeed.
 *
 * Isolated (`mock.module`) because the stub is process-global.
 */

const realRename = fsSync.promises.rename.bind(fsSync.promises)

let failuresRemaining = 0
let renameAttempts = 0

const stubbedRename = async (from: fsSync.PathLike, to: fsSync.PathLike) => {
  renameAttempts += 1
  if (failuresRemaining > 0) {
    failuresRemaining -= 1
    const err = new Error(
      `EPERM: operation not permitted, rename '${String(from)}' -> '${String(to)}'`,
    ) as NodeJS.ErrnoException
    err.code = "EPERM"
    throw err
  }
  return realRename(from, to)
}

mock.module("node:fs/promises", () => {
  const patched = { ...fsSync.promises, rename: stubbedRename }
  return { ...patched, default: patched }
})

const { writeJsonSecure } = await import("~/lib/first-mate/durable-store")

const dir = await fsSync.promises.mkdtemp(
  path.join(tmpdir(), "durable-store-rename-"),
)

describe("writeJsonSecure: transient rename failure", () => {
  test("recovers from a transient EPERM instead of losing the write", async () => {
    const target = path.join(dir, "ledger-transient.json")
    failuresRemaining = 2 // fails twice, succeeds on the third attempt
    renameAttempts = 0

    await writeJsonSecure(target, { mission: "alpha", units: 3 })

    expect(renameAttempts).toBe(3)
    // The bytes actually landed — a retry that "succeeds" without writing
    // would be worse than the original failure.
    const written = JSON.parse(
      await fsSync.promises.readFile(target, "utf8"),
    ) as { mission: string, units: number }
    expect(written).toEqual({ mission: "alpha", units: 3 })
  })

  test("still throws when the failure is persistent", async () => {
    // A retry loop that swallows a real error is worse than no retry: the
    // caller would believe state was durable when it was not. Permissions and
    // a full disk both look like this.
    const target = path.join(dir, "ledger-persistent.json")
    failuresRemaining = Number.MAX_SAFE_INTEGER
    renameAttempts = 0

    await expect(writeJsonSecure(target, { mission: "beta" })).rejects.toThrow(
      /EPERM/,
    )
    // Bounded: 1 initial attempt + 3 retries, not an unbounded spin.
    expect(renameAttempts).toBe(4)

    failuresRemaining = 0
  })

  test("leaves no temp file behind after a persistent failure", async () => {
    const target = path.join(dir, "ledger-cleanup.json")
    failuresRemaining = Number.MAX_SAFE_INTEGER

    await expect(writeJsonSecure(target, { mission: "gamma" })).rejects.toThrow()
    failuresRemaining = 0

    const leftovers = (await fsSync.promises.readdir(dir)).filter((f) =>
      f.startsWith("ledger-cleanup.json.tmp"),
    )
    expect(leftovers).toEqual([])
  })

  test("succeeds on the first attempt when nothing is contending", async () => {
    const target = path.join(dir, "ledger-clean.json")
    failuresRemaining = 0
    renameAttempts = 0

    await writeJsonSecure(target, { mission: "delta" })

    // The retry must not add latency to the normal path.
    expect(renameAttempts).toBe(1)
  })
})
