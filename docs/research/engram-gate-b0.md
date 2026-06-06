# Gate B0 — Engram source verification (for the deferred Phase B graph)

Read-only verification of the load-bearing claims behind a future "vendor Engram's graph
slice" effort (Phase B of the approved plan). Performed against a fresh clone of
`github.com/NickCirv/engram`.

- **Clone HEAD:** `4c344cce849eacf2395a28ef21bfacbda2195f3b`
- **Engram package version:** `4.3.2`
- **Verified:** 2026-06-06

## Verdict table

| # | Claim | Status | Evidence |
|---|---|---|---|
| 1 | `src/graph/traversal.ts` is pure, zero store coupling | **CONFIRMED** | Imports only `type { GraphEdge, GraphNode } from "./schema.js"`. `findCallers`/`findCallees`/`findImpact` operate on `readonly` arrays; no `store`/`getGraph` reference. The "vendor only 3 files" strategy is valid. |
| 2 | `schema.ts` carries bi-temporal + mistake fields and `calls`/`imports`/`contains` relations | **CONFIRMED** | `GraphNode` has `validUntil`/`invalidatedByCommit` (v3) + `thenBelieved`/`foundFalseAt`/`truthNow`/`appliesTo` (v4); a trim cleanly removes the optional tier. Relations present. |
| 3 | `path-utils.ts` `toPosixPath` is a zero-dep pure util | **CONFIRMED** | Single export, no imports, pure string replace. |
| 4 | web-tree-sitter ABI is incompatible with the proxy's pin | **CONFIRMED (incompatible)** | Engram pins `web-tree-sitter ^0.26.8` + grammar pkgs `^0.24–0.25`; proxy pins `web-tree-sitter 0.22.6` + `tree-sitter-wasms ^0.1.13`. 0.26 uses a separate `Language` object + `Parser.setLanguage()`; 0.22 differs. **A direct copy of `reference-miner.ts`/`grammar-loader.ts` would fail at parse time** — Phase B must reimplement the call-extraction on 0.22 (or bump web-tree-sitter, which would force re-validating `code-search.ts`'s structural pass). This is the decision-justifying finding, not a blocker. |
| 5 | `ast-miner.ts` is regex-based and emits NO `calls` edges; the call signal lives in `reference-miner.ts` | **CONFIRMED** | `ast-miner.ts` extracts defs/imports/exports via regex; `reference-miner.ts` uses tree-sitter to pull callee names then `resolveCallEdges()` emits `calls` edges. |
| 6 | Reference-miner caps: ≤60 refs/file, drop names resolving to >10 defs | **CONFIRMED (exact)** | `MAX_REF_FILE_BYTES = 1_000_000`, `MAX_AMBIGUOUS_DEFS = 10`, `maxPerFile` default `60`. |
| 7 | Graph recall figure | **CONFIRMED, real (not confabulated)** | `bench/recall-coverage.ts` + ADR-0009: recall@10 **33.0%**, recall@5 24.7%, MRR 0.466. Candidate generation reaches 43.0%; PageRank captures 76.6% of that at @10. The earlier "~33%" estimate was accurate — treat the graph as a low-recall heuristic, not LSP-grade. |
| 8 | License Apache-2.0; NOTICE obligation | **CONFIRMED; no NOTICE file** | LICENSE is Apache-2.0 (© 2026 Nicholas Ashkar). **No `NOTICE` file exists** at the repo root, so §4(d) reproduction does not apply — vendoring only needs to preserve the LICENSE + per-file attribution. |

## What this means for Phase B

- The three pure modules (`traversal.ts`, `schema.ts` trimmed, `path-utils.ts`) are vendorable
  as-is into `src/vendor/engram/`.
- The call-graph builder is NOT directly vendorable: `reference-miner.ts` is coupled to
  web-tree-sitter 0.26. Phase B's first spike (reimplement call-extraction on the proxy's 0.22
  `Parser.SyntaxNode`, or evaluate a web-tree-sitter bump) remains the correct gate.
- The recall ceiling (~33%) confirms the plan's "bounded additive boost / honest tool
  descriptions" posture — graph edges must augment, never override, the BM25F `code` ranking, and
  `impact` must be framed as heuristic.
- Phase B remains gated on Gate B1 (prove value vs the stateless ripgrep + on-demand-structural
  baselines) before committing to the persistent indexer + `sql.js` dependency.
