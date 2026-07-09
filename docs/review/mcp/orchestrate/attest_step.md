# Review: `mcp__orchestrate__attest_step`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__orchestrate__attest_step` |
| Group / server | `orchestrate` (serverInfo `github-router-orchestrate`) |
| Wire tool name | `attest_step` |
| Definition | `src/lib/peer-mcp-personas.ts:1819` (entry) → handler `1875-1882`; backend `src/lib/orchestration/attest.ts:111` (`attestRun`) |
| Always-on? | yes (pure logic, no gate) |
| Capability gate | none — the comment at `peer-mcp-personas.ts:1816` states "No capability gate (pure logic, like verify_workflow)"; the handler unconditionally calls `attestRun` |
| Backing model / endpoint | server-side fn (`attestRun`, no LLM, no network) |
| Write-capable | no (pure function; returns a verdict, mutates nothing) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`peer-mcp-personas.ts:1821-1838`):

> "Attest (audit) that an orchestrated run actually honored bias isolation: every producer node was checked by a DIFFERENT lab, and that check covered the producer's FINAL artifact (matched by content hash, so a check of a stale earlier version does not count). Input `nodes`: [{id, producerLab, artifactHash, checks:[{checkerLab, verifiedArtifactHash}]}]. Returns {attested, recommendation: 'accept'|'ship_baseline', nodes:[{id, attested, reason}]}. WHY: run_workflow's frozen kernel is the TAMPER-PROOF path (it controls the artifacts and computes the hashes). attest_step is for workflows you compose OUTSIDE the kernel: it deterministically checks your SELF-REPORTED lineage is structurally sound (a different-lab check whose hash equals each producer's final-artifact hash), catching the non-malicious failures (a missing / same-lab / stale check). It verifies consistency, NOT that the hashes are real — a completeness gate, not a security boundary. Fail-closed: anything short of a valid different-lab check on EVERY node recommends shipping the baseline. It RECOMMENDS; it never executes."

Input schema (`peer-mcp-personas.ts:1839-1874`):

- `nodes` (array, **required**) — "The run's producer lineage to attest. Each: {id, producerLab, artifactHash (the producer's final artifact hash), checks: [{checkerLab, verifiedArtifactHash}]}."
  - item (object, required `id, producerLab, artifactHash, checks`, `additionalProperties:false`):
    - `id` (string) — no description
    - `producerLab` (string) — "The lab that produced this node (openai/google/anthropic/...)."
    - `artifactHash` (string) — "Content hash of the producer's FINAL artifact."
    - `checks` (array):
      - item (object, required `checkerLab, verifiedArtifactHash`, `additionalProperties:false`):
        - `checkerLab` (string) — no description
        - `verifiedArtifactHash` (string) — "The hash this check actually verified (must equal artifactHash)."

### 2b. System prompt (`--append-system-prompt`)

`attest_step` IS named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts`), in BOTH gate branches, because it is pure and always-on. The clause differs by branch.

Workers-available branch (`peer-mcp-personas.ts:609`), final sentence:

> "…and `mcp__orchestrate__attest_step` audits that a finished run's producers were each checked by a different lab. They suit non-trivial, role-separated asks; a trivial ask does not need them."

Workers-unavailable branch (`peer-mcp-personas.ts:613`):

> "`mcp__orchestrate__verify_workflow` statically checks a workflow IR's floor invariants and `mcp__orchestrate__attest_step` audits a run's cross-lab lineage (the `decompose`/`run_workflow` composer + kernel need the worker backend, unavailable here)."

Pinned present in both by `tests/peer-mcp-personas.test.ts:566` (minimal snippet) and `:560-573`.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering block: **peer-awareness** (same text as 2b). `appendPeerAwarenessToMirroredClaudeMd` (`src/lib/claude-md-injection.ts:653`) writes the output of `buildPeerAwarenessSnippet` verbatim into the mirrored CLAUDE.md under the `PEER_MARKER_OPEN`/`CLOSE` fence (`claude-md-injection.ts:20-22`). So the mirrored-CLAUDE.md text for `attest_step` is byte-identical to surface 2b; no separate wording to review.

Checked-in root `CLAUDE.md` documents the tool in the "Six intent-named MCP servers" paragraph (`CLAUDE.md:129`):

> "…`orchestrate` (the workflow tools `decompose`, `verify_workflow`, `run_workflow`, `attest_step` — a distinct category from `workers`: these compose/verify/run/audit a workflow… `verify_workflow`/`attest_step` are pure + always-on, `decompose`/`run_workflow` share the worker backend gate)…"

This agrees with the code: no gate on `attest_step` (`peer-mcp-personas.ts:1816`, `1875-1882`), gate on decompose/run_workflow via `workerToolsAvailable`. The `orchestrate` group also appears in the root CLAUDE.md orchestration overview blob (`attest_step` audits "that a finished run's producers were each checked by a different lab" — matches 2b).

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal — strong.** The description tells the model both when to reach for the tool (workflows composed OUTSIDE the kernel, self-reported lineage) and when NOT to (run_workflow's frozen kernel is the TAMPER-PROOF path). The `accept` vs `ship_baseline` recommendation and the fail-closed rule are stated. The when-not signal is unusually explicit for a description, which is correct here because the tool is easy to mistake for the kernel's guarantee.
- **Completeness-gate-NOT-security-boundary distinction — present and load-bearing.** The description explicitly says "It verifies consistency, NOT that the hashes are real — a completeness gate, not a security boundary." This matches the source-header SCOPE / LIMITATION block (`attest.ts:12-22`): every field is self-reported, a caller that fabricates a matching `(artifactHash, verifiedArtifactHash)` pair passes. This is the single most important property to convey so the model does not over-trust the verdict, and the description conveys it. The verbal contract also matches the actual predicate: `attestNode` only checks `verifiedArtifactHash === node.artifactHash` and lab inequality (`attest.ts:88-91`); it never hashes anything itself, so "does not verify the hashes are real" is literally true.
- **Accuracy vs implementation — accurate.**
  - "different lab" comparison is case/whitespace-insensitive via `normLab` (`attest.ts:70-72`, applied at `88`), so the description's "DIFFERENT lab" claim is robust, not a naive string compare. Not surfaced in the description, but that is fine (an internal robustness detail, not model-actionable).
  - "Fail-closed: anything short of a valid different-lab check on EVERY node recommends shipping the baseline" matches `attestRun` (`attest.ts:118-122`: `every(r.attested)` → `accept` else `ship_baseline`) and the empty-nodes case (`attest.ts:113-115`: empty → `ship_baseline`, "do not bless an empty lineage").
  - "It RECOMMENDS; it never executes" matches: the handler returns the JSON verdict and nothing else (`peer-mcp-personas.ts:1879-1881`); no side effects.
  - Return shape `{attested, recommendation, nodes:[{id, attested, reason}]}` matches `AttestResult` (`attest.ts:54-61`) and `NodeAttestation` (`attest.ts:48-52`).
- **Schema minimality — clean, every field is needed to attest.** Per the "ruthlessly minimal MCP tool surface" principle:
  - `nodes[].id` — needed: it is echoed into each `NodeAttestation.id` so the model can map a verdict back to a node (`attest.ts:76-108`). Not diagnostic-only; it is the correlation key.
  - `producerLab` — needed: one side of the different-lab comparison (`attest.ts:83, 88`).
  - `artifactHash` — needed: the RHS of the hash-match check (`attest.ts:90`).
  - `checks[].checkerLab` — needed: the other side of the different-lab check (`attest.ts:88`).
  - `checks[].verifiedArtifactHash` — needed: the LHS of the hash-match (`attest.ts:90`).
  - No echoed-input-only or diagnostic-only fields. `additionalProperties:false` at every level keeps the surface tight.
- **Output actionability — high.** Every `nodes[].reason` is a distinct, actionable diagnostic string keyed to the specific failure mode (missing id, missing producerLab/artifactHash, no check, same-lab-only, stale-hash) (`attest.ts:77-108`), so the model learns exactly what to fix before re-attesting or before falling back to `ship_baseline`. `recommendation` is the single next-action signal. Nothing in the output is non-actionable.

### 3b. System-prompt coverage

- **Named, in both branches, by design.** Correct: the tool is always-on, so naming it unconditionally is right, and the two branches accurately reflect that decompose/run_workflow are gated while verify_workflow/attest_step are not.
- **Accurate & non-redundant with the description.** The snippet gives the one-line routing signal ("audits that a finished run's producers were each checked by a different lab" / "audits a run's cross-lab lineage") and defers the full contract to the description. Consistent with the code (cross-lab + final-hash check).
- **Framing-constraint compliance — compliant.** The clauses are descriptive, not imperative: no "Lead with", "Reach for", "Brief them" (negatively pinned at `tests/peer-mcp-personas.test.ts:536-538`); no `→` arrow (`:524`); no em dash (`:551`); no hedge phrases (`:530-535`). "They suit non-trivial, role-separated asks; a trivial ask does not need them" is a scoping statement in the descriptive register, matching the sibling `verify_workflow` phrasing.
- **One gap (see Findings I1):** the awareness clause does NOT carry the completeness-gate-not-security-boundary caveat that the description leads with. In the snippet, `attest_step` reads as a peer to `verify_workflow` ("audits … cross-lab lineage"), with no signal that its input is self-reported and un-verifiable. The description carries the caveat, and the model does see the description in `tools/list`, so this is a redundancy gap, not a correctness hole — but the awareness snippet is the higher-salience surface (system prompt + top-of-CLAUDE.md), and it is where the model forms its first mental model of the tool.

### 3c. CLAUDE.md coverage

- **Mirrored CLAUDE.md**: identical to 2b (same `buildPeerAwarenessSnippet` output), so the same assessment and the same I1 gap apply. No drift possible — it is the same string.
- **Checked-in root CLAUDE.md** (`CLAUDE.md:129`, plus the orchestration overview blob): accurate and non-redundant. Correctly states `attest_step` is pure + always-on and belongs to the compose/verify/run/audit category distinct from `workers`. Agrees with the code gate (none) and backend. The root CLAUDE.md is documentation-for-maintainers, not injected, so it is allowed to be denser than the awareness snippet, and it does convey the "audits a run's cross-lab lineage" purpose.

### 3d. Cross-surface consistency

- Description ↔ code: consistent (verified field-by-field above).
- Description ↔ awareness snippet: consistent in direction; the snippet is a strict subset that omits the security-boundary caveat (I1). No contradiction.
- Awareness snippet (2b) ↔ mirrored CLAUDE.md (2c): identical string.
- Root CLAUDE.md ↔ code: consistent (gate, category, always-on).
- No contradictions found across surfaces. The only cross-surface issue is an omission, not a conflict.

## 4. Findings

- **[Important]** `src/lib/peer-mcp-personas.ts:609` (and mirror `:613`) — the awareness-snippet clause for `attest_step` omits the completeness-gate-not-security-boundary caveat that the tool description leads with. The higher-salience surface (system prompt + top-of-mirrored-CLAUDE.md) presents it as a lineage auditor with no signal that its input is self-reported and the hashes are not verified real, which invites the model to over-trust an `attested: true` verdict as a tamper-proof guarantee. The description carries the caveat, so this is a redundancy/salience gap rather than a false statement. Fix: add a short descriptive-register half-sentence to the clause, e.g. "…audits that a finished run's producers were each checked by a different lab over each producer's final-artifact hash (a completeness check on self-reported lineage, not a tamper-proof guarantee)." Keep it descriptive to stay within the framing constraint pinned by `tests/peer-mcp-personas.test.ts:524-551`, and mirror the wording in the workers-unavailable branch at `:613`.

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:1855` and `:1865` — `nodes[].id` and `checks[].checkerLab` carry no field `description`, while their siblings (`producerLab`, `artifactHash`, `verifiedArtifactHash`) do. `id` is the verdict correlation key and `checkerLab` is one side of the different-lab comparison; a one-clause description on each ("stable node identifier, echoed into the verdict" / "the lab that performed this check") would make the schema self-describing without adding a field. Non-blocking; the array-level `description` at `:1846-1849` already gives the shape.

- **[Suggestion]** `src/lib/orchestration/attest.ts:90` — the stale-hash diagnosis at `:104-108` is only emitted when a cross-lab check exists but no cross-lab check matches the hash; a check that matches the hash but is same-lab is correctly caught by the earlier `crossLab.length === 0` branch (`:97-103`). The reasons are mutually exclusive and correct, but the description's "a missing / same-lab / stale check" list could be read by the model as three independent orthogonal failures when a single node reports exactly one (the most-actionable) reason. Not a defect (the ordering is deliberately "diagnose the most actionable failure", `:95`); noting only so a future edit to the description does not imply multi-reason output.

## 5. Verdict

Y — the injected surface is correct, minimal, consistent, and well-routed. The description accurately conveys the load-bearing completeness-gate-not-security-boundary distinction and the schema is tight. Single most important fix: propagate that caveat into the awareness-snippet clause (`peer-mcp-personas.ts:609`/`:613`) so the higher-salience surface does not let the model over-trust an `attested: true` verdict as tamper-proof.
