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

Semantic-ready result rows carry a `score` field (ColBERT relevance, interpretable). Lexical rows omit it. With `summary` enabled (the default), both semantic and lexical responses include compact outlines for up to the first 10 distinct result files, limited to top-level declarations and class members; `summary:false` omits them.

## Freshness verdict (the staleness correctness guard)

colgrep owns the physical index dir (keyed by `xxh3(path|model)`) and runs
a non-blocking incremental update. That is **not** the same as "results
are correct right now": a query can run against an index that predates a
branch switch or a file deletion. The router keeps a per-workspace
metadata sidecar (`indices/.gh-router-meta/<hash>.json`) and computes a
freshness verdict on each query from `git rev-parse HEAD` +
`git status --porcelain`:

- **fresh** - `ready`, physical shard intervals are contiguous and non-overlapping,
  the recorded binary/ORT SHAs match the provisioned generation, HEAD matches
  the last index, and the tree is not newly dirty → serve semantic.
- **stale** - HEAD moved or the tree is dirty since indexing → honest
  `stale` notice, **no** possibly-deleted-content hits labeled `ready`.
- **corrupt** - numbered PLAID shard metadata is unreadable, malformed, gapped,
  overlapping, or belongs to an older binary/ORT generation → quarantine the
  project directory by atomic rename, remove it out of band, and start one
  bounded clean rebuild. A failed rename never falls back to in-place deletion.

A non-git workspace falls back to colgrep's own mtime-based incremental
signal, but still passes the physical-integrity and engine-generation gates.

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

**CPU share.** colgrep defaults its encoding parallelism to the machine's
FULL thread count, so a background index build saturates the box — the
opposite of what a background build should do during a long interactive
session (the proxy even holds a keep-awake assertion so those sessions run
unattended). Before each `init` the runner caps it at **25% of threads with
a floor of 2** (16 threads → 4 sessions; a 4-thread box → 2, not 1).

`--parallel` exists only on colgrep's `settings` subcommand — there is no
per-run flag and no env var — and it writes `parallel_sessions` into
`<COLGREP_DATA_DIR>/../config.json`, which for us is
`<APP_DIR>/colbert/config.json`. That is router-owned: after we write ours,
a plain `colgrep settings` with no `COLGREP_DATA_DIR` still reports `auto`,
so a user's own colgrep install keeps its own settings. Because the value
persists there, it also governs the reconcile a later `search` may run.
Applying it is best-effort — a failure means colgrep encodes at its default,
which is greedy but not incorrect, so it never blocks a build. Override the
share with `GH_ROUTER_COLBERT_PARALLEL` (a positive integer).

**Failure-class-aware self-heal.** A failed build records a `failureClass`
(`crashed` | `stuck` | `corrupt` | `error` | `launch`) and increments a `failedAttempts`
counter (reset to 0 on success). On a later query the runner re-kicks a
debounced background re-index when the attempt is under the per-class cap
(`stuck` and `corrupt` retry once, transient classes up to 3) AND a 5-min
backoff has elapsed; past the cap it returns an operator-actionable notice
instead of looping. The startup auto-kick (`provisionAndIndexColbert`) skips a
workspace that is already capped or `stuck`; an under-cap `corrupt` workspace
gets its bounded clean retry after restart, but a capped one stays
operator-actionable so a restart loop cannot re-burn a known-bad build.

**The cap resets when the inputs change.** `failedAttempts` is evidence about a
SPECIFIC set of inputs, not a permanent verdict on the workspace. A counter
that only ever counts up makes `failed` terminal for the life of the process —
which is exactly what happened in practice: a workspace sat at
`failedAttempts: 3` with a complete, healthy, queryable index on disk, and the
router refused to look at it again. So each failure also stamps `failedAt`
(the git HEAD, the working tree's dirty flag, the colgrep/ORT shas, and the
model revision in effect at the time), and `handleFailure` clears the streak
when any of those differ from the current state — a commit, a `checkout`, an
edit to a dirty tree, a colgrep or ONNX-runtime upgrade, or a model re-pin.

`failedAt` is deliberately separate from `lastIndexedHead`, which on the ready
path means "what we successfully indexed" and feeds the git-freshness
comparison; reusing it would entangle failure-reset with freshness. A legacy
entry written before `failedAt` existed has no baseline and therefore does NOT
reset — a missing baseline must not read as "everything changed".

Recovery always goes through a REAL rebuild under the unchanged cap and the
unchanged 5-min backoff, so completeness is established by colgrep exiting
successfully, never inferred from what happens to be on disk. A genuinely
broken workspace still caps out; it just re-earns the cap after each input
change instead of being condemned forever by one bad commit. With this,
`failed` is no longer a terminal dead-end within a session.

**Failures are visible to the human, not just the model.** Two channels, added
after a real outage went unnoticed for an unknown period — possibly weeks —
because the only signals were an MCP `notice` string the model reads and a
`consola.debug` that the file-log reporter drops:

- The init failure is logged at `warn`, so it survives `FileLogReporter`'s
  level filter and lands in `PATHS.ERROR_LOG_PATH`. Only the class, duration
  and attempt count are recorded — never raw colgrep stderr, which can embed
  source.
- `colbertDegradedWarning()` writes one line to stderr at `claude` / `codex` /
  `start` launch when the current workspace's index is in a terminal `failed`
  state, naming the class and pointing at that log. It is gated only on the
  `GH_ROUTER_DISABLE_SEMANTIC_SEARCH` opt-out — deliberately NOT on
  `colbertSearchEnabled()`, since missing artifacts or a failed smoke test are
  themselves degraded states worth reporting.

The capped MCP `notice` carries no env-var tuning advice: a spawned agent
cannot set env vars on the running proxy, so that guidance lives in the banner
and the log where an operator can act on it.

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
