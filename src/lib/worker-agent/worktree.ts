/**
 * Git worktree provisioning for `worker_implement({worktree: true})`.
 *
 * Plan: see `plans/we-have-added-a-dreamy-tide.md` ("Worktree mode"
 * section). Peer-review fixes baked in here (every one is load-bearing):
 *
 *   - Base on the WORKING tree, not just HEAD: replay the user's
 *     uncommitted edits (`git diff HEAD | git apply --3way`) and
 *     copy untracked-not-ignored files. Otherwise the worker would
 *     diverge from the human's current state and produce a diff that
 *     doesn't apply cleanly.
 *
 *   - Untracked-file copy uses a CROSS-PLATFORM Bun loop, NOT
 *     POSIX-only `xargs cp --parents`. Windows CI is the canonical
 *     gate (CLAUDE.md "Primary deployment target"), and `xargs`/`cp`
 *     are absent on stock Windows runners.
 *
 *   - `finalize()` runs `git add -N .` BEFORE `git diff` so freshly
 *     written untracked files appear in the diff (without intent-to-add,
 *     `diff HEAD` ignores them).
 *
 *   - The full diff is ALWAYS returned via a saved patch file (with a
 *     `git diff --stat` summary + a bounded preview), never inlined at
 *     full size — a large diff inlined into the MCP result would overflow
 *     Claude Code's 25k-token relay cap and be silently truncated. Only a
 *     small diff (<= PREVIEW_CAP) is inlined in full for convenience.
 *
 *   - `remove()` is idempotent: a `finally`-block in the engine plus
 *     the lifecycle signal-handler sweep plus the boot-time safety
 *     net all converge on it; each must be safe to no-op the second
 *     time.
 *
 *   - No git? Hard throw. The caller asked for isolation; silently
 *     falling back to direct edits would violate their request.
 */

import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"

import { PATHS } from "../paths"
import { recordWorkerRepo } from "./lifecycle"
import type { WorktreeRegistry, WorktreeRegistryEntry } from "./lifecycle"
import { sweepAgedWorkerDiffs, utf8HeadPreview } from "./relay-cap"

/**
 * A diff at or below this size is inlined in full. Above it, `finalize()`
 * saves the complete patch to a file and returns a `git diff --stat`
 * summary + a bounded UTF-8-safe preview + the file path, so the full
 * change never rides (and overflows) Claude Code's 25k-token result relay.
 */
const PREVIEW_CAP = 8 * 1024

/** Max entries allowed under `<repoRoot>/.git/worker-worktrees/`. */
const QUOTA_PER_REPO = 20

/** Per-call age sweep: remove worktree dirs older than this. */
const AGE_SWEEP_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Floor on dir mtime for the age sweep: we ONLY age out dirs whose
 * mtime is also at least this old. Short floor prevents an active
 * worker (whose dir was created moments ago but happens to have
 * survived a clock jump) from being swept out from under itself.
 */
const AGE_SWEEP_MTIME_FLOOR_MS = 60 * 60 * 1000

/**
 * Strict regex for worktree dir names. The slug is
 * `<pid>-<uuid>-<8hex>` where `<uuid>` is `randomUUID()`'s output
 * (hyphenated, 36 chars). This regex is shared by the per-call age
 * sweep AND the lifecycle boot-time sweep — keep them in sync.
 *
 * The strictness matters: a user could theoretically drop a stray
 * directory under `.git/worker-worktrees/` (e.g. via `git config
 * --local worker-worktrees.something /path`), and we must never
 * delete one we didn't create.
 */
export const WORKTREE_DIR_NAME_RE =
  /^(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{8})$/

export interface WorktreeHandle {
  /** Absolute path of the worktree directory (the worker's `cwd`). */
  dir: string
  /** Newly created branch name (`worker/<pid>-<uuid>-<8hex>`). */
  branch: string
  /**
   * Produce the unified diff (with intent-to-add for untracked files).
   * A diff <= PREVIEW_CAP is returned inline in full; a larger one is
   * saved to a `.patch` file and this returns a `git diff --stat`
   * summary + a bounded preview + the patch's absolute path.
   */
  finalize: () => Promise<string>
  /**
   * Best-effort idempotent cleanup. `git worktree remove --force` and
   * `git branch -D`; swallows EBUSY/ENOENT. Safe to call from the
   * lifecycle handlers after a successful `engine.ts` cleanup.
   */
  remove: () => Promise<void>
}

interface ExecResult {
  stdout: string
  stderr: string
}

/**
 * Promise-wrapped `execFile`. We use `execFile` (not `exec`) to dodge
 * shell-quoting bugs — the argv is passed to the OS without going
 * through `/bin/sh -c`.
 *
 * `encoding: "buffer"` because git can emit binary content (in `git
 * diff` for binary files); we decode to utf-8 at the call sites that
 * specifically expect text, and pass through bytes everywhere else.
 */
function execFileP(
  file: string,
  args: ReadonlyArray<string>,
  opts: {
    cwd?: string
    timeout?: number
    input?: string | Buffer
    maxBuffer?: number
  } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args as Array<string>,
      {
        cwd: opts.cwd,
        timeout: opts.timeout,
        // 256 MiB. The default 1 MiB cap would trip on any sizeable
        // `git diff HEAD` — we re-cap the diff at the `finalize` layer
        // with a much smaller business-logic-driven 256 KiB.
        maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024,
        encoding: "buffer",
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const stdoutStr =
          stdout instanceof Buffer ? stdout.toString("utf8") : String(stdout)
        const stderrStr =
          stderr instanceof Buffer ? stderr.toString("utf8") : String(stderr)
        if (err) {
          // Attach stderr to the error so the catcher gets the real
          // git diagnostic, not just "Command failed".
          ;(err as Error & { stderr?: string; stdout?: string }).stderr =
            stderrStr
          ;(err as Error & { stderr?: string; stdout?: string }).stdout =
            stdoutStr
          reject(err)
          return
        }
        resolve({ stdout: stdoutStr, stderr: stderrStr })
      },
    )
    if (opts.input !== undefined) {
      // Swallow EPIPE — `git apply --3way` can close stdin early on
      // conflict, which on Linux/macOS raises EPIPE on our subsequent
      // `.end(opts.input)` write. The exec callback above will still
      // surface the underlying git failure via stderr + non-zero exit,
      // so the EPIPE is purely a noisy unhandled-error from the write
      // side. Without this guard, the unhandled `error` event on the
      // socket can crash the process (Node default behaviour) before
      // exec's callback has a chance to reject.
      child.stdin?.on("error", () => {})
      child.stdin?.end(opts.input)
    }
  })
}

/**
 * Locate the repo root and the `.git` common dir for `workspaceAbs`.
 *
 * We use BOTH `--show-toplevel` and `--git-common-dir` so we cope
 * with the case where `workspaceAbs` is itself inside an existing
 * worktree — `.git` in a worktree is a `gitfile` pointing at the
 * shared common dir under the main checkout, and that's where new
 * `git worktree add` calls will place their bookkeeping.
 *
 * If `git` is not installed OR `workspaceAbs` is not a repository,
 * this throws — that is the HARD ERROR the plan calls for. Do not
 * silently fall back to direct edits.
 */
async function findRepoRoot(
  workspaceAbs: string,
): Promise<{ repoRoot: string; gitCommonDir: string }> {
  let result: ExecResult
  try {
    result = await execFileP(
      "git",
      ["-C", workspaceAbs, "rev-parse", "--show-toplevel", "--git-common-dir"],
      { timeout: 5000 },
    )
  } catch (err) {
    const e = err as Error & { stderr?: string; code?: string }
    const detail = e.stderr ? e.stderr.trim() : e.message
    throw new Error(
      `worker-agent worktree: git unavailable or workspace is not a repository: ${detail}. ` +
        `worker_implement/worker_test always run in an isolated git worktree and require a git repo; ` +
        `for in-place edits (or a non-git workspace), use the native \`implementer\` subagent instead.`,
      { cause: err },
    )
  }
  const lines = result.stdout.split(/\r?\n/).filter((s) => s.length > 0)
  if (lines.length < 2) {
    throw new Error(
      `worker-agent worktree: unexpected git rev-parse output: ${JSON.stringify(result.stdout)}`,
    )
  }
  const repoRoot = lines[0]
  let gitCommonDir = lines[1]
  // `--git-common-dir` returns a path relative to the cwd (which we
  // passed via `-C`). Resolve it so callers always get absolute paths.
  if (!path.isAbsolute(gitCommonDir)) {
    gitCommonDir = path.resolve(repoRoot, gitCommonDir)
  }
  return { repoRoot, gitCommonDir }
}

/**
 * Sweep aged worktree dirs under `parent`. We only touch dirs whose
 * NAME matches the strict pattern AND whose mtime is older than both
 * `AGE_SWEEP_MS` (7 days) and `AGE_SWEEP_MTIME_FLOOR_MS` (1 hour) —
 * the floor is belt-and-suspenders against clock jumps.
 *
 * Errors are swallowed: this runs at the head of `createWorktree` and
 * must not block the user's request because some unrelated dir is
 * locked.
 */
async function sweepAgedWorktrees(parent: string): Promise<void> {
  let entries: Array<string>
  try {
    entries = await fs.readdir(parent)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    return
  }
  const now = Date.now()
  for (const name of entries) {
    if (!WORKTREE_DIR_NAME_RE.test(name)) continue
    const full = path.join(parent, name)
    try {
      const stat = await fs.stat(full)
      const ageMs = now - stat.mtimeMs
      if (ageMs < AGE_SWEEP_MTIME_FLOOR_MS) continue
      if (ageMs < AGE_SWEEP_MS) continue
      // Best-effort: prefer `git worktree remove --force` so git's
      // internal bookkeeping (`.git/worktrees/<name>`) is cleaned too.
      // Even if that fails, the directory removal below ensures we
      // don't keep accumulating disk.
      await execFileP(
        "git",
        ["worktree", "remove", "--force", full],
        { timeout: 10_000 },
      ).catch(() => {})
      await fs.rm(full, { recursive: true, force: true }).catch(() => {})
    } catch {
      // ignore
    }
  }
}

/**
 * Create a fresh git worktree rooted at `workspaceAbs`, replaying the
 * user's working-tree state (dirty tracked + untracked-not-ignored)
 * into it.
 *
 * Failures during the replay are rolled back (worktree removed,
 * branch deleted, registry entry dropped) so the caller never sees a
 * partially-initialized handle.
 */
export async function createWorktree(
  workspaceAbs: string,
  opts: { instanceUuid: string; registry?: WorktreeRegistry },
): Promise<WorktreeHandle> {
  const { repoRoot, gitCommonDir } = await findRepoRoot(workspaceAbs)

  const parent = path.join(gitCommonDir, "worker-worktrees")
  await fs.mkdir(parent, { recursive: true })

  // Age sweep BEFORE the quota check so abandoned dirs from a prior
  // process don't artificially block a legitimate new request.
  await sweepAgedWorktrees(parent)

  // Quota: count only dirs we recognize as worker worktrees.
  let existing: Array<string> = []
  try {
    existing = await fs.readdir(parent)
  } catch {
    /* fresh dir */
  }
  const count = existing.filter((n) => WORKTREE_DIR_NAME_RE.test(n)).length
  if (count >= QUOTA_PER_REPO) {
    throw new Error(
      `worker-agent worktree: per-repo quota exceeded (>=${QUOTA_PER_REPO} entries under ` +
        `${parent}); abort, investigate, then prune manually or wait for the age sweep`,
    )
  }

  const suffix = randomBytes(4).toString("hex")
  const slug = `${process.pid}-${opts.instanceUuid}-${suffix}`
  const branch = `worker/${slug}`
  const dir = path.join(parent, slug)

  // Step 1: `git worktree add` — a fresh branch off HEAD in the new dir.
  // Git itself takes `.git/index.lock` during this operation, so
  // concurrent calls queue rather than corrupt — documented as
  // expected latency, not a correctness bug.
  await execFileP(
    "git",
    ["-C", repoRoot, "worktree", "add", "-b", branch, dir, "HEAD"],
    { timeout: 30_000 },
  )

  // Register early — if the replay below fails, the rollback path
  // needs the registry entry to be present so the engine's
  // finally-block cleanup can find it too.
  const entry: WorktreeRegistryEntry = { repoRoot, dir, branch }
  opts.registry?.add(entry)

  // Best-effort ledger write for the boot-time PID+instance sweep.
  // Don't let a ledger write failure block the user's request.
  await recordWorkerRepo(repoRoot).catch(() => {})

  try {
    // Step 2: replay dirty tracked files. `git diff HEAD` produces
    // the patch; `git apply --3way` lets us fall back to 3-way merge
    // if context lines don't match perfectly (shouldn't happen — we
    // just created the worktree from the same HEAD — but cheap insurance).
    const diff = await execFileP(
      "git",
      ["-C", repoRoot, "diff", "HEAD"],
      { maxBuffer: 256 * 1024 * 1024 },
    )
    if (diff.stdout.length > 0) {
      await execFileP(
        "git",
        ["-C", dir, "apply", "--3way"],
        { input: diff.stdout },
      )
    }

    // Step 3: copy untracked-not-ignored files. `-z` for NUL-separated
    // output handles paths with newlines / spaces / other oddities
    // correctly. Cross-platform Bun loop (NOT POSIX-only `xargs cp
    // --parents` — Windows CI gate).
    const ls = await execFileP(
      "git",
      ["-C", repoRoot, "ls-files", "--others", "--exclude-standard", "-z"],
    )
    const files = ls.stdout.split("\0").filter((s) => s.length > 0)
    for (const rel of files) {
      const src = path.join(repoRoot, rel)
      const dst = path.join(dir, rel)
      await fs.mkdir(path.dirname(dst), { recursive: true })
      try {
        await fs.copyFile(src, dst)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        // File raced out from under us between `ls-files` and `copyFile`
        // — skip and continue rather than aborting the whole replay.
        if (code === "ENOENT") continue
        throw err
      }
    }
  } catch (err) {
    // Roll back: best-effort remove the worktree + branch so we don't
    // leave a half-initialized dir under `worker-worktrees/`. The
    // engine's per-call age sweep + boot-time sweep would catch this
    // eventually, but failing fast and clean is much nicer.
    await execFileP("git", ["-C", repoRoot, "worktree", "remove", "--force", dir], {
      timeout: 10_000,
    }).catch(() => {})
    await execFileP("git", ["-C", repoRoot, "branch", "-D", branch]).catch(
      () => {},
    )
    opts.registry?.delete(entry)
    throw err
  }

  let removed = false
  const remove = async (): Promise<void> => {
    if (removed) return
    removed = true
    // `git worktree remove --force` handles both the working tree and
    // the bookkeeping under `.git/worktrees/<name>`. We swallow
    // ENOENT/EBUSY — re-runs of this function (from the engine's
    // finally + lifecycle signal-handler + boot sweep) are expected.
    await execFileP("git", ["-C", repoRoot, "worktree", "remove", "--force", dir], {
      timeout: 10_000,
    }).catch(() => {})
    await execFileP("git", ["-C", repoRoot, "branch", "-D", branch]).catch(
      () => {},
    )
    opts.registry?.delete(entry)
  }

  const finalize = async (): Promise<string> => {
    // Intent-to-add untracked files so they show up in `git diff HEAD`.
    // Without this, a worker that creates a new file would silently
    // omit it from the returned diff.
    await execFileP("git", ["-C", dir, "add", "-N", "."]).catch(() => {
      // Continue — `add -N` failing is rare (write-protected tree?)
      // and we'd rather return a partial diff than no diff at all.
    })
    const diff = await execFileP(
      "git",
      ["-C", dir, "diff", "HEAD"],
      { maxBuffer: 256 * 1024 * 1024 },
    )
    if (Buffer.byteLength(diff.stdout, "utf8") <= PREVIEW_CAP) {
      // Small enough to inline in full — a 3-line change shouldn't
      // require the caller to read a file.
      return diff.stdout
    }
    // Larger diff: NEVER inline it in full (it would overflow the relay's
    // 25k-token cap and be silently truncated). Save the complete patch to
    // a durable file and return a `--stat` summary + a bounded preview +
    // the patch path, so the full (possibly binary) change is recoverable /
    // `git apply`-able rather than destroyed with the worktree.
    let stat = ""
    try {
      const r = await execFileP("git", ["-C", dir, "diff", "--stat", "HEAD"])
      stat = r.stdout
    } catch {
      // proceed with empty stat
    }
    const preview = utf8HeadPreview(diff.stdout, PREVIEW_CAP)
    const previewBlock =
      `\n\n--- diff preview (first ${PREVIEW_CAP >> 10} KiB of ${Buffer.byteLength(diff.stdout, "utf8")} bytes) ---\n` +
      preview
    let savedPath: string | null = null
    let saveError: string | null = null
    try {
      savedPath = await saveOverflowPatch(dir)
    } catch (err) {
      saveError = (err as Error).message
    }
    if (savedPath !== null) {
      return (
        `[large diff — full patch saved to a file]\n${stat}` +
        `${previewBlock}\n\n` +
        `Full patch (git apply-able; includes binary blobs) saved to: ${savedPath}`
      )
    }
    // Durable persistence failed (e.g. the full patch exceeded the exec
    // buffer, or the app dir was unwritable). Don't hide it — the worktree
    // is about to be removed, so signal explicitly that only the summary +
    // preview survive rather than returning something that looks complete.
    return (
      `[large diff — full patch save FAILED: ${saveError ?? "unknown"}; ` +
      `only the summary + preview below survive]\n${stat}${previewBlock}`
    )
  }

  return { dir, branch, finalize, remove }
}

/**
 * Persist the FULL `git diff --binary --full-index HEAD` of `dir` to a
 * durable, router-owned file under `PATHS.WORKER_DIFFS_DIR` and return its
 * absolute path.
 *
 * Called by `finalize()` whenever the inline diff exceeds `PREVIEW_CAP`:
 * the worktree is removed immediately after finalize, so the full patch
 * must be persisted or the actual change is lost forever. The durable dir
 * lives under the app dir — never inside the worktree (deleted) nor the
 * user's repo (don't pollute it).
 *
 * `--binary` keeps binary blobs recoverable (git base85-encodes them into
 * the patch) and `--full-index` writes exact 40-char object indexes, so the
 * saved patch reconstructs the change precisely under `git apply`. Uses the
 * same `execFileP` git mechanism the rest of `finalize()` uses (shell:false).
 *
 * Unique filename `<pid>-<8hex>.patch` — collision-free across concurrent
 * workers and repeated finalize calls.
 */
async function saveOverflowPatch(dir: string): Promise<string> {
  const patch = await execFileP(
    "git",
    ["-C", dir, "diff", "--binary", "--full-index", "HEAD"],
    { maxBuffer: 256 * 1024 * 1024 },
  )
  // Best-effort age sweep so the durable dir (shared with relay-cap's
  // `.txt` spills) doesn't grow unbounded. Throttled — concurrent worktree
  // finalizes don't each re-scan the directory.
  await sweepAgedWorkerDiffs({ throttle: true })
  await fs.mkdir(PATHS.WORKER_DIFFS_DIR, { recursive: true })
  // `flag: "wx"` (exclusive create) matches the repo's secure-write
  // convention and refuses to clobber a pre-existing file/symlink at the
  // path. Retry on the (astronomically rare) name collision with a fresh
  // suffix before surfacing the error to finalize()'s save-error handler.
  let lastErr: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = `${process.pid}-${randomBytes(4).toString("hex")}.patch`
    const patchPath = path.join(PATHS.WORKER_DIFFS_DIR, name)
    try {
      await fs.writeFile(patchPath, patch.stdout, { mode: 0o600, flag: "wx" })
      return patchPath
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      lastErr = err
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("saveOverflowPatch: exhausted unique-name retries")
}
