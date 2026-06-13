# Semantic code search (ColBERT sidecar)

`github-router` ships an opt-OUT semantic code search capability, backed by a router-managed [`colgrep`](https://github.com/lightonai/next-plaid) sidecar (ColBERT / PLAID late-interaction). It is folded into the unified `mcp__search__code` tool as the default `mode: "semantic"`.

Design + adversarial-review record:
[`research/colbert-sidecar-design.md`](research/colbert-sidecar-design.md).

## On by default, availability-gated

Semantic search is **on by default**. At `start` / `claude` / `codex`
launch the proxy, fire-and-forget and non-blocking:

1. **Provisions** three SHA256-pinned artifacts into the router data dir
   (`~/.local/share/github-router/colbert/`): the `colgrep` binary, the
   ONNX Runtime CPU dylib (`ORT_DYLIB_PATH`), and the ColBERT INT8 model
   (`--model <local-dir>`). Pinning closes the two supply-chain holes
   colgrep leaves open - it does **no** checksum on its own ORT / HF-model
   downloads.
2. Runs a **post-provision smoke test** (one colgrep invocation with the
   exact isolating env) and only marks the capability available if the
   ORT dylib actually loaded. An invalid `ORT_DYLIB_PATH` makes colgrep
   silently fall through to its own unverified download - the smoke test
   is the guard against that.
3. **Background-indexes** the launch cwd if it is a git repo.

The capability gate `semanticSearchEnabled()` is **availability-based**
(exactly like `browserToolsEnabled()`): the tool is listed/callable only
when the artifacts are present on disk **and** the smoke test passed
**and** the operator has not opted out. On CI, sandboxes, or any host
where provisioning hasn't completed, the tool is simply absent - the
`tools/list` surface stays `{code, web}`.

**Opt out:** `GH_ROUTER_DISABLE_SEMANTIC_SEARCH=1`.

## Contract split: Strict runner, fallback tool

The underlying ColBERT runner (`src/lib/colbert/runner.ts`) **never runs another search engine.** It returns an honest `status` (ready, building, stale, unavailable, failed) and stops.

However, the unified `code` MCP tool (`src/lib/unified-code-search.ts`) provides a **transparent fallback**. The tool exposes a `mode` argument: `semantic` (default) | `lexical` | `exact` | `regex` | `ast`. 

When called in the default `semantic` mode, the tool attempts ColBERT. If the index is not ready, building, stale, or failed, it **transparently falls back to lexical BM25F**. Forced lexical modes (`lexical`, `exact`, `regex`, `ast`) never touch colgrep.

The tool response carries a 3-valued top-level `source` field to tell the model what engine actually ran:
- `"semantic"` (colgrep ran successfully)
- `"lexical"` (caller forced a lexical mode)
- `"lexical-fallback"` (a semantic/default query degraded to lexical because the index wasn't ready)

Semantic-ready result rows carry a `score` field (ColBERT relevance, interpretable). Lexical rows omit it.

## Freshness verdict (the staleness correctness guard)

colgrep owns the physical index dir (keyed by `xxh3(path|model)`) and runs
a non-blocking incremental update. That is **not** the same as "results
are correct right now": a query can run against an index that predates a
branch switch or a file deletion. The router keeps a per-workspace
metadata sidecar (`indices/.gh-router-meta/<hash>.json`) and computes a
freshness verdict on each query from `git rev-parse HEAD` +
`git status --porcelain`:

- **fresh** - `ready` AND HEAD matches the last index AND the tree is not
  newly dirty → serve semantic.
- **stale** - HEAD moved or the tree is dirty since indexing → honest
  `stale` notice, **no** possibly-deleted-content hits labeled `ready`.

A non-git workspace falls back to colgrep's own mtime-based incremental
signal.

## Definitive index state (not a blunt timeout)

A fixed total build timeout can't distinguish "slow but progressing" (a
legitimately huge repo whose CPU ColBERT encode takes hours) from "hung."
The state is instead derived from real signals, so the right thing happens
in each case:

| State | Signal |
|---|---|
| **completed** | a completed index is on disk (`completedIndexOnDisk`). |
| **running** | the recorded `buildPid` is alive (`isPidAlive`), or this proxy has an init in flight for the workspace. |
| **crashed** | `buildPid` dead + no index. Caught **per-query** by the freshness verdict (`verdict:"crashed"`), not only at boot, so a mid-session proxy-kill / OOM build self-heals on the next query. |
| **stuck** | `buildPid` alive but making no progress — see the watchdog below. |

**Stall watchdog** (`runManagedExeCapture` `inactivityTimeoutMs` +
`onInactivityCheck`): colgrep is SILENT on a non-TTY pipe during the encode,
so output can't signal progress — but it writes index shards incrementally,
so the watchdog re-arms while the index dir keeps **growing on disk**
(`indexDirSignature`) and kills (`stalled`) only when the dir is frozen for
`GH_ROUTER_COLBERT_INIT_STALL_MS` (default 5 min). A progressing 50GB build
runs as long as it needs; a hung one dies fast. A generous absolute
`GH_ROUTER_COLBERT_INIT_TIMEOUT_MS` (default 6h) is only a runaway backstop.

**Failure-class-aware self-heal.** A failed build records a `failureClass`
(`crashed` | `stuck` | `error` | `launch`) and increments a `failedAttempts`
counter (reset to 0 on success). On a later query the runner re-kicks a
debounced background re-index when the attempt is under the per-class cap
(`stuck` retries once, transient classes up to 3) AND a 5-min backoff has
elapsed; past the cap it returns an operator-actionable notice instead of
looping. The startup auto-kick (`provisionAndIndexColbert`) skips a workspace
that is already capped or `stuck`, so a restart loop can't re-burn a
known-bad build. `failed` is no longer a terminal dead-end within a session.

## Model guidance during the unavailable window

When semantic degrades, the `code` tool's `lexical-fallback` notice is
**instructive**: it tells the model that the results are literal keyword
matches (sparse for a natural-language phrase) and that it can either retry
`mode:"semantic"` shortly (the index is self-healing in the background) or
re-query with specific symbol/keyword terms. The lexical backend
(`code-search.ts`) is deliberately NOT tokenized for NL phrases — the model
is steered to use the right lever rather than fed noisy OR-matches.

## Lifecycle

colgrep is CLI-per-invocation (no daemon), so the lifecycle is process
tracking + cancellation + boot/exit sweep, not keep-alive:

- A `search` NEVER kills colgrep mid-write. colgrep auto-indexes /
  reconciles during a search when its index is behind (it has no read-only
  flag), and killing that mid-write **orphans index docs** (a DB↔index desync
  that every later search then re-triggers — the original corruption bug). So
  a search runs colgrep under the build-grade watchdog (only a truly hung
  child — no output AND no index-dir growth for `INIT_STALL_MS` — is reaped;
  `INIT_TIMEOUT_MS` is a pure runaway backstop), and the byte cap TRUNCATES
  rather than kills (a huge result must not tree-kill a non-atomic colgrep).
  The CALLER never waits that long: if the search hasn't returned results
  within `GH_ROUTER_COLBERT_SEARCH_RESPOND_MS` (default 20s) it **detaches** —
  returns a `building` fallback now and lets the colgrep child finish the
  index in the background (tracked, never killed mid-write). The next query is
  then fast. A per-workspace lock serializes searches (held from spawn until
  the colgrep child exits) so two concurrent searches can't both reconcile as
  unsynchronized writers; a SEQUENTIAL search pattern never contends, only a
  simultaneous batch on the same workspace (where the losers get an immediate
  lexical fallback + can retry). A warm search is sub-second → `semantic`.
- An in-memory PID ledger holds this run's live children; SIGINT /
  SIGTERM / exit tree-kills them.
- A boot-time sweep reclassifies any `building` metadata entry whose
  `buildPid` is dead to `failed` (stamping `failureClass:"crashed"` so the
  self-heal treats it as transient); it never kills a PID from a prior boot -
  a recycled PID could belong to an unrelated process.

## When semantic beats lexical (drives the tool description)

| Query | Prefer |
|---|---|
| "where is `verifyJwt` defined", "callers of `Foo`" | `mode: "lexical"` |
| "auth middleware", "retry/backoff around the upstream fetch" | `mode: "semantic"` (default) |
| "async fns ranked by error handling" (regex-narrow then rank) | `mode: "semantic"` `pattern` pre-filter |

## Storage

```
~/.local/share/github-router/colbert/
  bin/colgrep[.exe]
  models/LateOn-Code-edge/<rev>/        # 5 INT8 model files
  onnxruntime/1.23.0/cpu/<libname>      # ORT_DYLIB_PATH
  indices/                              # COLGREP_DATA_DIR (never in the repo)
    <project>-<hash>/                   # colgrep-owned PLAID index
    .gh-router-meta/<hash>.json         # router-owned freshness sidecar
  .smoke-ok                             # written once the smoke test passes
```

Re-pin the SHA256 digests with `bun run scripts/gen-colbert-manifest.ts`.
