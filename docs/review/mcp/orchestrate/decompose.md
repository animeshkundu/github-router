# Review: `mcp__orchestrate__decompose`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__orchestrate__decompose` |
| Group / server | `orchestrate` (serverInfo `github-router-orchestrate`) |
| Wire tool name | `decompose` |
| Definition | `src/lib/peer-mcp-personas.ts:1686` (NON_PERSONA_MCP_TOOLS) |
| Always-on? | gated |
| Capability gate | `capability: "worker"` → `workerToolsEnabled()` (shares the worker backend gate; `src/lib/peer-mcp-personas.ts:1688`) |
| Backing model / endpoint | driver `claude-opus-4-8` xhigh `/v1/messages` (default in `buildLiveDecomposeDeps`, `src/lib/orchestration/decompose-live.ts:106`) + cross-lab critic `gemini-3.1-pro-preview` high `/v1/chat/completions` (`src/lib/peer-mcp-personas.ts:1739`) via `dispatchModelCall` |
| Write-capable | no (returns an IR object; executes nothing) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

`src/lib/peer-mcp-personas.ts:1689-1702`:

> Compose a VERIFIED, tool-routed workflow IR from an open-ended software ask. A single strong driver model drafts a typed WorkflowIR; a static verifier checks it against the floor invariants and the driver re-drafts on any violation; a cross-lab critic reviews a clean draft. Returns {ok, ir, rounds, concerns?} on success, or {ok:false, violations, rounds} if it never converged. WHY: a single model anchors on its own framing of a task (the decompose step is itself a single point of failure), so the driver is decorrelated by a cross-lab critic, and the output is a typed IR a verifier/kernel enforce in CODE rather than prose the model could quietly violate. The IR is DATA you then pass to run_workflow (or re-check with verify_workflow). Reach for it on non-trivial, role-separated asks where blind-spot reduction pays off; a trivial ask does not need it.

Input schema (`src/lib/peer-mcp-personas.ts:1703-1716`), `required: ["ask"]`, `additionalProperties: false`:
- `ask` (string): "The open-ended software task to decompose into a verified workflow."
- `context` (string, optional): "Optional extra context (repo facts, constraints) for the driver."

### 2b. System prompt (`--append-system-prompt`)

`buildPeerAwarenessSnippet`, `src/lib/peer-mcp-personas.ts:607-610` (emitted only when `opts.workerToolsAvailable`, matching the live `tools/list` gate — verbatim):

> `mcp__orchestrate__decompose` composes an open-ended ask into a typed, VERIFIED workflow IR (a strong driver decorrelated by a cross-lab critic, so the decompose step isn't a single point of failure), and `mcp__orchestrate__run_workflow` executes that IR through a frozen kernel delivering max(orchestrated, baseline) over a sealed executable gate, so it never ships worse than a plain single-model run. `mcp__orchestrate__verify_workflow` checks an IR's floor invariants before you run it, and `mcp__orchestrate__attest_step` audits that a finished run's producers were each checked by a different lab. They suit non-trivial, role-separated asks; a trivial ask does not need them.

When `workerToolsAvailable` is false the else-branch (`src/lib/peer-mcp-personas.ts:612-614`) deliberately does NOT name `decompose` ("the `decompose`/`run_workflow` composer + kernel need the worker backend, unavailable here"). This correctly mirrors the gate. Pinned by `tests/peer-mcp-personas.test.ts:569` (absent in minimal snippet) and `:572` (present with workers).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering block: peer-awareness (same text as 2b — the mirrored CLAUDE.md carries `buildPeerAwarenessSnippet` output). No separate directive block covers this tool.

Checked-in root `CLAUDE.md:129` documents the tool under "Six intent-named MCP servers": the `orchestrate` group holds "the workflow tools `decompose`, `verify_workflow`, `run_workflow`, `attest_step` — a distinct category from `workers`: these compose/verify/run/audit a workflow, whereas the workers are what a workflow delegates to; `verify_workflow`/`attest_step` are pure + always-on, `decompose`/`run_workflow` share the worker backend gate." Agrees with the code (gate at `:1688`; pure siblings verified against `verify_workflow` at `:1672`).

Also injected (surface 3): the `/gh-orchestrate` skill (`src/lib/injected-skills/orchestrate-skill.ts:61,63`) instructs the model to call `mcp__orchestrate__decompose({ ask, context: research brief plus blind-spots })` — it treats `context` as a load-bearing carrier for the research brief. See Finding 1.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: strong. The description states what it returns in both branches, gives an explicit WHY (single-model framing is a single point of failure), and carries a clear when-to-use / when-NOT ("non-trivial, role-separated asks ... a trivial ask does not need it"). Crucially it names the composition-vs-execution boundary: "The IR is DATA you then pass to run_workflow (or re-check with verify_workflow)." A model reading this learns decompose does not execute anything.
- **Accuracy vs implementation**: the described loop matches `decomposeWorkflow` (`src/lib/orchestration/decompose.ts:86-135`) exactly — driver drafts, static verifier checks, driver re-drafts on violation with the violations as feedback, a cross-lab critic reviews a clean draft. Return shapes match `DecomposeResult` (`decompose.ts:49-51`) and the handler's `isError: !result.ok` (`:1743`). The driver model is not named in the description (only "a single strong driver model"); the default is `claude-opus-4-8` xhigh (`decompose-live.ts:106`) and the critic is `gemini-3.1-pro-preview` (`:1739`) — genuinely cross-lab (anthropic driver vs google critic). No stale id.
- **Schema minimality**: `ask` is required and load-bearing. `context` is declared optional and its handler-side plumbing is entirely severed — see Finding 1. This is a minimality violation: an input field the model is told it can pass, that the tool silently ignores.

### 3b. System-prompt coverage

- **Named or omitted**: named when workers are available, omitted (by design) when not — correctly gated to mirror `tools/list`.
- **Accurate & non-redundant**: accurate; compresses the description without contradicting it, and pairs decompose with run_workflow (compose → execute) so the model learns the two-step flow. Not redundant with the description (the description is the deep reference; the snippet is the one-line routing pointer).
- **Framing-constraint compliance**: compliant. No imperatives directed at the reader, no "Lead with X", no hedges, no anchors disguised as description. It is declarative capability text. The `context` field is not mentioned in the snippet, so the snippet itself does not propagate the dead-field problem.

### 3c. CLAUDE.md coverage

- **Accurate, non-drifted**: the peer-awareness block (2b) and the root CLAUDE.md server-split paragraph (`:129`) both agree with the code on gate, category, and sibling always-on status. No drift there.
- **Injected-block vs checked-in consistency**: consistent between the mirrored snippet and root CLAUDE.md. The inconsistency is with the third injected surface, the `/gh-orchestrate` skill, which relies on a field the code drops (Finding 1).

### 3d. Cross-surface consistency

One contradiction, and it is the central finding: the tool schema (2a) advertises `context`, and the injected `/gh-orchestrate` skill (2c) actively instructs the model to pass the research brief through `context` — but the handler and live adapter never read it. Description ↔ skill ↔ code disagree. The system-prompt snippet (2b) and root CLAUDE.md are internally consistent and do not mention `context`, so they are clean.

## 4. Findings

- **[Important]** `context` input is accepted, documented, and skill-directed, but silently dropped — never reaches the driver.
  `src/lib/peer-mcp-personas.ts:1725-1743`: the handler reads only `args.ask` (`:1725`) and calls `decomposeWorkflow(ask, deps, ...)` (`:1742`); `args.context` is never read here. `buildLiveDecomposeDeps`'s `draftIR({ ask, feedback })` (`src/lib/orchestration/decompose-live.ts:108`) destructures only `ask`/`feedback` — `grep context` in that file returns zero matches. And `decomposeWorkflow` calls `safeDraft(deps, { ask, feedback })` (`src/lib/orchestration/decompose.ts:98`, `:120`), never threading `context`, even though the `DecomposeDeps.draftIR` type declares `context?: string` (`decompose.ts:33`). So the field is severed at all three levels. This is worse than an idle echoed input: the injected `/gh-orchestrate` skill (`src/lib/injected-skills/orchestrate-skill.ts:61,63`) tells the model to pass "research brief plus blind-spots" as `context`, so the model's most load-bearing grounding for the decomposition is silently discarded, and the driver decomposes the bare ask with no repo facts or constraints. Not Critical because decompose still returns a verifier-clean IR (the floor invariants hold on `ask` alone), so there is no correctness or data-loss failure — but the quality of the IR is materially degraded versus what the skill promises. Repro: launch `github-router claude`, run `/gh-orchestrate` on any non-trivial ask; the skill issues `decompose({ ask, context: <brief> })`; instrument `dispatchModelCall`'s `userText` in `decompose-live.ts:108-111` and observe it contains only `Ask:\n<ask>` with no `<brief>`.
  Fix (pick one): (a) thread `context` end to end — read `args.context` in the handler, pass it into `decomposeWorkflow`, thread it through `safeDraft`/`draftIR`, and append it to `userText` in `decompose-live.ts` (the `DecomposeDeps.draftIR` type already supports it, so this is the minimal-surprise fix and honors the skill); or (b) if context is intentionally unsupported, drop the `context` property from the input schema (`:1712-1715`) AND fix the `/gh-orchestrate` skill (`:61,63`) to stop passing it. Option (a) is preferred: the skill's design intent is that decompose is grounded by the research brief.

- **[Suggestion]** Description does not name the driver model, but names no fallback either.
  `src/lib/peer-mcp-personas.ts:1690-1691` says "a single strong driver model" without a slug. That is defensible (the model's job is to call the tool, not pin the model), and consistent with how `run_workflow` describes itself. No change required; noting only that unlike the worker tools' CLAUDE.md rows, there is no operator-facing "errors at call time if `claude-opus-4-8` absent" note. The gate is on the worker sentinel, not on the driver model, so if `claude-opus-4-8` is missing on a lesser tier the driver dispatch would fail at call time. This is consistent with the `worker_implement`/`gpt-5.5` pattern documented elsewhere; a one-line note in the design doc would close the loop, but the model-facing surface is fine.

## 5. Verdict

N — the injected surface is well-routed and the description/system-prompt/CLAUDE.md triple is accurate and framing-compliant, but the schema advertises a `context` field that the code severs at three call sites while the injected `/gh-orchestrate` skill actively feeds the research brief through it. Single most important fix: thread `context` end to end into the driver's `userText` (or remove it from the schema and the skill).
