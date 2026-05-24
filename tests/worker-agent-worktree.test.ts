/**
 * Tests for `src/lib/worker-agent/worktree.ts`.
 *
 * Verifies the load-bearing peer-review fixes:
 *   - Working-tree-based replay (NOT HEAD-based) — pre-modified
 *     tracked files in the user's checkout appear in the worktree.
 *   - Untracked-not-ignored files included via cross-platform Bun
 *     loop (mandatory: Windows CI has no `xargs cp --parents`).
 *   - `finalize()` runs `git add -N .` so freshly created files
 *     appear in the diff.
 *   - 256 KiB cap with summary fallback (never half-hunk).
 *   - `remove()` idempotent.
 *   - No-git workspace → hard throw.
 *   - 20-entry quota.
 *
 * Plan: `plans/we-have-added-a-dreamy-tide.md` ("Worktree mode").
 *
 * Cross-platform: every test runs on Windows too. Adding new
 * `process.platform === "win32"` guards here would be a CLAUDE.md
 * violation — these are the canonical worktree probes for the
 * primary deployment target.
 */

import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  WorktreeRegistry,
  __resetInstanceUuidForTests,
} from "../src/lib/worker-agent/lifecycle"
import {
  WORKTREE_DIR_NAME_RE,
  createWorktree,
} from "../src/lib/worker-agent/worktree"

// ---------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------

interface RepoFixture {
  root: string
  cleanup: () => void
}

function git(cwd: string, args: Array<string>): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      // Deterministic identity for `git commit` so tests don't fail on
      // bare CI runners with no user.name configured.
      GIT_AUTHOR_NAME: "worker-agent-test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "worker-agent-test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  }).toString()
}

function makeRepo(setup: (root: string) => void): RepoFixture {
  // realpathSync because macOS mkdtempSync returns a symlinked path.
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wa-wt-")))
  git(root, ["init", "-q", "-b", "main"])
  setup(root)
  // Initial commit so HEAD exists.
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

function makeRegistry(): {
  registry: WorktreeRegistry
  instanceUuid: string
} {
  __resetInstanceUuidForTests()
  return { registry: new WorktreeRegistry(), instanceUuid: randomUUID() }
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("createWorktree happy path", () => {
  test("creates worktree dir and branch off HEAD", async () => {
    const repo = makeRepo((root) => {
      writeFileSync(path.join(root, "README.md"), "hello\n")
    })
    const { registry, instanceUuid } = makeRegistry()
    try {
      const handle = await createWorktree(repo.root, {
        instanceUuid,
        registry,
      })
      // Worktree dir exists and is named according to the strict regex.
      const stat = await fs.stat(handle.dir)
      expect(stat.isDirectory()).toBe(true)
      const slug = path.basename(handle.dir)
      expect(WORKTREE_DIR_NAME_RE.test(slug)).toBe(true)
      expect(handle.branch).toBe(`worker/${slug}`)

      // Branch exists in the repo.
      const branches = git(repo.root, ["branch", "--list", handle.branch])
      expect(branches).toContain(handle.branch)

      // Registry tracks it.
      expect(registry.size).toBe(1)

      await handle.remove()
      expect(registry.size).toBe(0)
    } finally {
      repo.cleanup()
    }
  })
})

describe("createWorktree replay semantics", () => {
  test("untracked files created in the worktree appear in finalize()", async () => {
    const repo = makeRepo((root) => {
      writeFileSync(path.join(root, "README.md"), "hello\n")
    })
    const { registry, instanceUuid } = makeRegistry()
    try {
      const handle = await createWorktree(repo.root, {
        instanceUuid,
        registry,
      })
      // Drop a new file directly in the worktree to simulate a write.
      writeFileSync(
        path.join(handle.dir, "new-file.txt"),
        "created-by-worker\n",
      )
      const diff = await handle.finalize()
      expect(diff).toContain("new-file.txt")
      expect(diff).toContain("created-by-worker")
      await handle.remove()
    } finally {
      repo.cleanup()
    }
  })

  test("pre-modified tracked files in repoRoot are replayed into the worktree", async () => {
    const repo = makeRepo((root) => {
      writeFileSync(path.join(root, "tracked.txt"), "original\n")
    })
    const { registry, instanceUuid } = makeRegistry()
    try {
      // Dirty the working tree BEFORE creating the worktree.
      writeFileSync(
        path.join(repo.root, "tracked.txt"),
        "human-edit\n",
      )
      const handle = await createWorktree(repo.root, {
        instanceUuid,
        registry,
      })
      // The worktree must reflect the human edit, not the HEAD content.
      const worktreeContent = await fs.readFile(
        path.join(handle.dir, "tracked.txt"),
        "utf8",
      )
      expect(worktreeContent).toBe("human-edit\n")
      await handle.remove()
    } finally {
      repo.cleanup()
    }
  })

  test("untracked-not-ignored files in repoRoot are copied into the worktree", async () => {
    const repo = makeRepo((root) => {
      writeFileSync(path.join(root, "README.md"), "hello\n")
      writeFileSync(
        path.join(root, ".gitignore"),
        "ignored.txt\nignored-dir/\n",
      )
    })
    const { registry, instanceUuid } = makeRegistry()
    try {
      // Untracked but NOT ignored — must be copied.
      writeFileSync(
        path.join(repo.root, "untracked.txt"),
        "untracked-content\n",
      )
      // Untracked AND ignored — must NOT be copied.
      writeFileSync(
        path.join(repo.root, "ignored.txt"),
        "ignored-content\n",
      )
      // Nested untracked-not-ignored to exercise the mkdir loop.
      mkdirSync(path.join(repo.root, "nested"), { recursive: true })
      writeFileSync(
        path.join(repo.root, "nested", "deep.txt"),
        "nested-content\n",
      )

      const handle = await createWorktree(repo.root, {
        instanceUuid,
        registry,
      })

      const copied = await fs.readFile(
        path.join(handle.dir, "untracked.txt"),
        "utf8",
      )
      expect(copied).toBe("untracked-content\n")

      const nested = await fs.readFile(
        path.join(handle.dir, "nested", "deep.txt"),
        "utf8",
      )
      expect(nested).toBe("nested-content\n")

      // ignored.txt must NOT have been copied.
      let ignoredExists = true
      try {
        await fs.stat(path.join(handle.dir, "ignored.txt"))
      } catch {
        ignoredExists = false
      }
      expect(ignoredExists).toBe(false)

      await handle.remove()
    } finally {
      repo.cleanup()
    }
  })
})

describe("createWorktree finalize truncation", () => {
  test("returns summary (never half-hunk) when diff exceeds 256 KiB", async () => {
    const repo = makeRepo((root) => {
      writeFileSync(path.join(root, "README.md"), "hello\n")
    })
    const { registry, instanceUuid } = makeRegistry()
    try {
      const handle = await createWorktree(repo.root, {
        instanceUuid,
        registry,
      })
      // Synthesize a giant new file inside the worktree (> 256 KiB
      // so the diff blows past the cap).
      const giant = "x".repeat(400 * 1024)
      writeFileSync(path.join(handle.dir, "big.txt"), giant)
      const diff = await handle.finalize()
      expect(diff.startsWith("[diff truncated at 256KB")).toBe(true)
      // Must include a `--stat`-style summary line for big.txt rather
      // than a half-hunk of `+xxxxx…`. The summary should contain
      // the filename + a "files changed" trailer.
      expect(diff).toContain("big.txt")
      expect(diff).toContain("file")
      expect(diff).toContain("changed")
      // Defensive: the giant body itself must NOT be inlined.
      expect(diff.includes(giant.slice(0, 1000))).toBe(false)
      await handle.remove()
    } finally {
      repo.cleanup()
    }
  })
})

describe("createWorktree remove() idempotent", () => {
  test("calling remove() twice does not throw", async () => {
    const repo = makeRepo((root) => {
      writeFileSync(path.join(root, "README.md"), "hello\n")
    })
    const { registry, instanceUuid } = makeRegistry()
    try {
      const handle = await createWorktree(repo.root, {
        instanceUuid,
        registry,
      })
      await handle.remove()
      // Second call is a true no-op.
      await handle.remove()
      expect(registry.size).toBe(0)
    } finally {
      repo.cleanup()
    }
  })
})

describe("createWorktree no-git hard error", () => {
  test("throws when workspace is not a git repository", async () => {
    const dir = realpathSync.native(
      mkdtempSync(path.join(os.tmpdir(), "wa-wt-no-git-")),
    )
    const { registry, instanceUuid } = makeRegistry()
    try {
      await expect(
        createWorktree(dir, { instanceUuid, registry }),
      ).rejects.toThrow(/not a repository|git/i)
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
  })
})

describe("createWorktree quota", () => {
  test("refuses creation when >= 20 entries are already present", async () => {
    const repo = makeRepo((root) => {
      writeFileSync(path.join(root, "README.md"), "hello\n")
    })
    const { registry, instanceUuid } = makeRegistry()
    try {
      const parent = path.join(repo.root, ".git", "worker-worktrees")
      await fs.mkdir(parent, { recursive: true })

      // Pre-create 20 dummy dirs matching the strict regex so they
      // count against the quota. Each gets a unique UUID + suffix.
      for (let i = 0; i < 20; i++) {
        const slug = `99999${i}-${randomUUID()}-${i.toString(16).padStart(8, "0")}`
        await fs.mkdir(path.join(parent, slug))
      }

      await expect(
        createWorktree(repo.root, { instanceUuid, registry }),
      ).rejects.toThrow(/quota/i)
    } finally {
      repo.cleanup()
    }
  })
})
