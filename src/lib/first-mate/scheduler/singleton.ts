import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/paths"

/**
 * Daemon process singleton (review minor). The fencing lease already guarantees
 * a single DRIVER, but two daemon PROCESSES can still run (one drives, one backs
 * off) — wasteful and confusing. This is a pidfile guard so a second daemon on
 * the same first-mate dir either refuses to start or (opt-in) terminates the
 * incumbent first.
 *
 * A pidfile is advisory, not a lock: it is only consulted at startup, and a
 * crashed daemon leaves a STALE pidfile whose pid is no longer alive — that is
 * detected via a signal-0 liveness probe and overwritten. The clocks/fs are
 * injectable so this is unit-testable without spawning processes.
 */

function daemonPidPath(dir: string): string {
  return path.join(dir, "scheduler.daemon.pid")
}

/** True iff a process with `pid` currently exists (signal 0 probe). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

export interface SingletonOptions {
  dir?: string
  selfPid?: number
  isAlive?: (pid: number) => boolean
  /**
   * Conflict policy when a LIVE daemon already holds the pidfile:
   *   "refuse" (default) — do not start a second daemon.
   *   "terminate" — SIGTERM the incumbent, then take over.
   */
  onConflict?: "refuse" | "terminate"
  terminate?: (pid: number) => void
}

export interface SingletonResult {
  /** Whether THIS process may run as the daemon. */
  acquired: boolean
  /** The live incumbent's pid when acquisition was refused. */
  existingPid?: number
  /** Release the pidfile (only if still ours). Safe to call once. */
  release: () => void
}

/**
 * Attempt to become the singleton daemon. Writes our pid to the pidfile when we
 * win; returns `{acquired:false, existingPid}` when a live daemon already holds
 * it and the policy is "refuse". A stale pidfile (dead pid) is always taken over.
 */
export function acquireDaemonSingleton(opts: SingletonOptions = {}): SingletonResult {
  const dir = opts.dir ?? PATHS.FIRST_MATE_DIR
  const selfPid = opts.selfPid ?? process.pid
  const isAlive = opts.isAlive ?? isProcessAlive
  const onConflict = opts.onConflict ?? "refuse"
  const pidPath = daemonPidPath(dir)

  const readPid = (): number | undefined => {
    if (!existsSync(pidPath)) return undefined
    const raw = Number(readFileSync(pidPath, "utf8").trim())
    return Number.isInteger(raw) && raw > 0 ? raw : undefined
  }

  const existing = readPid()
  if (existing !== undefined && existing !== selfPid && isAlive(existing)) {
    if (onConflict === "refuse") {
      return { acquired: false, existingPid: existing, release: () => {} }
    }
    // "terminate": ask the incumbent to stop, then take over the pidfile.
    ;(opts.terminate ?? ((pid) => process.kill(pid, "SIGTERM")))(existing)
  }

  writeFileSync(pidPath, `${selfPid}`, { mode: 0o600 })
  return {
    acquired: true,
    release: () => {
      // Only remove the pidfile if it is still ours (never delete a successor's).
      if (readPid() === selfPid) {
        try {
          unlinkSync(pidPath)
        } catch {
          // already gone
        }
      }
    },
  }
}
