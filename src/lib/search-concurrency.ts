/**
 * Search-specific concurrency control for `code_search`.
 *
 * The MCP-wide `MAX_INFLIGHT_TOOLS_CALL` (128) is shared across ALL tools —
 * it bounds operator-traffic starvation, not CPU. Sixteen parallel
 * `code_search` calls fit under it easily yet oversubscribe a 4-core box:
 * each spawns ripgrep (multi-threaded by default) plus tree-sitter parses.
 * This module bounds ACTIVE search weight so parallel queries degrade
 * gracefully instead of thrashing.
 *
 * Design (Phase 1, A8):
 *   - Weight-based FIFO semaphore. Modes carry different CPU costs:
 *     ranked/regex/ast do the most work (BM25F two-pass + structural pass
 *     or ast-grep spawn); literal is a thin streaming scan.
 *   - Small requests naturally fit into freed capacity first (a 0.5-weight
 *     exact query proceeds when 0.5 frees, while a 1.0 ranked query waits)
 *     — no explicit priority lane needed.
 *   - No queue cap in v1: bursts are finite (16 parallel), and the MCP
 *     layer already caps at 128. Saturation errors would add failure modes
 *     without evidence of queue buildup; revisit with benchmark data.
 *   - `recommendedRgThreads()` lets ripgrep spawns size their own thread
 *     pools from live concurrency (Phase 1, A5): a sole searcher gets all
 *     cores; six concurrent searches get ~1 thread each.
 *
 * `searchCode` (src/lib/code-search.ts) is the choke point — every caller
 * (MCP `code` tool, worker `code_search` tool, direct imports) funnels
 * through it, so acquiring here covers all surfaces. Acquisition happens
 * AFTER input/workspace validation so invalid calls fail fast without
 * holding a slot.
 */

import * as os from "node:os";

/** CPU cost classes for search dispatch. */
export type SearchWeightClass = "ranked" | "literal" | "regex" | "ast";

/**
 * Per-class weights. Ranked pays for BM25F two-pass + the structural pass;
 * regex can backtrack; ast spawns sg. Literal streams matches with no
 * scoring — cheapest.
 */
const WEIGHTS: Record<SearchWeightClass, number> = {
  ranked: 1.0,
  literal: 0.5,
  regex: 1.0,
  ast: 1.0,
} as const;

function cpuCount(): number {
  try {
    const n = os.cpus().length;
    return Number.isSafeInteger(n) && n > 0 ? n : 4;
  } catch {
    return 4;
  }
}

/**
 * Max aggregate active weight. Default `cpus * 1.5` (4-core → 6.0):
 * six concurrent ranked searches, or twelve literal, or a mix. The 1.5x
 * headroom accounts for searches spending part of their time in I/O
 * (ripgrep streaming, file reads) rather than on-CPU.
 * Override with `GH_ROUTER_SEARCH_MAX_WEIGHT` (positive number).
 */
export function maxSearchWeight(): number {
  const raw = process.env.GH_ROUTER_SEARCH_MAX_WEIGHT;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return cpuCount() * 1.5;
}

/**
 * Bypass switch for tests and single-shot debugging:
 * `GH_ROUTER_SEARCH_NO_LIMIT=1` makes acquisition a no-op.
 */
function bypassed(): boolean {
  const v = process.env.GH_ROUTER_SEARCH_NO_LIMIT;
  return v === "1" || v === "true";
}

interface Waiter {
  weight: number;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  onAbort: () => void;
  signal?: AbortSignal;
  settled: boolean;
}

let activeWeight = 0;
const queue: Array<Waiter> = [];

/** Test-only: reset active weight + drop queued waiters (rejects them). */
export function __resetSearchConcurrencyForTests(): void {
  activeWeight = 0;
  const pending = queue.splice(0, queue.length);
  for (const w of pending) {
    if (w.settled) continue;
    w.settled = true;
    w.signal?.removeEventListener("abort", w.onAbort);
    w.reject(new Error("search concurrency reset"));
  }
}

/** Current aggregate active weight (telemetry/tests). */
export function currentSearchWeight(): number {
  return activeWeight;
}

/** Current queued waiter count (telemetry/tests). */
export function queuedSearchCount(): number {
  return queue.length;
}

function release(weight: number): void {
  activeWeight = Math.max(0, activeWeight - weight);
  drain();
}

/**
 * Admit queued waiters in FIFO order, skipping entries that don't fit the
 * freed capacity (they wait for the next release). Single pass per release
 * — bursts drain; strict head-of-line blocking would idle freed capacity
 * behind one large waiter while smaller ones could proceed.
 */
function drain(): void {
  if (queue.length === 0) return;
  const max = maxSearchWeight();
  const remaining: Array<Waiter> = [];
  for (const w of queue) {
    if (w.settled) continue;
    if (activeWeight + w.weight <= max) {
      w.settled = true;
      w.signal?.removeEventListener("abort", w.onAbort);
      activeWeight += w.weight;
      w.resolve(() => release(w.weight));
    } else {
      remaining.push(w);
    }
  }
  queue.length = 0;
  queue.push(...remaining);
}

/**
 * Acquire a search slot. Resolves with a release function the caller MUST
 * invoke exactly once (typically from a `finally` block); the release is
 * idempotent. Rejects immediately if `signal` is already aborted; removes
 * the waiter and rejects if it aborts while queued.
 */
export function acquireSearchSlot(
  mode: SearchWeightClass,
  signal?: AbortSignal,
): Promise<() => void> {
  const weight = WEIGHTS[mode] ?? 1.0;
  if (bypassed()) return Promise.resolve(() => {});
  if (signal?.aborted) {
    return Promise.reject(new Error("search aborted before dispatch"));
  }
  if (queue.length === 0 && activeWeight + weight <= maxSearchWeight()) {
    activeWeight += weight;
    let released = false;
    return Promise.resolve(() => {
      if (released) return;
      released = true;
      release(weight);
    });
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = {
      weight,
      resolve,
      reject,
      signal,
      settled: false,
      onAbort: () => {
        if (waiter.settled) return;
        waiter.settled = true;
        const i = queue.indexOf(waiter);
        if (i >= 0) queue.splice(i, 1);
        reject(new Error("search aborted while queued"));
      },
    };
    queue.push(waiter);
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
  });
}

/**
 * Recommended ripgrep `--threads` for a spawn happening RIGHT NOW
 * (Phase 1, A5). Divides cores across live searches so N concurrent
 * searches don't each fan out to `cpus` threads: a sole searcher gets
 * all cores; six concurrent on 4-core get 1 each. Called at spawn time
 * from `buildRgArgs` — no signature changes needed anywhere.
 */
export function recommendedRgThreads(): number {
  const cpus = cpuCount();
  // activeSearchCount derives from weight; a lone literal (0.5) still
  // counts as one live searcher for thread-division purposes.
  const active = Math.max(1, Math.ceil(activeWeight));
  return Math.max(1, Math.floor(cpus / active));
}
