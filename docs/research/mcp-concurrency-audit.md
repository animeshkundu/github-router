# MCP tool concurrency / parallelizability audit

**Claim under test:** *"all the MCP tools we run are completely parallelizable — none waits for another instance of itself, nor for another tool, to complete."*

**Verdict (one line):** **FALSE.** Every MCP `tools/call` is hard-capped at a shared 8-wide fail-fast semaphore (the 9th in-flight call is *rejected*, not queued), and several tools add their own serialization on top. Almost every break is **intentional and necessary** (the global cap, the CDP per-tab input mutex, git's index lock, stand_in's sequential rounds, the single-shared tree-sitter WASM heap). The **one accidental break worth fixing** is that the browser `ensureBridgeReady()` pre-flight runs *inside* the held MCP slot instead of before acquiring it — contrary to the `predictedTooLong` invariant the same handler enforces for personas.

There is **no deadlock** in the current surface: every contention point is either fail-fast (returns `null`/"queue full" immediately) or a bounded same-resource wait that the holder always releases. The historically-dangerous nested-slot path (`peer_review` / `advisor` inside a worker) is **not in the active worker toolset** — see §3.

---

## 1. The serialization points (traced)

| # | Mechanism | File:line | Kind | Self-block? | Cross-block? |
|---|-----------|-----------|------|-------------|--------------|
| 1 | `MAX_INFLIGHT_TOOLS_CALL = 8` shared semaphore | `src/lib/mcp-inflight.ts:24,41-50` | **fail-fast** (returns `null` on cap, never queues) | yes, at N=8 | **yes — every MCP tool shares this counter** |
| 2 | tree-sitter single WASM heap (`Parser.init()` + grammar cache, synchronous `parser.parse`) | `src/lib/tree-sitter-grammars.ts:237-301`; `src/lib/code-search.ts:1141`, `outlineFile` parse at `tree-sitter-grammars.ts:514` | CPU-bound serialization on the JS event loop (no mutex) | partial | partial — `code` ⇄ `read summary` contend on parse CPU |
| 3 | Worker semaphore `MAX_INFLIGHT_WORKER_CALLS = 8` (separate counter) | `src/lib/worker-agent/semaphore.ts:27-67` | **fail-fast** | yes, at N=8 | no (workers-only) |
| 4 | Worker nested `codex_review` re-acquires an mcp-inflight slot | `src/lib/worker-agent/tools.ts:1132-1139` | **soft-fail** (returns a "skipped" content block, worker continues) | n/a | competes for cap #1 |
| 5 | `withTabInputLock(tabId)` — per-tab promise-chain mutex | `src/browser-ext/background.js:864,894-944` | **blocking wait** (2nd same-tab caller awaits the 1st) | yes, same tab only | only within humanlike-input subset, same tab |
| 6 | `navigator.locks` debugger-attach lock, per tab | `src/browser-ext/background.js:1663` | blocking wait (brief) | same-tab attach only | no |
| 7 | git `.git/index.lock` during `git worktree add` | `src/lib/worker-agent/worktree.ts:301-305` | blocking wait (git-internal, brief) | yes, same repo, `worktree add` window only | no |
| 8 | `ensureBridgeReady()` single-flight readiness probe | `src/lib/browser-mcp/install-check.ts:307,316-324` | **coalescing** (concurrent callers share one promise) | no (dedup, not block) | no |
| 9 | `_treeCache` LRU, `_rgResolution` memo, `_grammarBundle` memo | `code-search.ts:285,885`; `tree-sitter-grammars.ts:237` | module-global mutable state | safe under single-thread JS | none |
| 10 | `update-lock.ts` | `src/lib/update-lock.ts` | cross-process file lock | **CLI-launch only — NOT on the `tools/call` path** | none |

---

## 2. Per-tool verdict

`self-parallel` = can N instances run concurrently without one waiting on another instance of *itself*. `cross-parallel` = does it block *other* tools. Every row is `CAPPED-AT-8` for both because of semaphore #1; the column notes what *else* serializes beyond the cap.

| Tool | self-parallel | cross-parallel | extra serialization point | intentional? |
|------|---------------|----------------|---------------------------|--------------|
| **peers** `codex_critic` / `codex_reviewer` / `gemini_critic` / `gemini_reviewer` / `opus_critic` | CAPPED-AT-8 | CAPPED-AT-8 | none — stateless upstream fetch, no shared mutable state (`callPersona`→`dispatchModelCall`, `handler.ts:788-812,690-779`) | ✅ cap is the only bound; upstream 429 is the real backpressure |
| **search** `code` | CAPPED-AT-8 | CAPPED-AT-8 + tree-sitter CPU | structural pass + default-on `summary` outlines share the one WASM heap (`code-search.ts:1062,1141`; `tree-sitter-grammars.ts:514`); synchronous parse blocks the loop | ✅ acceptable backpressure (see §5) |
| **search** `web` | CAPPED-AT-8 | CAPPED-AT-8 | none — `searchWeb` is stateless, no module globals; signal-cancellable | ✅ |
| **search** `grep` | CAPPED-AT-8 | CAPPED-AT-8 | none — pure `rg` spawn, no tree-sitter (`search-fs-tools.ts:72`) | ✅ |
| **search** `read` (raw) | CAPPED-AT-8 | CAPPED-AT-8 | none — async `fs.readFile` (`search-fs-tools.ts:296`) | ✅ |
| **search** `read` (`summary:true`) | CAPPED-AT-8 | CAPPED-AT-8 + tree-sitter CPU | `outlineFile` parses on the shared WASM heap (`search-fs-tools.ts:284`) — contends with `code` summary | ✅ acceptable backpressure |
| **workers** `explore` / `review` | CAPPED-AT-8 (cap #1 at MCP boundary) **and** CAPPED-AT-8 (worker cap #3) | CAPPED-AT-8 | two independent 8-wide caps in series; no nested mcp-slot re-acquire (read-only toolset, `tools.ts:1386`) | ✅ |
| **workers** `implement` (in-place) | double-CAPPED-AT-8 | CAPPED-AT-8 | nested `codex_review` competes for a 2nd cap-#1 slot, **soft-fails** on saturation (`tools.ts:1132`); in-place edits race the user's own edits (documented) | ✅ |
| **workers** `implement` (`worktree:true`) | double-CAPPED-AT-8 | CAPPED-AT-8 | `git worktree add` serializes on `.git/index.lock` for its window (`worktree.ts:301`); `QUOTA_PER_REPO=20` hard cap (`worktree.ts:285`) | ✅ git-internal, brief |
| **decide** `stand_in` | CAPPED-AT-8 (**holds 1 slot for the whole 2-3 min run**) | CAPPED-AT-8 | rounds are **sequential by protocol** (R1 `Promise.all` → R2 `Promise.all`), 3 models parallel within a round (`stand-in.ts:170,222`); 6 internal `dispatchModelCall`s consume **1** slot total (no re-acquire) | ✅ protocol-required |
| **browser** `mouse`/`drag`/`type`/`keyboard`/`scroll`(at-pointer) | CAPPED-AT-8 + **per-tab wait** | CAPPED-AT-8 | `withTabInputLock(tabId)` — same-tab humanlike-input calls serialize; **different tabs run free** (`background.js:894`) | ✅ CDP mouse/keyboard state is global per attachment |
| **browser** all tools (`navigate`/`act`/`observe`/`read_page`/…) | CAPPED-AT-8 | CAPPED-AT-8 | `ensureBridgeReady()` awaited **inside** the held slot — see §4 / §6 | ⚠️ **accidental** |

---

## 3. Inflight-cap deadlock analysis (the most dangerous failure mode)

**Conclusion: no deadlock exists, and the historically-risky path is dead code.**

The dangerous shape would be: tool A holds slot 1 and *blocks awaiting* a nested call that needs slot 2, while all 8 slots are held by callers each blocked the same way → circular wait → deadlock. This cannot happen here, for three independent reasons:

1. **`acquireInFlightSlot()` is fail-fast, not blocking** (`mcp-inflight.ts:41-43`): on saturation it returns `null` synchronously. A caller that can't get a slot never *parks* on the semaphore — it gets an immediate "queue full" and unwinds. A fail-fast semaphore cannot form a hold-and-wait cycle.

2. **The nested-slot consumers that *throw* are not in the active worker toolset.** `peerReviewTool` and `advisorTool` (which `throw` on saturation) still exist in `tools.ts` but are referenced **only** from `__testExports` (`tools.ts:1406-1421`). `buildWorkerTools` returns:
   - explore/review → `read, glob, grep, code_search, web_search, fetch_url` (no nested mcp-slot tool), and
   - implement → the above + `edit, write, bash, codex_review`
   (`tools.ts:1374-1394`). So the *only* live nested cap-#1 consumer is `codex_review`.

3. **`codex_review` soft-fails** (`tools.ts:1132-1139`): on cap saturation it returns a structured "skipped, proceed without review" content block and the worker continues — it does **not** block the parent. The parent worker therefore always makes progress and always releases.

Worst realistic case: 8 simultaneous `implement` runs each hold one cap-#1 slot (acquired at the MCP boundary in `handleToolsCall`). Every nested `codex_review` they fire sees a saturated cap and skips review. Outcome: degraded review quality under extreme load, **not** a stall. The worker semaphore (#3) is a *separate* 8-wide counter, so 8 workers can be in flight even while the 8 cap-#1 slots are held by their own MCP-boundary acquisitions — the two caps are accounted independently and never cross-wait.

`stand_in` is the one tool that holds a single cap-#1 slot for a long time (2-3 minutes across two sequential rounds), but it makes its 6 internal `dispatchModelCall`s **without re-acquiring** (`stand-in.ts:282-336` calls `dispatchModelCall` directly, which never touches the semaphore). So a `stand_in` call is exactly 1 slot for its whole lifetime — it can starve *throughput* (1/8 of the pool parked for minutes) but cannot deadlock.

---

## 4. The accidental break: browser readiness inside the held slot

`handleToolsCall` acquires the cap-#1 slot at `handler.ts:1028`, then invokes the tool's handler at `handler.ts:1082`. For browser tools the handler is `dispatchBrowserTool` (`browser-mcp/index.ts:86`), which **awaits `ensureBridgeReady()` at `dispatch.ts:327` — already inside the held slot.**

This contradicts the load-bearing invariant the same file enforces for personas: the `predictedTooLong` / `predictedWindowOverflow` pre-flights fire *before* `acquireInFlightSlot()` precisely so a doomed/slow pre-flight never burns a slot (`handler.ts:1003-1010`, and the architectural note at `handler.ts:455-459`). The CLAUDE.md browser section even claims browser tools run their pre-flight "BEFORE acquiring an inflight slot (same load-bearing invariant as `predictedTooLong`)" — but the dispatch path does not implement that. The pre-flight is inside the slot.

**Severity: Important (not Critical).** Two mitigations bound the blast radius:
- `_inFlightReady` single-flight (`install-check.ts:316-324`) means concurrent browser calls share **one** readiness probe rather than each running their own — so the worst case is N slots held during *one* probe, not N probes.
- On the happy path (bridge already running) `ensureBridgeReady()` is a fast discovery-file read + `/health` round-trip, so the slot is held only briefly.

The bad case is first-call cold start: `installNativeHostForAll` writes NMH manifests and spawns `reg.exe` on Windows (`install-check.ts:349`), which can take a noticeable beat. If 8 browser calls arrive before the bridge is up, all 8 slots are held awaiting that single shared probe — and for that window, **every other MCP tool (peers, search, workers, decide) is locked out of the pool.** That cross-tool block is unnecessary.

**Fix:** move the browser readiness pre-flight ahead of `acquireInFlightSlot()`, mirroring `jsonPathPreflightCap`. Concretely, add a browser branch in `handleMcpPost` (or a `preflight?` hook on `NonPersonaMcpTool`) that calls `ensureBridgeReady()` and, on `install_required`, returns the structured `install_required` envelope **before** `handleRpc → handleToolsCall` increments the counter. The single-flight memo already makes this cheap and idempotent, so the only change is *where* the await happens relative to the slot. (Same invariant, same file, already proven safe for the persona pre-flights.)

---

## 5. The web-tree-sitter serialization reality

There is exactly **one** `Parser.init()` and **one** grammar cache for the whole process (`tree-sitter-grammars.ts:22-23,237-301`), pre-warmed at module import (`tree-sitter-grammars.ts:299`). Every structural consumer — the `code` ranking pass, the default-on `code` `summary` outlines, and `read summary` — awaits the same `getGrammarBundle().ready` promise and then parses with `parser.parse(source)`, which is **synchronous** on the single Emscripten heap.

Implications, precisely:
- **No async mutex, no lock — but `parser.parse` is CPU-bound and synchronous**, so while one call is parsing a file, the JS event loop is blocked and no other `code`/`read summary` call can make progress on *its* parse. Two concurrent `code` calls do not corrupt each other (single-threaded JS), but they effectively **serialize on parse CPU**: their parse sections interleave only at `await` boundaries (between files), never mid-parse.
- The cost is bounded by design: the structural pass is wrapped in a **200ms wall-clock budget** checked *between files* (`code-search.ts:140,1088-1094`), the structural slice is the top 50 (or 10) hits (`code-search.ts:141-142`), files over 1 MiB are skipped (`tree-sitter-grammars.ts:42`), and parsed trees are LRU-cached by `(path, mtime)` (`code-search.ts:885,887-926`). A typical source file parses in well under 50ms. So the worst-case added latency from heap contention is "your parse waits behind another call's ≤200ms structural window," not unbounded.
- `_treeCache` (`code-search.ts:885`) is mutated by `cacheGet`/`cachePut` across interleaved async calls. **This is safe**: all mutation happens synchronously between `await`s (the parse and the Map writes are not split by an `await`), and JS is single-threaded, so there is no torn read/write and no lost-update. No corruption finding.

**Is a parser pool / worker_threads warranted?** No. The contention is real but small and self-bounded (≤200ms structural budget, sub-50ms typical parse, cap-of-8 already limits how many calls can pile up). Moving tree-sitter into `worker_threads` would add WASM-per-thread memory cost, message-passing serialization of source/results, and grammar-load duplication for a latency win that the 200ms budget already caps. This is **acceptable backpressure**, not a bottleneck to fix.

---

## 6. Ranked list of ACCIDENTAL bottlenecks to fix

1. **(Important) Browser readiness pre-flight runs inside the held MCP slot.** `dispatch.ts:327` awaits `ensureBridgeReady()` after `handler.ts:1028` already took the slot, violating the `predictedTooLong` "pre-flight before acquire" invariant. Fix in §4. This is the only break that is unnecessary *and* causes cross-tool blocking (cold-start NMH install can park up to 8 slots, locking out peers/search/workers/decide).

That is the complete list. Everything else that serializes is intentional and necessary:
- the 8-wide cap (deliberate backpressure / runaway-client bound),
- the CDP per-tab input mutex (global-per-attachment mouse state — corruption otherwise),
- git's `.git/index.lock` on `worktree add` (git-internal correctness),
- `stand_in`'s sequential rounds (the blind-R1→informed-R2 anti-sycophancy protocol *requires* ordering),
- the single tree-sitter heap (acceptable, self-bounded — §5),
- `update-lock.ts` (CLI-launch only, not on the tool-call path).

---

## 7. Final verdict

The "completely parallelizable, none waits" claim is **false as stated**. The accurate statement is:

> All MCP tools run under a shared 8-wide fail-fast concurrency cap; beyond that cap, peers/web/grep/read-raw are fully parallel, while `code`/`read summary` share one tree-sitter CPU heap, same-tab browser input serializes on a per-tab CDP mutex, `worktree:true` implement briefly serializes on git's index lock, and `stand_in` runs two sequential rounds holding one slot. Every one of these waits is intentional and necessary **except** the browser readiness pre-flight, which is held inside the MCP slot instead of run before acquiring it — the single accidental, fixable break.

No deadlock risk exists in the current surface: the cap is fail-fast, the only live nested-slot consumer (`codex_review`) soft-fails, and the throw-on-saturation nested tools (`peer_review`/`advisor`) are not registered in the active worker toolset.
