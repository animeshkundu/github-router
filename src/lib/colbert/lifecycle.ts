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

function isPidAlive(pid: number): boolean {
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
    // Dead build PID → reclassify to failed (atomic temp+rename).
    meta.status = "failed"
    const tmp = `${file}.${process.pid}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify(meta, null, 2))
      await fs.rename(tmp, file)
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  }
}
