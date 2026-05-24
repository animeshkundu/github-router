/**
 * Tests for `src/lib/worker-agent/lifecycle.ts`.
 *
 * Covers:
 *   - `getInstanceUuid()` is stable across calls (and resettable for tests).
 *   - `registerExitHandlers` registers each signal exactly once
 *     (idempotent across calls).
 *   - `sweepRegistry` walks entries and removes them from the registry.
 *   - `sweepStaleWorktreesAtBoot` removes dirs whose <pid>/<uuid>
 *     don't match the current proxy.
 *   - `recordWorkerRepo` writes the ledger atomically under
 *     concurrent invocation (no JSON corruption).
 *
 * Plan: `plans/we-have-added-a-dreamy-tide.md` ("Cleanup paths").
 *
 * Mocking strategy: same as `tests/lib-paths.test.ts` — override
 * `os.homedir()` to return a per-test-file temp dir BEFORE importing
 * any module that touches `PATHS.APP_DIR`. The os mock is global for
 * the rest of the test run; we preserve all other os exports.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const tempHome = await fs.mkdtemp(
  path.join(os.tmpdir(), "wa-lifecycle-"),
)

// Override `os.homedir()` BEFORE importing the module under test so
// `PATHS.APP_DIR` resolves under our temp dir. Preserve every other
// os export — see `tests/lib-paths.test.ts` for the same pattern's
// rationale (later tests may import node:os and expect tmpdir/platform).
mock.module("node:os", () => ({
  default: { ...os, homedir: () => tempHome },
  ...os,
  homedir: () => tempHome,
}))

const {
  WorktreeRegistry,
  __clearLedgerForTests,
  __readLedgerForTests,
  __resetInstanceUuidForTests,
  __unregisterExitHandlersForTests,
  getInstanceUuid,
  recordWorkerRepo,
  registerExitHandlers,
  sweepRegistry,
  sweepStaleWorktreesAtBoot,
} = await import("../src/lib/worker-agent/lifecycle")

const { PATHS } = await import("../src/lib/paths")

beforeAll(async () => {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
})

// ---------------------------------------------------------------------
// getInstanceUuid
// ---------------------------------------------------------------------

describe("getInstanceUuid", () => {
  test("returns the same UUID across repeated calls", () => {
    __resetInstanceUuidForTests()
    const a = getInstanceUuid()
    const b = getInstanceUuid()
    expect(a).toBe(b)
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  test("__resetInstanceUuidForTests yields a fresh UUID", () => {
    __resetInstanceUuidForTests()
    const first = getInstanceUuid()
    __resetInstanceUuidForTests()
    const second = getInstanceUuid()
    expect(first).not.toBe(second)
  })
})

// ---------------------------------------------------------------------
// registerExitHandlers + sweepRegistry
// ---------------------------------------------------------------------

describe("registerExitHandlers", () => {
  test("registers each signal handler exactly once", () => {
    __unregisterExitHandlersForTests()
    const baseSigInt = process.listenerCount("SIGINT")
    const baseSigTerm = process.listenerCount("SIGTERM")
    const baseExit = process.listenerCount("exit")

    registerExitHandlers(new WorktreeRegistry())
    expect(process.listenerCount("SIGINT")).toBe(baseSigInt + 1)
    expect(process.listenerCount("SIGTERM")).toBe(baseSigTerm + 1)
    expect(process.listenerCount("exit")).toBe(baseExit + 1)

    // Idempotent: second call must NOT add another listener.
    registerExitHandlers(new WorktreeRegistry())
    expect(process.listenerCount("SIGINT")).toBe(baseSigInt + 1)
    expect(process.listenerCount("SIGTERM")).toBe(baseSigTerm + 1)
    expect(process.listenerCount("exit")).toBe(baseExit + 1)

    __unregisterExitHandlersForTests()
    expect(process.listenerCount("SIGINT")).toBe(baseSigInt)
    expect(process.listenerCount("SIGTERM")).toBe(baseSigTerm)
    expect(process.listenerCount("exit")).toBe(baseExit)
  })

  test("sweepRegistry drains the active registry (best-effort)", () => {
    __unregisterExitHandlersForTests()
    const registry = new WorktreeRegistry()
    // Synthetic entries pointing nowhere — git will fail to remove
    // them, but the sweep must still drop them from the registry.
    registry.add({
      repoRoot: path.join(tempHome, "does-not-exist-repo-1"),
      dir: path.join(tempHome, "does-not-exist-worktree-1"),
      branch: "worker/synthetic-1",
    })
    registry.add({
      repoRoot: path.join(tempHome, "does-not-exist-repo-2"),
      dir: path.join(tempHome, "does-not-exist-worktree-2"),
      branch: "worker/synthetic-2",
    })
    expect(registry.size).toBe(2)
    registerExitHandlers(registry)
    sweepRegistry()
    expect(registry.size).toBe(0)
    __unregisterExitHandlersForTests()
  })

  test("sweepRegistry without a registered registry is a no-op", () => {
    __unregisterExitHandlersForTests()
    expect(() => sweepRegistry()).not.toThrow()
  })
})

// ---------------------------------------------------------------------
// recordWorkerRepo + atomic ledger writes
// ---------------------------------------------------------------------

describe("recordWorkerRepo", () => {
  test("writes a single entry", async () => {
    await __clearLedgerForTests()
    await recordWorkerRepo("/some/repo")
    const entries = await __readLedgerForTests()
    expect(entries.length).toBe(1)
    expect(entries[0].repoRoot).toBe("/some/repo")
    expect(typeof entries[0].lastSeenMs).toBe("number")
  })

  test("dedupes repeated calls for the same repo", async () => {
    await __clearLedgerForTests()
    await recordWorkerRepo("/some/repo")
    await recordWorkerRepo("/some/repo")
    await recordWorkerRepo("/some/repo")
    const entries = await __readLedgerForTests()
    expect(entries.length).toBe(1)
    expect(entries[0].repoRoot).toBe("/some/repo")
  })

  test("concurrent writes don't corrupt the ledger", async () => {
    await __clearLedgerForTests()
    const repos = Array.from({ length: 25 }, (_, i) => `/repo-${i}`)
    await Promise.all(repos.map((r) => recordWorkerRepo(r)))
    // The on-disk file must still be valid JSON describing every repo.
    const raw = await fs.readFile(
      path.join(PATHS.APP_DIR, "worker-repos.json"),
      "utf8",
    )
    const parsed = JSON.parse(raw) as { entries: Array<{ repoRoot: string }> }
    expect(Array.isArray(parsed.entries)).toBe(true)
    const seen = new Set(parsed.entries.map((e) => e.repoRoot))
    for (const r of repos) {
      expect(seen.has(r)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------
// sweepStaleWorktreesAtBoot
// ---------------------------------------------------------------------

describe("sweepStaleWorktreesAtBoot", () => {
  test("removes stale dirs (dead PID or wrong UUID), keeps live ours", async () => {
    // Reset so we control which UUID is "current".
    __resetInstanceUuidForTests()
    const currentUuid = getInstanceUuid()
    const otherUuid = randomUUID()
    const livePid = process.pid
    // Pick a PID that is overwhelmingly unlikely to be alive. Linux
    // and macOS use 32-bit PIDs but reserve high values; 2_147_000_000
    // sits past the typical pid_max ceilings without colliding with
    // sentinel values.
    const deadPid = 2_147_000_000

    // Set up a fake "repo" — sweep treats `<repoRoot>/.git/worker-worktrees/`
    // as the parent dir. Anything outside that pattern is ignored.
    const repoRoot = path.join(tempHome, "boot-sweep-repo")
    const parent = path.join(repoRoot, ".git", "worker-worktrees")
    await fs.mkdir(parent, { recursive: true })

    const mkdir = async (slug: string): Promise<string> => {
      const dir = path.join(parent, slug)
      await fs.mkdir(dir, { recursive: true })
      // Drop a marker file so we can verify the dir was actually
      // removed by the sweep (rather than already missing).
      await fs.writeFile(path.join(dir, "marker.txt"), slug)
      return dir
    }

    // 1. Live PID + current UUID — must survive.
    const survivor = await mkdir(`${livePid}-${currentUuid}-aaaaaaaa`)
    // 2. Live PID + wrong UUID — must be removed.
    const wrongUuidLivePid = await mkdir(`${livePid}-${otherUuid}-bbbbbbbb`)
    // 3. Dead PID + current UUID — must be removed.
    const deadPidCurrentUuid = await mkdir(
      `${deadPid}-${currentUuid}-cccccccc`,
    )
    // 4. Dead PID + wrong UUID — must be removed.
    const deadPidWrongUuid = await mkdir(`${deadPid}-${otherUuid}-dddddddd`)
    // 5. Random unrelated dir name — must be left alone.
    const unrelated = path.join(parent, "definitely-not-a-worktree-of-ours")
    await fs.mkdir(unrelated)
    await fs.writeFile(path.join(unrelated, "marker.txt"), "leave me alone")

    // Wire the ledger so the sweep knows where to look.
    await __clearLedgerForTests()
    await recordWorkerRepo(repoRoot)

    await sweepStaleWorktreesAtBoot()

    const stillExists = async (p: string): Promise<boolean> => {
      try {
        await fs.stat(p)
        return true
      } catch {
        return false
      }
    }

    expect(await stillExists(survivor)).toBe(true)
    expect(await stillExists(wrongUuidLivePid)).toBe(false)
    expect(await stillExists(deadPidCurrentUuid)).toBe(false)
    expect(await stillExists(deadPidWrongUuid)).toBe(false)
    expect(await stillExists(unrelated)).toBe(true)
  })

  test("is a no-op when the ledger is empty", async () => {
    await __clearLedgerForTests()
    await expect(sweepStaleWorktreesAtBoot()).resolves.toBeUndefined()
  })
})
