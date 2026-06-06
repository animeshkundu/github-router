# Phase B Lite — index-free structural enrichment for `code_search`

Read-only research proposal. Evaluates which parts of Engram's "Phase B"
structural call-graph value (callers / callees / references / impact) can be
added to `github-router`'s `code_search` **cheaply, with no heavy machinery**.

**Hard constraints (non-negotiable):** ZERO persistent state, ZERO new heavy
deps (no sql.js, no background indexer, no cross-session cache, no `.engram`
file). The only budget is the per-call ephemeral tree-sitter parsing
`code_search` already does.

Implementation surface: `src/lib/code-search.ts`, `src/lib/tree-sitter-grammars.ts`.
MCP response shaping (the model-facing trim): `src/lib/peer-mcp-personas.ts:860-978`.

---

## The core insight, stated honestly

Engram's expensive part is the **persistent, whole-repo** `calls` edge graph:
`buildReferenceEdges` re-parses *every* file in the repo, resolves callee names
to definitions, and stores edges in `.engram/graph.db` (sql.js). The pure
traversal verbs (`findCallers` / `findCallees` / `findImpact`,
`/tmp/engram-map/src/graph/traversal.ts`) are cheap — but they consume an edge
set that only the expensive miner produces.

`code_search` already parses trees per call. But **how many** trees, and which,
is the load-bearing detail — and it is NOT "the whole result set". There are
three distinct cost classes, and every proposal below is tagged with one:

| Cost class | What is already parsed | Where |
|---|---|---|
| **FREE-A** | Top-N BM25F hits in **ranked mode only** (50 for `structural:"full"`, 10 for `"topN"`), parsed by `runStructuralPass`, trees cached in `_treeCache` (mtime-gated LRU, cap 64). Each hit's matched identifier is already walked, and `isDefiningSite` already classifies it. | `code-search.ts:1029-1193` |
| **FREE-B** | Up to 10 distinct **result files** (`CODE_SUMMARY_MAX_FILES`) outlined by `outlineFile` when `summary` is on (default). NOTE: this is a *separate* parse from FREE-A — `outlineFile` builds its own `Parser`, does not consult `_treeCache`, and frees the tree immediately (`tree-sitter-grammars.ts:434-532`). So a small amount of duplicate parsing already happens today; some proposals can *remove* that duplication. | `code-search.ts:1730-1756` |
| **EXTRA** | Anything requiring a parse of files NOT in FREE-A or FREE-B — e.g. all result files in literal/regex mode (which parse nothing today), or files beyond the top-50 / first-10 caps. | (new cost) |

**Recall ceiling for everything below:** scoped-to-results means we only see
relationships *among the files this one search matched/parsed* — NEVER the whole
repo. "Callers within the result set" is not "all callers in the repo." Every
proposal states this caveat in its own terms. This is the honest, free version
of Engram's value; the whole-repo version is exactly the persistent index we
are refusing to build.

---

## Ranked proposals (cheapest-and-highest-value first)

### 1. Per-hit `role` tag: `definition` vs `usage` — **FREE-A, ranked mode**

**What it adds.** Tag each returned hit (ranked mode) with `role:
"definition"` or `role: "usage"`. The model's workflow is "search, then read
the subset the summary points to." Today every hit is just `{file, line,
snippet}`; the model cannot tell the *declaration* of `resolveModel` from the
20 call-sites that mention it without reading each snippet. A one-word tag lets
it jump straight to the definition — the single most common "where is X defined"
intent the tool's own description advertises.

**Where it hooks.** `searchCode`, the ranked-mode block at `code-search.ts:1635-1674`.
`runStructuralPass` already returns `confirmedHitIndexes: Set<number>` — the
exact set of top-N hits whose matched identifier sits at a real definition site
(`isDefiningSite`, `code-search.ts:942-988`). Today that set is consumed only to
boost BM25F `symbol_context`. Reuse it directly: a hit whose index is in
`confirmedHitIndexes` → `role: "definition"`; any other hit in the top-N slice
→ `role: "usage"`; hits outside the top-N slice (or non-ranked modes) → omit
the field (honest "unknown", not a guess). Plumb a per-hit `role?` onto
`CodeSearchHit` and emit it from the handler's `trimmedHits` map
(`peer-mcp-personas.ts:909-922`).

**Cost.** Truly free. Reuses the already-computed `confirmedHitIndexes`; zero
additional parses, zero additional tree walks. One `Set.has(i)` per emitted hit.

**Recall honesty.** Only hits inside the structurally-parsed top-N slice (≤50 /
≤10) carry a confident tag; everything below the slice is honestly untagged.
The tag answers "is THIS hit a definition?", which needs no graph at all — so
recall is perfect *within the tagged slice* and simply absent below it. No
whole-repo claim is made or implied.

**Zero-state check.** PASS. No index, no cache beyond the per-call
`confirmedHitIndexes` that already exists and dies with the call.

---

### 2. `callers_in_results` for single-identifier queries — **FREE-A + small EXTRA-bounded walk, ranked mode**

**What it adds.** When the query is a single identifier (the same
`SINGLE_IDENTIFIER_REGEX` gate that already drives skeleton expansion,
`code-search.ts:523`), add a top-level `callers_in_results: string[]` — the
files in the parsed slice that contain a **call-site** of the query symbol
(`foo(...)`, `obj.foo(...)`, `new Foo(...)`). This is the cheap, scoped port of
Engram's `findCallers`: it answers "which of these matched files actually *call*
this thing" vs merely mention it in a comment or string. It strengthens the
search-first workflow — the model gets a ready-made "start reading here" list of
real callers without opening every hit.

**Where it hooks.** New helper alongside `runStructuralPass`, run over the trees
already in `_treeCache` after the structural pass. Port Engram's `CALL_NODE_TYPES`
+ `calleeName` + `trailingIdentifier` logic verbatim
(`reference-miner.ts:37-99`) — it is ~60 lines, pure, web-tree-sitter-native,
and already matches the grammars we load. Walk each cached tree's call nodes;
if any call's trailing-identifier callee equals the query identifier (compare
against the skeleton variants we already compute via `expandIdentifierVariants`),
record that file. Emit the de-duplicated sorted file list.

**Cost.** Mostly free, but **not zero**: it requires a *second walk* of each
already-parsed top-N tree to collect call nodes (the structural pass walks only
each hit's matched node, not the whole tree for call expressions). The trees are
in `_treeCache`, so there is no re-read and no re-parse — only an O(nodes) walk
per file, bounded to ≤50 files and wrapped in the same `STRUCTURAL_BUDGET_MS`
(200ms) style budget. No file beyond the top-N slice is touched, so it stays
within FREE-A's parse set. Quantify: one extra full-tree visit per top-N file;
empirically a single source file's full walk is sub-millisecond, so ≤50 files
is comfortably inside a small budget.

**Recall honesty.** STRONG caveat, must be surfaced in the field's framing:
these are **callers among the result set (the top-N parsed files), not all
callers in the repo.** A caller in a file that did not match the query (so was
never parsed) is invisible. Name-based resolution also can't distinguish two
unrelated `close()` methods — same limitation Engram accepts
(`MAX_AMBIGUOUS_DEFS`), but here it is *less* harmful because we are not
asserting an edge to a specific definition, only "this file calls something by
this name." Frame the field to the model as "files in the result set that call
`<query>`" so it never over-reads it as repo-complete.

**Zero-state check.** PASS. Pure per-call walk over the existing ephemeral tree
cache; nothing persisted.

---

### 3. Outline enrichment: per-symbol `usages` count within the result set — **FREE-B (piggyback on the summary parse)**

**What it adds.** The `outlines` summary already lists each result file's
top-level definitions `{kind, name, line}`. Add an optional `usages?: number`
per outline entry: how many times that defined symbol is *called* across the
parsed/result set. This turns the outline from a static map into a lightweight
"which of these definitions is actually hot" signal — the model can prioritize
reading the 3 heavily-used functions over the 30 dead ones, directly serving the
"read the subset the summary points to" workflow.

**Where it hooks.** `outlineFile` / `collectTopLevelDefinitions`
(`tree-sitter-grammars.ts:381-532`) already parses each summary file's full
tree. While that tree is alive, do one extra call-node walk (the same ported
`calleeName` logic from proposal 2) to build a `name → count` map, then annotate
each outline entry. Because the outline parse already has the whole tree in
hand, the call-node walk is the *only* added work and it shares the existing
parse.

**Cost.** Cheap, FREE-B. No new parse — the summary pass already parsed these ≤10
files. One extra tree walk per outlined file (same sub-ms cost as proposal 2),
inside the existing 2s outline deadline (`code-search.ts:1748`). The real cost
is **response surface**, not CPU: the MCP handler trims aggressively and fits
outlines into the leftover byte budget after hits (`peer-mcp-personas.ts:937-951`).
A per-entry integer is tiny, but it competes for the 256KB cap, so it should be
a small int only (no per-call-site detail).

**Recall honesty.** The count is "usages within the parsed/result set," not
repo-wide call frequency. A symbol called 100× across the repo but 0× within the
matched files reads as `usages: 0`. State this plainly in the field doc so the
model treats it as a *relative* prioritization hint among the result set, never
an absolute popularity metric.

**Zero-state check.** PASS. Counts computed during the existing per-call outline
parse; nothing persisted.

---

### 4. Scoped `callees` / mini edge-set — **EVALUATED, recommend DEFER (not reject)**

**What it would add.** Engram's `findCallees` — for a query that resolves to a
file/symbol, list the definitions *it* calls. Portable in principle: from the
query symbol's owning file's tree, collect callee names, resolve each against
the definitions found in the *other* parsed result files.

**Why it is weaker than 1–3 (defer, don't reject).** It is still index-free and
zero-state, so it does NOT violate the hard constraints. But name-only
resolution against only the result subset is the weakest signal of the four:
unlike "callers" (which only asserts "this file calls *something* named X" — a
robust claim), "callees" must resolve each callee name to a *specific
definition*, and with only the matched files in scope, most callees will resolve
to nothing (their definition file didn't match the query) or resolve ambiguously.
The result is a sparse, low-confidence list that risks misleading more than it
helps. It also needs the definition inventory of every parsed file, pushing
toward an EXTRA parse of result files in literal/regex mode (which parse nothing
today). Value-per-byte is poor against the 256KB cap. Defer until 1–3 are proven
in the wild and there's evidence the model wants it.

**Recall honesty.** Would be "callees resolvable within the result set" — by
construction the sparsest, least-complete of any option here.

**Zero-state check.** PASS in principle, but value does not justify the surface.

---

### REJECTED — `impact` / transitive blast radius

Engram's `findImpact` (`traversal.ts:102-140`) is a backward BFS over the
**whole-repo** file→file dependency graph. Transitivity is the entire point: a
blast radius scoped to one search's matched files is not a blast radius, it is a
truncated and actively misleading subset (it would report "3 files affected"
when the real answer is 300). There is no faithful index-free version: a correct
impact answer requires the persistent whole-repo edge set we are refusing to
build (sql.js / `.engram` / background indexer). **Rejected outright** — it
cannot avoid a persistent index, and a scoped approximation would be worse than
omitting it.

---

## Top recommendation — if we do ONE thing, do **Proposal 1 (per-hit `role` tag)**

It is the only **truly free** option (reuses `confirmedHitIndexes`, zero extra
parses, zero extra walks), it is honest by construction (it answers "is this hit
a definition?" — a per-hit fact needing no graph, so the scoped-recall caveat
barely applies), and it lands the single highest-frequency value: "where is X
*defined*" vs "where is X *mentioned*" — exactly what the tool's own description
sells. It adds one optional word per hit, well within the minimality principle
(`docs/peer-mcp-design.md`), and the model can act on it immediately (jump to the
definition site).

If a second lands, **Proposal 2 (`callers_in_results`)** is the natural next
step — it is the cheap, scoped, zero-state port of Engram's actual `findCallers`
value, with a clearly-stated "within the result set, not the repo" caveat. It
costs one extra bounded walk over trees already in cache, no new parse.

Proposals 3 and 4 are real but second-order; gate them on evidence the model
uses 1–2 before spending response-surface budget on them.

---

## Constraint compliance summary

| # | Proposal | Cost class | Persistent index? | Verdict |
|---|---|---|---|---|
| 1 | per-hit `role` (def/usage) | FREE-A | none | **adopt first** |
| 2 | `callers_in_results` | FREE-A + bounded walk | none | adopt second |
| 3 | outline `usages` count | FREE-B | none | defer (surface cost) |
| 4 | scoped `callees` | EXTRA-leaning | none | defer (weak signal) |
| — | `impact` / blast radius | whole-repo | **REQUIRED** | **reject** |

Every adopted/deferred proposal confirmed zero-state: all reuse the per-call
ephemeral tree cache (`_treeCache`) or the per-call outline parse, both of which
already exist and die when the search returns. No `.engram` file, no sql.js, no
background indexer, no cross-session cache is introduced by 1–4.
