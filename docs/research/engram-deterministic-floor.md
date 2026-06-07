# Engram — the deterministic floor: what raises it BY CONSTRUCTION

Read-only adversarial investigation. The filter is strict: a mechanism qualifies
ONLY if it raises the floor **deterministically** — a guaranteed improvement,
never-worse by construction — at low cost and with **zero side effects** (no
persistent state, no disk writes, no background process, no new heavy dependency).
Everything probabilistic (PageRank, name-resolved call edges, recall-dependent
ranking) is rejected with quantification.

All claims below are from a direct read of the Engram source at
`/tmp/engram-map` (HEAD `4c344cce…`, `engramx@4.3.2`), not from summaries. Our
target surface is `src/lib/code-search.ts` + `src/lib/tree-sitter-grammars.ts`.

**Method note.** Two background research workers were dispatched and both errored
out (one hit the 105-turn wall, one exited early), so every Engram file in the
table below was read first-hand by the lead. Three cross-lab critics
(gpt-5.5, gemini-3.1-pro, opus-4.7) plus a three-lab `stand_in` consensus were
used for the adversarial filter; the load-bearing recall finding was verified
**empirically** with a runnable probe (see §"The strongest finding").

---

## Distinction that does the work: "deterministic OUTPUT given the AST" ≠ "deterministic FLOOR-RAISER"

The trap throughout this analysis: a mechanism can produce a deterministic output
(same AST in → same bytes out) and still NOT be a floor-raiser, because the value
it surfaces depends on the probabilistic graph it reads, or because its label
asserts more than the AST proves. The table separates the two columns.

---

## Mechanism × verdict table

| Mechanism (file:line) | Deterministic output given AST? | Deterministic FLOOR-RAISER? | Cost / call | Side effects | Ports to our index-free model? | What it would add to `code_search` |
|---|---|---|---|---|---|---|
| **`renderFileStructure`** `query.ts:465-626` — single-file structural summary | NO. Node list grouped by kind is AST-derivable, but it is **sorted by edge degree** (`:522-526`) and the "Key relationships" block (`:566-602`) renders `calls`/`imports` edges. | **NO.** The ordering signal (degree) and the relationship block come from the persistent graph's edges, including the 0.7-confidence `calls` edges. | reads persistent store (`getNodesByFile`/`getEdgesForNodes`) | reads `.engram/graph.db` | **NO** (the value is the indexed edges, not the rendering). The flat node list it would degrade to is **strictly worse** than our `outlineFile` (no nesting depth, no signatures). | Nothing we don't already have. Our `outlineFile` is better. |
| **grep never-worse SIZE gate** `grep.ts:93-116, 168-187` | YES (compares token counts) | **Partial — TOKEN guarantee, not recall.** It guarantees the packet is never bigger than raw `rg -wF`; recall is preserved only because the answer **always appends `rg -n "<symbol>"`** (`:253-282`). | one `execFileSync rg -wF` | none (pure given inputs) | The graph packet it gates does not exist for us — **but the PRINCIPLE ports** (see §"The strongest finding"). | The never-worse *invariant*: never silently return less than raw ripgrep. |
| **read token-saving gate** `read.ts:161-173` | YES | **YES (fail-open).** `summaryTokens >= fileTokens → PASSTHROUGH`. Never replaces a read with something larger, by construction. | one `statSync` | none | The construction ports (only intercept when strictly smaller); we have no Read interception to apply it to. | Conceptual: only substitute when strictly cheaper. Already implicit in our "summary augments, never replaces" posture. |
| **read confidence gate** `read.ts:55, 159` | n/a (threshold) | **NO.** `READ_CONFIDENCE_THRESHOLD = 0.7` is a tuned heuristic over a coverage formula. | — | — | no | rejected (heuristic) |
| **reference-miner: callee-name EXTRACTION** `reference-miner.ts:58-128` (`CALL_NODE_TYPES`+`calleeName`+`trailingIdentifier`+`extractCalleeNames`) | **YES** — pure tree-sitter walk; given the grammar, the set of callee names a file uses is exact. | **NO by itself** (it is an input, not an answer — but it is the deterministic half). | one extra full-tree walk per parsed file | none | **YES** — ~60 pure lines, web-tree-sitter-native, matches the grammars we load. | The raw material for any "this file calls X" annotation. |
| **reference-miner: cross-file NAME RESOLUTION** `reference-miner.ts:139-203` (`resolveCallEdges`) | output is deterministic given the node set, but the EDGES it asserts are name-collision-prone | **NO — this is the probabilistic 33%-recall half.** `confidenceScore: 0.7`, `provenance:"heuristic"`, `MAX_AMBIGUOUS_DEFS=10` drops over-common names, name→def is the recall ceiling. | in-memory resolve | none | ports in principle but is the part we explicitly refuse | rejected (probabilistic) |
| **ast-miner (regex defs)** `ast-miner.ts:118-123, 245-317` | regex line-by-line, NOT tree-sitter (despite header) | **NO — strictly worse than ours.** Misses multi-line decls, false-positives on commented code (only a crude `//`/`*` skip), no nesting. | regex scan | none | redundant — our `outlineFile` uses real tree-sitter with depth | rejected (inferior + redundant) |
| **same-session read dedup** `served-reads.ts:7-10, 123-175` | n/a | **NO.** | disk read+write | **WRITES `<root>/.engram/served-reads-<session>.json`** (`:163-167`); needs session-id + compaction-epoch lifecycle | **NO** — violates the zero-state / zero-disk constraint outright | rejected (stateful, disk) |
| **`pageRank` + degree ranking** `pagerank.ts`, `query.ts:317-345` | deterministic numerically | **NO.** Ranking signal over the probabilistic `calls` graph; ADR-0009 measures recall@10 = **33.0%**, PageRank captures 76.6% of a 43% reachable set. | power iteration | reads graph | no (needs the persistent edge set) | rejected (probabilistic, quantified) |
| **compaction ledger / `exploredFiles`** `served-reads.ts:105-116` | n/a | **NO.** | disk read | reads session state file | no | rejected (stateful) |

---

## The strongest finding — a deterministic recall-floor VIOLATION already in `code_search` (NOT in the parallel doc)

The most valuable deterministic, zero-side-effect win is **not** any of Engram's
features and **not** any of the four proposals in `phase-b-lite-options.md`. It is
porting Engram's *never-worse invariant* (`grep.ts`) to close a recall hole that
`code_search` **already has today**.

**Empirically proven** (runnable probe, executed during this investigation):

```
query "ab", RANKED mode  → 4 hits, pruned_below_shoulder = 1
query "ab", LITERAL mode → 5 hits   (== raw ripgrep truth)
```

The dropped 5th hit is `const material = "fabric stuff"`, where `ab`
substring-matches `fabric`. ripgrep `-F` matched the line; but the BM25F
tokenizer splits `fabric → {fabric}`, so the query token `ab` has **zero
term-frequency in every field → score 0**. With another hit scoring 0.607,
`shoulderPrune` (`code-search.ts:1418-1443`, cut below `0.5 × topScore`) deletes
the 0-score hit. **Ranked mode silently returns fewer hits than raw `rg`.**

This is exactly the floor Engram's grep handler protects by construction: it runs
raw `rg -wF`, substitutes its packet only when strictly smaller, and **always
appends the `rg -n` escalation** so recall is recoverable in one step
(`grep.ts:168-187, 253-282`). `code_search`'s ranked mode does the opposite — it
starts from ripgrep's hits and can only *lose* them, silently.

### The fix (three-lab consensus): remove score-based shoulder deletion

`stand_in` consensus = **F2** (confidence 0.83; all three labs picked it in round 1,
no round 2 needed). Even the lab that initially defended shoulder-prune as a
precision feature flipped once the limit-redundancy argument was explicit.

**Construction-level guarantee (stated precisely — do NOT overstate it):**
shoulder-prune is **functionally redundant with the `limit` slice** that already
runs after it (`code-search.ts:1672-1673`). Removing the score cut means ranked
mode **no longer deletes any hit by score**; the only loss comes from the explicit
`limit` the caller chose. BM25F still reorders best-first. Context stays bounded by
`limit` (default 200), so the "context bloat" objection is answered by the cap that
already exists.

> Precise claim: this is a deterministic improvement over the *current
> score-prune behavior*. It is NOT "recall ≥ raw `rg`" in the absolute sense —
> when `|hits| > limit`, score-order and document-order surface different subsets,
> so they are incomparable. The honest guarantee is: **ranked mode stops dropping
> hits by score; loss is attributable only to the user's `limit`.**

Cost: a **deletion** (removes an O(n) filter). Zero new parses, zero state, zero
disk, no deps. Strictly cheaper than today. Defense-in-depth retained: keep
`pruned_below_shoulder`/`truncated` honest and document that literal/regex mode is
the full-recall escalation (the Engram `rg -n` analogue) for the residual
`|hits| > limit` case.

---

## SHORTLIST (ranked) — deterministic, zero-side-effect, low-cost

1. **Remove score-based shoulder deletion in ranked mode (the recall floor).**
   *Engram-inspired invariant, not an Engram feature.* Closes a proven, silent
   recall loss vs raw ripgrep. One deletion, strictly cheaper, three-lab
   consensus. **This is the top recommendation.** Pair with keeping
   `pruned_below_shoulder`/`truncated` honest + a documented literal-mode
   escalation for the `|hits| > limit` tail.

2. **`role: "definition"`-ONLY tag (definition-positive, never "usage").**
   Reuse `confirmedHitIndexes` (`code-search.ts:1008-1017`, already computed by
   `runStructuralPass`). Tag a hit `definition` **only** when its index is in that
   set; **omit the field otherwise.** Truly free (one `Set.has`), deterministic,
   honest by construction (the set is AST-confirmed). This is the safe subset of
   the parallel doc's Proposal 1 — see the overturn below.

3. **Port the callee-name EXTRACTION walk (deterministic half of the reference
   miner) as raw material only.** `CALL_NODE_TYPES`+`calleeName`+`trailingIdentifier`
   (`reference-miner.ts:58-99`). Deterministic given the grammar. Worth porting
   **only if** a definition-positive "this file calls X" annotation is later
   wanted — and even then framed as "syntactic call-name match in the parsed
   slice," never as "callers." Gate behind evidence the model uses #1 and #2 first.

---

## REJECTED — with the adversarial reason

- **`renderFileStructure`** — its value (degree sort, `calls`/`imports`
  relationships) comes from the persistent probabilistic graph, not the AST. The
  AST-only residue is a flat node list that is *worse* than our `outlineFile`.
- **`resolveCallEdges` / name resolution / PageRank / degree ranking** —
  probabilistic; ADR-0009 measures recall@10 = 33.0%. These are the explicit
  graph value we are refusing to build. Quantified reject.
- **`ast-miner` regex extraction** — regex line scanning; strictly inferior to and
  redundant with our tree-sitter `outlineFile`.
- **same-session read dedup / compaction ledger** — write `.engram/*.json` to disk
  and depend on session + compaction-epoch lifecycle. Violates zero-state/zero-disk.
- **read confidence threshold (0.7)** — tuned heuristic, not a construction-level
  guarantee.
- **`impact` / transitive blast radius** (parallel doc already rejected) — requires
  the whole-repo dependency graph; a scoped approximation is actively misleading.

---

## Verdict on the parallel `phase-b-lite-options.md` (adversarial)

**Overturned / corrected:**

- **Proposal 1 (`role: "definition" | "usage"`) is UNSOUND as written.**
  `confirmedHitIndexes` answers "checked AND a definition." Its **negation
  conflates "checked, not a definition" with "never checked"** — a top-N hit can be
  unconfirmed because its file was skipped (unsupported language, >1 MiB cap, parse
  error, or the 200ms structural budget fired mid-pass). The doc would tag those
  `usage`, which can **mislabel a real definition as a usage** — the opposite of
  "honest by construction." Fix: emit `definition` only and omit otherwise (shortlist
  #2), or thread a separate `checkedHitIndexes` and use a narrower label like
  `non_definition_identifier` only for AST-checked hits. As written, reject; the
  definition-only subset is adopted.

- **Proposals 2 (`callers_in_results`) and 3 (`usages` count) are downgraded** from
  "deterministic floor-raisers" to "deterministic, zero-state **annotations over a
  heuristic result slice**." They are deterministic-given-inputs but the inputs are
  the BM25F top-N cut, so they make no never-worse guarantee. Two real costs the doc
  underweights: (a) the extra full-tree walk competes for the **same 200ms structural
  budget** that drives ranking quality (the doc calls it "free"; it is not — it can
  starve `isDefiningSite`); (b) name-only matching cannot distinguish two unrelated
  `foo()`s, so the field must be framed as "syntactic call-name matches in the parsed
  slice," never "callers"/"usages." Useful later, but not floor-raisers and not the
  first thing to ship.

**Upheld:**

- The doc's **REJECTED `impact`** is correct (needs the whole-repo graph).
- The doc's core insight — Engram's expensive value is the persistent `calls` graph;
  the cheap residue is the per-call AST walk — is correct and matches the source.
- The hard zero-state constraints are correctly applied to every proposal.

**The doc's central miss:** it hunts for *additive metadata fields* and never checks
whether `code_search`'s existing ranking already **violates** the never-worse-than-grep
floor. It does (proven above). That recall floor outranks all four proposals.

---

## One crisp top recommendation

**Adopt Engram's never-worse principle first: stop deleting hits by score in ranked
mode (remove shoulder-prune; let only the `limit` cap reduce the set), keeping the
`pruned_below_shoulder`/`truncated` signals honest and literal/regex mode documented
as the full-recall escalation.** It is a deletion, strictly cheaper, zero
side-effects, deterministic, three-lab-consensus, and it fixes a *proven* silent
recall loss `code_search` has today. Only after that, add the definition-only `role`
tag (free, safe). Reject the persistent graph, PageRank, name-resolved edges, and
the disk-backed dedup outright.
