# `code_search` recall floor — the never-worse guarantee

This documents the guarantee `code_search` provides about *completeness*: what it will and
will not drop. The load-bearing claim is narrow and provable — in `complete` mode it drops
nothing by its own heuristics (only the explicit `limit`) — plus the honest, scoped
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
two precision reducers **by default** — and `complete: true` disables both.

## The constructed ripgrep invocation

`code_search` never invents matches and never drops them by heuristic in `complete` mode —
its candidate set is *exactly* what one specific ripgrep command produces. Define that
command, for a query `Q` in mode `m` (see `buildRgArgs`):

```
C(Q, m) = rg --json --no-binary --no-follow [-C ctx] FLAG [-g glob] -- PATTERN .
```

- **PATTERN** = `Q` verbatim, EXCEPT when `Q` is a single identifier in `ranked`/`literal`
  mode — then PATTERN is the regex alternation of `Q`'s camelCase / PascalCase / snake /
  kebab / SCREAMING skeletons (so `getUserName` also matches `get_user_name`).
- **FLAG** = `-F` (fixed-string) for `literal`/`ranked` without expansion; `--pcre2` for
  `regex` mode or whenever an expansion alternation is used.
- **`--no-binary`** (skip binary files) and **`--no-follow`** (don't traverse symlinks)
  scope the universe to *source text not reached through a symlink*. This is a deliberate,
  documented scoping for code search — a byte match inside a `.png`, or a file reachable only
  by escaping the workspace via a symlink, is not "code". It is the one way `C(Q,m)` is NOT a
  literal superset of a bare `rg Q`, and it is intentional, not a recall miss.
- In **`complete` mode the per-file `--max-count` is omitted**, so `C` emits *every* match
  per file.

## The floor theorem (scoped to the constructed invocation)

> For any query `Q`, mode `m`, workspace `W`, and limit `L`:
> `code_search(Q, W, mode: m, complete: true, limit: L)` returns a BM25F-reordering (ranked)
> / document-order slice (literal/regex) of AT MOST the first `L` match events streamed by
> `C(Q, m)`. **No match is dropped by `code_search`'s own heuristics** — there is no score
> shoulder-cut and no per-file cap; the SOLE reducer is the explicit `L`, signalled via
> `truncated: true`.

**Proof.** With `complete: true`, `buildRgArgs` omits `--max-count` and the ranked branch
uses `pass2` directly instead of `shoulderCut(pass2)`; in `literal`/`regex` neither reducer
exists. The candidate set is exactly `parseRgJsonStream`'s output — the match stream of
`C(Q, m)` — halted only once `L` total matches accumulate. `sortByScore` is an in-place
`Array.sort` (a permutation: it reorders, removes nothing). Hence the result is a permutation
of the streamed matches, truncated only at `L`. ∎

**Determinism caveat.** When the total match count ≤ `L`, the result IS the complete match set
of `C(Q, m)` and is deterministic. When total > `L`, *which* `L` survive the global-cap kill
follows ripgrep's own streaming order (ripgrep is multi-threaded and we do not pass `--sort`),
so the truncated SUBSET may vary across runs. The guarantee is therefore "`code_search` never
drops a streamed match by its own scoring/per-file heuristics — only at the explicit `L`," not
"an identical truncated subset every run." For an exhaustive, order-stable result, raise `L`
past the total (then `truncated: false`).

## How it relates to rg / grep / ast-grep / tree-sitter

Let `M(cmd)` be a command's match set on text files. For `complete: true`:

- **= the ripgrep it runs.** `R` is a permutation of `M(C(Q,m))` truncated at `L`; `code_search`
  never drops a match `C(Q,m)` streams (before `L`) by its own heuristics. This is the
  load-bearing guarantee — everything below is *relative to `C`'s flags*, not generic tools.
- **vs naive `rg Q` / `grep Q` (same flags):**
  - *single ASCII identifier `Q`* — expansion triggers only for `^[A-Za-z][A-Za-z0-9_-]*$` (no
    regex metacharacters) and the alternation includes `Q` itself as a branch, so
    `M(C) ⊇ M(rg -F Q)`: a strict **superset** (also finds `get_user_name` for `getUserName`).
  - *multi-token / regex `Q`* — `M(C) = M(rg Q)`.
  - **Scope, not dominance:** `C` fixes `--no-binary --no-follow` + the workspace's ignore
    rules, so `code_search` is `≥` *rg with the same flags*, NOT `≥` `rg -a`/`grep -a`
    (binary-as-text), `rg -L` (follow symlinks), or `--no-ignore`. Known blind spot:
    `--no-binary` is a NUL-byte heuristic, so a real source file containing a NUL byte (e.g.
    UTF-16-without-BOM) can be misclassified binary and silently excluded.
- **vs `ast-grep`: NOT a superset.** ripgrep here is line-oriented (no `--multiline`), while
  `ast-grep` matches multi-line AST constructs ripgrep cannot. The honest relationship: for a
  single-token symbol occurrence ripgrep finds the line, and `code_search` *adds* AST
  confirmation via `role: "definition"` — it does not subsume `ast-grep`'s structural patterns.
- **vs `tree-sitter` alone: a bounded subset, not a superset.** `outlines` is a tree-sitter
  outline of only the (≤ `CODE_SUMMARY_MAX_FILES`) distinct *result* files, capped at
  `MAX_OUTLINE_ENTRIES` and budget-fitted into 256 KB. A full-workspace tree-sitter scan would
  see definitions in files `code_search` never matched. The outline *enriches* results; it does
  not replace an AST search.

The empirically-proven prior violation it fixes: `"ab"` in old ranked mode returned 4 hits
while `M(C)` had 5 — the shoulder cut silently dropped `fabric`. Under `complete: true` that
cannot happen; pinned by `tests/code-search.test.ts` ("floor guarantee").

## Side effects

`code_search` performs **no repository writes and maintains no persistent or cross-call index**.
Its only observable effects are spawning a read-only `rg` child process and updating an
in-memory, mtime-gated parse cache (`_treeCache`, freed on eviction) — nothing survives the
process. That is the side-effect bound: no workspace mutation, no on-disk artifact, no
background process.

## The default is precise — but never *silently* lossy

The default (`complete` unset) keeps the shoulder cut + per-file cap so the model isn't
flooded with low-relevance noise on a broad query. The floor is preserved at the **contract**
level: whenever **either** reducer hides matches, the response `notice` says so and points at
`complete: true`. Both disclosures accumulate (joined with ` · `), so neither overwrites the
other nor the structural-budget fallback:

> `"3 lower-relevance matches hidden by precision pruning — pass complete:true for the full set"`
> `"2 files hit the per-file match cap — pass complete:true for every match"`

The per-file-cap disclosure is conservative: ripgrep's `--max-count` does not report how many it
truncated, so we flag any file that *reached* the cap (a file with exactly `RANKED_MAX_PER_FILE`
real matches may trigger it) — erring toward over-disclosure rather than a silent miss.

So a default-mode miss is never *silent*: the model always knows the result is pruned and
how to get the complete set in one follow-up call. (`limit` truncation is likewise always
reported via `truncated: true`.)

## Accuracy: the `role` tag never lies

A hit carries `role: "definition"` **only** when the tree-sitter structural pass AST-confirms
it is the symbol's definition site. Absence of the tag is **not** a claim that the hit is a
usage — a hit may simply not have been AST-checked (unsupported language, file over the 1 MiB
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

The one thing outside our control is the user's `limit` — and that loss is always reported.
</content>
