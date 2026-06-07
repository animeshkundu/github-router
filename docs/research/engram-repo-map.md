# Engram — load-bearing repo map

Read-only research map of the external repo `github.com/NickCirv/engram` (npm package **`engramx`**). Produced for a possible github-router vendor/carve effort. This is navigation + load-bearing analysis, not a spec.

## 1. Header

**Purpose.** Engram is a local-first "context spine" for AI coding agents. `engram init` indexes a repo into a SQLite knowledge graph (`<project>/.engram/graph.db`); then a Claude Code (or Cursor/etc.) PreToolUse hook (`engram intercept`) sits at the agent's tool boundary and replaces full-file `Read`s with a ~300-token structural graph summary, answers `Grep` symbol lookups from a resolved `calls` reference graph, and closes the `cat`-via-`Bash` loophole. It also mines **bi-temporal "mistakes"** from git revert/bug-fix history and session transcripts, surfacing them as ⚠️ landmines before the agent re-makes a fixed mistake. Pure JS, zero native deps (sql.js + web-tree-sitter WASM), zero cloud, zero LLM cost. Apache-2.0.

**Pin.**
- Clone path (left in place): **`/tmp/engram-map`**
- HEAD: **`4c344cce849eacf2395a28ef21bfacbda2195f3b`** (branch `main`)
- `package.json` version: **`4.3.2`** (name `engramx`)
- Cross-check vs prior known state: HEAD and version **unchanged** (still `4c344cce…` / `4.3.2`).

**LOC table.** `tokei` would not install on this host (no aarch64-apple-darwin release asset for the tracked versions; the x86_64 binary needs Rosetta, which is absent; no `cargo` to build from source). Table below is from **`scc` v3.7.0 as a tokei fallback** — same language/files/code/comment columns. Numbers are the whole repo minus `node_modules`/`dist`/`.git`.

| Language | Files | Lines | Code | Comments | Blanks |
|---|---:|---:|---:|---:|---:|
| TypeScript | 197 | 42,971 | 32,183 | 6,793 | 3,995 |
| Markdown | 66 | 7,872 | 5,976 | 0 | 1,896 |
| HTML | 7 | 7,341 | 6,497 | 125 | 719 |
| JSON | 17 | 528 | 528 | 0 | 0 |
| YAML | 11 | 373 | 305 | 9 | 59 |
| JavaScript | 5 | 402 | 247 | 124 | 31 |
| Shell / BASH | 4 | 317 | 222 | 67 | 28 |
| Other (License, CSV, Python, SVG, .d.ts) | 6 | 584 | 481 | 18 | 85 |
| **Total** | **313** | **60,388** | **46,439** | **7,136** | **6,813** |

The product spine is the **`src/` TypeScript only**: **102 files, 16,637 code lines** (`scc src`). The single largest file is `src/cli.ts` at 2,060 code lines (commander wiring for ~50 commands).

## 2. Annotated directory tree (top 2–3 levels)

```
engram/
├── src/                         # the product (102 .ts, ~16.6k LOC)
│   ├── core.ts          🔴      # main API: init/query/path/getFileContext/mistakes/learn/benchmark — CLI + MCP both call this
│   ├── cli.ts           ⚪      # commander wiring for ~50 subcommands (2k LOC); thin shells over core/* + intercept
│   ├── serve.ts         🟡      # MCP stdio server (bin: engram-serve) — 6 tools over core.ts
│   ├── index.ts         ⚪      # public npm API surface (re-exports)
│   ├── hooks.ts / autogen.ts / watcher.ts / dashboard.ts / core.ts
│   ├── graph/           🔴      # the knowledge graph (schema, store, query, traversal, pagerank, render/path utils)
│   ├── miners/          🔴      # graph builders: ast (regex defs), reference (tree-sitter calls), git*, session, skills
│   ├── providers/       🟡      # pluggable context sources + grammar-loader (web-tree-sitter) + resolver + lsp
│   ├── intercept/       🔴      # the hook layer: dispatch + handlers/{read,grep,bash,...} + safety + context + formatter
│   │   └── handlers/    🔴      # one file per PreToolUse/lifecycle event (Read/Grep/Bash are the value)
│   ├── db/migrate.ts    🟡      # PRAGMA-less schema versioning (CURRENT_SCHEMA_VERSION=9), additive migrations + backup
│   ├── server/          ⚪      # local HTTP REST + SSE + dashboard UI (token-authed, 127.0.0.1)
│   ├── generators/      ⚪      # gen-aider / cursor-mdc / windsurf-rules (export graph to IDE rule files)
│   ├── ccs/             ⚪      # Common Context Spec import/export
│   ├── mesh/            ⚪      # multi-machine mistake sharing (ed25519, JCS, append-only audit) — peripheral, self-contained
│   ├── cost/            ⚪      # hook-log token-savings telemetry/digest/formatter
│   ├── tuner/           ⚪      # auto-tune thresholds from hook-stats
│   ├── doctor/          ⚪      # `engram doctor` health report
│   ├── intelligence/    🟡      # cache.ts (query/pattern cache), hook-log.ts (JSONL telemetry), token-tracker.ts
│   ├── setup/           ⚪      # interactive install wizard + IDE detect
│   ├── update/          ⚪      # self-update check/install/notify
│   ├── cli/ commands/   ⚪      # format-mistake.ts, measure.ts
│   └── types/sql.js.d.ts
├── adapters/{continue,zed}/     # per-IDE adapter packages (separate npm)
├── extensions/vscode/           # VS Code / OpenVSX extension
├── plugins/anthropic-marketplace/engram/  # Claude Code plugin (SKILL.md set)
├── bench/                       # real-world.ts (89% claim), recall-coverage.ts (ADR-0009), runner/stress
├── scripts/                     # bundle-grammars.mjs, postinstall/preuninstall, release.sh, mcp-engram
├── docs/{adr,specs,integrations,plugins,demos}/  # 11 ADRs, ECP spec, per-IDE guides
├── tests/                       # vitest (~1149 tests per README badge)
├── CONTEXT.md                   # domain glossary (canonical vocabulary — read first)
├── CLAUDE.md / AGENTS.md        # dual-emitted agent context (engram dogfoods itself)
└── package.json                 # name=engramx, bins: engram, engramx, engram-serve
```

## 3. Subsystem map + data flow

### 3.1 `core.ts` — the orchestration hub 🔴
**File:** `src/core.ts` (523 code lines). The single API surface both the CLI and the MCP server call. Owns the `init` lockfile, the build pipeline ordering, and the read-side `getFileContext` confidence math.

Key exports (verbatim signatures):
- `init(projectRoot: string, options?: InitOptions): Promise<InitResult>` — the build pipeline (see flow 3a).
- `getFileContext(projectRoot, absFilePath): Promise<FileContextResult>` — the Read hook's bridge. **Never throws** (any error → `found:false`). Computes `confidence = min(codeNodeCount/3, 1) * avgExtractionConfidence` (`FILE_CONTEXT_COVERAGE_CEILING = 3`).
- `query / path / godNodes / stats / callers / callees / impact` — thin store wrappers (open → call graph fn → close in `finally`).
- `mistakes(projectRoot, {limit,sinceDays,sourceFile,minConfidence})` — filters `kind==="mistake"` nodes.
- `learn(projectRoot, text, sourceLabel)` — promotes mined mistakes to `confidenceScore ≥ 0.85`.
- `computeKeywordIDF(...)` — TF-IDF filter for UserPromptSubmit pre-query (drops keywords in >15% of node labels).
- `benchmark(...)` / `packetRatioPhrase(ratio)` — honest reduction reporting.

**Depends on:** `graph/store`, `graph/query`, `graph/traversal`, `graph/path-utils`, and all of `miners/*`. **Depended on by:** `cli.ts`, `serve.ts`, `intercept/handlers/{read,grep}`, `server/http`, benches.

### 3.2 Graph layer (`src/graph/*`) 🔴
| File | Code | Role | Key exports |
|---|---:|---|---|
| `schema.ts` | 27 | **Data contract.** Pure types, zero imports. | `GraphNode`, `GraphEdge`, `NodeKind` (13 kinds incl. `mistake`/`concept`), `EdgeRelation` (13: `calls`,`imports`,`contains`,`extends`,`implements`,`method_of`,`tested_by`,`similar_to`,`triggered_by`,…), `Confidence` (`EXTRACTED`/`INFERRED`/`AMBIGUOUS`), `GraphStats`. Carries v3 (`validUntil`,`invalidatedByCommit`) + v4 (`thenBelieved`,`foundFalseAt`,`truthNow`,`appliesTo`) bi-temporal fields, all optional. |
| `store.ts` | 544 | **sql.js persistence.** `class GraphStore`. Owns nodes/edges/stats/provider_cache tables + 8 indexes. | `GraphStore.open(dbPath)` (async, loads buffer via sql.js), `bulkUpsert`, `replaceEdgesByRelation('calls', edges)` (atomic DELETE+INSERT in one txn — the load-bearing rebuild primitive), `getGodNodes`, `getNodesByFile`, `getEdgesForNodes` (chunked at 400 to stay under SQLITE 999-var limit), `getCachedContext`/`warmCache`/`pruneStaleCache`, `close()`→`save()` (whole-DB `db.export()` → `writeFileSync`). |
| `traversal.ts` | (pure) | **callers/callees/impact** over the `calls` graph. Pure fns on `readonly` arrays, imports only `schema`. | `findCallers(nodes,edges,name): string[]`, `findCallees(...): {name,file}[]`, `findImpact(...): string[]` (backward BFS over file→file deps). Edge model: caller **file** node ──calls──▶ callee **def** node. |
| `query.ts` | 431 | **Semantic query + the structural-summary renderer.** | `queryGraph(store,question,opts)` (BFS/DFS, mistake boost ×2.5, keyword downweight ×0.5, PageRank-ranked render), `shortestPath`, **`renderFileStructure(store, relPath, tokenBudget=600): FileStructureResult`** — the function the Read hook's summary is built from. `MAX_MISTAKE_LABEL_CHARS=500`. |
| `pagerank.ts` | (pure) | **Personalized weighted PageRank.** Power iteration, deterministic, no Date/random. | `pageRank(nodeIds, edges, {damping=0.85, iterations=20, personalization})`. Only edges with both endpoints present participate; dangling mass redistributed via teleport. The ranking signal that differentiates Engram from FTS5-only competitors. |
| `path-utils.ts` | ~5 | `toPosixPath(p)` — backslash→slash, single pure export, zero imports. Single source of truth for portable `sourceFile` storage. |
| `render-utils.ts` | ~50 | `sliceGraphemeSafe` / `truncateGraphemeSafe` (surrogate-safe cuts so truncation never corrupts JSON), `formatThousands`. |
| `index.ts` | barrel | re-exports `GraphStore` + schema types. |

### 3.3 Miners (`src/miners/*`) 🔴 (build the graph)
Run order is fixed in `core.ts::init`. All return `{nodes, edges}` (or richer). All are `execFileSync('git', …)`-based or regex/tree-sitter — none call an LLM.

| File | Export | Method | Emits | Real caps |
|---|---|---|---|---|
| `ast-miner.ts` | `extractDirectory(root, …)`, `extractFile(path, root)`, `SUPPORTED_EXTENSIONS` | **Regex** line-by-line (NOT tree-sitter, despite the file's header comment). `LANG_CONFIGS` for ts/py/go/rust/java/ruby/php. | `file`/`class`/`function`/`interface`/`type`/`import` nodes + `contains`/`imports` edges. `confidenceScore: 0.85` ("reserve 1.0 for tree-sitter"). Functions labelled `foo()`. **No `calls` edges.** | mtime-keyed incremental skip; per-file id capped 120 chars |
| `reference-miner.ts` | `extractFileReferences(path, src)`, `resolveCallEdges(nodes, fileRefs, {maxPerFile})`, `buildReferenceEdges(root, nodes)`, **`buildReferenceEdgesCached(root, nodes, prevCache)`** | **tree-sitter** (web-tree-sitter via `grammar-loader`). Two-step: extract callee names → resolve name→def-node-in-another-file. | `calls` edges only (`INFERRED`, `confidenceScore 0.7`, `metadata.provenance:"heuristic"`). | `MAX_REF_FILE_BYTES = 1_000_000` (skip minified); `MAX_AMBIGUOUS_DEFS = 10` (drop names resolving to >10 defs); `maxPerFile = 60`; cross-file only; `tree.delete()` to avoid WASM heap leak. Cached form keyed on mtime — warm reindex re-parses 0 files. |
| `git-miner.ts` | `mineGitHistory(root)` | `git log` churn/co-change | file `metadata.churn_rate`, co-change edges | maxCommits bound |
| `git-revert-miner.ts` | `mineGitReverts(root)` | parses `Revert "..."` + `This reverts commit <sha>` | **bi-temporal `mistake` nodes** (thenBelieved/foundFalseAt/truthNow/appliesTo). Idempotent stable IDs (revertSha+origSha). | default 200 commits; one `git show` per revert pair; never throws |
| `git-bugfix-miner.ts` | `looksLikeBugFix(subject,body)`, `mineBugFixCommits(root)` | fix/bug commit heuristic | lower-confidence `mistake` nodes (browse-only, score 0.6) | bounded commit scan |
| `session-miner.ts` | `mineSessionHistory(root)`, `learnFromSession(text, label)` | scans Claude session transcripts for corrections | `mistake` nodes (`edges: []` by construction) | — |
| `skills-miner.ts` | `mineSkills(skillsDir): SkillMineResult` | parses `~/.claude/skills/*/SKILL.md` | `concept` nodes (`metadata.subkind` `"skill"`/`"keyword"`) + `triggered_by`/`similar_to` edges | keyword nodes are render-hidden (see query.ts) |

### 3.4 Providers (`src/providers/*`) 🟡 (enrich the Read packet)
`ContextProvider` contract (`types.ts`): `{name, label, tier:1|2, tokenBudget, timeoutMs, resolve(file,ctx): Promise<ProviderResult|null>, warmup?, isAvailable()}` — **MUST NOT throw** (return null). Tier 1 = graph-local; Tier 2 = external, cached in `provider_cache`. `PROVIDER_PRIORITY` order: `engram:ast`, `engram:structure`, `engram:mistakes`, `anthropic:memory`, `mempalace`, `context7`, `engram:git`, `obsidian`, `engram:lsp`. `CachedContext` is the SQLite cache row shape (**couples `store.ts` → `providers/types.ts`**).

- `resolver.ts` (357) — **`resolveRichPacket(filePath, context, enabledProviders?)`** (priority + mistake-boost + per-provider budget), `resolveRichPacketStreaming` (async generator, one SSE frame/provider, `Last-Event-ID` resumable — used by `server/http.ts /context/stream`), `warmAllProviders`, `enforcePerProviderBudget`, `boostByMistakes`. Called by `intercept/handlers/read.ts` with a **1500ms timeout** (`withRichTimeout`).
- `grammar-loader.ts` 🔴-adjacent — `getSupportedLang(path)`, `getParser(lang): Promise<Parser|null>`. **web-tree-sitter 0.26 API**: `import {Parser, Language} from "web-tree-sitter"`, `await Parser.init()`, `Language.load(wasmPath)`, `new Parser().setLanguage(language)`. Resolves `.wasm` from `dist/grammars/` → `node_modules/<pkg>` → `require.resolve`. Returns null on any failure.
- `engram-structure.ts` / `engram-mistakes.ts` / `engram-git.ts` / `ast.ts` — Tier-1 graph-local providers.
- `anthropic-memory.ts` — reads Claude Code `MEMORY.md`, 1MB cap, <10ms.
- `mempalace.ts` / `context7.ts` / `obsidian.ts` — Tier-2 external (execFile/HTTP, cached).
- `lsp.ts` / `lsp-connection.ts` — optional LSP upgrade path (heuristic → resolved).
- `mcp-client.ts` / `mcp-config.ts` / `plugin-loader.ts` — generic MCP-server aggregator + the 10-line `mcpConfig` plugin contract (`createMcpProvider()` auto-wrap).

### 3.5 Interception / hooks (`src/intercept/*`) 🔴 (the product's value)
`engram intercept` (cli.ts:1047) reads stdin JSON (1MB cap, 3s watchdog, **never `process.exit` on the happy path** — Node 25/Windows sql.js WASM async-handle libuv assertion) → `dispatch.ts::dispatchHook(payload)` → handler → stdout JSON. Every handler wrapped in `runHandler` (`safety.ts`) so any throw becomes PASSTHROUGH (fail-open).

Handler registry (`dispatch.ts`): PreToolUse:Read→`handleRead`; Edit/Write→`handleEditOrWrite` (+`applyMistakeGuard`); Bash→`handleBash` (+`applyMistakeGuard`); Grep→`handleGrep`; plus lifecycle SessionStart/SubagentStart/UserPromptSubmit/PostToolUse/PreCompact/CwdChanged/Stop. Wire contract: `{permissionDecision:"deny", permissionDecisionReason:<summary>}` to substitute the summary, or `null` (PASSTHROUGH) to let the tool run.

The three value handlers:
- **`handlers/read.ts`** — 10 gates to PASSTHROUGH; intercepts only when confident. `READ_CONFIDENCE_THRESHOLD = 0.7`. Order: not-Read / no path / explicit offset|limit / unsafe content (binary/secret) / outside-project / kill-switch (`.engram/hook-disabled`) / **same-session dedup** (`served-reads.ts::dedupOrRecord`, ADR-0003, opt-out `ENGRAM_READ_DEDUP=0`) / not-in-graph / stale (file mtime > graph mtime) / confidence<0.7 / **token-saving gate** (summary must be smaller than the file). Then enriches via `resolveRichPacket` (1.5s timeout) and returns the deny.
- **`handlers/grep.ts`** — symbol→call-sites from the `calls` graph (ADR-0001/0004/0007). Gates: `SYMBOL_RE = /^[A-Za-z_$][A-Za-z0-9_$]{2,}$/` + `STOPWORDS` + `output_mode==="content"` only + **`MIN_CALLER_FILES = 4`** + **never-worse size gate**: `rawGrepFloorTokens()` runs `rg -wF` against the *agent's own scope* (cwd+path+glob); intercept only if packet < that floor; can't size → passthrough. Always appends the `rg -n "<symbol>"` escalation (recall-safety). Caps: `MAX_CALLER_FILES=15`, `MAX_SITES=25`, `MAX_LINE_LEN=140`, `MAX_FILE_BYTES=1_000_000`. Opt-out `ENGRAM_GREP_INTERCEPT=0`.
- **`handlers/bash.ts`** — closes the `cat`-bypass. STRICT parser (`parseReadLikeBashCommand`): only `cat/head/tail/less/more` + exactly one path arg, no shell metachars (`UNSAFE_SHELL_CHARS`), ≤200 chars; then delegates to `handleRead`. Anything complex passes through.
- Support: `context.ts` (`resolveInterceptContext`, `findProjectRoot`, `isContentUnsafeForIntercept`), `safety.ts` (`runHandler`, `PASSTHROUGH`, `isHookDisabled`), `formatter.ts` (`buildDenyResponse`), `served-reads.ts` (session dedup), `installer.ts` (write hook entries into `.claude/settings.json`), `mistake-guard.ts` (pre-mortem nag), `cursor-adapter.ts` (Cursor `beforeReadFile` shape).

### 3.6 MCP serve / HTTP server / generators / db / mesh
- **`serve.ts`** 🟡 (bin `engram-serve`): MCP stdio server, 6 tools — `query_graph`, `god_nodes`, `graph_stats`, `shortest_path`, `benchmark`, `list_mistakes`. `clampInt` guards untrusted numeric args (`depth:Infinity` DOS). `serverInfo.version` read from package.json.
- **`server/http.ts`** ⚪ (632): `createHttpServer` on `127.0.0.1`, token-authed (`~/.engram/http-server.token`, 0600), PID file. Routes: `/health`, `/ui`, `/query`, `/stats`, `/providers`, `POST /learn`, `/api/hook-log[/summary]`, `/api/tokens`, `/api/files/heatmap`, `/api/providers/health`, `/api/cache/stats`, `/api/graph/{nodes,god-nodes}`, `/api/sse`, **`/context/stream`** (SSE rich packets). UI in `ui*.ts`.
- **`db/migrate.ts`** 🟡: `CURRENT_SCHEMA_VERSION = 9`, `runMigrations(db, dbPath)`. Migrations are SQL strings or functions (v8/v9 add bi-temporal columns via function because `ALTER TABLE ADD COLUMN` isn't idempotent in SQLite). Backs up before migrating; rollback bounded `0..9`.
- **`generators/*`** ⚪: `gen-aider` / `cursor-mdc` / `windsurf-rules` export the graph to IDE rule files. `autogen.ts` (`VIEWS` table, `generateSummary`, `autogen`) dual-emits AGENTS.md+CLAUDE.md.
- **`mesh/*`** ⚪: self-contained multi-machine layer. `identity.ts` (ed25519), `jcs.ts` (~150-LoC RFC-8785 canonicalization), `audit.ts` (append-only, 10MB rotate), `pii-gate.ts` (`containsPii`/`stripPiiDeep`), `types.ts` (`MESH_PROTOCOL_VERSION=1`, `Envelope`, `computeTrust`). No coupling into the graph hot path.

### Data-flow diagrams

**(a) `engram init` → build graph** (`core.ts::init`, ordering is load-bearing):
```
init(root)
  ├─ writeFileSync(init.lock, {flag:"wx"})         # atomic; EEXIST → throw "another init running"
  ├─ extractDirectory(root)        ── ast-miner (REGEX) ──▶ file/class/fn/type/import nodes + contains/imports edges (score 0.85)
  ├─ mineGitHistory(root)          ── git log        ──▶ churn metadata + co-change edges
  ├─ mineGitReverts(root)          ── git revert     ──▶ bi-temporal MISTAKE nodes (score high)
  ├─ mineBugFixCommits(root)       ── git fix-commit ──▶ MISTAKE nodes (score 0.6, browse-only)
  ├─ mineSessionHistory(root)      ── transcripts    ──▶ MISTAKE nodes (edges:[])
  ├─ [if withSkills] mineSkills()  ── SKILL.md       ──▶ concept nodes + triggered_by/similar_to
  │
  ├─ store.clearAll()  (full)  OR  removeNodesForFile per changed file (incremental)
  ├─ store.bulkUpsert(allNodes, allEdges)            # commit + save()
  │
  └─ buildReferenceEdgesCached(root, store.getAllNodes(), prevRefCache)   # tree-sitter, AFTER upsert, over FULL graph
        └─ store.replaceEdgesByRelation("calls", refEdges)   # ATOMIC; rollback preserves prior graph on failure
        └─ persist file_refs_cache  (warm next reindex)
     totalEdgeCount = store.getStats().edges          # authoritative from disk
```
Note: `calls` edges are (re)built last, separately, over the whole current graph — so incremental reindex stays correct and PageRank ranking doesn't drift. `watcher.ts` reuses the same cached builder on the per-edit hot path.

**(b) Read-hook → structural summary** (`handlers/read.ts`):
```
PreToolUse:Read {file_path, offset?, limit?, cwd, session_id}
  └─ 10 PASSTHROUGH gates (offset/limit, secret/binary, outside-proj, kill-switch, dedup,
     not-in-graph, stale, confidence<0.7, summary≥file-size)
        │ confident
        ▼
   getFileContext → renderFileStructure(store, relPath)       # graph summary (~600-token budget)
        │
        ▼ enrich (resolveRichPacket, 1.5s timeout, providers: mistakes/git/mempalace/context7/obsidian)
   buildDenyResponse(summary [+ enrichment])  →  {permissionDecision:"deny", reason:<text>}
        │ Claude Code blocks the Read, delivers reason as system-reminder
        ▼
   agent sees structural view instead of full file  (tokens saved)
```

**(c) Grep-hook → call-sites** (`handlers/grep.ts`):
```
PreToolUse:Grep {pattern, output_mode, cwd, path?, glob?}
  └─ gates: SYMBOL_RE & !STOPWORD & output_mode=="content"
        ▼
   callers(projectRoot, pattern)   # from `calls` graph (traversal.findCallers)
        └─ < MIN_CALLER_FILES(4) → PASSTHROUGH
        ▼
   collectCallSites(root, callerFiles, symbol)   # actual file:line: code, capped 15 files/25 sites/140 chars
        └─ 0 sites → PASSTHROUGH
        ▼
   never-worse gate: rawGrepFloorTokens(rg -wF, agent's cwd+path+glob)
        └─ packet ≥ floor (or unsizable) → PASSTHROUGH
        ▼
   buildGrepAnswer(...) + "rg -n \"<symbol>\"" escalation  →  deny
```

## 4. LOAD-BEARING markers — the spine

### 🔴 CRITICAL set (breaking these breaks the product)

| File | What it does / key fns | Breaks if changed → |
|---|---|---|
| `src/core.ts` | The API hub. `init` build pipeline + lockfile; `getFileContext` confidence math; `query/callers/callees/impact`/`mistakes`/`learn`. | Both CLI and MCP lose their entry; init ordering corruption; Read hook gets no confidence/summary. |
| `src/graph/schema.ts` | The data contract — `GraphNode`/`GraphEdge`/`NodeKind`/`EdgeRelation`/`Confidence`. Pure, zero imports. | Every miner, store, query, traversal recompiles against a different shape; bi-temporal mistake fields vanish. |
| `src/graph/store.ts` | sql.js persistence + the atomic `replaceEdgesByRelation` rebuild + `provider_cache`. | Graph can't persist/load; non-atomic calls-rebuild can persist a calls-less graph (worse than no init); cache breaks. |
| `src/graph/query.ts` | `renderFileStructure` (the Read summary) + `queryGraph` (ranked traversal, mistake boost, keyword filter). | Read hook produces no/garbage summary; mistakes stop surfacing; keyword bloat returns. |
| `src/graph/traversal.ts` | `findCallers/findCallees/findImpact` over `calls` edges. Pure. | Grep hook + `callers/callees/impact` CLI/MCP verbs all break. |
| `src/graph/pagerank.ts` | Personalized weighted PageRank — the only ranking signal in the category. Pure, deterministic. | Ranking degrades to flat degree; god-nodes/summary ordering wrong (non-fatal but the differentiator is gone). |
| `src/miners/ast-miner.ts` | **Regex** def/import extraction (the node universe). `extractDirectory`/`extractFile`. | No nodes → empty graph → every downstream is empty. |
| `src/miners/reference-miner.ts` | **tree-sitter** `calls` edges. `buildReferenceEdgesCached` + caps (1MB/10-defs/60-per-file). | No call graph → PageRank, Grep call-sites, callers/callees/impact all collapse to nothing. ABI-coupled to web-tree-sitter 0.26. |
| `src/miners/git-revert-miner.ts` | Bi-temporal mistake extraction from reverts — the "rave moment" feature. | The headline bi-temporal mistake-memory product disappears. |
| `src/intercept/dispatch.ts` | The hook router + `validatePayload`. Sole handler registry. | No hook fires; or a malformed-payload throw escapes fail-open and blocks Claude Code. |
| `src/intercept/handlers/read.ts` | The highest-leverage interception (the token-saving core) + all 10 safety gates. | Either no savings, or (worse) unsafe/low-confidence summaries replace real reads → correctness loss. |
| `src/intercept/handlers/grep.ts` | Symbol→call-sites with the never-worse gate + rg escalation. | Either no Grep value, or recall regressions (graph has lower textual recall than grep). |
| `src/intercept/handlers/bash.ts` | The `cat`-bypass closer (STRICT parser). | The Read interception is trivially bypassable via `cat`. |
| `src/intercept/safety.ts` | `runHandler` fail-open wrapper, `PASSTHROUGH`, kill switch. | A handler bug stops being invisible and starts blocking the agent — the whole fail-open guarantee. |

(`graph/path-utils.ts` and `graph/render-utils.ts` are 🔴-adjacent: tiny, pure, but every `sourceFile` lookup and every truncation depends on them. Marked 🟡 by size, but a change to `toPosixPath` silently breaks cross-OS lookups.)

### 🟡 IMPORTANT (significant but replaceable / peripheral to the core loop)
`providers/resolver.ts` (enrichment — Read works graph-only without it), `providers/grammar-loader.ts` (tree-sitter loader; the reference miner can't run without it but it's mechanical), `providers/types.ts` (provider contract + `CachedContext`), `serve.ts` (MCP surface — the hook path doesn't need it), `db/migrate.ts` (schema evolution; fresh installs don't migrate), `intelligence/{cache,hook-log,token-tracker}.ts`, the other git/session/skills miners (additive signal), `intercept/{context,formatter,served-reads,installer,mistake-guard}.ts`, `graph/{path-utils,render-utils}.ts`.

### ⚪ PERIPHERAL (CLI sugar, generators, UI, networking, docs)
`cli.ts` (just commander wiring over the above), `server/*` (HTTP/SSE/UI), `generators/*`, `ccs/*`, `mesh/*`, `cost/*`, `tuner/*`, `doctor/*`, `setup/*`, `update/*`, `cli/format-mistake.ts`, `commands/measure.ts`, `dashboard.ts`, `autogen.ts`, `hooks.ts`, `watcher.ts`, `intercept/cursor-adapter.ts`, everything under `adapters/`, `extensions/`, `plugins/`, `bench/`, `scripts/`, `docs/`.

## 5. Coupling / risk notes

- **`store.ts` → `providers/types.ts`**: `GraphStore` imports `CachedContext` (the cache table row shape). A graph-only carve must either keep this type or stub the `provider_cache` methods. Otherwise the graph layer has no provider coupling.
- **`reference-miner.ts` + `providers/grammar-loader.ts` → web-tree-sitter 0.26**: the only hard native/ABI coupling. The reference miner imports `type { Node } from "web-tree-sitter"` and calls `getParser`/`tree.delete()`. Everything else in the graph layer is pure TS.
- **tree-sitter ABI version**: Engram pins **`web-tree-sitter@0.26.8`** (lockfile-resolved) with native grammar packages `tree-sitter-typescript@0.23.2`, `tree-sitter-javascript@0.25.0`, `tree-sitter-python@0.25.0`, `tree-sitter-go@0.25.0`, `tree-sitter-rust@0.24.0` (the `.wasm` are bundled by `scripts/bundle-grammars.mjs` into `dist/grammars/`). 0.26 API = separate `Language` object + `Parser.init()` + `Language.load()` + `parser.setLanguage()`.
- **sql.js whole-DB write**: `store.close()`/`save()` does `db.export()` → `writeFileSync` of the *entire* DB. Fine for repo-scale graphs; a concern only at very large node counts. `getEdgesForNodes` chunks at 400 to dodge SQLite's 999-variable limit.
- **Recall ceiling (verified, not confabulated)**: `bench/recall-coverage.ts` + ADR-0009 measure (engram-on-engram, deterministic): **recall@10 = 33.0%**, recall@5 = 24.7%, MRR = 0.466, 71.5% of trials hit @10, worst-case recall@10 = 20.2%. Candidate generation (callers∪callees) reaches **43.0%**; PageRank captures **76.6%** of that reachable set at @10 (vs 29.8% random ordering). Treat the graph as a **low-recall structural heuristic**, not LSP-grade — Grep hook's always-on `rg` escalation exists precisely because of this.
- **Confidence-gate known limitation** (`core.ts` comment): the coverage formula counts 1 node per class (AST miner doesn't emit per-method nodes), so a 20-method file scores as 1 code node → conservative passthrough.
- **Process-exit hazard** (`cli.ts intercept`): must NOT `process.exit` on the happy path — Node 25 + Windows + sql.js WASM async handle in `UV_HANDLE_CLOSING` triggers a libuv assertion (`src/win/async.c:76`). Drains the loop naturally instead.

## 6. For a github-router vendor / carve effort

github-router pins **`web-tree-sitter@0.22.6`** + `tree-sitter-wasms@^0.1.13`; Engram is on **0.26.8** + native grammar packages. The ABIs are **incompatible** (0.22 `Parser.SyntaxNode` / different load API vs 0.26 separate `Language` object). Per-module portability:

**Cleanly portable (pure, zero or schema-only coupling) — copy as-is into `src/vendor/engram/`:**
- `src/graph/schema.ts` — pure types, zero imports. (Trim the optional v3/v4 bi-temporal tier if mistakes aren't carved.)
- `src/graph/traversal.ts` — `findCallers/findCallees/findImpact`, pure fns on `readonly` arrays, imports only `schema`.
- `src/graph/pagerank.ts` — pure, deterministic, zero imports.
- `src/graph/path-utils.ts` — `toPosixPath`, single pure string op.
- `src/graph/render-utils.ts` — surrogate-safe truncation, pure.
- `src/miners/ast-miner.ts` — **regex-only, NO tree-sitter** (despite its misleading header comment). Portable without an ABI bump; gives you the node universe (defs/imports) but no `calls` edges.

**Coupled (need light adaptation):**
- `src/graph/store.ts` — sql.js (github-router has no sql.js dep today; adds the `sql.js` runtime + a whole-DB-write persistence model). Also imports `CachedContext` — stub or drop the provider_cache methods.
- `src/graph/query.ts` / `core.ts::getFileContext` — depend on store + render-utils; portable once the store is.

**Needs reimplementation against the proxy's 0.22 tree-sitter (or a web-tree-sitter bump):**
- `src/miners/reference-miner.ts` + `src/providers/grammar-loader.ts` — the **only** ABI-blocked modules. The `calls`-edge call-extraction must be rewritten against 0.22's `Parser.SyntaxNode` API, OR web-tree-sitter bumped to 0.26 (which would force re-validating `src/lib/code-search.ts`'s tree-sitter structural pass in github-router). The caps (`MAX_REF_FILE_BYTES=1_000_000`, `MAX_AMBIGUOUS_DEFS=10`, `maxPerFile=60`) and the two-step extract→resolve algorithm port conceptually; only the parser API changes.
- Note: without the reference miner there are **no `calls` edges**, so PageRank, the Grep call-site hook, and `callers/callees/impact` all degrade to nothing. The `calls` graph is the load-bearing dependency for half the spine.

**License**: Apache-2.0 (© 2026 Nicholas Ashkar). **No `NOTICE` file** at the repo root, so §4(d) reproduction doesn't apply — a vendor only needs to preserve LICENSE + per-file attribution.

**Carve recommendation alignment**: given the 33% recall ceiling, graph edges should *augment*, never *override*, github-router's existing BM25F `code` ranking, and `impact` must be surfaced as a heuristic. (Independently re-verified here; consistent with the prior `docs/research/engram-gate-b0.md`.)

## Items I could NOT fully verify
- `tokei` summary is a **`scc` fallback** (tokei uninstallable on this host); the column semantics match but it is not literally tokei output.
- I read every 🔴 file in full and the key 🟡 files; some ⚪ files (full `server/ui*.ts`, all generators, `mesh/*` internals beyond signatures, `cost/`/`tuner/`/`doctor/` bodies) were skimmed by exported-signature + grep, not deep-read. Tiering for those is by role, not line-by-line audit.
- The "~89% per-file reduction" headline is a `bench/real-world.ts` claim; I did not re-run the bench, only located the source.
