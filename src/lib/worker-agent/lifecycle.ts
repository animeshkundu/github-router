/**
 * Lifecycle plumbing for worker worktrees: in-memory registry, signal
 * handlers, ledger of repos touched, and the boot-time PID+instance
 * safety net.
 *
 * Plan: see `plans/we-have-added-a-dreamy-tide.md` ("Worktree mode" →
 * "Cleanup paths"). Three layers cooperate, none of them sufficient
 * alone:
 *
 *   1. Per-call cleanup (`engine.ts` finally block invoking
 *      `WorktreeHandle.remove()`) — covers the happy path.
 *
 *   2. Session-end signal sweep (this file, registered via
 *      `registerExitHandlers`) — covers Ctrl+C, service-manager stop,
 *      and (in `github-router claude` mode) the spawned child's exit.
 *      Synchronous `execFileSync` is intentional: exit handlers can't
 *      reliably await async work.
 *
 *   3. Boot-time PID+instance sweep (`sweepStaleWorktreesAtBoot`) —
 *      covers SIGKILL, OOM, container restart. Walks the ledger of
 *      repos this proxy has touched and removes worktree dirs whose
 *      `<pid>` is dead OR whose `<instance>` UUID doesn't match the
 *      current proxy's UUID.
 *
 * Ledger writes are ATOMIC (temp + rename) per peer review — a
 * concurrent-RMW corruption would silently strand worktrees because
 * the boot sweep can't find their repo roots.
 */

import { execFileSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"

import { PATHS, writeRuntimeFileSecure } from "../paths"

/**
 * Same regex worktree.ts uses for its per-call age sweep — kept in
 * sync intentionally. `<pid>-<uuid>-<8hex>` strictly.
 */
const WORKTREE_DIR_NAME_RE =
  /^(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{8})$/

/**
 * Cap on the ledger: how many repos we remember across boots, and how
 * old an entry may be before it's pruned. Both are belt-and-suspenders
 * — the per-call age sweep is the primary guard against accumulation
 * inside any single repo.
 */
const LEDGER_MAX_ENTRIES = 100
const LEDGER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface WorktreeRegistryEntry {
  repoRoot: string
  dir: string
  branch: string
}

/**
 * Set-like in-memory registry of worktrees this proxy created. Engine
 * passes it to `createWorktree` so per-call cleanup deletes the entry
 * on success; the signal handlers walk what's left at shutdown.
 *
 * Not a bare `Set` because we want to expose only the operations we
 * actually use, and we want a stable testable surface.
 */
export class WorktreeRegistry {
  private readonly entries = new Set<WorktreeRegistryEntry>()

  add(entry: WorktreeRegistryEntry): void {
    this.entries.add(entry)
  }
  delete(entry: WorktreeRegistryEntry): void {
    this.entries.delete(entry)
  }
  has(entry: WorktreeRegistryEntry): boolean {
    return this.entries.has(entry)
  }
  values(): IterableIterator<WorktreeRegistryEntry> {
    return this.entries.values()
  }
  get size(): number {
    return this.entries.size
  }
  clear(): void {
    this.entries.clear()
  }
}

// ---------------------------------------------------------------------
// Per-launch instance UUID
// ---------------------------------------------------------------------

let _instanceUuid: string | null = null

/**
 * Stable UUID4 generated once per proxy process. Used in worktree
 * dir/branch names so the boot sweep can reliably distinguish "this
 * proxy's still-live worktrees" from "stranded dirs from a prior
 * proxy that happens to have a recycled PID" — Docker PID-1 across
 * container restarts is the classic case (peer-review HIGH finding).
 */
export function getInstanceUuid(): string {
  if (_instanceUuid === null) {
    _instanceUuid = randomUUID()
  }
  return _instanceUuid
}

/** Test-only: reset the cached UUID. */
export function __resetInstanceUuidForTests(): void {
  _instanceUuid = null
}

// ---------------------------------------------------------------------
// Signal handlers + sweepRegistry
// ---------------------------------------------------------------------

let _registered = false
let _activeRegistry: WorktreeRegistry | null = null
let _exitHandler: (() => void) | null = null
let _sigintHandler: (() => void) | null = null
let _sigtermHandler: (() => void) | null = null

/**
 * Synchronous cleanup of every registry entry. Best-effort:
 * `execFileSync` failures are swallowed (the dir may have been
 * removed already, or git may not be on PATH any more in some
 * environments). After a successful removal we drop the entry from
 * the registry so a second call is a true no-op.
 *
 * Synchronous on purpose — exit handlers can't reliably await async
 * work; the process would die before the promise settled.
 */
export function sweepRegistry(): void {
  if (!_activeRegistry) return
  // Snapshot the values first so we can mutate the underlying set
  // during iteration without skipping entries.
  const snapshot = [..._activeRegistry.values()]
  for (const entry of snapshot) {
    try {
      // `-C entry.repoRoot` is load-bearing: without it git resolves
      // the worktree path relative to the proxy's cwd (which is the
      // user's launch dir, typically NOT inside the target repo), and
      // fails with `fatal: '<path>' is not a working tree`. The E2E
      // boot-sweep test (worker-agent-boot-sweep.test.ts) is what
      // caught the missing flag.
      execFileSync(
        "git",
        ["-C", entry.repoRoot, "worktree", "remove", "--force", entry.dir],
        { stdio: "ignore", timeout: 10_000, windowsHide: true },
      )
    } catch {
      // Already gone, EBUSY, or git not on PATH — best effort.
    }
    try {
      execFileSync("git", ["-C", entry.repoRoot, "branch", "-D", entry.branch], {
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      })
    } catch {
      // Same as above.
    }
    _activeRegistry.delete(entry)
  }
}

/**
 * Wire up SIGINT/SIGTERM/exit handlers that walk the registry and
 * remove every entry. Idempotent: subsequent calls swap the registry
 * pointer but do NOT register additional process listeners (otherwise
 * we'd leak listeners on every `runWorkerAgent`).
 *
 * Signal handlers re-raise the signal after sweeping. Naively running
 * the sweep on SIGINT/SIGTERM and returning would *suppress* the
 * signal: Node defaults to terminating the process on these, but only
 * if no user listener is attached. Once we attach a listener, the
 * default action is cancelled and the process keeps running — which
 * means Ctrl-C would clean worktrees but not actually exit, leaving
 * orphan processes in dev. The `process.kill(pid, sig)` re-raise
 * after removing our own listener restores the default behaviour
 * (the second delivery now hits an empty listener list, so Node
 * terminates with the conventional `128 + signum` exit code).
 */
export function registerExitHandlers(registry: WorktreeRegistry): void {
  _activeRegistry = registry
  if (_registered) return
  _registered = true
  _exitHandler = () => sweepRegistry()
  _sigintHandler = () => {
    sweepRegistry()
    if (_sigintHandler) process.off("SIGINT", _sigintHandler)
    process.kill(process.pid, "SIGINT")
  }
  _sigtermHandler = () => {
    sweepRegistry()
    if (_sigtermHandler) process.off("SIGTERM", _sigtermHandler)
    process.kill(process.pid, "SIGTERM")
  }
  process.on("SIGINT", _sigintHandler)
  process.on("SIGTERM", _sigtermHandler)
  // `exit` handlers can only run synchronous code — exactly what
  // sweepRegistry does. Async work here would never complete.
  process.on("exit", _exitHandler)
}

/**
 * Test-only: unregister the handlers and reset module state. Tests
 * that want to verify `registerExitHandlers` semantics must clean up
 * after themselves or future tests in the same process inherit the
 * (now stale) registry pointer.
 */
export function __unregisterExitHandlersForTests(): void {
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
  _activeRegistry = null
}

// ---------------------------------------------------------------------
// Ledger: which repos has this proxy touched?
// ---------------------------------------------------------------------

interface LedgerEntry {
  repoRoot: string
  lastSeenMs: number
}

interface LedgerFile {
  entries: Array<LedgerEntry>
}

function ledgerPath(): string {
  return path.join(PATHS.APP_DIR, "worker-repos.json")
}

async function readLedger(): Promise<LedgerFile> {
  let raw: string
  try {
    raw = await fs.readFile(ledgerPath(), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [] }
    }
    return { entries: [] }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LedgerFile>
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] }
    const cleaned: Array<LedgerEntry> = []
    for (const e of parsed.entries) {
      if (
        e &&
        typeof e === "object" &&
        typeof (e as LedgerEntry).repoRoot === "string" &&
        typeof (e as LedgerEntry).lastSeenMs === "number"
      ) {
        cleaned.push({
          repoRoot: (e as LedgerEntry).repoRoot,
          lastSeenMs: (e as LedgerEntry).lastSeenMs,
        })
      }
    }
    return { entries: cleaned }
  } catch {
    // Corrupted JSON — start fresh rather than crashing the proxy.
    return { entries: [] }
  }
}

/**
 * Per-process serializer for ledger writes. Multiple concurrent
 * `recordWorkerRepo` calls (legitimate: several workers may start at
 * once) would otherwise race read-modify-write on the JSON file. Each
 * call chains onto the previous so the on-disk sequence is
 * deterministic from this process's perspective.
 *
 * Cross-process safety is provided by the atomic temp+rename below,
 * which makes the final state of the file always be a well-formed
 * full snapshot from ONE writer — never a partial write or
 * interleaved JSON.
 */
let _ledgerChain: Promise<void> = Promise.resolve()

/**
 * Append `repoRoot` to the ledger (or update its `lastSeenMs`).
 * Atomic temp+rename per peer review.
 */
export function recordWorkerRepo(repoRoot: string): Promise<void> {
  const next = _ledgerChain.then(async () => {
    await fs.mkdir(PATHS.APP_DIR, { recursive: true })
    const current = await readLedger()
    // Dedup: drop any existing entry for this root before appending
    // the fresh one so the array doesn't grow unbounded with repeats.
    const filtered = current.entries.filter((e) => e.repoRoot !== repoRoot)
    filtered.push({ repoRoot, lastSeenMs: Date.now() })
    // Prune by age and cap entry count (newest wins).
    const now = Date.now()
    const pruned = filtered
      .filter((e) => now - e.lastSeenMs < LEDGER_MAX_AGE_MS)
      .slice(-LEDGER_MAX_ENTRIES)
    const ledger: LedgerFile = { entries: pruned }

    // Atomic temp+rename. The temp filename is unique per call
    // (PID + 8 random hex chars) so concurrent processes don't
    // collide on the temp name; the final `rename` is atomic on
    // POSIX and on Windows (both with same filesystem).
    const tmp = `${ledgerPath()}.tmp.${process.pid}.${randomBytes(4).toString(
      "hex",
    )}`
    try {
      await writeRuntimeFileSecure(tmp, JSON.stringify(ledger, null, 2))
      await fs.rename(tmp, ledgerPath())
    } catch (err) {
      // Clean up the temp file if rename failed midway.
      await fs.unlink(tmp).catch(() => {})
      throw err
    }
  })
  // Swallow chain-internal errors so one failed write doesn't poison
  // the chain for every subsequent caller. Each call still sees its
  // own rejection (we return `next`, not the catch-handler chain).
  _ledgerChain = next.catch(() => undefined)
  return next
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // EPERM = process exists but we can't signal it — still alive
    // for our purposes (we just need to know whether to clean up).
    if (code === "EPERM") return true
    return false
  }
}

/**
 * Boot-time sweep. For every repo we recorded in the ledger,
 * enumerate `<repoRoot>/.git/worker-worktrees/` (the conventional
 * location — for repos already inside a worktree, the actual
 * `git-common-dir` may differ, in which case we'll miss this batch
 * and the per-call age sweep will catch them within 7 days) and
 * remove dirs that aren't owned by THIS proxy.
 *
 * Ownership rule: dir is "ours" iff its embedded PID is alive AND
 * its embedded UUID equals `getInstanceUuid()`. Either condition
 * failing → remove.
 */
export async function sweepStaleWorktreesAtBoot(): Promise<void> {
  const ledger = await readLedger()
  if (ledger.entries.length === 0) return
  const currentUuid = getInstanceUuid()
  for (const entry of ledger.entries) {
    const parent = path.join(entry.repoRoot, ".git", "worker-worktrees")
    let names: Array<string>
    try {
      names = await fs.readdir(parent)
    } catch {
      continue
    }
    for (const name of names) {
      const m = WORKTREE_DIR_NAME_RE.exec(name)
      if (!m) continue
      const pid = Number.parseInt(m[1], 10)
      const uuid = m[2]
      const isOurs = isPidAlive(pid) && uuid === currentUuid
      if (isOurs) continue

      const fullDir = path.join(parent, name)
      const branch = `worker/${pid}-${uuid}-${m[3]}`
      try {
        // `-C entry.repoRoot` is load-bearing here too — see the
        // matching comment in `sweepRegistry`. The boot sweep runs
        // BEFORE any worker tool has set cwd, so the proxy's cwd is
        // the user's launch dir, which is almost never inside the
        // target repo.
        execFileSync(
          "git",
          ["-C", entry.repoRoot, "worktree", "remove", "--force", fullDir],
          { stdio: "ignore", timeout: 10_000, windowsHide: true },
        )
      } catch {
        // ignore
      }
      try {
        execFileSync(
          "git",
          ["-C", entry.repoRoot, "branch", "-D", branch],
          { stdio: "ignore", timeout: 5_000, windowsHide: true },
        )
      } catch {
        // ignore
      }
      try {
        await fs.rm(fullDir, { recursive: true, force: true })
      } catch {
        // ignore — git may have removed it already
      }
    }
  }
}

/** Test-only: clear the ledger file (does NOT remove on-disk worktrees). */
export async function __clearLedgerForTests(): Promise<void> {
  await fs.unlink(ledgerPath()).catch(() => {})
}

/** Test-only: read the ledger as a plain array (no side effects). */
export async function __readLedgerForTests(): Promise<Array<LedgerEntry>> {
  return (await readLedger()).entries
}
