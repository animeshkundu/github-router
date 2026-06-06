/**
 * Cross-process install lock for the auto-update / self-update paths.
 *
 * Multiple concurrent `github-router` launches must not run
 * `npm install -g` (or `claude update`) at the same time — on Windows
 * the global `node_modules` / `.cmd` shim rewrite is fragile and
 * concurrent writers corrupt it. An `O_EXCL` lockfile guarantees
 * exactly one updater runs; others skip.
 */

import { open, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** A lock older than this is treated as stale (crashed holder) and stolen. */
const STALE_LOCK_MS = 10 * 60 * 1000 // 10 min > the 120s install timeout

function lockPath(name: string): string {
  return path.join(os.homedir(), ".local", "share", "github-router", name)
}

/**
 * Run `fn` while holding an exclusive lockfile named `name` under the
 * app dir. Returns `true` if the lock was acquired and `fn` ran,
 * `false` if another process already holds it (caller skips silently).
 *
 * A lock left by a crashed process older than `STALE_LOCK_MS` is
 * stolen so the updater can never be wedged permanently.
 */
export async function withInstallLock(
  name: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  const p = lockPath(name)

  let handle = await tryCreateLock(p)
  if (!handle) {
    // Existing lock — steal it if stale, else skip.
    let stale = false
    try {
      const s = await stat(p)
      stale = Date.now() - s.mtimeMs > STALE_LOCK_MS
    } catch {
      // Disappeared between create-attempt and stat — try once more.
      stale = true
    }
    if (!stale) return false
    await rm(p, { force: true }).catch(() => {})
    handle = await tryCreateLock(p)
    if (!handle) return false
  }

  try {
    await handle.close()
    await fn()
    return true
  } finally {
    await rm(p, { force: true }).catch(() => {})
  }
}

async function tryCreateLock(
  p: string,
): Promise<Awaited<ReturnType<typeof open>> | null> {
  try {
    // "wx" = O_CREAT | O_EXCL — fails if the file already exists.
    return await open(p, "wx")
  } catch {
    return null
  }
}
