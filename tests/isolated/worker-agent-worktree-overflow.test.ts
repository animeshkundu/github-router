/**
 * Regression test for Fix 3 of the worktree diff-loss work:
 * `finalize()` in `src/lib/worker-agent/worktree.ts`.
 *
 * When a worktree diff exceeds the inline `DIFF_CAP_BYTES` (256 KiB) cap,
 * the inline return is a `--stat` summary (never a half-hunk). Previously
 * the actual patch was lost the moment the worktree was removed. The fix
 * writes the FULL `git diff --binary --full-index HEAD` patch to a durable,
 * router-owned file under `PATHS.WORKER_DIFFS_DIR` BEFORE removal and returns
 * its absolute path, so the (possibly binary) change stays recoverable.
 *
 * Isolation: this file mocks `os.homedir()` to a per-file temp dir BEFORE
 * importing anything that reads `PATHS` (same pattern as
 * `tests/worker-agent-boot-sweep.test.ts`), so the durable patch lands under
 * a temp `PATHS.WORKER_DIFFS_DIR` and never pollutes the real app dir. The
 * git repos live under the OS temp dir (unaffected by the homedir mock).
 *
 * Cross-platform: no `process.platform === "win32"` skips (CLAUDE.md
 * Windows-first CI gate). `core.autocrlf=false` keeps the text diff byte
 * size deterministic on Windows runners.
 */

import { describe, expect, mock, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "wa-wt-overflow-home-"))

mock.module("node:os", () => ({
  default: { ...os, homedir: () => tempHome },
  ...os,
  homedir: () => tempHome,
}))

const { createWorktree } = await import("../../src/lib/worker-agent/worktree")
const { WorktreeRegistry, __resetInstanceUuidForTests } = await import(
  "../../src/lib/worker-agent/lifecycle"
)
const { PATHS } = await import("../../src/lib/paths")

// ---------------------------------------------------------------------
// Fixture helpers (mirror tests/worker-agent-worktree.test.ts)
// ---------------------------------------------------------------------

function git(cwd: string, args: Array<string>): void {
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "worker-agent-test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "worker-agent-test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  })
}

function makeRepo(): { root: string; cleanup: () => void } {
  const root = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), "wa-wt-overflow-")),
  )
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "core.autocrlf", "false"])
  git(root, ["config", "core.eol", "lf"])
  writeFileSync(path.join(root, "README.md"), "hello\n")
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "initial"])
  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
  }
}

/** Pull the saved patch path out of the truncation summary text. */
function extractPatchPath(text: string): string {
  const marker = "saved to: "
  const idx = text.lastIndexOf(marker)
  expect(idx).toBeGreaterThanOrEqual(0)
  return text.slice(idx + marker.length).trim()
}

// ---------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------

describe("finalize() over-cap: durable full --binary patch", () => {
  test("writes the full patch to PATHS.WORKER_DIFFS_DIR and returns its path + the stat summary", async () => {
    __resetInstanceUuidForTests()
    const repo = makeRepo()
    const registry = new WorktreeRegistry()
    let savedPath: string | null = null
    try {
      const handle = await createWorktree(repo.root, {
        instanceUuid: randomUUID(),
        registry,
      })

      // A large TEXT file so the INLINE `git diff HEAD` blows past the
      // 256 KiB cap (a binary-only change would show "Binary files differ"
      // and stay under the cap).
      writeFileSync(path.join(handle.dir, "big.txt"), "x\n".repeat(200_000))
      // A binary file (all byte values, incl. NUL) so the saved
      // `--binary` patch carries a real GIT-binary-patch blob.
      const blob = Buffer.alloc(1024)
      for (let i = 0; i < blob.length; i += 1) blob[i] = i % 256
      writeFileSync(path.join(handle.dir, "blob.bin"), blob)

      const summary = await handle.finalize()

      // Inline return is still the truncation summary (never a half-hunk).
      expect(summary.startsWith("[diff truncated at 256KB")).toBe(true)
      expect(summary).toContain("changed")
      expect(summary).toContain("big.txt")
      // ...and it now carries an absolute path to the saved patch.
      savedPath = extractPatchPath(summary)
      expect(path.isAbsolute(savedPath)).toBe(true)

      // The path lives under the router-owned durable dir (NOT the worktree
      // or the user's repo).
      const diffsDir = realpathSync.native(PATHS.WORKER_DIFFS_DIR)
      expect(realpathSync.native(savedPath).startsWith(diffsDir)).toBe(true)
      expect(savedPath.endsWith(".patch")).toBe(true)
      expect(savedPath.startsWith(handle.dir)).toBe(false)
      expect(savedPath.startsWith(repo.root)).toBe(false)

      // The saved file holds the FULL patch that the inline return omitted.
      const patch = readFileSync(savedPath, "utf8")
      // `--binary` captured the binary blob.
      expect(patch).toContain("GIT binary patch")
      // `--full-index` wrote exact 40-char object indexes.
      expect(/index [0-9a-f]{40}\.\.[0-9a-f]{40}/.test(patch)).toBe(true)
      // The full big.txt content that was truncated from the inline return
      // is present in the durable patch.
      expect(patch).toContain("big.txt")
      expect(patch).toContain("+x")

      await handle.remove()
    } finally {
      if (savedPath) rmSync(savedPath, { force: true })
      repo.cleanup()
    }
  }, 30_000)
})
