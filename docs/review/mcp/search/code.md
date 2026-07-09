# Review: `mcp__search__code`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__search__code` |
| Group / server | `search` (serverInfo `github-router-search`) |
| Wire tool name | `code` |
| Definition | `src/lib/peer-mcp-personas.ts:865` (NON_PERSONA_MCP_TOOLS) |
| Always-on? | yes (always listed) |
| Capability gate | none for listing. Semantic mode is availability-gated internally: `colbertSearchEnabled()` decides ColBERT-vs-lexical-fallback inside `runUnifiedCodeSearch` (`src/lib/unified-code-search.ts:194`); the tool never disappears |
| Backing model / endpoint | server-side fn (`runUnifiedCodeSearch`); ColBERT/colgrep sidecar for semantic, ripgrep/ast-grep/tree-sitter for lexical. No LLM call |
| Write-capable | no (read-only; spawns read-only child processes, no repo writes) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/peer-mcp-personas.ts:867-895`):

> Fast structured code search over a local workspace. Default (`mode:"semantic"`, or omit `mode`) ranks by MEANING via ColBERT over a per-workspace index — best for intent/concept queries where the literal keywords may not appear ("where do we rate-limit", "auth token refresh"). When that index is building/stale/absent it TRANSPARENTLY returns lexical (BM25F) results and labels the response `source` ("lexical-fallback") so a degrade is never silent. On a `lexical-fallback` the `notice` says how to proceed: retry `mode:"semantic"` shortly (the index self-heals in the background) or re-query with specific symbols — the lexical engine matches keywords/symbols, not natural-language phrases. Other modes force the lexical engine: `lexical` (BM25F ranked, best for exact symbols), `exact` (fixed-string), `regex` (PCRE2), `ast` (ast-grep structural via `ast_pattern`+`ast_lang`). Lexical ranking refines a `symbol-context` field with tree-sitter AST analysis so definitions outrank incidental matches. Launch multiple code searches in parallel to triangulate — e.g. definition + callers + tests in one round-trip. Prefer this over Grep/Bash+grep for ranked discovery ("where is X defined", "which files reference Y", "find code that does Z"). Use Grep for exact-pattern enumeration when you need every hit unranked, and Glob for file-name patterns (no content match). `workspace` is any absolute path the proxy process can read — typically the project root or a sub-tree you're working in. Each response also carries a tree-sitter structural outline of the matched files (`summary` on by default; set it false to omit).

Input schema fields (`src/lib/peer-mcp-personas.ts:896-1022`), `required: ["query", "workspace"]`, `additionalProperties: false`:

- **`query`** (string): "Search text. In the default 'semantic' mode it's natural-language intent (finds code by meaning even when the words don't appear literally). In 'lexical'/'exact' modes it's a literal string (single-identifier queries auto-expand across camelCase / snake_case / kebab-case / SCREAMING_SNAKE so `getUserName` also matches `get_user_name`). In 'regex' mode it's a PCRE2 regex."
- **`workspace`** (string): "Absolute path to the project root (or sub-tree) to search."
- **`mode`** (enum `semantic|lexical|exact|regex|ast`): "Search mode. 'semantic' (DEFAULT): ColBERT meaning-based ranking over a per-workspace index; transparently falls back to lexical when the index is building/stale/absent (the response `source` says which engine ran). 'lexical': BM25F + tree-sitter structural boost, ordered by score with shoulder pruning — best for exact symbols. 'exact': fixed-string, ripgrep document order. 'regex': PCRE2, ripgrep document order. 'ast': ast-grep structural match (requires `ast_pattern` + `ast_lang`)."
- **`pattern`** (string): "Semantic mode only: regex pre-filter (colgrep -e) — grep first, then rank the matches semantically. Use to scope a semantic ranking to e.g. async fns. Ignored in lexical modes."
- **`file_glob`** (string): "Optional ripgrep glob filter (e.g. 'src/**/*.ts')."
- **`limit`** (number): "Max hits to return (default 200)."
- **`structural`** (enum `full|topN`): "Structural-ranking depth (lexical mode only). 'full' (default) runs tree-sitter on the top 50 BM25F hits — best signal, fine for typical repos. 'topN' restricts to the top 10 for tighter latency on very large workspaces. Both modes share a 200ms wall-clock budget; on budget exhaustion the response includes `notice` and remaining hits fall back to the regex symbol heuristic."
- **`summary`** (boolean): "Structural summary, ON BY DEFAULT: the response includes `outlines` — a tree-sitter outline (top-level symbols + line numbers) of the distinct files in the result set (first 10, in result order), a compact map of where the matches live that augments each hit's `snippet`. Set false to omit it when you only need the matching lines."
- **`complete`** (boolean): "Exhaustiveness (lexical mode). Default false — lexical mode applies a precision shoulder cut + a per-file cap so you aren't overwhelmed, and the response `notice` tells you when matches were hidden. Set true to disable both and return the COMPLETE match set (every line `grep` would find, reordered by relevance), capped only by `limit` — use it when you must not miss any occurrence (e.g. "every caller of X", a rename, an audit)."
- **`multiline`** (boolean): "Default false. Set true WITH mode:'regex' to let a pattern span newlines (ripgrep -U)... Off by default keeps the line-oriented recall floor."
- **`scan`** (boolean): "Default false. Set true to make `outlines` a tree-sitter symbol map of the ENTIRE workspace (every non-ignored source file), not just the matched files — use it to map an unfamiliar codebase in one call. Capped; `notice` reports coverage when truncated. Independent of which files matched the query."
- **`ast_pattern`** (string): "ast-grep structural pattern... When set, matches come from ast-grep INSTEAD of ripgrep... Takes PRECEDENCE over `query` for matching (but `query` is still required). REQUIRES `ast_lang`... If ast-grep isn't installed, you get a `notice` to run it directly — it never falls back to regex."
- **`ast_lang`** (string): "Grammar for `ast_pattern` (REQUIRED alongside it): 'ts' | 'tsx' | 'js' | ... omitting it returns a `notice` (no language is guessed...)."

Response shape (handler `src/lib/peer-mcp-personas.ts:1069-1153`): `{source, results: [{file, line, snippet, role?, endLine?, name?, score?}], truncated, outlines?, notice?}`. `role` only on lexical hits (`unified-code-search.ts:167`); `endLine`/`name`/`score` only on `source:"semantic"` rows (`unified-code-search.ts:235-237`). 256KB size cap with a size-cap `notice` (`peer-mcp-personas.ts:1140-1144`).

### 2b. System prompt (`--append-system-prompt`)

The `code` tool gets a full sentence in paragraph 2 of `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:596`), verbatim:

> `mcp__search__code` is the one-stop code search (no extra model call). Its DEFAULT mode (or `mode:"semantic"`) ranks by MEANING via ColBERT over a per-workspace index, the first thing to reach for on intent/concept questions ("where is retry/backoff handled", "how does auth work"); when that index isn't ready it transparently falls back to lexical (the response `source` says which engine ran). Forced modes cover the rest: `lexical` (BM25F-ranked + tree-sitter, best for exact symbols), `exact`, `regex`, `complete` (exhaustive set), `ast_pattern`+`ast_lang` for multi-line AST shapes, `scan` for a whole-workspace symbol outline, `multiline` for cross-line regex. Multiple queries can run in a single turn. The index covers code-shaped files; for unstructured files (logs, `.csv`, `.env*`, config-only wiring), `grep`/`glob` still apply.

(The `searchKey` interpolates to `search` on the default no-collision path.) This is the only clause naming the tool in the snippet.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The covering injected block is **peer-awareness** — the same `buildPeerAwarenessSnippet` text as 2b, appended to the mirror via `appendPeerAwarenessToMirroredClaudeMd` (`src/lib/claude-md-injection.ts:653`). No separate CLAUDE.md text for this tool; the mirror and the `--append-system-prompt` carry identical bytes.

The checked-in root `CLAUDE.md` documents the tool at length across two spots: the "Peer review and advisor" paragraph (the `mcp__search__code` semantic-first sentence, matching the snippet), and the "Semantic code search (folded into the `code` tool, ON by default)" section (the ColBERT/fallback/contract-split/freshness detail). Both agree with the code: default `limit` 200, `summary` on by default, 3-valued `source`, forced lexical family never touches colgrep, `scan`/`complete`/`multiline`/`ast_pattern`+`ast_lang` semantics all match `unified-code-search.ts` + `code-search.ts` + the floor doc.

## 3. Assessment

### 3a. Description quality

**Clarity & routing signal — strong.** The description does the hardest routing job in the surface well: it tells the model when to reach for semantic (intent/concept), when to force a lexical mode (exact symbols, regex, AST), and explicitly when NOT to use it (Grep for exhaustive unranked enumeration, Glob for filename patterns). The "launch multiple in parallel to triangulate" line is a genuine capability hint, not filler. The `source`/`notice` self-correction loop is spelled out so a `lexical-fallback` is not a dead end.

**Accuracy vs implementation — accurate.** Spot-checked every load-bearing claim:
- Default `mode:"semantic"` and the fallback chain: `unified-code-search.ts:184-248` — omitted mode ⇒ semantic; `!colbertSearchEnabled()` ⇒ `lexical-fallback`; runner throw ⇒ `lexical-fallback`; `building|stale|unavailable|failed` ⇒ `lexical-fallback` with a status-specific notice (`fallbackNoticeFor`, `unified-code-search.ts:104-119`).
- `pattern` is semantic-only and ignored in lexical modes: `runUnifiedCodeSearch` passes `pattern` ONLY into `runSemanticSearch` (`unified-code-search.ts:214`); `runLexical` never forwards it (`unified-code-search.ts:143-160`). Description matches.
- `ast` mode requires `ast_pattern`+`ast_lang`, never falls back to regex, discloses via `notice` when `sg` absent: consistent with `code-search-floor.md:124-137` and the handler wiring (`unified-code-search.ts:156-157` only forwards `ast_pattern`/`ast_lang` when `mode==="ast"`).
- `complete` disables shoulder cut + per-file cap (lexical only): `code-search-floor.md:16-20`. `structural` default `full` (top 50) vs `topN` (top 10) with 200ms budget: matches `code-search-floor.md` + description.
- Default `limit` 200, `summary` on by default: schema + `code-search-floor.md:15`.

No stale model id (there is no model — server-side fn). No wrong default found.

**Schema minimality — passes, with one deliberate omission worth recording.** Against the three-way test in `docs/peer-mcp-design.md:314-320`:

| Field | Verdict | Test |
|---|---|---|
| `query`, `workspace` | keep | (a) required to call |
| `mode` | keep | (b) model tunes semantic-vs-lexical-vs-regex-vs-ast to improve outcome |
| `limit` | keep | (b)/(c) model raises on `truncated` |
| `structural` | keep | (b) drop to `topN` on a huge repo |
| `summary` | keep | (b) turn off outlines when only lines are needed |
| `complete` | keep | (b) exhaustive audit vs precision default |
| `multiline` | keep | (b) cross-line regex is a distinct capability |
| `scan` | keep | (b) whole-workspace map is a distinct capability |
| `ast_pattern`, `ast_lang` | keep | (b) structural-match capability; `ast_lang` required for correctness |
| `pattern` | keep (borderline) | (b) narrow the semantic candidate set. See finding [Suggestion-1] |
| `file_glob` | keep | (b) scope the search |

Response fields all pass: `file`/`line`/`snippet` are payload; `source` is the actionable engine-provenance signal; `truncated`, `notice` are self-correction levers; `role`/`endLine`/`name`/`score` are present-iff-carried and interpretable. The handler explicitly does NOT forward BM25F scores, field contributions, scanned-files, or elapsed-ms (`peer-mcp-personas.ts:854-864` comment + trimming loop). This matches the worked-example table in `docs/peer-mcp-design.md:328-343` field-for-field.

One thing NOT exposed: the backend accepts `context_lines` (default 2, max 10 — `src/lib/code-search.ts:124,147,194,452`) and `runUnifiedCodeSearch` forwards it (`unified-code-search.ts:49,156`), but the MCP schema omits it. This is a correct minimality cut (the model rarely improves an outcome by tuning context window), so it is not a gap — recording it so a future contributor does not "add it back" thinking it was an oversight.

Verdict on the central minimality question: this is a 12-field input schema and it is still justified. Each field unlocks a distinct engine or a distinct precision/recall lever the model can reason about. Nothing here is an echoed input or a diagnostic-for-humans. The tool earns its size by being the single search entry point (it folds in what would otherwise be `semantic_search` + `code_search` + an `ast` tool + a `scan` tool).

### 3b. System-prompt coverage

**Named, correctly.** The snippet names `mcp__search__code`, gives the default-semantic routing signal, lists the forced modes, and steers unstructured-file lookups to `grep`/`glob`. That last steer (`.env*`, logs, `.csv`, config-only wiring) is a real value-add not in the tool description — the semantic index covers code-shaped files, so pointing the model elsewhere for non-code is accurate and non-redundant.

**Framing-constraint compliance — passes.** The clause is declarative ("is the one-stop code search", "the first thing to reach for") not imperative. "the first thing to reach for on intent/concept questions" is a scoped routing statement, not a blanket "always use this first" anchor, and it is qualified to a question class. No hedges, no rationale-as-description.

**Redundancy — minor, acceptable.** The snippet and the tool description overlap on the semantic-default + fallback-`source` story. This is by design: the description is read at `tools/list` time, the snippet primes the model before it ever lists tools, and the two live on different surfaces. The snippet is deliberately shorter and adds the parallel-queries + unstructured-file routing the description states differently. Not bloat.

### 3c. CLAUDE.md coverage

**Accurate, not drifted (for this tool's own facts).** The mirrored peer-awareness block is byte-identical to 2b. The checked-in root CLAUDE.md "Semantic code search" section and "Peer review and advisor" paragraph both match `unified-code-search.ts` and the floor/semantic docs on every checked fact (default mode, fallback provenance, contract split, forced-lexical family, `scan`/`complete` semantics, freshness verdict).

### 3d. Cross-surface consistency

Description ↔ snippet ↔ CLAUDE.md ↔ code are consistent on all `code`-tool-specific facts. The one drift I found is NOT in this tool's surface: `docs/peer-mcp-design.md:351,359-365` still says the `explore`/`review` **worker** defaults are `gpt-5.5`, while the code and root CLAUDE.md say explore → `gpt-5.4-mini` (gate sentinel) / `claude-sonnet-5` and review → `gemini-3.1-pro-preview`. That belongs to the worker-tools review, not here, but it sits in the same design doc that holds the `code` worked example, so a reader cross-referencing could be misled — flagged as [Suggestion-2] for traceability.

## 4. Findings

- **[Suggestion-1]** `src/lib/peer-mcp-personas.ts:931-937` — `pattern` is the weakest-justified input field. It is semantic-mode-only, silently ignored in every lexical mode, and overlaps conceptually with `file_glob` (both narrow the candidate set) and with just putting terms in `query`. It passes test (b) narrowly (pre-filtering to e.g. async fns before semantic ranking is a real lever), so keep it, but it is the first field to reconsider if the schema is ever trimmed. Fix: none required; if revisited, verify with a usage probe whether the model ever sets it.
- **[Suggestion-2]** `docs/peer-mcp-design.md:351,359-365` — the worker-tools default-model table in the SAME doc that holds the `code` worked example is stale (`explore`/`review` shown as `gpt-5.5`; actual: explore `gpt-5.4-mini`/`claude-sonnet-5`, review `gemini-3.1-pro-preview`). Not part of the `code` surface, but a reader landing on the minimality worked example may scroll into wrong worker facts. Fix: update the table to match `src/lib/worker-agent/engine.ts` constants (owned by the worker-tools reviewer).
- **[Suggestion-3]** `src/lib/peer-mcp-personas.ts:896-1022` — `context_lines` is a real, forwarded backend param deliberately not surfaced in the MCP schema. Correct cut, but undocumented as intentional. Fix: one line in the schema comment block (`peer-mcp-personas.ts:854-864`) noting `context_lines` is intentionally omitted (not model-tunable-to-improve-outcome) so a future contributor does not re-add it.

No Critical or Important findings. No case where the description tells the model to do something the code rejects; the `additionalProperties: false` schema plus permissive `typeof` guards in the handler (`peer-mcp-personas.ts:1030-1066`) mean a malformed arg degrades to `undefined` rather than erroring, and required `query`/`workspace` are enforced upstream.

## 5. Verdict

**Y — correct, minimal, consistent, and well-routed.** This is the largest input schema in the surface and it holds up as the worked example of ruthless minimality: every one of the 12 input fields and every response field is required, a real model-tunable lever, or actionable feedback, with internal diagnostics correctly withheld. Single most important fix: none blocking — the top polish item is [Suggestion-3], record that `context_lines` is an intentional omission so it is not mistaken for a gap.
