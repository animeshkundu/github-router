/**
 * E2E test for `sweepStaleWorktreesAtBoot` — simulates a real proxy
 * crash by creating `.git/worker-worktrees/<dead-pid>-<old-uuid>-…`
 * worktrees via REAL `git worktree add`, then verifies the boot-sweep
 * removes them on the next launch while preserving worktrees owned by
 * the current PID + current instance UUID.
 *
 * Why this is separate from the synthetic-dir unit test in
 * `tests/worker-agent-lifecycle.test.ts`: that test uses `fs.mkdir` +
 * marker files to fake the worktree dirs, which exercises the
 * loop / PID-UUID parsing / fs.rm fallback, but does NOT exercise
 * the load-bearing `git worktree remove --force` integration. Codex
 * reviewer MEDIUM-C (task #12) flagged the coverage gap — the
 * boot-sweep is the only safety net when SIGKILL / OOM / host crash
 * bypasses the session-end deterministic sweep, so the git-removal
 * path must have a regression test that actually invokes git.
 *
 * Mocking strategy: same as `tests/worker-agent-lifecycle.test.ts`
 * and `tests/lib-paths.test.ts` — override `os.homedir()` BEFORE
 * importing any module that touches `PATHS.APP_DIR`, so the ledger
 * lands under a per-test-file temp dir. Bun runs each test file in
 * its own process by default, so the mock doesn't bleed across files.
 *
 * Cross-platform: every test runs on Windows too — `git worktree add`
 * / `git worktree remove` / `git branch -D` are git surface, identical
 * everywhere. No `process.platform === "win32"` skips here would be
 * justified (CLAUDE.md rule).
 */

import { beforeAll, describe, expect, mock, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const tempHome = await fs.mkdtemp(
  path.join(os.tmpdir(), "wa-boot-sweep-"),
)

mock.module("node:os", () => ({
  default: { ...os, homedir: () => tempHome },
  ...os,
  homedir: () => tempHome,
}))

const {
  __clearLedgerForTests,
  __resetInstanceUuidForTests,
  getInstanceUuid,
  recordWorkerRepo,
  sweepStaleWorktreesAtBoot,
} = await import("../src/lib/worker-agent/lifecycle")

const { PATHS } = await import("../src/lib/paths")

beforeAll(async () => {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
})

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function git(cwd: string, args: Array<string>): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "boot-sweep-test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "boot-sweep-test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).toString()
}

function makeRepo(): { root: string; cleanup: () => void } {
  // realpathSync to neutralize macOS tmpdir symlinks — git resolves
  // symlinks internally and the sweep compares against real paths.
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wa-bs-repo-")))
  git(root, ["init", "-q", "-b", "main"])
  writeFileSync(path.join(root, "README.md"), "hello\n")
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "initial"])
  return {
    root,
    cleanup: (): void => {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
  }
}

function listGitWorktreePaths(repoRoot: string): Array<string> {
  // `git worktree list --porcelain` emits one `worktree <path>` line
  // per registered worktree (incl. the main one). We only need paths
  // to assert presence/absence of specific worktrees.
  const out = git(repoRoot, ["worktree", "list", "--porcelain"])
  const paths: Array<string> = []
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length))
  }
  return paths
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    const out = git(repoRoot, ["branch", "--list", branch])
    return out.trim().length > 0
  } catch {
    return false
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * Past every supported platform's `pid_max` ceiling, well clear of
 * sentinel ranges. Reusing the same value the unit test already
 * picked so a single grep finds both call sites.
 */
const DEAD_PID = 2_147_000_000

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("sweepStaleWorktreesAtBoot — E2E with real git worktrees", () => {
  test(
    "removes a stale worktree (dead PID + old UUID) and preserves a live one (current PID + current UUID)",
    async () => {
      __resetInstanceUuidForTests()
      const currentUuid = getInstanceUuid()
      const oldUuid = randomUUID()
      const livePid = process.pid

      const repo = makeRepo()
      try {
        const parent = path.join(repo.root, ".git", "worker-worktrees")
        await fs.mkdir(parent, { recursive: true })

        // STALE: dead PID + a UUID that isn't the current instance's.
        // Registered with git via real `worktree add` so that the
        // sweep's `git worktree remove --force` actually has work to
        // do (vs. the unit test's fake-dir setup).
        const staleSlug = `${DEAD_PID}-${oldUuid}-aaaaaaaa`
        const staleDir = path.join(parent, staleSlug)
        const staleBranch = `worker/${staleSlug}`
        git(repo.root, ["worktree", "add", "-b", staleBranch, staleDir, "HEAD"])

        // LIVE: current PID + current UUID — sweep must leave it alone.
        const liveSlug = `${livePid}-${currentUuid}-bbbbbbbb`
        const liveDir = path.join(parent, liveSlug)
        const liveBranch = `worker/${liveSlug}`
        git(repo.root, ["worktree", "add", "-b", liveBranch, liveDir, "HEAD"])

        // Pre-conditions: both registered with git, both branches present.
        const before = listGitWorktreePaths(repo.root)
        expect(before).toContain(staleDir)
        expect(before).toContain(liveDir)
        expect(branchExists(repo.root, staleBranch)).toBe(true)
        expect(branchExists(repo.root, liveBranch)).toBe(true)

        // Wire the ledger so the sweep knows where to look.
        await __clearLedgerForTests()
        await recordWorkerRepo(repo.root)

        await sweepStaleWorktreesAtBoot()

        // STALE: gone from filesystem AND git AND branch list.
        expect(await dirExists(staleDir)).toBe(false)
        expect(branchExists(repo.root, staleBranch)).toBe(false)
        const after = listGitWorktreePaths(repo.root)
        expect(after).not.toContain(staleDir)

        // LIVE: still on disk, still in git, branch still present.
        expect(await dirExists(liveDir)).toBe(true)
        expect(branchExists(repo.root, liveBranch)).toBe(true)
        expect(after).toContain(liveDir)

        // Tidy up the live worktree before rmSync runs over the repo
        // root in cleanup — leaves git's metadata in a consistent
        // state so the test process doesn't print confusing stderr.
        git(repo.root, ["worktree", "remove", "--force", liveDir])
        git(repo.root, ["branch", "-D", liveBranch])
      } finally {
        repo.cleanup()
      }
    },
    30_000,
  )

  test("ledger missing entirely → sweep no-ops cleanly", async () => {
    await __clearLedgerForTests()
    // Hard-confirm the ledger file is genuinely absent before we
    // assert no-throw — otherwise a stale file from a prior test
    // could silently re-route the assertion through the populated
    // code path.
    expect(
      await dirExists(path.join(PATHS.APP_DIR, "worker-repos.json")),
    ).toBe(false)
    await expect(sweepStaleWorktreesAtBoot()).resolves.toBeUndefined()
  })

  test(
    "ledger entry pointing at a deleted repo → sweep skips gracefully (no throw)",
    async () => {
      await __clearLedgerForTests()
      // Record a repo, then nuke it from disk so the sweep hits ENOENT
      // when it tries to `readdir(<repoRoot>/.git/worker-worktrees)`.
      const repo = makeRepo()
      await recordWorkerRepo(repo.root)
      repo.cleanup()
      expect(await dirExists(repo.root)).toBe(false)

      // The sweep walks the (now-missing) parent dir, catches the
      // readdir failure, and `continue`s to the next ledger entry.
      // Must resolve cleanly.
      await expect(sweepStaleWorktreesAtBoot()).resolves.toBeUndefined()
    },
    30_000,
  )

  test(
    "git removal failure on one entry does not stop the loop (fs.rm fallback + continuation)",
    async () => {
      __resetInstanceUuidForTests()
      // Pin a fresh instance UUID so the stale slugs we build below
      // are guaranteed to NOT match it.
      void getInstanceUuid()
      const oldUuid = randomUUID()

      const repo = makeRepo()
      try {
        const parent = path.join(repo.root, ".git", "worker-worktrees")
        await fs.mkdir(parent, { recursive: true })

        // STALE-A: a dir matching the strict regex but NOT registered
        // with git. `git worktree remove --force` will error (git
        // doesn't know about this path); the sweep's fs.rm fallback
        // must clean it up AND the loop must continue to STALE-B.
        const bogusSlug = `${DEAD_PID}-${oldUuid}-cccccccc`
        const bogusDir = path.join(parent, bogusSlug)
        await fs.mkdir(bogusDir, { recursive: true })
        await fs.writeFile(
          path.join(bogusDir, "marker.txt"),
          "bogus-not-registered-with-git",
        )

        // STALE-B: a REAL stale worktree that git CAN clean. If the
        // loop terminated on the failure at STALE-A, STALE-B would
        // survive — so a successful removal here is what proves
        // continuation.
        const realSlug = `${DEAD_PID}-${oldUuid}-dddddddd`
        const realDir = path.join(parent, realSlug)
        const realBranch = `worker/${realSlug}`
        git(repo.root, ["worktree", "add", "-b", realBranch, realDir, "HEAD"])

        await __clearLedgerForTests()
        await recordWorkerRepo(repo.root)

        await sweepStaleWorktreesAtBoot()

        // Both gone — STALE-A via the fs.rm fallback, STALE-B via the
        // real git removal that happened after the loop continued.
        expect(await dirExists(bogusDir)).toBe(false)
        expect(await dirExists(realDir)).toBe(false)
        expect(branchExists(repo.root, realBranch)).toBe(false)
        expect(listGitWorktreePaths(repo.root)).not.toContain(realDir)
      } finally {
        repo.cleanup()
      }
    },
    30_000,
  )
})
