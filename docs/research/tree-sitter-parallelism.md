# Making `code_search`'s tree-sitter work parallel and fast

Read-only investigation + design. Goal: parallelize and speed up the tree-sitter
portion of `code_search`. All line numbers are against `src/lib/code-search.ts`
and `src/lib/tree-sitter-grammars.ts` as read on 2026-06-06. Timing figures are
rough local measurements (macOS, Bun 1.3.14, warm FS cache), not universal
claims. **No code is modified by this document.**

## The serialization problem, stated precisely

`web-tree-sitter@0.22.6` is a **single module-global Emscripten `Module`** — one
`Parser.init()`, one `wasmMemory`, one heap, shared by every `Parser` instance
(`tree-sitter-grammars.ts:260-294`; the one-init invariant is documented at
`tree-sitter-grammars.ts:20-23`). `parser.parse()` is **synchronous** CPU on the
single JS thread (`d.ts`: `parse(input, oldTree?, options?): Parser.Tree` — a
Tree, not a Promise). Constructing multiple `Parser` objects does **not** create
parallel isolates. So:

- **Within one process, parses serialize.** Two concurrent `code` calls do not
  corrupt each other (single-threaded JS, the cache mutations happen between
  `await`s — see `mcp-concurrency-audit.md` §5), but their parse sections cannot
  overlap. The only `await` boundaries are *between* files, never mid-parse.
- **`code_search` now runs TWO rounds of tree-sitter per call**, and they do not
  share work:
  1. **Structural pass** (`runStructuralPass`, `code-search.ts:1047`) — parses
     the top-N BM25F hits (50 for `structural:"full"`, 10 for `"topN"`), caches
     `{mtimeMs, tree, source}` in `_treeCache` (`code-search.ts:885`, mtime-gated
     LRU, cap 64), walks each hit's matched identifier through `isDefiningSite`.
     Wall-clock-budgeted at `STRUCTURAL_BUDGET_MS = 200` (`code-search.ts:140`),
     checked *between* files (`code-search.ts:1088-1094`).
  2. **Outline summary** (default-on, `code-search.ts:1780-1799`) — calls
     `outlineFile` (`tree-sitter-grammars.ts:448`) for each of the ≤10 distinct
     result files (`CODE_SUMMARY_MAX_FILES = 10`). `outlineFile` **creates its own
     `Parser`** (`tree-sitter-grammars.ts:512`), **re-reads the file**
     (`await readFile`, line 502), **re-parses** (line 514), walks
     `collectDefinitions`, then **`.delete()`s the tree** (line 538). It never
     consults `_treeCache`.

The result files (round 2) are the highest-ranked hits, which are a near-perfect
subset of the structural pass's top-N (round 1). So in the common default call,
**all ≤10 outline files were already parsed milliseconds earlier and the tree was
thrown away.** That redundancy is Lever 1.

> Telemetry note: a prior doc (`code-search-perf-modes.md`) claimed `elapsed_ms`
> excludes the outline loop. That is **stale** — the current file computes
> `elapsed_ms` at line 1801, *after* the outline loop (1780-1799), so latency is
> already honest. No telemetry change is part of this design.

---

## Lever 1 — eliminate the redundant outline parse (no threads, pure win)

**This is the obvious first win; do it unconditionally.** It removes up to 10
redundant `readFile` + `parse` operations per default `code_search` by having the
outline step reuse the trees the structural pass already parsed and is still
holding live in `_treeCache`.

### The ownership constraint that dictates the hook

`_treeCache` lives in `code-search.ts`. `outlineFile` lives in
`tree-sitter-grammars.ts` and is **also called by `src/lib/search-fs-tools.ts:284`**
(the `read summary:true` tool). The grammar module must **not** depend back on the
ranking-layer cache, and `outlineFile`'s existing contract (own its `Parser`, own
its `Tree`, free both in `finally`) must stay intact for that second caller. So
the cache reuse cannot live inside `outlineFile`; it must live in `searchCode`,
with a *pure* helper exported from the grammar module.

### Exact hook

1. **New export in `tree-sitter-grammars.ts`:**
   ```
   export function outlineFromTree(
     tree: Parser.Tree,
     language: string,
     signal?: AbortSignal,
   ): FileOutlineResult
   ```
   It runs ONLY the existing walk: look up `DEFINITION_NODE_TYPES[language]`,
   call `collectDefinitions(tree.rootNode, defTypes, signal)`, sort by line, apply
   the `MAX_OUTLINE_ENTRIES` truncation notice. **It does NOT read, parse, or
   delete** — the tree is borrowed, not owned. `outlineFile` is then refactored to
   `read → parse → outlineFromTree(tree, language, signal) → finally delete`, so
   the two share one walk implementation and the `read summary` caller is
   unchanged.

2. **In `searchCode`'s outline loop** (`code-search.ts:1791-1798`), for each
   distinct result `file`:
   - Compute `absPath = path.resolve(ws.canonical, file)` (already done at 1796).
   - `statSync(absPath).mtimeMs` → `cacheGet(absPath, mtimeMs)`
     (`code-search.ts:887`). `cacheGet` already does the mtime re-check and frees
     the stale tree on mismatch — so a file edited between the structural pass and
     the outline loop misses cleanly and re-parses.
   - **On hit with a non-null `cached.tree`:** call
     `outlineFromTree(cached.tree, langKey, ac.signal)` **synchronously** — no
     `await` between `cacheGet` and the walk. Use the result.
   - **On any miss** (not cached, mtime changed, `cached.tree === null` i.e. prior
     parse failure, unsupported language, or `ac.signal.aborted`): fall back to
     the existing `await outlineFile(absPath, ac.signal)`.

### Lifecycle safety (the load-bearing caveats)

- **Never delete the borrowed tree.** `outlineFromTree` must not call
  `tree.delete()`. The tree's owner is `_treeCache`; it is freed only on mtime
  invalidation (`cacheGet`, line 892) or LRU eviction (`cachePut`, line 916). The
  structural pass frees its *parsers* in `finally` (line 1200) but leaves the
  *trees* live in the cache — confirmed at `code-search.ts:1147-1148,1197-1208`.
  So the trees are guaranteed reusable at outline time. Deleting in
  `outlineFromTree` would double-free when the cache later evicts.
- **No `await` across the borrow.** Hold the cached `Tree` reference only across
  the synchronous `collectDefinitions` walk. Do not `await` anything between
  `cacheGet` and the walk — an interleaved `code` call on the same heap could LRU-
  evict and `.delete()` the tree mid-walk, use-after-free. (`cachePut` eviction is
  synchronous, so as long as the walk has no `await`, no other turn runs.)
- **mtime gate is the only correctness guard.** `cacheGet` already invalidates on
  mtime change, so a between-passes edit is handled; nothing else is needed.
- **The structural-pass LRU is cap-64; the outline set is ≤10 and is the top of
  the rank**, so under normal load the outline files are still resident (they were
  the last 10-50 things inserted). On a pathological broad search where the top-50
  structural files differ from the first-10 result files, the misses fall back to
  `outlineFile` exactly as today — no regression, just a smaller win.

### Quantified saving

Per default (`summary:true`, `mode:"ranked"`) call: **up to 10 redundant file
reads + 10 redundant parses eliminated** whenever the ≤10 outline files overlap
the structural top-N (the normal case). A typical source file parses in well under
50ms and reads in sub-ms warm / several ms cold, so this is the bulk of the
post-rg, non-structural CPU on the default path. It also stops the outline loop
from re-reading files off disk — the biggest single win on cold-cache or network-
FS workspaces (Windows network drives are the primary deployment target). In
`literal`/`regex` modes there is no structural pass, so `_treeCache` is empty and
the outline loop parses fresh exactly as today (no change, no regression).

### Why Lever 1 is safe w.r.t. the stream/abort rules

It is entirely downstream of `parseRgJsonStream` — it touches no
`enqueue`/`close`/`read` call site, so CLAUDE.md's "every stream call site needs a
race-triggering regression test" rule does not apply. It must preserve the
existing `ac.signal.aborted` check at the top of the loop (`code-search.ts:1795`)
and pass `ac.signal` into `outlineFromTree` so a cancelled call bails mid-walk
(`collectDefinitions` already honors `signal`, `tree-sitter-grammars.ts:399,401`).

---

## Lever 2 — parallelize the remaining parses (warm worker-thread pool)

After Lever 1, the only tree-sitter CPU left per call is the **structural pass's
top-N parses** (≤50 in `full`, ≤10 in `topN`) plus any **outline misses** that
fell back to `outlineFile`. True parallelism of those parses needs multiple WASM
heaps, which means `worker_threads` (separate V8 isolates, each its own
Emscripten module). A `Tree` is a native handle into one heap's memory and
**cannot cross the thread boundary** — so each worker must parse AND walk and
return **plain data**, never a Tree.

### Bun / Node / Windows feasibility — VERIFIED

I ran a feasibility probe (`node:worker_threads` → inside the worker:
`Parser.init()` → `Parser.Language.load(tree-sitter-typescript.wasm)` → `new
Parser()` → `parse()` → walk `rootNode` → `tree.delete()` → `postMessage` plain
data back). Resolving `web-tree-sitter` and `tree-sitter-wasms` through the repo's
own package paths (a bare-specifier probe from `/tmp` fails for module-resolution
reasons unrelated to worker support — that is a probe artifact, not a Bun
limitation):

| Runtime | Result |
|---|---|
| **Bun 1.3.14** | `{ok:true, runtime:"bun", rootType:"program", childCount:1}` |
| **Node (control)** | `{ok:true, runtime:"node", rootType:"program"}` |

**Verdict: Bun's `node:worker_threads` runs web-tree-sitter WASM inside a worker
today.** The Bun-vs-Node bridge gotcha documented for the browser bridge (bun
closing the bridge's binary **stdin** prematurely on SW dormancy) **does not apply
here** — worker_threads communicate over `postMessage`, not stdin, so there is no
stdin lifecycle to mismanage. No child-process fallback is needed for Bun.

**Windows specifics.** `worker_threads` is cross-platform in both runtimes; the
probe is POSIX-run here, so the doc's Windows posture is: **expected to work
cross-platform, must be proven green in `windows-latest` CI before the
implementation lands** (the project's Windows-first gate). Worker threads do NOT
spawn child processes, so the `taskkill /T /F` descendant-kill machinery
(`killChild`, `code-search.ts:494`) and the `exec.ts` PATHEXT/quoting helpers are
**not** in play for the pool — `worker.terminate()` is the cross-platform teardown
and needs no Windows special-casing. (Those helpers remain relevant only if Lever
2 ever degrades to a child-process pool, which the probe shows it need not.)

### Pool design

**Sizing.** `Math.max(1, Math.min(4, os.cpus().length - 1))`. Cap at 4: the
realized parse work per call is small and bounded (see cost/benefit), each worker
holds its own full WASM heap + 9 grammars (memory cost), and the MCP surface is
already capped at 8 concurrent `tools/call`s — a per-call pool of 4 across up to 8
concurrent `code` calls would oversubscribe cores. One worker on a single-core
box (still better than nothing: it offloads parse CPU off the main event loop).

**Warm lifecycle.** Spawn **lazily on first structural pass**, not at module
import — module-import spawn would pay the pool cost even for a proxy run that
never calls `code` (e.g. a pure `claude` passthrough session). Each worker, on
spawn, runs `Parser.init()` + loads all 9 grammars once (the same
`getGrammarBundle` logic, re-implemented worker-side) and signals ready. Keep the
pool alive for the process lifetime (warm — the per-call spawn cost is the whole
reason the prior `cs-perf` doc rejected a throwaway-per-call worker: cold spawn +
init + grammar load is hundreds of ms, larger than the 200ms budget). **Clean
shutdown / never-orphan:** register `worker.unref()` so the pool never keeps the
process alive on its own, and a `process.once("exit"|"SIGINT"|"SIGTERM")` sweep
that calls `worker.terminate()` on each — mirroring the worktree session-end
signal-handler sweep pattern (`worker-agent/worktree.ts`). A crashed worker is
replaced lazily on next dispatch (see error isolation).

**Job protocol (plain data only — no Tree crosses the boundary).** One job per
file, and **coalesce the structural-confirm and outline work for the same file
into one job** so a file needed by both rounds is parsed once worker-side:

```
// main → worker
{ id, filePath, language, want: { confirm?: {hits: [{line, matchStart, matchEnd, hitIndex}]},
                                  outline?: true } }
// worker → main
{ id, ok: true,
  confirmedHitIndexes?: number[],   // subset of the input hitIndexes, AST-confirmed
  outlineEntries?: FileOutlineEntry[] }   // plain {kind,name,line,depth}
// or { id, ok: false, error }  → main treats the file as a structural/outline miss
```

The worker reads the file itself (or the main thread reads and ships the source
string — prefer worker-side read so the file bytes never cross `postMessage`; the
source string is the larger payload). It runs `isDefiningSite` for each requested
hit and/or `collectDefinitions` for the outline, deletes its tree, and posts back
**only the confirmed indices and/or the outline entries**. The byte-offset
arithmetic (`lineStartByte`) and the walk helpers move into the worker module
verbatim.

> **Interaction with Lever 1's tree sharing.** Lever 1's win (reuse one parsed
> Tree across the structural pass and the outline) is an **in-process** win that a
> Tree cannot replicate across threads. In the pooled architecture the equivalent
> is the **coalesced job**: when a file is in both the structural top-N and the
> outline set, send ONE job with `want:{confirm, outline}` so the worker parses
> once and returns both `confirmedHitIndexes` and `outlineEntries`. That recovers
> the dedupe inside the threaded model without shipping a Tree.

**Budget mapping (200ms → a pool).** The structural budget today is wall-clock
across serial parses. With a pool, dispatch all top-N file jobs at once and race a
single 200ms `setTimeout` against the aggregate. When the timer fires, stop
*consuming* further results and mark the unfinished files as the regex-heuristic
fallback (`StructuralPassResult.fallback`, today's notice string). The budget
becomes **wall-clock across parallel workers**, so 50 files across 4 workers fit
the same 200ms far more often than serially — i.e. the budget more often
*completes* instead of truncating, which is a precision win, not just a latency
one. Per-file parse time is unchanged; only the wall-clock to chew through N files
shrinks ~Nx-bounded-by-pool-width.

**Determinism (hard requirement — there is a 5-run identical-output test,
`code-search.test.ts:428`).** Results must be identical regardless of which worker
finishes first. Enforce by making the merge **order-independent**:

- The structural result is a `Set<number>` of confirmed hit indices
  (`confirmedHitIndexes`). Set membership is independent of insertion order — a
  worker confirming hit 7 before or after another worker confirms hit 12 yields
  the identical set. The downstream `sortByScore` already sorts by
  `(score, file, line)` deterministically (`code-search.ts:1442`). ✓
- The outline result is keyed by `file` and each file's entries are sorted by line
  (`collectDefinitions` + the `outline.sort` at `tree-sitter-grammars.ts:526`),
  then the outlines array is built in **result order** (the `distinct` loop,
  `code-search.ts:1782-1788`), not worker-completion order. So assemble the
  `outlines` array by iterating `distinct` and pulling each file's
  (now-precomputed) entries from a `Map<file, entries>` — never by pushing in the
  order jobs return. ✓
- **Budget non-determinism is the one trap.** If "which files finished before the
  200ms timer" varies run-to-run, the confirmed set varies, and ranking flips.
  Mitigations: (a) the 5-run determinism test uses a tiny fixture that completes
  far inside budget, so it is stable; (b) for real workloads, budget truncation
  already makes the *serial* implementation non-deterministic under load (a slow
  disk can change how many files parse in 200ms today) — the pool does not
  introduce a *new* class of non-determinism, it changes the threshold. Document
  this honestly: exact-budget-boundary determinism is best-effort in both the
  serial and pooled designs; the *test-fixture* determinism (small inputs, well
  inside budget) is preserved because all files complete regardless of scheduling.
  Do **not** let a late worker whose result arrives after the timer mutate the
  confirmed set — drop post-timer results so the cutoff is "results consumed
  before the timer," applied identically each run for in-budget inputs.

**Abort propagation.** `searchCode` already threads `ac.signal` everywhere. On
abort: stop dispatching new jobs, post a `{type:"cancel"}` to busy workers (the
worker checks a flag between files / before the walk and posts back an empty
result), and resolve the pass with whatever was confirmed pre-abort. Because the
merge is a Set, a partial confirmed set is still valid (it just confirms fewer
hits — same semantics as a budget truncation). Never `await` a hung worker on
abort; `worker.terminate()` is the hard stop and the worker is replaced lazily.

**Error isolation (a worker crash must never kill the search).** Each job is
wrapped: a worker `error` event or an `{ok:false}` reply marks that file a
**miss** — the file's hits keep the regex `symbol_context` heuristic (structural)
and the file's outline falls back to an empty/`outlineFile` outline. A worker that
crashes (uncaught WASM trap, OOM) is removed from the pool and respawned lazily on
the next dispatch; the in-flight job it was running is retried on another worker
or degraded to a miss after one retry. The whole pass is additionally wrapped so
that a total pool failure (all workers dead, spawn failure) degrades to **exactly
today's regex-heuristic + own-Parser `outlineFile` path** — i.e. Lever 2 can fail
completely and `code_search` still returns correct (just less precisely ranked)
results. This mirrors the existing `getGrammarBundle` "init failed → structural
ranking disabled, not an error" posture (`tree-sitter-grammars.ts:266-271`).

---

## Honest cost / benefit

**Parses remaining per default call after Lever 1:**

| Path | Tree-sitter parses (after Lever 1) |
|---|---|
| `ranked`, `summary:true` (the default) | ≤50 structural parses; **0** redundant outline parses (outline reuses cached trees); a small number of outline misses fall back to `outlineFile` only when result files fall outside the structural top-N |
| `ranked`, `summary:false` | ≤50 structural parses, 0 outline |
| `literal` / `regex`, `summary:true` | 0 structural; ≤10 outline parses (no `_treeCache` to reuse — no structural pass ran) |

So after Lever 1 the dominant remaining tree-sitter cost is **≤50 parses, already
hard-capped at 200ms wall-clock total**, where a typical file parses in well under
50ms. The pool would be parallelizing **~200ms of budget-capped work behind
~tens-of-ms of `postMessage` coordination + worker-side re-read**.

**Is Lever 2 worth it?** **Recommendation: build Lever 1 always; treat Lever 2 as
conditional, gated on profiling — and the most likely outcome is "not worth it
for the default path."** Reasoning:

- The structural pass is **already self-bounded to 200ms** and only runs in
  `ranked` mode. Lever 2 cannot make a search faster than ~200ms-of-structural in
  the worst case; it makes the budget *more often complete* (precision win) and
  moves parse CPU off the main event loop (helps concurrent `code` calls under the
  cap-of-8, since today they serialize on the one heap). Those are real but
  second-order benefits.
- The complexity is substantial: a warm pool with lazy spawn, grammar
  duplication across N heaps (memory), `postMessage` job protocol, abort
  threading across the boundary, crash-respawn, never-orphan shutdown, and a
  *new* `windows-latest` CI surface to keep green. That is a large, ongoing
  maintenance cost against a latency win the 200ms budget already caps.
- The one scenario that *does* justify Lever 2: **many concurrent `code` calls**
  (up to 8 under the cap) all wanting structural ranking, where today they fully
  serialize on the single WASM heap and block the event loop for each other. A
  pool turns that into parallel parse CPU. If real traffic shows `code` is
  frequently called concurrently AND parse CPU is the measured bottleneck (not rg,
  not BM25F, not I/O), the pool pays off. Until that is *measured*, it is
  speculative.

**Phased recommendation:**

1. **Phase 1 (do now, unconditional): Lever 1.** Export `outlineFromTree`, reuse
   `_treeCache` trees in the outline loop, fall back to `outlineFile` on miss.
   Pure win, no threads, no new failure surface, eliminates up to 10 redundant
   read+parses per default call. Preserve the determinism test and the mtime gate.
2. **Phase 2 (gate on profiling): Lever 2 warm pool.** Only after Phase 1 ships,
   instrument `code` parse-CPU vs total latency under representative concurrent
   load. Build the pool **only if** parse CPU is the measured dominant term under
   concurrency — and even then, scope it to the structural pass with coalesced
   confirm+outline jobs, order-independent Set/Map merges for determinism, lazy
   warm spawn, never-orphan terminate-on-exit, and a green Windows CI run. If the
   numbers don't justify it, the honest answer is: Lever 1 alone, optionally
   widening `STRUCTURAL_BUDGET_MS` (e.g. 200 → 300ms) to let more of the top-N
   confirm on slow disks — a one-constant change with none of the pool's
   machinery.

**Bottom line:** Lever 1 is a clear, safe, do-it-now win. Lever 2 is feasible on
both Bun and Node (verified), but its benefit is capped by the 200ms structural
budget and its real value is only the concurrent-`code` case — so it should be
built only against measured evidence, not on spec.
