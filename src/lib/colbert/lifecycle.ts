/**
 * ColBERT sidecar lifecycle: in-memory PID ledger for the short-lived
 * `colgrep` children this proxy spawns, signal-handler tree-kill on
 * exit, and a boot-time metadata reclassification sweep.
 *
 * Because colgrep is CLI-per-invocation (no daemon), the lifecycle
 * problem is **process tracking + cancellation + boot/exit sweep**, NOT
 * keep-alive. Modeled on `worker-agent/lifecycle.ts` (PID ledger + boot
 * sweep + per-proxy-run instance UUID) and `exec.ts`'s tree-kill.
 *
 * Three cooperating layers (none sufficient alone):
 *   1. Per-call cleanup — the runner's `finally` force-kills the child
 *      it spawned (handled in runner.ts).
 *   2. Session-end signal sweep (this file) — SIGINT/SIGTERM/exit kill
 *      every still-tracked child of THIS run.
 *   3. Boot-time sweep (`sweepStaleColbertMetaAtBoot`) — reclassifies
 *      `.gh-router-meta/*.json` entries whose `buildPid` is dead from
 *      `building` → `failed`. It NEVER issues a kill to a PID from a
 *      prior boot (a reused PID may belong to an unrelated process);
 *      only the in-memory ledger (this run's spawns) is ever killed.
 */

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"

import consola from "consola"

import { killManagedTree } from "../exec"
import { PATHS } from "../paths"

// ---------------------------------------------------------------------
// Per-launch instance UUID (mirrors worker-agent/lifecycle.ts)
// ---------------------------------------------------------------------

let _instanceUuid: string | null = null

/**
 * Stable UUID4 generated once per proxy process. Written into the
 * sidecar metadata `ownerInstanceId` so the boot sweep can tell "this
 * proxy's still-live build" from "a stranded `building` entry from a
 * prior proxy whose PID got recycled" (Docker PID-1 across restarts).
 */
export function getColbertInstanceUuid(): string {
  if (_instanceUuid === null) _instanceUuid = randomUUID()
  return _instanceUuid
}

/** Test-only: reset the cached UUID. */
export function __resetColbertInstanceUuidForTests(): void {
  _instanceUuid = null
}

// ---------------------------------------------------------------------
// In-memory PID ledger of THIS run's live colgrep children
// ---------------------------------------------------------------------

type TrackedChild = ReturnType<typeof spawn>

const _liveChildren = new Set<TrackedChild>()

/**
 * Register a freshly-spawned colgrep child so the exit sweep can reap
 * it. The runner also removes it on natural close via `untrackChild`.
 */
export function trackChild(child: TrackedChild): void {
  _liveChildren.add(child)
  child.once("close", () => _liveChildren.delete(child))
  child.once("error", () => _liveChildren.delete(child))
}

/** Remove a child from the ledger (e.g. after a clean per-call kill). */
export function untrackChild(child: TrackedChild): void {
  _liveChildren.delete(child)
}

/** Count of live tracked children (test/diagnostic). */
export function liveChildCount(): number {
  return _liveChildren.size
}

/**
 * Synchronous best-effort tree-kill of every tracked child. Called from
 * the signal/exit handlers. After killing, the set is cleared so a
 * second call is a no-op.
 */
export function sweepLiveChildren(): void {
  const isWin = process.platform === "win32"
  for (const child of _liveChildren) {
    try {
      killManagedTree(child, isWin)
    } catch {
      // already gone
    }
  }
  _liveChildren.clear()
}

// ---------------------------------------------------------------------
// Signal handlers (mirror worker-agent/lifecycle.ts re-raise pattern)
// ---------------------------------------------------------------------

let _registered = false
let _exitHandler: (() => void) | null = null
let _sigintHandler: (() => void) | null = null
let _sigtermHandler: (() => void) | null = null

/**
 * Wire SIGINT/SIGTERM/exit handlers that tree-kill every tracked
 * colgrep child. Idempotent — subsequent calls are a no-op (we never
 * leak listeners). The signal handlers re-raise after sweeping so Node's
 * default terminate-on-signal behavior is restored (otherwise attaching
 * a listener cancels the default and Ctrl-C would clean but not exit).
 */
export function registerColbertExitHandlers(): void {
  if (_registered) return
  _registered = true
  _exitHandler = () => sweepLiveChildren()
  _sigintHandler = () => {
    sweepLiveChildren()
    if (_sigintHandler) process.off("SIGINT", _sigintHandler)
    process.kill(process.pid, "SIGINT")
  }
  _sigtermHandler = () => {
    sweepLiveChildren()
    if (_sigtermHandler) process.off("SIGTERM", _sigtermHandler)
    process.kill(process.pid, "SIGTERM")
  }
  process.on("SIGINT", _sigintHandler)
  process.on("SIGTERM", _sigtermHandler)
  process.on("exit", _exitHandler)
}

/** Test-only: unregister handlers + reset module state. */
export function __unregisterColbertExitHandlersForTests(): void {
  if (_sigintHandler) {
    process.off("SIGINT", _sigintHandler)
    _sigintHandler = null
  }
  if (_sigtermHandler) {
    process.off("SIGTERM", _sigtermHandler)
    _sigtermHandler = null
  }
  if (_exitHandler) {
    process.off("exit", _exitHandler)
    _exitHandler = null
  }
  _registered = false
  _liveChildren.clear()
}

// ---------------------------------------------------------------------
// Boot-time metadata reclassification sweep
// ---------------------------------------------------------------------

/**
 * True iff `pid` names a live process. `process.kill(pid, 0)` probes
 * existence without signalling; `EPERM` means the process exists but is
 * owned by another user (still alive). Exported so the per-query freshness
 * verdict can mirror the boot sweep's liveness check.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true
    return false
  }
}

/**
 * Boot-time sweep. Walks `.gh-router-meta/*.json`; any entry stuck in
 * `status:"building"` whose `buildPid` is DEAD is a crashed-build
 * escapee → reset to `status:"failed"` so the next search re-kicks a
 * build instead of routing to a never-finishing one.
 *
 * It NEVER kills anything: a live PID matching a stale `buildPid` from a
 * prior boot may be a recycled PID belonging to an unrelated process, so
 * the boot sweep only RECLASSIFIES metadata. The in-memory ledger (this
 * run's spawns) is the only thing the SIGINT/SIGTERM handler ever kills.
 *
 * Best-effort; never throws (wrapped by the caller in `ensurePaths`).
 */
export async function sweepStaleColbertMetaAtBoot(): Promise<void> {
  const metaDir = PATHS.COLBERT_META_DIR
  let names: Array<string>
  try {
    names = await fs.readdir(metaDir)
  } catch {
    return // no meta dir yet — nothing to sweep
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const file = path.join(metaDir, name)
    let meta: Record<string, unknown>
    try {
      meta = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>
    } catch {
      continue // corrupt — leave it; index-store re-derives on next access
    }
    if (meta.status !== "building") continue
    const buildPid = typeof meta.buildPid === "number" ? meta.buildPid : 0
    if (buildPid > 0 && isPidAlive(buildPid)) {
      // A live PID — could be ours (this run re-kicked) or a recycled
      // unrelated PID. Either way: never kill from the boot sweep. Leave
      // the entry; the runner's own ownership check governs.
      continue
    }
    // Dead build PID → reclassify to failed (atomic temp+rename). Stamp the
    // crash class so the per-query self-heal treats it as transient (re-kick)
    // rather than operator-actionable.
    meta.status = "failed"
    meta.failureClass = "crashed"
    const tmp = `${file}.${process.pid}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify(meta, null, 2))
      await fs.rename(tmp, file)
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  }
  await sweepColbertStore()
}

/** An orphan stub younger than this may be a build that just started. */
const ORPHAN_GRACE_MS = 60 * 60 * 1000

/**
 * Reclaim disk in the colgrep store, ordered so it cannot destroy good data.
 *
 * This runs AFTER the identity fix in this same release, which matters: the
 * scanner that decides "unreachable" is the one that was wrong. Under the old
 * comparison a perfectly healthy index looked unreachable, and a sweep written
 * against that scanner would have deleted it. Everything below therefore
 * leans on evidence that does not depend on our path matching at all.
 *
 * Three rules, in increasing order of caution:
 *
 *   1. ORPHAN STUB — no `project.json` AND an empty-or-absent `index/` AND
 *      older than the grace window. All three required. A dir with a
 *      `project.json` is real data and is never touched by this rule; a dir
 *      with shards is never touched even without one. Deleted outright,
 *      because there is provably nothing in it.
 *
 *   2. DEAD META — a sidecar whose `workspace` no longer exists on disk. Pure
 *      bookkeeping, never index data. (48 such entries had accumulated on the
 *      machine where this was diagnosed; nothing ever reaped them.)
 *
 *   3. QUARANTINE, NEVER DIRECT DELETE, for anything holding real bytes. A
 *      dir with a `project.json` is left alone entirely, however unreachable
 *      it looks. Reclaiming those would mean deleting real index data on our
 *      own inference about what colgrep would use — and this incident is the
 *      proof that such inference can be wrong. If it is ever added it must
 *      rename first and delete only after a retention window, so the whole
 *      period stays reversible.
 *
 * Skips any dir with a live lock owner or an in-flight init, and logs a
 * one-line count so the accumulation is observable rather than silent.
 */
export async function sweepColbertStore(): Promise<void> {
  const indicesDir = PATHS.COLBERT_INDICES_DIR
  let names: Array<string>
  try {
    names = await fs.readdir(indicesDir)
  } catch {
    return
  }

  const now = Date.now()
  let orphans = 0
  let deadMeta = 0

  for (const name of names) {
    if (name === ".gh-router-meta") continue
    // Quarantined husks are owned by the corrupt-repair path, which deletes
    // them out of band. Never race it.
    if (name.includes(".corrupt-")) continue
    const dir = path.join(indicesDir, name)
    try {
      const st = await fs.stat(dir)
      if (!st.isDirectory()) continue
      // A live build claims its dir with a `.lock`; another proxy may own it.
      if (await exists(path.join(dir, ".lock"))) continue
      // Real index data — leave it. Reclaiming this needs quarantine-first
      // semantics, not a boot-time `rm`.
      if (await exists(path.join(dir, "project.json"))) continue
      // Anything with shards is real work in progress, even mid-build.
      let indexEntries: Array<string> = []
      try {
        indexEntries = await fs.readdir(path.join(dir, "index"))
      } catch {
        /* absent index/ is the orphan shape */
      }
      if (indexEntries.length > 0) continue
      if (now - st.mtimeMs < ORPHAN_GRACE_MS) continue
      await fs.rm(dir, { recursive: true, force: true })
      orphans++
    } catch {
      // Vanished mid-sweep or unreadable — skip.
    }
  }

  // Dead sidecars: the workspace they describe is gone.
  try {
    const metaDir = PATHS.COLBERT_META_DIR
    for (const f of await fs.readdir(metaDir)) {
      if (!f.endsWith(".json")) continue
      const file = path.join(metaDir, f)
      try {
        const meta = JSON.parse(await fs.readFile(file, "utf8")) as {
          workspace?: string
          status?: string
        }
        const ws = meta.workspace
        if (typeof ws !== "string" || ws.length === 0) continue
        // Never reap a live build's bookkeeping.
        if (meta.status === "building") continue
        // Nor an entry this very sweep just reclassified. The reclassification
        // pass above rewrites `building` + dead-PID to `failed` so the runner
        // can self-heal; deleting it in the same pass would erase that state
        // before anything could act on it. Only reap entries that have been
        // settled for a while.
        const stMeta = await fs.stat(file).catch(() => null)
        if (stMeta && now - stMeta.mtimeMs < ORPHAN_GRACE_MS) continue
        if (await exists(ws)) continue
        await fs.rm(file, { force: true })
        deadMeta++
      } catch {
        // Corrupt/unreadable — leave it; index-store re-derives on next access.
      }
    }
  } catch {
    // No meta dir yet.
  }

  if (orphans > 0 || deadMeta > 0) {
    consola.debug(
      `colbert: store sweep reclaimed ${orphans} orphan index dir(s), ${deadMeta} dead metadata entr(ies)`,
    )
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}
