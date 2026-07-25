# Review: `mcp__workers__plan`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__workers__plan` |
| Group / server | `workers` (serverInfo `github-router-workers`) |
| Wire tool name | `plan` |
| Definition | `src/lib/peer-mcp-personas.ts:1450` |
| Always-on? | gated by capability `worker` |
| Capability gate | `worker` → `workerToolsEnabled()` (`src/lib/mcp-capabilities.ts:99`) |
| Backing model / endpoint | `claude-opus-5` at `xhigh` (native, via `/chat/completions`); overridable by caller `model` |
| Write-capable | no (read-only tool surface; the worker is framed as a planner and cannot edit) |

Dual surface: the MCP tool `plan` AND the background dispatcher subagent `worker-plan` (`dispatcherDescription("plan")`, `src/lib/worker-dispatch.ts:211-212`). The lead is steered to dispatch via the Agent tool (`subagent_type: worker-plan`), which calls `mcp__workers__plan` once and relays verbatim.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/peer-mcp-personas.ts:1454-1466`):

> Runs as the background `worker-plan` agent. Dispatch via the Agent tool (subagent_type: worker-plan) so your turn is never blocked; the result arrives as a completion notification. Read-only implementation planning by an autonomous worker (Pi runtime; default model `claude-opus-5`, override via `model` with any Copilot-catalog model that advertises `tool_calls`). Same read-only toolset as `explore` (read, glob, grep, code_search, web_search, fetch_url, advisor, update_plan, toolbelt) — it CANNOT edit — but the worker is framed as a planner: from the task and acceptance criteria it produces a concrete, ordered implementation plan (the files to change, the approach, the key risks, and how each acceptance criterion will be verified), grounded by reading the actual code. Brief it with the task and any acceptance criteria; it returns a single plan, not code.

Input-schema fields (`src/lib/peer-mcp-personas.ts:1467-1516`):

- `prompt` (required, string): "The task to plan — what to build or change, plus any acceptance criteria. The worker reads the codebase and returns an ordered implementation plan."
- `model` (optional, string): "Optional Copilot catalog model id (defaults to claude-opus-5). Must advertise tool_calls support; the engine emits an isError envelope listing the eligible catalog models on mismatch."
- `thinking` (optional, enum `off|minimal|low|medium|high|xhigh`): "Optional reasoning depth (default high). Silently clamped to the model's allowed range; \"off\" drops the parameter entirely."
- `workspace` (optional, string): "Optional absolute path to the workspace the worker operates in. Defaults to the proxy's launch cwd. Use this when the parent agent has multiple workspaces open and the worker must operate in a specific one. Must be absolute (relative paths rejected)."
- `maxWallClockMs` (optional, integer): "Optional per-call wall-clock budget in ms; default 6h (21600000). Clamped just under the MCP tool-call ceiling (the injected MCP tool-call timeout minus a 15-min teardown headroom) so the worker aborts gracefully with its partial work rather than being hard-killed; the effective value is reported in the result when a larger value is clamped down."

Dispatcher subagent human description (`src/lib/worker-dispatch.ts:211-212` + `:218-221`):

> Non-blocking `plan` worker: dispatches a read-only planner that returns an ordered implementation plan, in the background, and delivers it as a completion notification. Use proactively for any plan-mode worker task so a long run never blocks your turn: it returns immediately and notifies you when done.

The dispatcher's own system prompt (`dispatcherPrompt`, `src/lib/worker-dispatch.ts:226+`) is a thin "call the one worker tool once, relay verbatim, do nothing else" frame — not model-facing routing text, so it is out of scope for the routing-signal assessment. The worker's planner ROLE frame (`PLAN_ROLE`, `src/lib/worker-agent/prompts.ts:79`) is the internal system prompt the worker runs under, not part of the injected `tools/list` surface.

### 2b. System prompt (`--append-system-prompt`)

The worker sentence in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:598-601`), gated on `opts.workerToolsAvailable`, names `worker-plan` verbatim:

> `worker-*` are background Agent subagents (subagent_type) that run the matching worker in its own context and deliver the result as a completion notification, so a long run never blocks the turn: `worker-explore` (read-only research), `worker-review` (reads the code to verify a change or claim), `worker-plan` (ordered implementation plan), `worker-implement` (edit/write/bash; `worktree: true` isolates in a git worktree and returns the diff), `worker-test` (independent test author). The raw `mcp__workers__*` tools they call are guarded (a direct main-thread call is redirected to the matching agent); Workers themselves have `code_search`.

`worker-plan` is named, tagged with the one-liner "(ordered implementation plan)". The plan model / effort / read-only nature are NOT in the snippet (correctly — that detail lives in the tool `description`, surface 2a; the snippet only orients the model to which worker exists). `/gh-orchestrate` and its skill (`src/lib/injected-skills/orchestrate-skill.ts:61,64,87`) and `/gh-worker` (`src/lib/injected-skills/worker-skill.ts:31`) also reference `worker-plan`; both agree with the code (ordered implementation plan from task + acceptance criteria).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The injected marker block covering this tool is **peer-awareness** — the SAME `buildPeerAwarenessSnippet` text as surface 2b, appended to the mirrored CLAUDE.md by `claude-md-injection.ts` (`appendPeerAwareness`, `src/lib/claude-md-injection.ts:641+`). So the `worker-plan` clause in 2b is verbatim what lands in the mirrored CLAUDE.md; no separate/divergent text.

Checked-in repo root `CLAUDE.md` documents the plan default in the "worker tools" paragraph:

> read-only `plan` → `PLAN_DEFAULT_MODEL` = `claude-opus-5` (single-segment exact catalog id — the worker resolver exact-matches `catalog.id`) at `xhigh` (planning is the highest-leverage step, so it gets the strongest model, not a cheaper default; errors helpfully at call time if opus-5 is absent, like `implement`'s `gpt-5.6-sol`)

This matches the code exactly: `PLAN_DEFAULT_MODEL = "claude-opus-5"` (`engine.ts:197`), `PLAN_DEFAULT_THINKING = "xhigh"` (`engine.ts:198`), and the resolver exact-matches `catalog.id` (`model-resolve.ts:99`: `catalog.find((m) => m.id === opts.model)`).

## 3. Assessment

### 3a. Description quality

**Clarity & routing signal.** Strong. The model learns: this is read-only planning (cannot edit), it returns a plan not code, brief it with task + acceptance criteria, and it runs in the background via the Agent tool so the turn isn't blocked. The "it CANNOT edit … it returns a single plan, not code" is a clear when-NOT signal that separates plan from `implement`/`test`. The tool surface is listed explicitly so the model knows what the worker can reach.

**Accuracy vs implementation.**
- Default model `claude-opus-5` — CORRECT. It is a single-segment slug and exact live Copilot `catalog.id` match (`model-resolve.ts:99`), so there is no dotted-vs-dashed distinction on this worker path.
- `tool_calls` requirement + isError envelope listing eligible models — CORRECT (`model-resolve.ts:100-101` enumerates candidates on unknown-model miss).
- Read-only toolset list (read, glob, grep, code_search, web_search, fetch_url, advisor, update_plan, toolbelt) — CORRECT; plan shares explore's read-only surface (`prompts.ts:73` "Review/plan modes share explore's read-only tool surface"; `buildWorkerTools` returns the explore array for plan too).
- The `thinking` field says **"default high"** but the actual plan default is **`xhigh`** (`PLAN_DEFAULT_THINKING`, `engine.ts:198`; applied via `opts.thinking ?? defaultThinking` at `engine.ts:344`). When the caller omits `thinking`, `runWorkerToolCall` leaves it `undefined` (`peer-mcp-personas.ts:2178-2195`), so the engine applies `xhigh`, NOT high. The schema field lies about the effective default. This is a shared copy-pasted `thinking` description across all worker tools, but plan (and explore) default to xhigh while the string says high. See Findings.

**Schema minimality.** All five fields pass the minimality bar:
- `prompt` — required, the task. Necessary.
- `model` — model-tunable, actionable (override + eligible-list on error). Justified.
- `thinking` — model-tunable reasoning depth. Justified (modulo the wrong stated default).
- `workspace` — actionable in multi-workspace scenarios; absolute-only enforced at the boundary. Justified.
- `maxWallClockMs` — model-tunable budget; the clamp behavior is actionable ("effective value is reported when clamped"). Justified.

No echoed-input or diagnostic-only fields. Surface is minimal.

### 3b. System-prompt coverage

**Named.** `worker-plan` is named in `buildPeerAwarenessSnippet` (`peer-mcp-personas.ts:600`) with the one-liner "(ordered implementation plan)".

**Accurate & non-redundant.** The snippet orients ("which worker exists, what it returns") without duplicating the tool `description`'s model/effort/toolset detail. Non-redundant with 2a by design.

**Framing-constraint compliance.** Compliant. The `worker-plan` clause is a descriptive noun-phrase ("ordered implementation plan"), no imperative ("Lead with…"), no hedge, no anchor. `tests/peer-mcp-personas.test.ts:536` pins `expect(snippet).not.toMatch(/^Lead with /im)`; the plan clause does not trip it.

### 3c. CLAUDE.md coverage

**Accurate, non-drifted.** The injected peer-awareness block is the same snippet as 2b (no drift by construction). The checked-in root `CLAUDE.md` "worker tools" paragraph states `PLAN_DEFAULT_MODEL = claude-opus-5` DOTTED at `xhigh` — matches `engine.ts:197-198` and correctly explains the dotted-vs-dashed distinction (resolver exact-matches `catalog.id`). No drift.

**docs/peer-mcp-design.md gap.** A grep for `PLAN_DEFAULT_MODEL` / `worker-plan` / "planning is the highest" in `docs/peer-mcp-design.md` returns nothing. The design doc's "Worker tools" section predates the per-mode model split and does not document plan mode's `claude-opus-5`/`xhigh` default. Minor doc gap; the root CLAUDE.md carries the authoritative fact.

### 3d. Cross-surface consistency

The one cross-surface inconsistency is INSIDE the tool description itself: the prose says the default model is `claude-opus-5` at implied strongest reasoning, and the root CLAUDE.md + code confirm `xhigh`, but the `thinking` schema field says "default high". Description prose (implied strong) and code (`xhigh`) agree; only the `thinking` field's stated default is wrong. System prompt and CLAUDE.md peer-awareness are consistent (same snippet). No contradiction between the dispatcher description, the tool description, and the code on the read-only / background / returns-a-plan facts.

## 4. Findings

- **[Important]** `src/lib/peer-mcp-personas.ts:1490-1493` — the `thinking` field description says "default high", but plan mode's effective default is `xhigh` (`PLAN_DEFAULT_THINKING`, `engine.ts:198`, applied at `engine.ts:344` when the caller omits `thinking`; the MCP handler leaves it `undefined`, `peer-mcp-personas.ts:2178-2195`). A model reading the schema believes omitting `thinking` yields `high` and may pass `thinking: "xhigh"` to "upgrade" when it is already at xhigh, or under-reason expecting high. Fix: change the plan tool's `thinking` description to "Optional reasoning depth (plan defaults to `xhigh`, clamped to the model's allowed range; `off` drops the parameter entirely)." This is a per-tool string; the same generic "default high" text is reused on explore (also xhigh) and the write workers — verify each against its own `*_DEFAULT_THINKING` when fixing, do not blanket-edit.

- **[Suggestion]** `docs/peer-mcp-design.md` "Worker tools" section — add plan mode's `PLAN_DEFAULT_MODEL = claude-opus-5` (dotted) / `xhigh` default and the "planning is the highest-leverage step" rationale, so the design doc matches the root CLAUDE.md and the code (`engine.ts:197-198`). Currently the design doc has no plan-mode model row.

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:1481-1485` — the `model` field says "defaults to claude-opus-5" but does not note this is the DOTTED catalog id (not the dashed `claude-opus-4-8` the model may know from the `/model` picker). A model trying to re-specify the same default via `model:` could pass the dashed slug and hit the unknown-model isError. Optional one-clause add: "(the Copilot dotted catalog id, not the dashed `/model` slug)". Non-blocking; the isError envelope already lists valid ids.

## 5. Verdict

Y — the injected surface is correct, minimal, well-routed, and consistent across all three surfaces, with the DOTTED `claude-opus-5` default verified correct for the exact-match `catalog.id` resolver (`model-resolve.ts:99`). Single most important fix: correct the `thinking` field's stated default from "high" to `xhigh` (`peer-mcp-personas.ts:1490-1493`) so it stops misreporting plan mode's effective reasoning depth.
