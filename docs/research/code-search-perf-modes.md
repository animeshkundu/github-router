# code_search: ast-grep, parallelization, and the default mode

Read-only investigation of `src/lib/code-search.ts` (+ `src/lib/tree-sitter-grammars.ts`).
Goal: make `code_search` thorough AND fast. All line numbers are against the code as
read on 2026-06-06. Timing figures are rough local measurements on this machine
(macOS, warm FS cache), not universal performance claims.

Pipeline today (`searchCode`, `code-search.ts:1472`):

```
rg --json stream  ──▶ parseRgJsonStream (1585)  ──▶ BM25F pass1 (1639)
  ──▶ runStructuralPass: parse top-N hit files into _treeCache (1655)
  ──▶ BM25F pass2 w/ AST-confirmed symbol_context (1667)
  ──▶ shoulderPrune (1672)  ──▶ render results (1689)
  ──▶ elapsed_ms computed + logged (1715)            ◀── TELEMETRY STOPS HERE
  ──▶ outline loop: outlineFile() on ≤10 result files (1738-1757)
```

---

## Q1 — Does code_search benefit from ast-grep (`sg`)?

**Verdict: No for the existing free-text "where is X" use case. Yes, but only as a
distinct, opt-in `mode: "structural"` niche — not as a replacement for any current
internal step.**

Facts established:

- `ast-grep` / `sg` **0.43.0** is on the toolbelt PATH
  (`~/.local/share/github-router/bin/{sg,ast-grep}`), materialized by
  `src/lib/toolbelt/`. **But it is only on PATH for spawned-agent processes** (the
  toolbelt prepends to the child agent's PATH); the **proxy process that runs
  `searchCode` does not get the toolbelt PATH**, and the toolbelt is opt-out
  (`GH_ROUTER_DISABLE_TOOLBELT=1`) and skippable per-tool. So `code_search` cannot
  treat `sg` as reliably present without its own resolution/version-gate, the way it
  already tri-tiers `rg`. That alone makes "silently swap tree-sitter for sg" a
  non-starter; it would need a capability gate + fallback.
- `sg` has JSON output: `--json=compact` (array) and `--json=stream` (NDJSON).
  `--json=compact` emits per match `{text, range{byteOffset, start{line,column}, end},
  file, lines, language, metaVariables{single{NAME:{text, range}}}}`. The
  `metaVariables` block gives named captures with exact byte offsets — i.e. the same
  "this token is the name slot of a definition" signal `isDefiningSite` computes by
  hand.
- Spawn cost is low: ~10-20ms for a single-file pattern run, ~50ms to scan all of
  `src/` (process start + tree-walk of the whole subtree). `rg --json` over one file
  is ~0-10ms warm. So sg is a cheap process, but it is still a **per-call process
  spawn** vs in-process WASM that is already warmed at module load.

### (a) Replace web-tree-sitter structural confirmation with `sg`? — No.

The structural pass (`runStructuralPass`, 1029) answers a precise question for the
top-N already-ranked hits: "is the rg submatch at byte range `[start,end]` sitting at
the *name slot* of a definition node?" It does this from a parsed tree it then
**caches and reuses** (`_treeCache`).

Replacing it with `sg` is a net loss here:

- **Wrong query model.** `sg` matches a *pattern* you supply (`function $NAME`,
  `class $NAME`), then reports where `$NAME` landed. To confirm an arbitrary rg hit
  with `sg` you would have to either run a battery of per-language definition patterns
  per file, or run `sg` then point-match its `metaVariables[].range.byteOffset`
  against each rg hit's byte range — which is exactly the offset arithmetic
  `lineStartByte` + `isDefiningSite` already do in-process against a tree you keep.
- **Loses the cache.** The in-process tree is reused by the outline step (see Q2) and
  across calls within a 64-entry LRU (`STRUCTURAL_CACHE_MAX`). An `sg` subprocess
  produces JSON, not a reusable tree.
- **Adds N spawns and JSON (de)serialization** of full match `text` + `lines`
  (the sample object above re-emits the entire matched function body twice — `text`
  and `lines`) for what is currently a zero-copy native walk.
- **Coverage parity is not free.** Today's confirmation handles C/C++ `declarator`
  nesting, Rust `impl_item`/Go `type_spec` `type`-field names, etc.
  (`tree-sitter-grammars.ts:105-199`). Reproducing that breadth in sg patterns is a
  large per-language pattern catalog to author and maintain.

### (b) New structural-pattern query capability (`sg -p 'function $A() {}'`)? — Yes, as a separate opt-in mode only.

This is the one place sg adds a capability the current tool genuinely lacks. Today
queries are free text / identifier (`ranked|literal|regex`); you cannot ask "find
every `useEffect` call with an empty dependency array" or "every `function` with no
return type." A `mode: "structural"` that forwards the query verbatim as an sg pattern
(`sg run -p <query> --lang <inferred> --json=stream`, mapped to the same
`{file, line, snippet}` shape) would serve the AST-pattern niche.

Caveats that make it a niche, not a headline feature:

- It needs a language: sg patterns are per-language (`--lang`). You would infer from
  `file_glob`, or require a `lang` arg. Free-text queries cross languages for free;
  structural queries do not.
- It needs the sg capability gate + fallback described above (resolve sg, version
  check, degrade to an error notice if absent), mirroring `rg` tri-tier resolution.
- The audience is small. The dominant `code_search` use is "where is X" — ripgrep
  candidate generation + BM25F + tree-sitter confirmation already nails that. A
  structural-pattern mode is a power-user affordance, not a default.

### (c) Cost summary

| | tree-sitter (today) | ast-grep (`sg`) |
|---|---|---|
| Locality | in-process WASM, warmed at import | per-call subprocess spawn |
| Availability | dependency, always present | toolbelt PATH only (agent env), opt-out, version-variable |
| Tree reuse | cached (`_treeCache`, LRU 64), shared with outline | none (JSON out, no tree) |
| Query model | byte-range → definition-site confirm | author-supplied AST pattern |
| Per-call overhead | ~0 (parse already amortized) | ~10-50ms spawn + JSON serialize |

**Bottom line:** ripgrep + web-tree-sitter is the right tool for free-text search;
keep it. Add `sg` only if/when a structural-pattern query mode is wanted, gated and
fallible like `rg`, never as a swap for the confirmation or outline passes.

---

## Q2 — Can code_search parallelize its internal steps?

### Does multi-`Parser` give parallel CPU parsing? — No.

`web-tree-sitter@0.22.6` exposes `parse()` as **synchronous**: the d.ts signature is
`parse(input, oldTree?, options?): Parser.Tree` (returns a Tree, not a Promise). The
WASM build is a **single module-global Emscripten `Module`** — one `initPromise`, one
`wasmMemory`, one heap, shared by every `Parser` instance (`Parser.init()` is a
process-wide singleton; `getGrammarBundle` loads each grammar once into that one
module). Constructing several `Parser` objects does **not** create parallel isolates;
every `parser.parse()` is blocking CPU work on the single JS thread against the one
shared WASM heap. They serialize.

**Consequence:** in-process parse parallelism is impossible. The only true parse
parallelism is `worker_threads` (separate V8 isolates, each its own WASM module).
I/O around the parses *can* overlap; the parses themselves cannot.

### Ranked speedups, cheapest real win first

**1. Share parsed trees between the structural pass and the outline loop. (Cheapest, highest-confidence win — do this first.)**

The redundant re-parse is real and exactly as the brief suspected:

- `runStructuralPass` parses the top-N hit files (top-50 in `full`) and stores
  `{mtimeMs, tree, source}` in `_treeCache` (`code-search.ts:1103-1132`).
- The outline loop calls `outlineFile` (1754) for each of the ≤10 distinct result
  files. `outlineFile` (`tree-sitter-grammars.ts:448`) **creates its own `Parser`**
  (`new Parser()`, 512), reads the file again (`await readFile`, 502), parses again
  (514), and `.delete()`s the tree (538) — it never consults `_treeCache`.

The outline files are the *highest-ranked* result files, which are a near-perfect
subset of the structural pass's top-N. So in the common case **all ≤10 outline files
were already parsed milliseconds earlier and the tree was thrown away.** That is up to
10 redundant `readFile` + `parse` per call — the single most wasteful thing in the
pipeline.

Fix shape (low risk, behavior-preserving): give `outlineFile` an optional
"already-parsed tree" path. `_treeCache` lives in `code-search.ts`; `outlineFile`
lives in `tree-sitter-grammars.ts` and is also called by `search-fs-tools.ts`, so
don't make the grammar module depend back on the ranking cache. Two clean options:

- (preferred) Add an exported `outlineFromTree(tree, language, signal?)` helper in
  `tree-sitter-grammars.ts` that runs only `collectDefinitions` (no read, no parse, no
  delete). In `searchCode`, for each outline file, look it up in `_treeCache` by
  absolute path + current mtime; on hit call `outlineFromTree(cached.tree, lang)`; on
  miss fall back to `outlineFile`. The structural pass already keys `_treeCache` by
  `path.join(workspaceRoot, relFile)` and the outline loop already has
  `path.resolve(ws.canonical, file)` — same absolute path, so lookup is direct.
- (alternative) Pass an optional `treeProvider` callback into `outlineFile`.

Expected win: eliminates up to 10 file reads + 10 parses per ranked search whenever
the outline files overlap the structural top-N (the normal case). On a typical search
that is the bulk of the post-rg CPU. **Correctness caveat:** the structural pass frees
its parsers in `finally` but the *trees* stay in `_treeCache` (only deleted on mtime
change or LRU eviction) — so they are live and reusable at outline time. The only
guard needed is the mtime re-check `cacheGet` already does (file edited between the two
passes → miss → re-parse). No stream/abort surface is touched.

**2. Move `elapsed_ms` past the outline loop. (Measurement-correctness fix — do this with #1 so the win is visible.)**

`const elapsed_ms = Date.now() - t0` is computed at `1715` and logged at `1720`,
**before** the default-on outline loop (1738-1757). The reported/logged latency
therefore **excludes outline generation entirely** — today's telemetry understates the
real cost of the default `summary: true` path, and any improvement to the outline step
would be invisible in the logs. Move the `elapsed_ms` computation (and the `consola`
breadcrumb, or at least a second timing marker) to after the outline loop. The
returned `elapsed_ms` field becomes honest; `notice`/result shape unchanged. Zero risk.

**3. Overlap I/O while keeping parses serial. (Moderate win, moderate care.)**

Parses must serialize (single WASM heap), but the **`readFile`/`statSync` that feed
them need not.** Two serial-read sites:

- Structural pass: `readFileSync(absPath, "utf8")` at `1107`, inside the
  `for (const [relFile, entries] of byFile)` loop (1068) — fully synchronous, one file
  at a time, and `readFileSync` *blocks the event loop* on top of being serial.
- Outline loop: `await outlineFile(...)` at `1754`, serial; `outlineFile` uses async
  `readFile` but the caller awaits each before starting the next.

Better shape: pre-read the candidate files concurrently with a small bounded queue
(e.g. `Promise.all` over a concurrency-limited map, cap ~4-8), then run the
`parser.parse()` calls serially over the in-memory sources. This converts N serial
disk round-trips into ~one batch while leaving the CPU-bound parse loop untouched.
Switching the structural pass from `readFileSync` to async `readFile` also stops it
blocking the event loop during reads. Expected win: cuts read latency on cold-cache /
network-FS workspaces (Windows network drives are the primary deployment target —
serial sync reads hurt most there); near-zero on warm local cache.
**Correctness caveat:** the structural pass is wall-clock-budgeted (`STRUCTURAL_BUDGET_MS
= 200`, checked between files at 1071). Pre-reading changes *when* I/O happens relative
to the budget clock; keep the budget gate around the **parse** loop (the expensive
part) so the semantics ("parse as many top-N files as fit in 200ms") hold. Don't let a
slow batch-read silently consume the parse budget. Also preserve the per-file
`STRUCTURAL_MAX_FILE_BYTES` size gate *before* reading (it currently `statSync`-gates
at 1096 before the read) so a pre-read pass doesn't slurp a 50MB bundle.

**4. `worker_threads` parse pool. (Not worth it — deprioritize.)**

This is the only path to *parallel parsing*, but the economics are poor for this
workload:

- Per-call worker spawn + `Parser.init()` + grammar `.wasm` load is ~hundreds of ms
  cold — larger than the entire current structural budget (200ms) and most searches'
  total time. A throwaway-per-call worker would be net slower.
- It only pays off as a **warm persistent pool** (workers started at module load,
  grammars pre-loaded in each, jobs dispatched over `postMessage` with source-string
  transfer). That is real complexity: lifecycle, backpressure, the abort/`signal`
  plumbing across the thread boundary, and Bun-vs-Node `worker_threads` parity (this
  repo is Bun-first; verify Bun's `worker_threads` + web-tree-sitter WASM actually
  loads in a Bun worker before committing).
- The realized win is bounded by amount of parse work per call, which after fix #1 is
  small (≤ top-50 files, each a sub-50ms parse, budget-capped at 200ms total). You'd be
  parallelizing ~200ms of work behind ~100ms+ of coordination overhead.

Verdict: skip unless profiling after #1-#3 shows parse CPU is still the dominant term,
and even then only as a warm pool.

### Stream-lifecycle / abort note

Speedups #1-#3 are all **downstream of `parseRgJsonStream`** — they touch the
post-rg ranking/outline CPU, not the rg stream, the `ReadableStream` controller, or the
`AbortController` wiring. None of them adds an `enqueue`/`close`/`read` call site, so
the repo's "every stream call site needs a race-triggering regression test" rule
(CLAUDE.md) does not apply to them. The one thing to preserve: all three steps already
honor `ac.signal.aborted` (structural pass 1069, outline loop 1753); any refactor must
keep those abort checks, and a concurrent pre-read (#3) must also short-circuit on
`signal.aborted` so a cancelled call doesn't keep reading files.

---

## Q3 — The three modes, and the default

Per-mode behavior, with file:line evidence:

| Step | `ranked` (default) | `literal` | `regex` |
|---|---|---|---|
| Skeleton expansion (camel/snake/kebab/UPPER) | yes (`expandIdentifierVariants`, 1500-1501) | yes (1500-1501) | **no** (`mode === "regex" ? null`) |
| rg candidate flag | `-F` literal, unless expansion → regex alternation (632-634, 651) | `-F` literal (632-634) | rg default (PCRE2-via-builtin), no `-F` |
| Per-file `--max-count` | **yes**, `RANKED_MAX_PER_FILE=50` (644-646) | no | no |
| BM25F scoring | **yes**, two-pass (1635-1671) | no (document order, 1675-1682) | no (document order) |
| Tree-sitter structural pass | **yes** (`runStructuralPass`, 1655) | no | no |
| Shoulder prune (drop <0.5×top) | **yes** (`shoulderPrune`, 1672) | no | no |
| Result order | BM25F score desc, tie → (file,line) (`shoulderPrune` sort, 1421) | rg document order | rg document order |
| `score` / `field_contributions` in hit | populated (1701-1708) | null (1709-1711) | null |
| Structural outline (`outlines`) | **see note** | **see note** | **see note** |
| `ranking.algorithm` reported | `"BM25F"` | `"ripgrep_document_order"` | `"ripgrep_document_order"` |

**Outline note — important, and a real defect.** In `searchCode`, the outline loop is
gated only on `rawInput.summary !== false` (1738) — it is **mode-independent**, so
outlines run for `literal` and `regex` too, not just `ranked`. But:

- The **MCP handler does not forward `summary` to `searchCode`** at all. The handler
  builds the `searchCode` input at `peer-mcp-personas.ts:868-885` and **omits
  `summary`** (the worker-agent tool at `worker-agent/tools.ts:889-901` omits it too).
  The tool *schema* advertises `summary` and "set false to omit" (`peer-mcp-personas.ts:848-856`),
  but that field is dropped on the way in. So **through both MCP surfaces, `summary`
  is effectively pinned to its default (on); `summary: false` is unreachable.** Only a
  direct `searchCode()` import (which forces `summary` itself) can disable outlines.
  This is a schema-vs-behavior gap worth fixing independently of perf: either wire
  `summary` through in both handlers, or drop it from the schema.

So distinguish the two surfaces:

- **Raw `searchCode()`**: outlines run in every mode unless `summary: false`.
- **MCP tool (`mcp__search__code`) and worker tool**: outlines **always** run (≤10
  files), every mode, no opt-out.

### Recommended default: keep `ranked`.

`ranked` is already the max-helpful mode and should stay the default. It is the only
mode that (a) reorders by relevance so the best hits surface first under the limit,
(b) AST-confirms definition sites so "where is X *defined*" beats incidental mentions,
(c) shoulder-prunes the long tail of weak matches, and (d) carries the structural
outline map. `literal`/`regex` are deliberately *thinner* — exhaustive, document-order
enumeration for "show me every occurrence," which is the right tool when the user wants
completeness over ranking (hence no `--max-count`, no prune).

There is **no case for a richer combined default**, and a mild case for *trimming* what
`ranked` does by default:

- Don't add more to `ranked`. It already runs rg + two BM25F passes + a 200ms
  structural pass + ≤10 outlines. Adding sg (Q1) or more passes raises latency for the
  90% "where is X" query that the current stack already answers well.
- The honest tradeoff to flag: the **default-on outline step is unmetered and
  unskippable via MCP** (see the defect above). Today it costs up to 10 redundant
  parses (Q2 #1) and its latency isn't even in `elapsed_ms` (Q2 #2). The right move is
  **not** to change the default mode but to make the existing default *cheap and
  honest*: land Q2 #1 (share trees) + #2 (fix telemetry), and decide deliberately
  whether MCP callers should be able to set `summary: false`. After those, `ranked`
  with outlines on is both the most helpful default and a fast one.

**Recommendation:** default stays `ranked`. Make it cheaper, not heavier — ship the
tree-sharing dedup and the telemetry fix; treat the unreachable `summary: false` as a
bug to resolve (wire it through or remove the schema field). Reserve `sg` for a future
explicit `mode: "structural"`, gated and fallible like `rg`.
