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

## Lifecycle

colgrep is CLI-per-invocation (no daemon), so the lifecycle is process
tracking + cancellation + boot/exit sweep, not keep-alive:

- Each `search` child has a hard 30s timeout and a stdout byte cap; on
  expiry it is tree-killed (`taskkill /T /F` on Windows, POSIX
  process-group kill so colgrep's rayon workers die too).
- An in-memory PID ledger holds this run's live children; SIGINT /
  SIGTERM / exit tree-kills them.
- A boot-time sweep reclassifies any `building` metadata entry whose
  `buildPid` is dead to `failed` (it never kills a PID from a prior boot -
  a recycled PID could belong to an unrelated process).

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
