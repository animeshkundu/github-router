/**
 * `install-state.json`: the managed installer's memory across launches.
 *
 * Three separate concerns share one small file because they are written at the
 * same moments and a second file would be a second thing to keep consistent:
 *
 * - **backoff** (`lastAttemptAt`, `consecutiveFailures`, `nextAttemptAt`,
 *   `lastError`), so a failing registry is retried on a ladder instead of on
 *   every launch;
 * - **the cached npm cache path**, because `NPM_CONFIG_CACHE` is routinely moved
 *   and probing it costs a subprocess on every CLI invocation.
 *
 * There is deliberately no `registry` field. It used to be written here, was
 * never read (`update --check` takes provenance from the version dir's
 * `.installed.json`, which is per-install rather than per-machine), and never
 * cleared — so it reported one old install's registry forever. A field nobody
 * reads is a lie waiting to be trusted; `InstallState` ignores unknown keys, so
 * dropping it cannot break an existing file.
 *
 * Lives here rather than in `install.ts` because `origin.ts` needs it and must not
 * import the installer: the installer pulls `consola`, and `origin.ts` is on the
 * bootstrap's path. Nothing here logs.
 */

import fs from "node:fs/promises"
import path from "node:path"

import { readFileWithRetry, writeFileAtomic } from "../atomic-file"
import { reportManagedDiagnostic } from "./diagnostics"
import { type ManagedKind, installStatePath, managedRoot } from "./paths"

/** Backoff ladder for a failed install, in hours. The last entry repeats. */
export const BACKOFF_HOURS = [1, 6, 24] as const

/** Version dirs kept besides the pointer's (newest first). */
export const KEEP_VERSIONS = 2

/** Age floor before an old version may be deleted, in ms. */
export const VERSION_FLOOR_MS = 7 * 24 * 60 * 60_000

/** Abandoned `.staging-*`/`.trash-*` dirs older than this are swept. */
export const TRANSIENT_TTL_MS = 60 * 60_000

export interface InstallState {
  lastAttemptAt?: string
  lastSuccessAt?: string
  consecutiveFailures?: number
  nextAttemptAt?: string
  lastError?: string
  /** Cached `npm config get cache`, because `NPM_CONFIG_CACHE` moves routinely. */
  npmCache?: string
  /**
   * Cached answers from the two npm probes, keyed by the RUNTIME that produced
   * them.
   *
   * Keyed, not plain, because both answers are runtime-dependent under a version
   * manager: `npm root -g` is `~/.nvm/versions/node/<v>/lib/node_modules`, so a
   * bare cached string would send an nvm user's next launch to the previous
   * node's global tree. `process.execPath` changes exactly when that matters.
   */
  npmProbe?: {
    runtime: string
    globalRoot?: string
    cacheRoot?: string
  }
  /** Origin classification result of the last launch, for diagnostics. */
  lastOrigin?: string
}

export async function readInstallState(kind: ManagedKind): Promise<InstallState> {
  try {
    const raw = await readFileWithRetry(installStatePath(kind), { retryMissing: false })
    const parsed = JSON.parse(raw) as InstallState
    return typeof parsed === "object" && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Write state. Returns `false` on failure instead of throwing — this file is an
 * optimisation, never a gate — but never silently: a failed write is reported,
 * because the CALLER's next launch is what pays for it. The expensive case is the
 * success patch: if that one fails, the ladder from a previous failure is still
 * on disk, and every launch for the next 1–24 h reports "last attempt failed"
 * on a machine that is perfectly up to date.
 */
export async function writeInstallState(kind: ManagedKind, state: InstallState): Promise<boolean> {
  try {
    await fs.mkdir(managedRoot(kind), { recursive: true })
    await writeFileAtomic(installStatePath(kind), `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o644,
    })
    return true
  } catch (err) {
    reportManagedDiagnostic(
      "warn",
      `managed[${kind}]: could not write ${installStatePath(kind)} (${
        err instanceof Error ? err.message : String(err)
      }). The next launch may re-attempt or back off as if the previous attempt had failed.`,
    )
    return false
  }
}

/**
 * Read-modify-write a patch onto the CURRENT on-disk state.
 *
 * Not `writeInstallState({...staleSnapshot, ...patch})`: the callers that hold a
 * snapshot across an install (which can take minutes) would otherwise clobber
 * fields another process — or a `npmProbes()` probe earlier in this one — wrote
 * in the meantime. The observable version of that bug is subtle and expensive: the
 * cache/global-root memo disappears, and every launch pays a 250 ms npm probe
 * again.
 *
 * KNOWN LIMIT, stated because suppressing it would need a real lock on the file:
 * the read and the write are not atomic together, so two processes patching
 * DIFFERENT keys in the same instant can lose one of them ("last writer wins for
 * the whole file"). Callers hold the install lock for anything that must not be
 * lost, and every other writer writes a self-healing value: a lost `npmProbe` is
 * re-derived on the next launch, a lost `lastOrigin` is cosmetic. Do not add a
 * field whose loss changes a decision without also holding the lock.
 */
export async function patchInstallState(
  kind: ManagedKind,
  patch: Partial<InstallState>,
): Promise<boolean> {
  const current = await readInstallState(kind)
  const next: InstallState = { ...current, ...patch }
  // An explicit `undefined` in the patch means DELETE, the same convention as
  // `buildNpmEnv`'s overrides: `nextAttemptAt: undefined` clears the backoff.
  for (const key of Object.keys(patch) as Array<keyof InstallState>) {
    if (patch[key] === undefined) delete next[key]
  }
  return writeInstallState(kind, next)
}

/**
 * Whether the backoff window has expired.
 *
 * `nextAttemptAt` is written BEFORE an attempt (optimistic), so two launches
 * racing on the same failing registry do not both hammer npm.
 */
export function installAllowedNow(state: InstallState, now = Date.now()): boolean {
  if (!state.nextAttemptAt) return true
  const next = new Date(state.nextAttemptAt).getTime()
  if (Number.isNaN(next)) return true
  return now >= next
}

/**
 * Whether an attempt may start, distinguishing a RESERVATION from a BACKOFF.
 *
 * `nextAttemptAt` is written optimistically before every attempt so two launches
 * cannot both run npm, and it is also the backoff ladder's output. Those two
 * meanings must not be conflated: a reservation (`consecutiveFailures` still 0)
 * is not evidence of failure, so treating it as one makes an explicit
 * `github-router update` issued right after a launch that merely *scheduled* an
 * install print "last attempt failed (unknown error)" and do nothing. The install
 * lock — not this window — is what serialises attempts, so re-attempting a
 * reservation is cheap: the loser exits immediately.
 *
 * A crash mid-install also leaves a bare reservation, and retrying it is the
 * correct repair (the leftover `.staging-*` is swept by GC).
 */
export function mayAttemptNow(state: InstallState, now = Date.now()): boolean {
  if ((state.consecutiveFailures ?? 0) === 0) return true
  return installAllowedNow(state, now)
}

export function nextAttemptAtFor(failures: number, now = Date.now()): string {
  const index = Math.min(Math.max(failures, 1), BACKOFF_HOURS.length) - 1
  const hours = BACKOFF_HOURS[index] ?? 24
  return new Date(now + hours * 60 * 60_000).toISOString()
}

/** Dotted-path helpers for tests that need the file's location. */
export function installStateFile(kind: ManagedKind): string {
  return path.join(managedRoot(kind), "install-state.json")
}
