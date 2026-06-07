/**
 * Warm `worker_threads` pool that parallelizes the synchronous web-tree-sitter
 * parses the `code_search` structural pass would otherwise serialize on the one
 * module-global WASM heap.
 *
 * Decision + measured evidence: `docs/research/tree-sitter-parallelism.md`
 * ("Phase 2 decision"). Reproduce the benchmark with
 * `GH_ROUTER_BENCH_STRUCTURAL=1 BENCH_SPREAD=1 bun
 * scripts/bench-code-search-parallelism.ts`.
 *
 * Load-bearing properties (each has a test in tests/tree-sitter-pool.test.ts):
 *
 *   - DETERMINISM: the merge is order-independent. Confirmed hits land in a
 *     `Set<number>`; outlines are keyed by file and each file's entries are
 *     line-sorted worker-side. The caller assembles output in RESULT order, not
 *     worker-completion order. So which worker finishes first cannot change the
 *     bytes (the 5-run determinism test stays green).
 *   - ABORT: `signal` stops dispatch and posts `cancel` to busy workers; the
 *     pass resolves with whatever confirmed pre-abort (a partial Set is valid).
 *   - ERROR ISOLATION: a worker `error`/`exit`/`{ok:false}` marks that file a
 *     MISS (kept on the regex heuristic / empty outline) and the worker is
 *     retired + lazily respawned. A TOTAL pool failure makes `parseFiles`
 *     return `null`, and the caller falls back to the in-process path — so
 *     Lever 2 can fail completely and `code_search` still returns correct
 *     (just less precisely ranked) results.
 *   - NEVER ORPHAN: workers are `unref()`-ed (never keep the process alive) and
 *     a synchronous `process.once("exit")` sweep `terminate()`s them all. (We
 *     deliberately do NOT add SIGINT/SIGTERM listeners — they'd compete with the
 *     worker-agent lifecycle handlers; the `exit` sweep fires on every exit
 *     path, and unref()-ed workers die with the process regardless.)
 *   - BUDGET: a budget/abort drops this call's still-QUEUED jobs (resolving
 *     their promises as misses) so `parseFiles` returns at the deadline instead
 *     of waiting on jobs that won't be dispatched in time. In-flight jobs finish
 *     naturally (sub-50ms per file) and their post-deadline results are
 *     discarded by the `stopped` flag.
 *
 * Windows: `worker_threads` + WASM is cross-platform; `worker.terminate()` is
 * the teardown (no child process → no taskkill/PATHEXT). Must be proven green
 * on windows-latest CI (the project's Windows-first gate).
 */

import { existsSync } from "node:fs"
import * as os from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"

import consola from "consola"

import type { FileOutlineEntry, StructuralHit } from "~/lib/tree-sitter-grammars"
import type {
  ParseJobReply,
  ParseJobRequest,
  WorkerToMain,
} from "~/lib/tree-sitter-pool/protocol"

/**
 * Max time to wait for a freshly-spawned worker to post `ready` (Parser.init +
 * grammar load). A worker that never readies (grammar-load hang, bad layout)
 * must not wedge the spawn promise forever — on timeout we terminate it and
 * treat the spawn as failed, so the pool degrades to fewer workers / the
 * in-process path rather than hanging every search.
 */
const READY_TIMEOUT_MS = 10_000

/**
 * After this many cumulative worker deaths, retire the pool permanently
 * (`spawnFailed = true`) and force the in-process path. Guards against a
 * crash-storm — a corrupt grammar that traps on every parse — churning
 * spawn→crash without bound. The threshold is generous (occasional WASM OOM on
 * a pathological file is fine) but finite.
 */
const MAX_CRASHES = 50

/** Per-file work the pool dispatches. `file` is the relative key the caller
 *  uses to reassemble results in result order. */
export interface PoolJob {
  file: string
  absPath: string
  language: string
  mtimeMs: number
  /** Confirm-hit list; the returned indexes are positions into THIS array. */
  confirmHits: Array<StructuralHit>
  /** Whether to also compute the outline for this file. */
  outline: boolean
}

export interface PoolFileResult {
  confirmedHitIndexes: Array<number>
  outlineEntries?: Array<FileOutlineEntry>
  ok: boolean
}

export interface PoolRunResult {
  /** file → result. Files whose result arrived after the budget timer (or that
   *  errored) are absent → the caller treats them as misses. */
  byFile: Map<string, PoolFileResult>
  /** True iff the wall-clock budget fired before all jobs completed. */
  budgetHit: boolean
}

/**
 * Pool size: `max(1, min(4, cpus-2))`. Cap 4 — the parse work per call is small
 * and bounded, each worker holds a full WASM heap + grammars (memory), and the
 * MCP layer already caps concurrent tool calls at 8, so a per-call pool of 4
 * across 8 concurrent `code` calls already oversubscribes cores. On a 1–2 core
 * box this degrades to a single worker (still better than nothing: parse CPU
 * moves off the main event loop). Override via `GH_ROUTER_TS_POOL_SIZE`.
 */
function computePoolSize(): number {
  const env = process.env.GH_ROUTER_TS_POOL_SIZE
  if (env) {
    const n = Number(env)
    if (Number.isInteger(n) && n >= 1 && n <= 16) return n
  }
  let cpus = 1
  try {
    cpus = os.cpus().length
  } catch {
    cpus = 1
  }
  return Math.max(1, Math.min(4, cpus - 2))
}

interface PooledWorker {
  worker: Worker
  /** True once the worker posted `ready`. */
  ready: boolean
  /** Grammar keys this worker loaded; empty → useless, retire it. */
  loaded: Set<string>
  /** The job id currently dispatched to this worker, or null if idle. */
  busyJobId: number | null
}

/** One queued unit of work + the callback that routes its reply back to the
 *  `parseFiles` caller that enqueued it. `null` reply = worker died. */
interface QueuedJob {
  id: number
  req: ParseJobRequest
  done: (reply: ParseJobReply | null) => void
  /** True once this job has been retried after a worker death (retry once). */
  retried: boolean
}

class TreeSitterPool {
  private workers: Array<PooledWorker> = []
  private readonly size: number
  private readonly workerPath: string | null
  private nextJobId = 1
  private spawnFailed = false
  private shuttingDown = false
  private ensuring: Promise<number> | null = null
  /** Count of worker deaths. After too many (a crash storm — e.g. a corrupt
   *  grammar that traps the WASM heap on every parse), give up on the pool
   *  entirely and force the in-process path, rather than churning spawn→crash
   *  forever. */
  private crashCount = 0

  // ---- Central scheduler state (shared across ALL concurrent parseFiles
  // calls). A worker is leased to exactly one job at a time; replies route by
  // job id. This is what makes concurrent `code` searches safe: without a
  // single arbiter, two searches would dispatch to the same worker and clobber
  // each other's pending-reply state → deadlock. ----
  private readonly queue: Array<QueuedJob> = []
  private readonly inflight = new Map<number, QueuedJob>()

  constructor() {
    this.size = computePoolSize()
    this.workerPath = resolveWorkerPath()
  }

  /** True when the pool can never produce workers (no worker script found). */
  get unavailable(): boolean {
    return this.workerPath === null || this.spawnFailed
  }

  /** Lazily spawn up to `size` workers and await their `ready` signals. Safe to
   *  call repeatedly; respawns workers retired by crashes. Coalesces concurrent
   *  callers onto one in-flight ensure so 8 simultaneous searches don't each
   *  spawn a fresh batch. Returns the live worker count (0 → caller must fall
   *  back to the in-process path). */
  private ensureWorkers(): Promise<number> {
    if (this.unavailable || this.shuttingDown) return Promise.resolve(0)
    const liveNow = this.workers.filter((w) => w.ready && w.loaded.size > 0).length
    if (liveNow >= this.size) return Promise.resolve(liveNow)
    if (this.ensuring) return this.ensuring
    this.ensuring = this.doEnsureWorkers().finally(() => {
      this.ensuring = null
    })
    return this.ensuring
  }

  private async doEnsureWorkers(): Promise<number> {
    const need = this.size - this.workers.length
    const spawns: Array<Promise<PooledWorker | null>> = []
    for (let i = 0; i < need; i++) spawns.push(this.spawnWorker())
    const spawned = await Promise.all(spawns)
    let added = 0
    for (const w of spawned) {
      if (w && w.ready && w.loaded.size > 0) {
        this.workers.push(w)
        added += 1
      }
    }
    const total = this.workers.filter((w) => w.ready && w.loaded.size > 0).length
    if (total === 0 && need > 0) {
      // Every spawn attempt produced a useless/dead worker.
      this.spawnFailed = true
    }
    if (added > 0) this.pump() // newly-ready workers pull queued jobs
    return total
  }

  private spawnWorker(): Promise<PooledWorker | null> {
    if (!this.workerPath) return Promise.resolve(null)
    return new Promise((resolve) => {
      let settled = false
      let worker: Worker
      try {
        worker = new Worker(this.workerPath!)
      } catch (err) {
        consola.debug(
          `[code_search] tree-sitter worker spawn failed: ${(err as Error).message}`,
        )
        resolve(null)
        return
      }
      // unref so the pool never keeps the process alive on its own.
      worker.unref()
      const pw: PooledWorker = {
        worker,
        ready: false,
        loaded: new Set(),
        busyJobId: null,
      }
      // Bound the ready handshake: a worker that spawns but never posts `ready`
      // (e.g. a grammar-load hang) must NOT wedge the spawn promise forever —
      // that would hang `ensureWorkers` and every `parseFiles` awaiting it.
      const readyTimer = setTimeout(() => {
        if (!settled) {
          settled = true
          try {
            void worker.terminate()
          } catch {
            // best effort
          }
          resolve(null)
        }
      }, READY_TIMEOUT_MS)
      readyTimer.unref?.()
      const onError = (err: Error): void => {
        consola.debug(`[code_search] tree-sitter worker error: ${err.message}`)
        this.retire(pw)
        if (!settled) {
          settled = true
          clearTimeout(readyTimer)
          resolve(null)
        }
      }
      const onExit = (): void => {
        this.retire(pw)
        if (!settled) {
          settled = true
          clearTimeout(readyTimer)
          resolve(null)
        }
      }
      worker.on("error", onError)
      worker.on("exit", onExit)
      worker.on("message", (msg: WorkerToMain) => {
        if ("type" in msg && msg.type === "ready") {
          pw.ready = true
          pw.loaded = new Set(msg.loaded)
          if (!settled) {
            settled = true
            clearTimeout(readyTimer)
            resolve(pw)
          }
          return
        }
        // A job reply → route it to the owning queued job and free the worker.
        const reply = msg as ParseJobReply
        this.completeJob(pw, reply.id, reply)
      })
    })
  }

  /** Finish the job `id` that `pw` was running: route the reply, free the
   *  worker, and pump the next queued job. `reply === null` means the worker
   *  died (the job is routed null → requeued once or degraded by the caller). */
  private completeJob(pw: PooledWorker, id: number, reply: ParseJobReply | null): void {
    const job = this.inflight.get(id)
    if (!job || pw.busyJobId !== id) {
      // Stale/duplicate reply (already completed via retire) — ignore.
      return
    }
    this.inflight.delete(id)
    pw.busyJobId = null
    job.done(reply)
    this.pump()
  }

  private retire(pw: PooledWorker): void {
    // Fail the worker's in-flight job (if any) so its caller doesn't hang.
    if (pw.busyJobId !== null) {
      const id = pw.busyJobId
      pw.busyJobId = null
      const job = this.inflight.get(id)
      if (job) {
        this.inflight.delete(id)
        job.done(null)
      }
    }
    pw.ready = false
    pw.loaded = new Set()
    try {
      void pw.worker.terminate()
    } catch {
      // best effort
    }
    this.workers = this.workers.filter((w) => w !== pw)
    // Crash-storm guard: after MAX_CRASHES deaths, retire the pool permanently.
    // Set BEFORE pump() so pump drains the queue instead of respawning again.
    this.crashCount += 1
    if (this.crashCount >= MAX_CRASHES) this.spawnFailed = true
    // Other searches may have queued work that a surviving worker can take
    // (or, if spawnFailed just tripped, pump drains the queue as misses).
    this.pump()
  }

  /** Hand queued jobs to idle ready workers, one per worker. Called whenever a
   *  worker frees up, a new worker readies, or jobs are enqueued. If the queue
   *  is non-empty but no worker can ever serve it (all dead), it triggers a
   *  respawn; if respawn yields nothing, the stranded jobs are failed as misses
   *  so their `parseFiles` callers don't hang forever. */
  private pump(): void {
    if (this.shuttingDown) return
    for (const pw of this.workers) {
      if (this.queue.length === 0) break
      if (!pw.ready || pw.loaded.size === 0 || pw.busyJobId !== null) continue
      const job = this.queue.shift()
      if (!job) break
      pw.busyJobId = job.id
      this.inflight.set(job.id, job)
      try {
        pw.worker.postMessage(job.req)
      } catch (err) {
        // postMessage failed → treat as a worker death for this job.
        consola.debug(
          `[code_search] tree-sitter worker postMessage failed: ${(err as Error).message}`,
        )
        this.inflight.delete(job.id)
        pw.busyJobId = null
        job.done(null)
      }
    }

    // Jobs still queued with no live worker to take them: a crash retired every
    // worker mid-call. Try to respawn (recovery); if that produces no usable
    // worker, drain the stranded queue as misses so no caller hangs.
    if (this.queue.length > 0) {
      const liveOrBusy = this.workers.some((w) => w.ready && w.loaded.size > 0)
      if (!liveOrBusy && !this.ensuring && !this.spawnFailed && !this.shuttingDown) {
        void this.ensureWorkers().then((live) => {
          if (live === 0) this.drainQueue()
          // else: doEnsureWorkers calls pump() on success, draining the queue
          // onto the new workers.
        })
      } else if (this.spawnFailed && !liveOrBusy) {
        // Pool permanently failed AND no worker can serve the queue → drain.
        // The `!liveOrBusy` gate is load-bearing: a sticky `spawnFailed` must
        // NOT drain jobs a still-live worker could process.
        this.drainQueue()
      }
    }
  }

  /** Fail every queued job as a miss (null). Used when no worker can serve
   *  them. In-flight jobs are handled by `retire` when their worker dies. */
  private drainQueue(): void {
    while (this.queue.length > 0) {
      const job = this.queue.shift()
      job?.done(null)
    }
  }

  /** Enqueue one job; resolves with its reply (or null on worker death). When
   *  the pool is shutting down, resolve immediately as a miss so a retry after
   *  shutdown can't push a job that `pump()` (early-returns while shutting down)
   *  would never dispatch → caller hangs. */
  private enqueue(req: ParseJobRequest, retried: boolean): Promise<ParseJobReply | null> {
    if (this.shuttingDown) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.queue.push({ id: req.id, req, done: resolve, retried })
      this.pump()
    })
  }

  /** Remove every still-queued (not-yet-dispatched) job whose id is in `ids`
   *  and resolve it as a miss. Used by budget/abort so `parseFiles` doesn't wait
   *  on jobs that will never be dispatched before the deadline. In-flight jobs
   *  (already posted to a worker) are NOT touched — they resolve when the worker
   *  replies or dies; `stopped` makes `dispatchFile` discard their result. */
  private cancelQueued(ids: Set<number>): void {
    if (this.queue.length === 0) return
    const remaining: Array<QueuedJob> = []
    const drained: Array<QueuedJob> = []
    for (const job of this.queue) {
      if (ids.has(job.id)) drained.push(job)
      else remaining.push(job)
    }
    if (drained.length === 0) return
    this.queue.length = 0
    this.queue.push(...remaining)
    for (const job of drained) job.done(null)
  }

  /**
   * Parse all `jobs` across the pool, racing a `budgetMs` wall-clock timer.
   * Returns `null` if the pool is unavailable / failed as a whole (caller falls
   * back in-process). Order-independent: the returned `byFile` map is keyed by
   * file, so the caller reassembles deterministically regardless of which
   * worker (or which concurrent search) finished first.
   *
   * Concurrency-safe: jobs from every concurrent `parseFiles` call feed ONE
   * shared queue and workers are leased atomically, so two searches never
   * clobber each other's in-flight worker state.
   */
  async parseFiles(
    jobs: Array<PoolJob>,
    opts: { budgetMs: number; signal: AbortSignal },
  ): Promise<PoolRunResult | null> {
    if (jobs.length === 0) return { byFile: new Map(), budgetHit: false }
    if (opts.signal.aborted) return { byFile: new Map(), budgetHit: false }

    const byFile = new Map<string, PoolFileResult>()
    let budgetHit = false
    let stopped = false
    // Track job ids THIS call owns so abort/budget cancel only OUR queued jobs
    // and our busy workers, never another concurrent search's.
    const myJobIds = new Set<number>()

    // Register abort handling BEFORE awaiting ensureWorkers so an abort during
    // worker spawn is observed promptly for QUEUED work. NOTE: if the abort
    // lands while we're still inside `ensureWorkers()` (worker spawn/ready
    // handshake), the await itself is not interrupted — cancellation of the
    // *spawn* is bounded by READY_TIMEOUT_MS. The structural pass's 200ms budget
    // makes this a non-issue in practice (workers are warm after the first
    // call); a hard spawn-abort race isn't worth the added complexity.
    const stop = (): void => {
      stopped = true
      // Drop our still-queued jobs so their enqueue() promises resolve (else
      // Promise.all below waits on jobs that will never be dispatched in time).
      this.cancelQueued(myJobIds)
      // Ask workers currently running OUR jobs to cancel; they reply with
      // whatever they have. (Note: the worker's parse loop is synchronous, so
      // this only takes effect between files — best-effort, not preemptive.)
      for (const pw of this.workers) {
        if (pw.busyJobId !== null && myJobIds.has(pw.busyJobId)) {
          try {
            pw.worker.postMessage({ type: "cancel" })
          } catch {
            // ignore
          }
        }
      }
    }
    const onAbort = (): void => stop()
    if (opts.signal.aborted) {
      // Already aborted (caught above for the empty-jobs fast path, but a signal
      // can flip between that check and here).
      return { byFile, budgetHit: false }
    }
    opts.signal.addEventListener("abort", onAbort, { once: true })

    const budgetTimer = setTimeout(() => {
      budgetHit = true
      stop()
    }, opts.budgetMs)
    budgetTimer.unref?.()

    try {
      const liveCount = await this.ensureWorkers()
      if (liveCount === 0) return null

      // Per-file dispatch with a single retry on worker death. The `stopped`
      // flag (budget/abort) makes pending dispatches resolve as misses.
      const dispatchFile = async (job: PoolJob, retried: boolean): Promise<void> => {
        if (stopped) return
        const id = this.nextJobId++
        myJobIds.add(id)
        const req: ParseJobRequest = {
          id,
          absPath: job.absPath,
          language: job.language,
          mtimeMs: job.mtimeMs,
          want: {
            confirmHits: job.confirmHits.length > 0 ? job.confirmHits : undefined,
            outline: job.outline || undefined,
          },
        }
        const reply = await this.enqueue(req, retried)
        if (stopped) return
        if (reply === null) {
          // Worker died mid-job → retry once on another worker, else miss.
          if (!retried) await dispatchFile(job, true)
          return
        }
        if (!reply.ok) return // worker-reported failure → miss
        if (reply.mtimeMs !== job.mtimeMs) return // file changed → miss
        byFile.set(job.file, {
          confirmedHitIndexes: reply.confirmedHitIndexes ?? [],
          outlineEntries: reply.outlineEntries,
          ok: true,
        })
      }

      await Promise.all(jobs.map((job) => dispatchFile(job, false)))
    } finally {
      clearTimeout(budgetTimer)
      opts.signal.removeEventListener("abort", onAbort)
    }

    // Total-failure detection: if NO file produced a result and we weren't
    // stopped by abort/budget, the pool failed as a whole (every job hit a
    // dead worker) → return null so the caller falls back to in-process.
    const stillLive = this.workers.some((w) => w.ready && w.loaded.size > 0)
    if (!stopped && byFile.size === 0 && !stillLive) return null

    return { byFile, budgetHit }
  }

  /** Terminate every worker. Idempotent. Fails any queued / in-flight jobs as
   *  misses so no `parseFiles` caller hangs waiting on a worker that's gone. */
  shutdown(): void {
    this.shuttingDown = true
    for (const job of this.inflight.values()) job.done(null)
    this.inflight.clear()
    while (this.queue.length > 0) {
      const job = this.queue.shift()
      job?.done(null)
    }
    for (const pw of this.workers) {
      try {
        void pw.worker.terminate()
      } catch {
        // best effort
      }
    }
    this.workers = []
  }
}

// ---------------------------------------------------------------------------
// Worker-script resolution (dev .ts vs bundled .js)
// ---------------------------------------------------------------------------

/**
 * Resolve the worker entry path for the current layout. Mirrors version.ts's
 * candidate-list pattern: dev runs the `.ts` directly under Bun; the bundled
 * build emits `dist/lib/tree-sitter-pool/worker.js` (separate tsdown entry).
 * Returns null if no candidate exists → the pool is unavailable and the caller
 * falls back to the in-process path.
 */
function resolveWorkerPath(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const candidates = [
      join(here, "worker.ts"), // dev: src/lib/tree-sitter-pool/worker.ts
      join(here, "worker.js"), // bundled sibling
      join(here, "tree-sitter-pool", "worker.js"), // dist/lib/tree-sitter-pool/
      join(here, "lib", "tree-sitter-pool", "worker.js"), // from dist root
    ]
    for (const p of candidates) {
      if (existsSync(p)) return p
    }
  } catch {
    // fall through
  }
  return null
}

// ---------------------------------------------------------------------------
// Lazy singleton + never-orphan shutdown
// ---------------------------------------------------------------------------

let _pool: TreeSitterPool | null = null
let _shutdownRegistered = false
/**
 * The pool is OPT-IN. Its worker_threads + WASM grammar heap fails to
 * initialize under some sandboxes (CI runners on BOTH ubuntu and windows),
 * where it then yields degraded (role-tag-poorer) output instead of the
 * in-process result. The in-process structural pass is correct and is the
 * proven default. Enable the pool with `GH_ROUTER_ENABLE_TS_POOL=1` once
 * validated on the target host — it gives a large event-loop-latency win
 * under concurrent searches (see `scripts/bench-code-search-parallelism.ts`).
 * `GH_ROUTER_DISABLE_TS_POOL=1` still hard-disables and takes precedence.
 */
const poolEnabled = (): boolean =>
  process.env.GH_ROUTER_DISABLE_TS_POOL !== "1" &&
  process.env.GH_ROUTER_ENABLE_TS_POOL === "1"

/**
 * Get the process-wide pool, spawning it lazily on first use (NOT at import —
 * a `claude` passthrough session that never calls `code` should pay nothing).
 * Returns null when not opted-in or unavailable.
 */
export function getTreeSitterPool(): TreeSitterPool | null {
  if (!poolEnabled()) return null
  if (_pool) return _pool
  _pool = new TreeSitterPool()
  if (_pool.unavailable) {
    _pool = null
    return null
  }
  if (!_shutdownRegistered) {
    _shutdownRegistered = true
    // ONLY an `exit` handler. We deliberately do NOT add SIGINT/SIGTERM
    // listeners: those would compete with the worker-agent lifecycle handlers
    // (src/lib/worker-agent/lifecycle.ts), and calling process.exit() from one
    // signal listener suppresses the others. Because every worker is unref()-ed
    // it can never keep the process alive on its own — so the synchronous
    // `exit` sweep (which fires on EVERY exit path, including after another
    // handler re-raises a signal) is sufficient to terminate them cleanly and
    // never-orphan. terminate() is async but we don't await: the process is
    // already exiting and unref()-ed workers die with it regardless.
    process.once("exit", () => _pool?.shutdown())
  }
  return _pool
}

/** Test-only: tear down and reset the singleton. */
export function __resetTreeSitterPoolForTests(): void {
  _pool?.shutdown()
  _pool = null
}

export type { TreeSitterPool }
