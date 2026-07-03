import { open, readFile, unlink, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"

import { PATHS } from "~/lib/paths"

/**
 * Daemon process singleton (review minor). The fencing lease already guarantees
 * a single DRIVER, but two daemon PROCESSES can still run (one drives, one backs
 * off) — wasteful and confusing. This is a pidfile guard so a second daemon on
 * the same first-mate dir either refuses to start or (opt-in) terminates the
 * incumbent first.
 *
 * Hardening (#7):
 *  - ATOMIC acquisition via `open(..., "wx")` (O_EXCL). Two racing daemons can no
 *    longer both pass a read-then-write check — exactly one creates the file; the
 *    loser sees EEXIST and consults the incumbent.
 *  - IDENTITY, not PID alone. The pidfile stores `{pid, token, startedMs}` with a
 *    per-acquisition random token. Release and stale-takeover only remove a file
 *    that still carries OUR token, so we never delete a successor's pidfile, and
 *    a PID that was recycled by an unrelated process cannot trick us into
 *    deleting or claiming its record.
 *  - WAIT for exit on "terminate". After SIGTERM we poll the incumbent's liveness
 *    and only claim the pidfile once it has actually exited (bounded by
 *    `terminateWaitMs`); if it does not exit in time we REFUSE rather than run two
 *    daemons concurrently.
 *
 * A pidfile is advisory, not a lock. PID reuse is handled conservatively: a
 * stale record whose pid has been recycled by an unrelated live process is read
 * as "incumbent alive" and we REFUSE (never a double-run) — the token makes
 * release/takeover safe, but cross-process identity of a reused pid cannot be
 * verified portably, so we err toward not starting. The fs/clock are injectable
 * so this is unit-testable without spawning processes.
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

interface PidRecord {
  pid: number
  token: string
  startedMs: number
}

export interface SingletonOptions {
  dir?: string
  selfPid?: number
  isAlive?: (pid: number) => boolean
  /**
   * Conflict policy when a LIVE daemon already holds the pidfile:
   *   "refuse" (default) — do not start a second daemon.
   *   "terminate" — SIGTERM the incumbent, wait for it to exit, then take over.
   */
  onConflict?: "refuse" | "terminate"
  terminate?: (pid: number) => void
  /** Per-acquisition identity token (injectable for tests). */
  token?: string
  nowMs?: () => number
  /** Max ms to wait for a terminated incumbent to exit before giving up. */
  terminateWaitMs?: number
  /** Poll interval while waiting for a terminated incumbent (injectable). */
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface SingletonResult {
  /** Whether THIS process may run as the daemon. */
  acquired: boolean
  /** The live incumbent's pid when acquisition was refused. */
  existingPid?: number
  /** Release the pidfile (only if it still carries our token). Safe to call once. */
  release: () => Promise<void>
}

const DEFAULT_TERMINATE_WAIT_MS = 5_000
const DEFAULT_POLL_MS = 50

function parseRecord(raw: string): PidRecord | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === "object" && parsed !== null) {
      const r = parsed as Record<string, unknown>
      if (
        Number.isInteger(r.pid) &&
        (r.pid as number) > 0 &&
        typeof r.token === "string" &&
        r.token.length > 0
      ) {
        return {
          pid: r.pid as number,
          token: r.token,
          startedMs: typeof r.startedMs === "number" ? r.startedMs : 0,
        }
      }
    }
  } catch {
    // Legacy bare-pid file (pre-#7): honor it as an untokened record so an
    // in-place upgrade still detects the incumbent. Empty token → release/
    // takeover treat it as not-ours (safe: we never delete a live one).
    const bare = Number(trimmed)
    if (Number.isInteger(bare) && bare > 0) return { pid: bare, token: "", startedMs: 0 }
  }
  return undefined
}

/**
 * Attempt to become the singleton daemon. Atomically creates the pidfile when we
 * win; returns `{acquired:false, existingPid}` when a live daemon already holds
 * it (policy "refuse", or "terminate" that did not exit in time). A stale pidfile
 * (dead/absent pid, or one still carrying our own token) is taken over.
 */
export async function acquireDaemonSingleton(
  opts: SingletonOptions = {},
): Promise<SingletonResult> {
  const dir = opts.dir ?? PATHS.FIRST_MATE_DIR
  const selfPid = opts.selfPid ?? process.pid
  const isAlive = opts.isAlive ?? isProcessAlive
  const onConflict = opts.onConflict ?? "refuse"
  const now = opts.nowMs ?? Date.now
  const token = opts.token ?? randomBytes(8).toString("hex")
  const terminateWaitMs = opts.terminateWaitMs ?? DEFAULT_TERMINATE_WAIT_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const pidPath = daemonPidPath(dir)
  const serialized = JSON.stringify({ pid: selfPid, token, startedMs: now() } satisfies PidRecord)

  const readRecord = async (): Promise<PidRecord | undefined> => {
    try {
      return parseRecord(await readFile(pidPath, "utf8"))
    } catch {
      return undefined // absent / unreadable
    }
  }

  // Remove the pidfile ONLY if it still carries `expectToken` — never delete a
  // successor's file (races) or an unrelated recycled record.
  const removeIfToken = async (expectToken: string): Promise<void> => {
    const current = await readRecord()
    if (current !== undefined && current.token === expectToken) {
      await unlink(pidPath).catch(() => {})
    }
  }

  const tryCreate = async (): Promise<boolean> => {
    try {
      const fh = await open(pidPath, "wx", 0o600)
      try {
        await fh.writeFile(serialized)
      } finally {
        await fh.close()
      }
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      return false
    }
  }

  const acquired = (): SingletonResult => ({
    acquired: true,
    release: async () => {
      await removeIfToken(token)
    },
  })
  const refused = (existingPid: number): SingletonResult => ({
    acquired: false,
    existingPid,
    release: async () => {},
  })

  // Bounded loop: each iteration either wins the atomic create or resolves the
  // incumbent (stale → remove + retry; live → refuse/terminate).
  const maxIterations = Math.ceil(terminateWaitMs / Math.max(1, pollMs)) + 4
  for (let i = 0; i < maxIterations; i += 1) {
    if (await tryCreate()) return acquired()

    const existing = await readRecord()
    if (existing === undefined) {
      // Vanished/corrupt between our create attempt and read — retry create.
      await unlink(pidPath).catch(() => {})
      continue
    }
    if (existing.pid === selfPid) {
      // Re-entrant acquisition by the same process: refresh our record and own it.
      await writeFile(pidPath, serialized, { mode: 0o600 })
      return acquired()
    }
    if (isAlive(existing.pid)) {
      if (onConflict === "refuse") return refused(existing.pid)
      // "terminate": ask the incumbent to stop, then WAIT for it to exit before
      // claiming — never run two daemons at once.
      ;(opts.terminate ?? ((pid) => process.kill(pid, "SIGTERM")))(existing.pid)
      let waited = 0
      while (waited < terminateWaitMs && isAlive(existing.pid)) {
        await sleep(pollMs)
        waited += pollMs
      }
      if (isAlive(existing.pid)) return refused(existing.pid) // did not exit — refuse
      await removeIfToken(existing.token)
      continue
    }
    // Dead pid = stale pidfile from a crashed daemon — take it over.
    await removeIfToken(existing.token)
  }

  // Exhausted attempts (a persistent racer). Do not start.
  return refused((await readRecord())?.pid ?? selfPid)
}
