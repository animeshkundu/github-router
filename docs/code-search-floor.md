# `code_search` recall floor - the never-worse guarantee

This documents the guarantee `code_search` provides about *completeness*: what it will and
will not drop. The load-bearing claim is narrow and provable - in `complete` mode it drops
nothing by its own heuristics (only the explicit `limit`) - plus the honest, scoped
relationship to `rg`/`grep`, `ast-grep`, and `tree-sitter` used alone. Implementation:
`src/lib/code-search.ts`.

## The reducers

A `code_search` call can only reduce the candidate match set through these points:

| Reducer | When it applies | Drops by |
| --- | --- | --- |
| `limit` (default 200) | always | explicit count, **signalled** via `truncated: true` |
| shoulder cut (`shoulderCut`, `SHOULDER_THRESHOLD = 0.5`) | ranked mode, **default only** | relevance score (< 50% of top) |
| per-file `--max-count` (`RANKED_MAX_PER_FILE = 50`) | ranked mode, **default only** | per-file match count |

`literal`/`regex` modes never rank, so they apply **only** `limit`. Ranked mode adds the
two precision reducers **by default** - and `complete: true` disables both.

## The constructed ripgrep invocation

`code_search` never invents matches and never drops them by heuristic in `complete` mode -
its candidate set is *exactly* what one specific ripgrep command produces. Define that
command, for a query `Q` in mode `m` (see `buildRgArgs`):

```
C(Q, m) = rg --json --no-binary --no-follow [-C ctx] FLAG [-g glob] -- PATTERN .
```

- **PATTERN** = `Q` verbatim, EXCEPT when `Q` is a single identifier in `ranked`/`literal`
  mode - then PATTERN is the regex alternation of `Q`'s camelCase / PascalCase / snake /
  kebab / SCREAMING skeletons (so `getUserName` also matches `get_user_name`).
- **FLAG** = `-F` (fixed-string) for `literal`/`ranked` without expansion; `--pcre2` for
  `regex` mode or whenever an expansion alternation is used.
- **`--no-binary`** (skip binary files) and **`--no-follow`** (don't traverse symlinks)
  scope the universe to *source text not reached through a symlink*. This is a deliberate,
  documented scoping for code search - a byte match inside a `.png`, or a file reachable only
  by escaping the workspace via a symlink, is not "code". It is the one way `C(Q,m)` is NOT a
  literal superset of a bare `rg Q`, and it is intentional, not a recall miss.
- In **`complete` mode the per-file `--max-count` is omitted**, so `C` emits *every* match
  per file.

## The floor theorem (scoped to the LEXICAL constructed invocation)

**Note:** The recall-floor guarantees described below apply strictly to the LEXICAL path only (forced `lexical|exact|regex|ast` modes, plus the semantic fallback). The DEFAULT invocation now runs ColBERT (semantic mode) and is NOT BM25F-floored. The floor theorem is no longer the tool's blanket contract.

> For any query `Q`, mode `m`, workspace `W`, and limit `L`:
> `code_search(Q, W, mode: m, complete: true, limit: L)` returns a BM25F-reordering (ranked)
> / document-order slice (literal/regex) of AT MOST the first `L` match events streamed by
> `C(Q, m)`. **No match is dropped by `code_search`'s own heuristics** - there is no score
> shoulder-cut and no per-file cap; the SOLE reducer is the explicit `L`, signalled via
> `truncated: true`.

**Proof.** With `complete: true`, `buildRgArgs` omits `--max-count` and the ranked branch
uses `pass2` directly instead of `shoulderCut(pass2)`; in `literal`/`regex` neither reducer
exists. The candidate set is exactly `parseRgJsonStream`'s output - the match stream of
`C(Q, m)` - halted only once `L` total matches accumulate. `sortByScore` is an in-place
`Array.sort` (a permutation: it reorders, removes nothing). Hence the result is a permutation
of the streamed matches, truncated only at `L`. ∎

**Determinism caveat.** When the total match count ≤ `L`, the result IS the complete match set
of `C(Q, m)` and is deterministic. When total > `L`, *which* `L` survive the global-cap kill
follows ripgrep's own streaming order (ripgrep is multi-threaded and we do not pass `--sort`),
so the truncated SUBSET may vary across runs. The guarantee is therefore "`code_search` never
drops a streamed match by its own scoring/per-file heuristics - only at the explicit `L`," not
"an identical truncated subset every run." For an exhaustive, order-stable result, raise `L`
past the total (then `truncated: false`).

## How it relates to rg / grep / ast-grep / tree-sitter

Let `M(cmd)` be a command's match set on text files. For `complete: true`:

- **= the ripgrep it runs.** `R` is a permutation of `M(C(Q,m))` truncated at `L`; `code_search`
  never drops a match `C(Q,m)` streams (before `L`) by its own heuristics. This is the
  load-bearing guarantee - everything below is *relative to `C`'s flags*, not generic tools.
- **vs naive `rg Q` / `grep Q` (same flags):**
  - *single ASCII identifier `Q`* - expansion triggers only for `^[A-Za-z][A-Za-z0-9_-]*$` (no
    regex metacharacters) and the alternation includes `Q` itself as a branch, so
    `M(C) ⊇ M(rg -F Q)`: a strict **superset** (also finds `get_user_name` for `getUserName`).
  - *multi-token / regex `Q`* - `M(C) = M(rg Q)`.
  - **Scope, not dominance:** `C` fixes `--no-binary --no-follow` + the workspace's ignore
    rules, so `code_search` is `≥` *rg with the same flags*, NOT `≥` `rg -a`/`grep -a`
    (binary-as-text), `rg -L` (follow symlinks), or `--no-ignore`. Known blind spot:
    `--no-binary` is a NUL-byte heuristic, so a real source file containing a NUL byte (e.g.
    UTF-16-without-BOM) can be misclassified binary and silently excluded.
- **vs `ast-grep`: NOT a superset.** ripgrep here is line-oriented (no `--multiline`), while
  `ast-grep` matches multi-line AST constructs ripgrep cannot. The honest relationship: for a
  single-token symbol occurrence ripgrep finds the line, and `code_search` *adds* AST
  confirmation via `role: "definition"` - it does not subsume `ast-grep`'s structural patterns.
- **vs `tree-sitter` alone: a bounded subset, not a superset.** `outlines` is a tree-sitter
  outline of only the (≤ `CODE_SUMMARY_MAX_FILES`) distinct *result* files, capped at
  `MAX_OUTLINE_ENTRIES` and budget-fitted into 256 KB. A full-workspace tree-sitter scan would
  see definitions in files `code_search` never matched. The outline *enriches* results; it does
  not replace an AST search.

The empirically-proven prior violation it fixes: `"ab"` in old ranked mode returned 4 hits
while `M(C)` had 5 - the shoulder cut silently dropped `fabric`. Under `complete: true` that
cannot happen; pinned by `tests/code-search.test.ts` ("floor guarantee").

## Multi-engine modes: raising the floor over all four

By DEFAULT (none of `multiline`, `scan`, `ast_pattern` set), `code_search` is the
single-engine scoped ripgrep described above - the floor theorem and all caveats hold
unchanged, and the response is byte-identical to before these modes existed (pinned by
`tests/code-search.test.ts`, "default behavior is unchanged"). The three opt-in modes each
RUN the corresponding engine on demand, so the OUTPUT (not a regex approximation) provably
covers that engine when its mode is used:

| Mode | Engine RUN | Floor relationship |
| --- | --- | --- |
| *(default, no mode)* | ripgrep (line-oriented) | `⊇` rg/grep with the same flags (the theorem above). **Never** claimed `⊇` ast-grep. |
| `multiline: true` | ripgrep `-U --multiline-dotall` | `⊇` a multi-line `rg -U` run: it IS that run. Cross-line patterns (`foo[\s\S]*?bar`) the default line-oriented mode cannot match are found. Cross-line matching is a **`mode: "regex"`** feature - the `query` validator rejects literal newlines, so a `literal`/`ranked` multi-line LITERAL can't be expressed (the `-U -F` combo is valid but un-feedable). |
| `ast_pattern: <p>` + `ast_lang: <L>` | ast-grep (`sg run -p <p> --lang <L> --json=stream`) | `=` ast-grep's own output for that pattern in grammar `<L>` - it RUNS ast-grep and returns its matches in `{file,line,snippet}` shape. Match generation comes from ast-grep, NOT regex, so a multi-line AST construct is matched directly. `ast_lang` is **required** (see caveat). |
| `scan: true` | ripgrep `--files` + tree-sitter outline of the whole tree | `⊇` a whole-workspace tree-sitter scan (up to `SCAN_MAX_FILES`): `outlines` covers EVERY non-ignored, non-sensitive source file, not just matched files. |

**Honest caveats (unchanged in spirit):**

- With **no mode set**, the original single-engine scoping still holds: the default is
  line-oriented ripgrep and is NOT a superset of ast-grep's structural patterns. We never
  assert `⊇ ast-grep` for the DEFAULT (regex) mode - only when `ast_pattern` is used does the
  output equal ast-grep's, because ast-grep is the engine that produced it.
- `ast_pattern` requires **ast-grep (`sg`) to be present** (toolbelt bin dir or system PATH).
  When it is absent, `code_search` returns `{results: [], notice: "ast_pattern requires
  ast-grep (sg), which isn't available here; the model can run ast-grep directly or omit
  ast_pattern"}` with `isError: false` - a graceful disclosure, NOT a silent fall-back to
  regex (which would quietly violate the `= ast-grep` claim). `ast_pattern` takes precedence
  over `query` for match generation; AST hits are document-order (no BM25F - there is no
  text-token relevance signal for a structural match).
- `ast_pattern` **requires `ast_lang`** (the grammar id: `ts` / `tsx` / `js` / `py` / `rust` /
  `go` / …). ast-grep parses the pattern in that grammar; WITHOUT a language it cross-matches
  every language and returns garbage (e.g. matching markdown prose). So `code_search` fails
  closed - `ast_pattern` set without `ast_lang` returns `{results: [], notice: "ast_pattern
  requires ast_lang …"}`, never garbage. The `= ast-grep` floor relationship therefore holds
  for `ast_pattern` + `ast_lang` together, scoped to grammar `<L>`. Pinned by
  `tests/code-search.test.ts` ("cross-language-garbage regression").
- `scan` is **budget-capped at `SCAN_MAX_FILES` and the 256 KB response envelope**, with
  disclosure: when truncated, `notice` reports `outlined N of M workspace source files`. The
  enumeration respects the same `.gitignore`/`.ignore` rules as the search path (it is the
  same `rg --files`), and the sensitive-path denylist (`.env*`, `*.pem`, `id_rsa*`, `.git/`
  interior, `.ssh/`, …) is applied so a scan never surfaces symbol names from a credential
  file. `scan` is independent of match generation: the hit set still comes from the query (or
  `ast_pattern`); only `outlines` widens to the whole tree.

The bottom line: `code_search`'s OUTPUT is `⊇` each engine WHEN that engine's mode is used (and
ast-grep present) - it raises the floor over rg/grep AND ast-grep AND a tree-sitter scan by
RUNNING those engines, not by regex emulation. The default stays the proven single-engine floor.

## Side effects

`code_search` performs **no repository writes and maintains no persistent or cross-call index**.
Its only observable effects are spawning read-only child processes - `rg` (search; plus a
second `rg --files` enumeration under `scan: true`), and a read-only `ast-grep` (`sg`)
subprocess under `ast_pattern` - and updating an in-memory, mtime-gated parse cache
(`_treeCache`, freed on eviction); nothing survives the process. The `ast-grep` child is
spawned with `shell: false` (argv form, no shell-metacharacter injection from a workspace path
containing `% & | ( ) ! "` or spaces), workspace-confined, with router credentials
(`GH_ROUTER_*`, `GITHUB_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`COPILOT_TOKEN`) stripped from its env, stdout-capped, and timeout-bounded. That is the
side-effect bound: no workspace mutation, no on-disk artifact, no background process.

## The default is precise - but never *silently* lossy

The default (`complete` unset) keeps the shoulder cut + per-file cap so the model isn't
flooded with low-relevance noise on a broad query. The floor is preserved at the **contract**
level: whenever **either** reducer hides matches, the response `notice` says so and points at
`complete: true`. Both disclosures accumulate (joined with ` · `), so neither overwrites the
other nor the structural-budget fallback:

> `"3 lower-relevance matches hidden by precision pruning - pass complete:true for the full set"`
> `"2 files hit the per-file match cap - pass complete:true for every match"`

The per-file-cap disclosure is conservative: ripgrep's `--max-count` does not report how many it
truncated, so we flag any file that *reached* the cap (a file with exactly `RANKED_MAX_PER_FILE`
real matches may trigger it) - erring toward over-disclosure rather than a silent miss.

So a default-mode miss is never *silent*: the model always knows the result is pruned and
how to get the complete set in one follow-up call. (`limit` truncation is likewise always
reported via `truncated: true`.)

## Accuracy: the `role` tag never lies

A hit carries `role: "definition"` **only** when the tree-sitter structural pass AST-confirms
it is the symbol's definition site. Absence of the tag is **not** a claim that the hit is a
usage - a hit may simply not have been AST-checked (unsupported language, file over the 1 MiB
parse cap, parse error, or the 200 ms structural budget was exhausted). We never assert a
false negative.

## What "misses none" means, honestly

Within the realms of reality, the guarantees are:
1. **`complete: true`** ⇒ every match of the constructed invocation `C(Q, m)` up to `limit`
   (a superset of naive `rg Q` for single identifiers; equal for multi-token/regex queries,
   modulo the intentional `--no-binary`/`--no-follow` scoping), reordered, nothing dropped by
   heuristic. Raise `limit` for more; `truncated` tells you when you've hit it.
2. **default** ⇒ precision-pruned, but the prune is always disclosed via `notice` + reversible
   via `complete: true`.
3. **structure** ⇒ a full nested outline of the result files by default; the model can decide
   what to actually open without missing a symbol.
4. **accuracy** ⇒ `role: "definition"` is emitted only when proven.

The one thing outside our control is the user's `limit` - and that loss is always reported.
</content>
