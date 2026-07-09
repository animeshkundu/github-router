# Review: `mcp__orchestrate__verify_workflow`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__orchestrate__verify_workflow` |
| Group / server | `orchestrate` (serverInfo `github-router-orchestrate`) |
| Wire tool name | `verify_workflow` |
| Definition | `src/lib/peer-mcp-personas.ts:1625` (NON_PERSONA_MCP_TOOLS) |
| Always-on? | yes (pure static function, no capability gate) |
| Capability gate | none. Unlike `decompose`/`run_workflow` (both `capability: "worker"`), this tool has no `capability` field, so it stays in `tools/list` + `tools/call` on every tier |
| Backing model / endpoint | server-side fn `verifyWorkflowIR` (`src/lib/orchestration/verify.ts:54`). No LLM call, no subprocess |
| Write-capable | no (pure function over the passed IR; no filesystem, no network) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/peer-mcp-personas.ts:1627-1640`):

> Statically verify a workflow IR against the orchestration floor invariants BEFORE running it. Input `ir`: the typed WorkflowIR (rawAskHash, acceptanceCriteriaHash, nodes[] with role/inputs/gate/onFail, maxDepth). Returns {ok, violations:[{code, message, nodeId?}]}. Each violation carries a stable code (e.g. NO_BASELINE, SELECTOR_NOT_RAW_ASK, SAME_LAB_CHECK, ORPHAN_NODE, MISSING_INTEGRATION_GATE) — fix every one until `ok` is true. WHY: a workflow's floor guarantee (deliver max(orchestrated, baseline), producer != checker, cross-lab checks, sealed gates) is only as good as the IR's structure; a probabilistically-composed IR can silently violate it. This is the cheap, pure, side-effect-free pre-flight that catches those violations with actionable codes so you self-correct BEFORE paying for execution. Call it right after composing/decomposing a workflow.

Input schema (`src/lib/peer-mcp-personas.ts:1641-1662`), `required: ["ir"]`, `additionalProperties: false`:

- **`ir`** (object): "The typed WorkflowIR to verify: { rawAskHash, acceptanceCriteriaHash, nodes: [{id, role, inputs, gate, onFail, ...}], maxDepth }."
- **`knownGateIds`** (array of string): "Optional allowlist of the kernel's sealed executable gate ids. When present, every executable gate's gateId must be in it (gate-immutability)."

Return shape (`src/lib/orchestration/verify.ts:32-35`): `{ ok: boolean, violations: [{ code, message, nodeId? }] }`. Stable codes enumerated in `verify.ts`: `BAD_IR`, `MISSING_HASH`, `BAD_MAX_DEPTH`, `EMPTY`, `BAD_NODE`, `BAD_ID`, `DUP_ID`, `BAD_ROLE`, `BAD_GATE`, `BAD_ON_FAIL`, `BAD_INPUT_REF`, `UNKNOWN_GATE_ID`, `MISSING_PRODUCER_LAB`, `SAME_LAB_CHECK`, `CYCLE`, `NO_BASELINE`, `MULTI_BASELINE`, `BASELINE_HAS_INPUTS`, `NO_SELECTOR`, `MULTI_SELECTOR`, `SELECTOR_NOT_RAW_ASK`, `SELECTOR_ONFAIL_NOT_BASELINE`, `SELECTOR_MISSING_BASELINE_INPUT`, `SELECTOR_NO_ORCHESTRATED_INPUT`, `SELECTOR_MULTIPLE_ORCHESTRATED`, `SELECTOR_NOT_TERMINAL`, `ORPHAN_NODE`, `MISSING_INTEGRATION_GATE`, `IMPLEMENT_NOT_INTEGRATED`.

### 2b. System prompt (`--append-system-prompt`)

Named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts`), and the clause differs by whether the worker backend is available.

**Workers-on branch** (`src/lib/peer-mcp-personas.ts:609`), verbatim:

> `mcp__orchestrate__decompose` composes an open-ended ask into a typed, VERIFIED workflow IR (a strong driver decorrelated by a cross-lab critic, so the decompose step isn't a single point of failure), and `mcp__orchestrate__run_workflow` executes that IR through a frozen kernel delivering max(orchestrated, baseline) over a sealed executable gate, so it never ships worse than a plain single-model run. `mcp__orchestrate__verify_workflow` checks an IR's floor invariants before you run it, and `mcp__orchestrate__attest_step` audits that a finished run's producers were each checked by a different lab. They suit non-trivial, role-separated asks; a trivial ask does not need them.

**Workers-off branch** (`src/lib/peer-mcp-personas.ts:613`), verbatim:

> `mcp__orchestrate__verify_workflow` statically checks a workflow IR's floor invariants and `mcp__orchestrate__attest_step` audits a run's cross-lab lineage (the `decompose`/`run_workflow` composer + kernel need the worker backend, unavailable here).

(`orchestrateKey` interpolates to `orchestrate` on the no-collision path.) The gating is correct: `verify_workflow` is named in BOTH branches because it is pure and always served, matching the always-on `tools/list` (pinned by `tests/peer-mcp-personas.test.ts:560-573`).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The covering injected block is **peer-awareness** — the same `buildPeerAwarenessSnippet` text as 2b, appended to the mirror via the peer-awareness injection. No separate CLAUDE.md text is authored for this tool; the mirror and the `--append-system-prompt` carry identical bytes.

The checked-in root `CLAUDE.md` documents the tool in the "Six intent-named MCP servers" paragraph (`CLAUDE.md:129`):

> `orchestrate` (the workflow tools `decompose`, `verify_workflow`, `run_workflow`, `attest_step` … `verify_workflow`/`attest_step` are pure + always-on, `decompose`/`run_workflow` share the worker backend gate)

This agrees with the code: `verify_workflow` carries no `capability` field (`src/lib/peer-mcp-personas.ts:1625-1626`) so it is pure + always-on; `decompose`/`run_workflow` both set `capability: "worker"` (`:1688`, `:1755`). The design doc `docs/agent-orchestration-design.md` also describes the tool (line 54-56, 173) but under a **stale MCP prefix** — see [Suggestion-1].

## 3. Assessment

### 3a. Description quality

**Clarity & routing signal — strong.** The description tells the model exactly when to call it ("right after composing/decomposing a workflow", "BEFORE running it"), what it returns, and the self-correction loop ("fix every one until `ok` is true"). It names five representative violation codes inline so the model sees the shape of the feedback before it ever calls the tool. The WHY paragraph correctly frames the tool as the cheap pure pre-flight that de-risks the expensive `run_workflow`. There is no over-claim: it says "statically" and "the invariants that are STATICALLY decidable", which matches `verify.ts:6-14` (the kernel enforces the runtime ones).

**Accuracy vs implementation — accurate on the invariants, one under-specified field.** Spot-checked the load-bearing claims:
- Named codes all exist and fire as described: `NO_BASELINE` (`verify.ts:167`), `SELECTOR_NOT_RAW_ASK` (`:189`), `SAME_LAB_CHECK` (`:156`), `ORPHAN_NODE` (`:231`), `MISSING_INTEGRATION_GATE` (`:242`).
- "producer != checker, cross-lab checks" ↔ `MISSING_PRODUCER_LAB`/`SAME_LAB_CHECK` (`verify.ts:151-157`).
- "deliver max(orchestrated, baseline)" ↔ the baseline + selector invariants (`verify.ts:164-218`).
- Untrusted-input contract ("never throws on a malformed shape"): the handler casts `args.ir as WorkflowIR` (`peer-mcp-personas.ts:1673`) and `verifyWorkflowIR` guards every access (`verify.ts:60-61` non-object, `:64` non-array nodes, `:94-126` per-node shape), returning violations instead of throwing. Pinned by `tests/orchestration-ir.test.ts:92,99` (`null` ⇒ `BAD_IR`, malformed ⇒ not-throw).

The gap is `knownGateIds`: see finding [Important-1]. The tool's own description says "against the orchestration floor invariants", and gate-immutability (invariant 5) is one of those invariants, but WITHOUT `knownGateIds` the tool can only enforce the weak half of that invariant (gateId is a non-empty string, `verify.ts:141`) and cannot check the gateId is actually one of the three sealed ids (`verify.ts:143`). The description never tells the model what the sealed ids are, nor that omitting `knownGateIds` weakens the gate check.

**Schema minimality — passes.** Two fields, both justified against the three-way test in `docs/peer-mcp-design.md`:

| Field | Verdict | Test |
|---|---|---|
| `ir` | keep | (a) required to call — it is the artifact under verification |
| `knownGateIds` | keep | (b) model-tunable: passing the sealed set strengthens the gate-immutability check |

The return `violations[]` is maximally actionable: `code` (stable, branchable), `message` (human/model-readable fix hint), `nodeId?` (present-iff-node-scoped, so the model knows which node to edit). Nothing echoed, nothing diagnostic-only. This is a textbook-minimal surface.

**One structural sharp edge worth recording (not a minimality violation):** the `ir` field is typed only as `object` in the JSON schema (`peer-mcp-personas.ts:1647`), with the shape carried in prose (`:1648-1651`). This is deliberate — a full JSON-schema encoding of `WorkflowIR` (9 roles, 3 gate kinds, 3 onFail values, the selector-only `judgesOnRawAsk`, the DAG `inputs` refs) would be large and the verifier already returns precise per-field codes on a malformed shape, so the prose+codes combination is the right trade. The prose shape hint omits `producerLab` and `judgesOnRawAsk`, which the model needs to clear `MISSING_PRODUCER_LAB`/`SELECTOR_NOT_RAW_ASK` — see [Suggestion-2].

### 3b. System-prompt coverage

**Named in both branches, correctly gated.** The snippet is the one surface that must never name a tool absent from the live `tools/list`; `verify_workflow` being pure means it is named unconditionally, which is right (`tests/peer-mcp-personas.test.ts:560-573`). The workers-off branch is a genuinely better sentence for that tier — it names only the two pure tools and explains WHY the composer/runner are absent, so the model does not try to call `decompose` and get a `-32601`.

**Framing-constraint compliance — passes.** Both clauses are declarative ("checks an IR's floor invariants", "statically checks a workflow IR's floor invariants"). No imperative ("Lead with…", "Always call…"), no hedge, no rationale-as-anchor. The paragraph-2-has-no-em-dash constraint (`tests/peer-mcp-personas.test.ts:551`) holds — the clause uses none.

**Non-redundant with the description.** The snippet gives the one-line routing role ("checks an IR's floor invariants before you run it"); the description carries the codes, the return shape, and the self-correction loop. Different surfaces, different depth, no bloat.

### 3c. CLAUDE.md coverage

**Accurate, not drifted.** The mirrored peer-awareness block is byte-identical to 2b. The checked-in root `CLAUDE.md:129` correctly classifies `verify_workflow` as pure + always-on and pairs it with `attest_step`, matching the `capability`-field reality in code. No stale fact in the root doc.

### 3d. Cross-surface consistency

Description ↔ snippet ↔ root CLAUDE.md ↔ code agree on this tool's own facts (pure, always-on, static, returns `{ok, violations}` with stable codes). The two consistency defects are:
1. The `knownGateIds` weakness ([Important-1]) — a `verify_workflow` `ok:true` does not guarantee a `run_workflow` accept, because `run_workflow` re-verifies against the actual selected gate (`run-workflow-live.ts:111,115`) and will surface `UNKNOWN_GATE_ID` for a gateId the gate-less `verify_workflow` waved through. The description promises the tool catches violations "BEFORE paying for execution", but this one class is not caught on the default (no-`knownGateIds`) call path.
2. The design-doc stale prefix ([Suggestion-1]) — not a model-facing surface, but a maintainer cross-referencing the doc lands on `mcp__workers__verify_workflow`, which is not the served name.

## 4. Findings

- **[Important-1]** `src/lib/peer-mcp-personas.ts:1653-1660` + `1627-1640` — `verify_workflow` cannot fully check the gate-immutability invariant on the call path the model will actually use. The sealed gate ids (`default-ci` | `typecheck-test` | `typecheck-only`) are enumerated ONLY in `run_workflow`'s `gateId` schema enum (`peer-mcp-personas.ts:1783`); `verify_workflow`'s description and `knownGateIds` field never name them. So a model that composes an IR with an executable gate and calls `verify_workflow` WITHOUT `knownGateIds` gets `ok: true` even when the gateId is bogus (only the non-empty-string check runs, `verify.ts:141`; the sealed-set check at `verify.ts:143` is skipped when `knownGateIds` is undefined). `run_workflow` then rejects that same IR with `UNKNOWN_GATE_ID` (it constrains verification to `new Set([opts.gateId])`, `run-workflow-live.ts:111,115`). The pre-flight's stated purpose ("catches those violations … BEFORE paying for execution") is defeated for this one class. Repro: call `verify_workflow` with the valid IR from `tests/routes-mcp.test.ts:769-776` (its `impl` node has `gate:{kind:"executable", gateId:"tests"}`) and no `knownGateIds` → `{ok:true}`; that IR's gateId `"tests"` is not a sealed id, so a subsequent `run_workflow` would reject it. Fix: either (a) list the three sealed ids in the `verify_workflow` description and the `knownGateIds` field description so the model can pass them, or (b) default `knownGateIds` to `sealedGateIds()` (`src/lib/orchestration/gate-registry.ts:43`) inside the handler when the caller omits it, keeping the arg as an override — (b) makes the default call path strictly stronger and matches how `run_workflow`/the kernel already behave.

- **[Suggestion-1]** `docs/agent-orchestration-design.md:173-175` — the design-doc component table names these tools under the stale `mcp__workers__` prefix (`mcp__workers__verify_workflow`, `mcp__workers__decompose`, `mcp__workers__run_workflow`); the served group is `orchestrate` (`peer-mcp-personas.ts:1626`, and the root `CLAUDE.md:129` server split). Not a model-facing surface, but a maintainer mapping the doc to a live tool would look under the wrong server. Fix: rename the three rows to `mcp__orchestrate__*`.

- **[Suggestion-2]** `src/lib/peer-mcp-personas.ts:1648-1651` — the `ir` field's prose shape hint lists `{id, role, inputs, gate, onFail, ...}` per node but omits the two fields a model most often gets wrong: `producerLab` (needed to clear `MISSING_PRODUCER_LAB`/`SAME_LAB_CHECK` on cross_lab gates, `verify.ts:151-157`) and the selector-only `judgesOnRawAsk: true` (needed to clear `SELECTOR_NOT_RAW_ASK`, `verify.ts:188`). The `...` implies more fields exist, but a model authoring an IR by hand from this hint alone would miss both and eat an extra verify round-trip. Fix: extend the hint to `{id, role, producerLab?, inputs, gate, onFail, judgesOnRawAsk?}` — this is where `decompose` already carries the full role/lab/gate vocabulary in its `toolCatalog` (`peer-mcp-personas.ts:1730-1738`), so hand-authoring is the case that benefits.

No Critical findings. [Important-1] is a "verify says ok, run says no" gap, not a data-loss or security defect — `run_workflow` re-verifies as defense in depth (`run-workflow-live.ts:114-118`), so the bad IR never executes; the cost is a wasted round-trip and a violated "catches it before execution" promise, which is why it is Important, not Critical.

## 5. Verdict

**Y, with one Important fix.** The injected surface is minimal (two fields, both justified), accurately gated (pure ⇒ named in both snippet branches, always in `tools/list`), framing-compliant, and consistent across description ↔ snippet ↔ root CLAUDE.md ↔ code. The violation-code return is a model of actionable feedback. Single most important fix: [Important-1] — default `knownGateIds` to the sealed registry (or name the three sealed ids in the description), so a `verify_workflow` `ok:true` actually predicts a `run_workflow` accept instead of silently waving through a bogus gateId that the kernel will reject.
