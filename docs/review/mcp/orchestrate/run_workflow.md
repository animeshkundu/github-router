# Review: `mcp__orchestrate__run_workflow`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__orchestrate__run_workflow` |
| Group / server | `orchestrate` (serverInfo `github-router-orchestrate`) |
| Wire tool name | `run_workflow` |
| Definition | `src/lib/peer-mcp-personas.ts:1753` (NON_PERSONA_MCP_TOOLS) |
| Always-on? | gated by `capability: "worker"` |
| Capability gate | `worker` → `workerToolsEnabled()` (`src/routes/mcp/handler.ts:337` list-time, `:919-920` call-time) |
| Backing model / endpoint | server-side fn `runWorkflowLive` (`src/lib/orchestration/run-workflow-live.ts:85`); internally spins the worker engine + cross-lab critics (gpt-5.5 `/responses`, gemini-3.1-pro-preview `/chat/completions`, claude-opus-4-6 `/chat/completions`) + real gate subprocesses via `liveExec` |
| Write-capable | yes — runs a worker DAG in git worktrees + executes real gate commands (`bun run typecheck` / `bun test` / `bun run lint`) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/peer-mcp-personas.ts:1756-1772`):

> Execute a VERIFIED workflow IR (from decompose / verify_workflow) through the frozen orchestration kernel. The kernel runs the single-model BASELINE plus the orchestrated DAG, gates every producer over a SEALED executable gate you name by `gateId` (the kernel owns the command; the IR cannot author it), and delivers max(orchestrated, baseline) by champion-retention: the orchestrated result ships only if it verifiably does not regress the baseline's executable checks, else the baseline ships. Returns {ok, outcome:{status, winner?, artifact?, reason, gatesPassed?}}. WHY: orchestration is a conditional bet (it helps on blind-spot/ambiguous asks, backfires on others), so the kernel NEVER ships something worse than a plain single-model run on the same ask. It enforces the floor in code (the model can't be trusted to honor it): a parallel baseline, a sealed executable gate as the selector, fail-to-baseline on any infra failure. Use after decompose for non-trivial asks on a harness-bearing repo.

Input-schema fields (`:1773-1793`):

- `ir` (object, required): "The verified WorkflowIR to execute."
- `ask` (string, required): "The raw user ask (the baseline and producers run on this)."
- `workspace` (string, required): "Absolute path to the git workspace the kernel runs in."
- `gateId` (string, required, enum `["default-ci","typecheck-test","typecheck-only"]`): "Which SEALED executable gate to run (the kernel owns the commands)."
- `tiePolicy` (string, optional, enum `["strict","superset"]`): "On an exact tie vs the baseline: 'strict' ships the baseline (default), 'superset' ships the orchestrated candidate."
- `maxRetries` (number, optional): "Retries after the first attempt for a loop node / baseline infra failure."

`required: ["ir","ask","workspace","gateId"]`; `additionalProperties: false`.

### 2b. System prompt (`--append-system-prompt`)

`run_workflow` IS named, in the workers-available branch of `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:608-610`), verbatim:

> `mcp__${orchestrateKey}__decompose` composes an open-ended ask into a typed, VERIFIED workflow IR (a strong driver decorrelated by a cross-lab critic, so the decompose step isn't a single point of failure), and `mcp__${orchestrateKey}__run_workflow` executes that IR through a frozen kernel delivering max(orchestrated, baseline) over a sealed executable gate, so it never ships worse than a plain single-model run. `mcp__${orchestrateKey}__verify_workflow` checks an IR's floor invariants before you run it, and `mcp__${orchestrateKey}__attest_step` audits that a finished run's producers were each checked by a different lab. They suit non-trivial, role-separated asks; a trivial ask does not need them.

Gated behind `opts.workerToolsAvailable` (`src/lib/peer-mcp-personas.ts:607`), matching the live `tools/list` gate (`src/routes/mcp/handler.ts:337`) — pinned by `tests/peer-mcp-personas.test.ts:560-573` (present with workers, absent without).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored CLAUDE.md carries the peer-awareness block (same text as 2b) via `src/lib/claude-md-injection.ts`, so the run_workflow sentence above is the covering text.

Checked-in root `CLAUDE.md:129` documents the tool at the group level:

> `orchestrate` (the workflow tools `decompose`, `verify_workflow`, `run_workflow`, `attest_step` — a distinct category from `workers`: these compose/verify/run/audit a workflow, whereas the workers are what a workflow delegates to; `verify_workflow`/`attest_step` are pure + always-on, `decompose`/`run_workflow` share the worker backend gate)

This agrees with the code: `run_workflow` carries `capability: "worker"` (`:1755`) and the snippet gates it on `workerToolsAvailable` (`:607`). The `/gh-orchestrate` skill named in the CLAUDE.md skill sentence (`:618-619`) is injected at runtime and is not present in the working tree, so its wording was not verifiable against code here; its one-line framing ("right-sizes a blind-spot-elimination pipeline whose nodes delegate to these tools") is consistent with run_workflow's role.

## 3. Assessment

### 3a. Description quality

**Clarity & routing signal.** Strong. The model learns when to reach for it ("after decompose for non-trivial asks on a harness-bearing repo") and the WHY paragraph gives the not-when signal implicitly (a trivial ask, or a repo with no executable harness, gains nothing because the gate is the selector). The "harness-bearing repo" qualifier is the load-bearing precondition and it is stated. The chain decompose → verify_workflow → run_workflow is spelled out in the first clause.

**Accuracy vs implementation.**
- "the single-model BASELINE plus the orchestrated DAG" — matches `kernel.ts:106-161` (baseline runs first off-chain, then the DAG).
- "gates every producer over a SEALED executable gate you name by `gateId` (the kernel owns the command; the IR cannot author it)" — accurate. `gate-registry.ts:28-39` holds the sealed commands; `resolveSealedGate` returns a defensive clone (`:52-56`); the IR references a gate by id only and `run-workflow-live.ts:111-117` constrains verification to the single selected gate so "IR declares X, kernel runs Y" is closed.
- "delivers max(orchestrated, baseline) by champion-retention: the orchestrated result ships only if it verifiably does not regress the baseline's executable checks, else the baseline ships" — accurate against `select.ts:51-111` (regression on any canonical check the baseline passed → baseline wins; strictly-more → orchestrated; tie → tiePolicy).
- "fail-to-baseline on any infra failure" — accurate (`kernel.ts:99-103, 149-154`), with the ONE documented exception the description omits (see Finding I2): if the BASELINE itself can't be produced there is no floor to ship, so the kernel returns `status:"escalated"` (`kernel.ts:110-115`) rather than shipping anything.
- "Use after decompose" — consistent; `decompose`/`verify_workflow` produce the `ir` this consumes.
- **Return shape drift**: the description says `Returns {ok, outcome:{status, winner?, artifact?, reason, gatesPassed?}}`, but the actual result is a discriminated union. On a validation failure `runWorkflowLive` returns `{ok:false, error}` (no `outcome` at all — `run-workflow-live.ts:61-63, 87-97`), and `KernelOutcome` has FOUR statuses (`kernel.ts:68-72`): `rejected` (carries `violations`, no `reason`), `delivered` (`winner`/`artifact?`/`reason`/`gatesPassed`), `baseline` (`reason`/`artifact?`/`gatesPassed`, no `winner`), `escalated` (`reason`/`nodeId?`, no `gatesPassed`). The advertised shape omits `violations`, `nodeId`, and the `{ok:false, error}` branch, and implies `reason`/`gatesPassed` are always present when they are status-conditional. See Finding I1.

**Schema minimality.** Good. Every field is either required-to-call or a genuine model-tunable knob:
- `ir`, `ask`, `workspace`, `gateId` — all required, all load-bearing. `ask` is not echo: `run-workflow-live.ts:148` feeds it into the runner as `rawAsk`, and `runner.ts:64,66` uses it verbatim as the baseline prompt and the producer-prompt prefix. `gateId` is a SEALED enum (`:1783`) whose three members exactly match the `SEALED_GATES` keys (`gate-registry.ts:29-38`) — confirmed, no drift; and the description makes the kernel-owns-command point twice.
- `tiePolicy` — a real product decision (`select.ts:27-39`), correctly surfaced as caller-tunable with the strict default stated.
- `maxRetries` — model-tunable and actionable; server-side clamped to `[0,3]` (`run-workflow-live.ts:102-105`), a bound the description does not mention (minor, see Finding S1).

No echoed-input or diagnostic-only fields. Surface is minimal.

### 3b. System-prompt coverage

**Named.** Yes, in the workers-on branch, correctly gated (2b).

**Accurate & non-redundant.** The snippet compresses the description to its floor claim ("delivering max(orchestrated, baseline) over a sealed executable gate, so it never ships worse than a plain single-model run") and situates it in the decompose → verify → run → attest pipeline, which the standalone description does not do. Complementary, not duplicative.

**Framing-constraint compliance.** Compliant. The sentence is descriptive ("executes that IR through a frozen kernel delivering …"), carries no imperative opener (no "Lead with" / "Reach for" / "Brief them"), no hedge, no anchor. It closes with the non-prescriptive "They suit non-trivial, role-separated asks; a trivial ask does not need them" rather than a forced-routing arrow. Consistent with the negative-pins in `tests/peer-mcp-personas.test.ts:523-551` (no `→`, no em dash, no banned hedges).

### 3c. CLAUDE.md coverage

Accurate and non-redundant. Root `CLAUDE.md:129` documents run_workflow only at the group level (compose/verify/run/audit; shares the worker backend gate) and defers the per-tool detail to the injected snippet + the design doc — the right altitude for the index-level file. It does not drift from code: the gate-sharing claim matches `capability:"worker"` (`:1755`), and the "distinct category from workers" framing matches the group split. The mirrored peer-awareness block (2b) carries the operative per-tool wording.

### 3d. Cross-surface consistency

No contradictions across description ↔ system prompt ↔ CLAUDE.md ↔ code on the core floor guarantee, the sealed-gate ownership, the gate enum, the worker gate, or the champion-retention semantics. The only cross-surface gap is internal to the description (the return-shape summary vs the actual union — Finding I1); the snippet and CLAUDE.md do not restate the return shape, so they don't inherit the drift.

## 4. Findings

- **[Important]** `src/lib/peer-mcp-personas.ts:1764-1765` — the advertised return shape `Returns {ok, outcome:{status, winner?, artifact?, reason, gatesPassed?}}` under-describes the real union and can misroute the model's result-parsing. It omits (a) the `{ok:false, error}` validation-failure branch (`run-workflow-live.ts:87-97` — bad workspace, unknown gateId, non-object ir, failed IR verification), (b) the `rejected` status with its `violations` array (`kernel.ts:69`), and (c) the `escalated` status with `nodeId` and NO `gatesPassed` (`kernel.ts:72`). It also implies `reason`/`gatesPassed` are always present when both are status-conditional. Concrete consequence: a model that reads `outcome.gatesPassed` after an `escalated`/`rejected` outcome gets `undefined`, and one that expects `outcome` on every response mis-handles the `{ok:false,error}` branch. Fix: expand the summary to name all four statuses and the `{ok:false,error}` branch, e.g. "Returns `{ok:false, error}` on invalid input, else `{ok:true, outcome}` where outcome.status is `delivered` (winner/artifact/reason/gatesPassed), `baseline` (reason/artifact/gatesPassed), `rejected` (violations), or `escalated` (reason/nodeId)."

- **[Important]** `src/lib/peer-mcp-personas.ts:1770-1771` — "fail-to-baseline on any infra failure" overstates the guarantee by one documented exception. When the BASELINE itself cannot be produced the kernel does NOT ship a baseline (there is none) — it returns `status:"escalated"` (`kernel.ts:110-115`). A model relying on "any infra failure ships something usable" would not anticipate the escalate-with-no-artifact outcome. Fix: append the carve-out, e.g. "fail-to-baseline on any infra failure (except when the baseline itself cannot run, which escalates)."

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:1791` — `maxRetries` description omits the server-side clamp to `[0,3]` (`run-workflow-live.ts:102-105`). A caller passing `maxRetries: 20` silently gets 3. Not harmful, but stating the bound ("clamped 0-3") makes the knob honest and removes a surprise.

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:1780` — the `workspace` field description says "Absolute path to the git workspace" but does not say what happens on a non-absolute or non-repo path. The absolute requirement IS enforced (`run-workflow-live.ts:88-90` returns `{ok:false, error}`) and a non-repo path fails safe to baseline (`createWorktree` throws → infra failure), so this is well-behaved; a half-sentence ("must be absolute; a non-repo path fails safe to the baseline") would preempt a confused retry loop. Non-blocking.

## 5. Verdict

Y — the injected surface is correct on every load-bearing claim (sealed-gate ownership, the gate enum, the worker gate, and the `max(orchestrated, baseline)` champion-retention floor all verify against code), minimal (no echoed or diagnostic fields), framing-compliant, and cross-surface consistent. Single most important fix: correct the return-shape summary (Finding I1) so the model parses the full `{ok:false,error}` / four-status union instead of the advertised single shape, and pair it with the baseline-cannot-run escalate carve-out (Finding I2).
