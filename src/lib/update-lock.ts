/**
 * Cross-process install lock for the auto-update / self-update / managed-install
 * paths.
 *
 * Multiple concurrent `github-router` launches must not install at the same
 * time. For the `-g` path that matters because Windows' global `node_modules`
 * and `.cmd` shim rewrite is fragile and concurrent writers corrupt it; for the
 * managed path it matters because two installers would race to publish the same
 * version and both write the pointer.
 *
 * An `O_EXCL` lockfile guarantees exactly one holder; everyone else either
 * skips or waits, and the caller is told which.
 *
 * ### Why this file changed
 *
 * The original version had three defects the managed installer would have
 * inherited:
 *
 * 1. **`STALE_LOCK_MS = 10 min` with the comment "10 min > the 120 s install
 *    timeout".** The premise was already wrong (CloudCLI's install allows 10
 *    minutes, `serve/cloudcli.ts:150`) and a cold 586 MB npm install over a
 *    corporate link is slower still. A second launch could therefore *steal* a
 *    live lock and start a competing install. Fixed by heart-beating the mtime
 *    while `fn` runs: staleness now means "the holder stopped touching it",
 *    not "the holder is taking a while".
 * 2. **The lock path was hardcoded** to `~/.local/share/github-router/<name>`,
 *    duplicating `PATHS.APP_DIR` and ignoring the app-dir override tests and the
 *    managed layout need. It now resolves through `appDir()`.
 * 3. **"Held" was indistinguishable from "ran and did nothing"** — both returned
 *    `false`. A caller that skipped silently could not report why, and the
 *    managed installer genuinely needs to say "another install is in progress".
 *    `withInstallLock` still returns a boolean (so every existing caller is
 *    unchanged) and a new `InstallLockResult`-returning entry point carries the
 *    distinction.
 */

import { mkdir, open, readFile, rm, stat, utimes } from "node:fs/promises"
import path from "node:path"

import { appDir } from "./managed-install/paths"

/**
 * A lock whose mtime has not moved for this long belongs to a dead holder.
 *
 * Safe to make generous *because* of the heartbeat: a live holder refreshes the
 * mtime every `HEARTBEAT_INTERVAL_MS`, so this only has to exceed the interval,
 * not the operation's duration.
 */
const STALE_LOCK_MS = 10 * 60 * 1000

/** How often a holder proves it is alive by touching the lock file. */
const HEARTBEAT_INTERVAL_MS = 30 * 1000

function lockPath(name: string): string {
  return path.join(appDir(), name)
}

export interface InstallLockOptions {
  /** Millisecond staleness window. Tests shorten it; production uses the default. */
  staleMs?: number
  /** Heartbeat period. `0` disables it (tests). */
  heartbeatMs?: number
}

/**
 * How a `withInstallLockResult` attempt ended.
 *
 * - `ran` — this process held the lock and `fn` completed.
 * - `skipped` — another live process holds it; `fn` did not run.
 * - `failed` — the lock was acquired but `fn` threw. The lock is released, and
 *   the error is available to the caller to report.
 */
export type InstallLockOutcome = "ran" | "skipped" | "failed"

export interface InstallLockResult {
  outcome: InstallLockOutcome
  /** Present when `outcome === "failed"`. */
  error?: unknown
}

/**
 * Run `fn` while holding an exclusive lockfile named `name` under the app dir.
 *
 * Returns `true` if the lock was acquired and `fn` ran, `false` if another
 * process already holds it (the caller skips). A lock left by a crashed process
 * is stolen once its mtime is older than the staleness window, so an updater can
 * never be wedged permanently.
 *
 * Kept as the primary entry point so the existing callers (`pi-version-check`,
 * `colbert`, `toolbelt`, `self-update`) need no change. New code that has
 * something to say about *why* it did not run should use
 * `withInstallLockResult`.
 */
export async function withInstallLock(
  name: string,
  fn: () => Promise<void>,
  opts: InstallLockOptions = {},
): Promise<boolean> {
  const result = await withInstallLockResult(name, fn, opts)
  return result.outcome === "ran"
}

/**
 * `withInstallLock`, but reporting whether `fn` ran, was skipped, or failed.
 *
 * The lock file is created with `flag: "wx"` (O_CREAT | O_EXCL) so exactly one
 * of any number of concurrent attempts wins. Its handle is closed immediately
 * and ownership is expressed by the file's existence plus its mtime: that is
 * what makes the heartbeat meaningful (a holder proves liveness by touching the
 * file it owns) and what makes a crashed holder recoverable.
 */
export async function withInstallLockResult(
  name: string,
  fn: () => Promise<void>,
  opts: InstallLockOptions = {},
): Promise<InstallLockResult> {
  const p = lockPath(name)
  const staleMs = opts.staleMs ?? STALE_LOCK_MS
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS

  let acquired = await tryCreateLock(p)
  if (!acquired.handle) {
    // A create failure that is not EEXIST is NOT "somebody else has it": a
    // read-only or otherwise unusable app dir, EACCES, ENOSPC, a path that is a
    // directory. Reporting those as `skipped` makes `update` say "another
    // github-router process is installing; retry shortly" forever, about a
    // process that does not exist — the mystery-bug class this file exists to
    // remove. Say what actually failed instead.
    if (acquired.code !== "EEXIST") {
      return { outcome: "failed", error: lockCreateError(p, acquired) }
    }
    if (!(await isStale(p, staleMs))) return { outcome: "skipped" }
    await rm(p, { force: true }).catch(() => {})
    acquired = await tryCreateLock(p)
    if (!acquired.handle) {
      return acquired.code === "EEXIST"
        ? { outcome: "skipped" }
        : { outcome: "failed", error: lockCreateError(p, acquired) }
    }
  }

  // Ownership token. Written into the file so this holder can tell its OWN lock
  // from one a thief installed after stealing a "stale" one (a laptop that
  // suspends mid-install ages the mtime past the window, and another launch
  // legitimately steals it). Without the token the original holder's `finally`
  // deletes the new holder's lock and its heartbeat keeps the new holder's file
  // alive — three installers instead of one.
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  const ownsLock = async (): Promise<boolean> => {
    try {
      return (await readFile(p, "utf8")).trim() === token
    } catch {
      return false
    }
  }
  try {
    await acquired.handle.writeFile(token, "utf8")
  } catch {
    // A lock we cannot stamp cannot be safely released; not fatal, just no
    // ownership check (the old behaviour).
  }

  let heartbeat: ReturnType<typeof setInterval> | undefined
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      void (async () => {
        // Proof of life, but only for a lock this process still owns.
        if (!(await ownsLock())) {
          if (heartbeat) clearInterval(heartbeat)
          return
        }
        const now = new Date()
        // Best effort. A failed touch means the filesystem is unhappy, not that
        // this process stopped: the staleness window is 20× the interval, so a
        // few lost beats are harmless.
        await utimes(p, now, now).catch(() => {})
      })()
    }, heartbeatMs)
    heartbeat.unref?.()
  }

  try {
    await acquired.handle.close().catch(() => {})
    await fn()
    return { outcome: "ran" }
  } catch (error) {
    return { outcome: "failed", error }
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    // Release only OUR lock. If it was stolen and re-created, `rm` here would
    // delete the thief's file and let a fourth process start.
    if (await ownsLock()) await rm(p, { force: true }).catch(() => {})
  }
}

async function isStale(p: string, staleMs: number): Promise<boolean> {
  try {
    const s = await stat(p)
    return Date.now() - s.mtimeMs > staleMs
  } catch {
    // Disappeared between create-attempt and stat — try once more.
    return true
  }
}

/**
 * The error handed to the caller when the lock could NOT be created.
 *
 * Carries the original `code` (and `cause`) so the caller can act on the reason
 * — `install.ts` reports `ENOTDIR`/`EACCES` as its own failure — instead of
 * re-deriving it from a message string.
 */
function lockCreateError(p: string, attempt: LockCreateAttempt): Error {
  const err = new Error(
    `could not create the install lock ${p}: ${attempt.detail ?? attempt.code ?? "unknown error"}`,
    attempt.cause ? { cause: attempt.cause } : undefined,
  )
  if (attempt.code) (err as NodeJS.ErrnoException).code = attempt.code
  return err
}

interface LockCreateAttempt {
  handle: Awaited<ReturnType<typeof open>> | null
  /** Node error code, when the attempt failed. `EEXIST` means a live holder. */
  code?: string
  detail?: string
  cause?: unknown
}

async function tryCreateLock(p: string): Promise<LockCreateAttempt> {
  try {
    // The app dir is not guaranteed to exist: the managed installer creates
    // `<APP_DIR>/m/<kind>` for its own state, but the `-g`/toolbelt/colbert
    // lock holders may run first on a fresh machine (or under a
    // `GH_ROUTER_APP_DIR` that has never been created). Without this, `open`
    // fails `ENOENT`, `isStale` then reads as "disappeared => stale", and the
    // installer reports `skipped` forever — an unexplainable "another install is
    // in progress" with no other process on the machine.
    // Failure here is NOT reported on its own: `open` below fails for the same
    // reason and with a more specific code (ENOTDIR rather than a bare `mkdir`
    // EEXIST when the app dir is, say, a path under a regular file). Whatever
    // `open` says is what the caller gets to act on.
    await mkdir(path.dirname(p), { recursive: true }).catch(() => {})
    // "wx" = O_CREAT | O_EXCL — fails if the file already exists.
    return { handle: await open(p, "wx") }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return {
      handle: null,
      ...(code ? { code } : {}),
      detail: err instanceof Error ? err.message : String(err),
      cause: err,
    }
  }
}
