# Review: `mcp__workers__test`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__workers__test` |
| Group / server | `workers` (serverInfo `github-router-workers`) |
| Wire tool name | `test` |
| Definition | `src/lib/peer-mcp-personas.ts:1528` (tool entry), `:1533` (description); handler routes to `runWorkerToolCall({ mode: "test" })` at `:1616` |
| Always-on? | gated by `capability: "worker"` (`:1531`) |
| Capability gate | `worker` → `workerToolsEnabled()` (`src/lib/mcp-capabilities.ts:99`): `GH_ROUTER_DISABLE_WORKER_TOOLS` unset AND catalog has `WORKER_DEFAULT_MODEL` (`gpt-5.4-mini`) with `tool_calls`. Note: the RESOLVED test model is `gpt-5.5` (`IMPLEMENT_DEFAULT_MODEL`), which is NOT a gate input — if absent, the mode errors at call time. |
| Backing model / endpoint | `gpt-5.5` at `xhigh` (`IMPLEMENT_DEFAULT_MODEL`, `engine.ts:168` / `:329`); Pi runtime over `/responses` (gpt-5.5) |
| Write-capable | yes — same 13-tool read+write surface as `implement` (`types.ts:52-54`, `tools.ts:1908`) |
| Dual dispatcher surface | `worker-test` background subagent (`src/lib/worker-dispatch.ts:214`), invoked `Agent(subagent_type: "worker-test")` |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

`src/lib/peer-mcp-personas.ts:1533-1546`:

> Runs as the background `worker-test` agent. Dispatch via the Agent tool (subagent_type: worker-test) so your turn is never blocked; the result arrives as a completion notification. Independent adversarial test authoring by an autonomous worker (Pi runtime; default model `gpt-5.5` at xhigh reasoning, override via `model` with any Copilot-catalog model that advertises `tool_calls`). Same read+write toolset as `implement` (the explore set plus edit, write, bash, codex_review). The worker is framed as an INDEPENDENT test author that did NOT write the code under test: from the task and acceptance criteria it writes tests that try to BREAK the implementation (edge cases, error paths, the acceptance criteria as executable checks), runs them, and reports which pass and fail — it does NOT modify the implementation to make tests pass. With `worktree: true` runs in an isolated git worktree and returns the diff; HARD ERROR if true and the workspace is not a git repository.

Input-schema fields:

- **`prompt`** (required, string) — "What to test — the feature or change and its acceptance criteria. The worker authors and runs tests that try to break it and reports which pass and fail."
- **`worktree`** (boolean) — "When true, run inside a fresh git worktree and return Pi's final text followed by the unified diff (so the lead can review the authored tests before merging). When false/omitted, writes tests in place — concurrent worker calls and Claude's own edits will race. HARD ERROR if true and the workspace is not a git repository."
- **`model`** (string) — "Optional Copilot catalog model id (defaults to gpt-5.5). Must advertise tool_calls support; the engine emits an isError envelope listing the eligible catalog models on mismatch."
- **`thinking`** (string enum `off|minimal|low|medium|high|xhigh`) — "Optional reasoning depth (default xhigh). Silently clamped to the model's allowed range; \"off\" drops the parameter entirely."
- **`workspace`** (string) — "Optional absolute path to the workspace the worker operates in. Defaults to the proxy's launch cwd. Use this when the parent agent has multiple workspaces open and the worker must operate in a specific one. Must be absolute (relative paths rejected). For worktree:true, must be inside a git repo."
- **`maxWallClockMs`** (integer) — "Optional per-call wall-clock budget in ms; default 6h (21600000). Clamped just under the MCP tool-call ceiling (the injected MCP tool-call timeout minus a 15-min teardown headroom) so the worker aborts gracefully with its partial work rather than being hard-killed; the effective value is reported in the result when a larger value is clamped down."

### 2b. System prompt (`--append-system-prompt`)

`buildPeerAwarenessSnippet`, `src/lib/peer-mcp-personas.ts:600` — the `worker-*` sentence names this tool inside a list, verbatim clause:

> `worker-*` are background Agent subagents (subagent_type) that run the matching worker in its own context and deliver the result as a completion notification, so a long run never blocks the turn: `worker-explore` (read-only research), `worker-review` (reads the code to verify a change or claim), `worker-plan` (ordered implementation plan), `worker-implement` (edit/write/bash; `worktree: true` isolates in a git worktree and returns the diff), `worker-test` (independent test author). The raw `mcp__workers__*` tools they call are guarded (a direct main-thread call is redirected to the matching agent); Workers themselves have `code_search`.

The tool is named as **`worker-test` (independent test author)**. Gated behind `opts.workerToolsAvailable` (`:598`), so the snippet never names it when the gate is off.

Worker-side ROLE frame (`systemPromptFor("test")` → `TEST_ROLE`, `src/lib/worker-agent/prompts.ts:81`), verbatim:

> You are an INDEPENDENT test author; you did NOT write the code under test. From the task and acceptance criteria, write tests that try to BREAK the implementation (edge cases, error paths, and the acceptance criteria as executable checks), then run them and report which pass and which fail. Do NOT modify the implementation to make tests pass.

Dispatcher subagent blurb (`src/lib/worker-dispatch.ts:214`):

> Non-blocking `test` worker: dispatches an independent test author that writes tests trying to break the implementation, in the background, and delivers pass/fail as a completion notification.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covered by the **peer-awareness block** (same text as 2b, mirrored via `src/lib/claude-md-injection.ts`). No artifact-panel / toolbelt block touches this tool.

Checked-in root `CLAUDE.md` (worker-tools paragraph, `CLAUDE.md:133`):

- Correct: `read+write implement/test → IMPLEMENT_DEFAULT_MODEL = gpt-5.5 at xhigh`; "the SAME read+write tool surface" (via `types.ts`); "coding wants max reasoning."
- **Drift**: the paragraph opens `/mcp also exposes **three** worker tools (group workers: explore read-only, review read-only, implement read+write ...)` — but the group exposes **five** (`explore`, `review`, `plan`, `implement`, `test`); `plan` and `test` are omitted from both the count and the enumeration. `docs/peer-mcp-design.md:380` correctly lists all five dispatcher subagents including `worker-test`. See Finding 1.
- **Drift**: `implement accepts worktree: boolean for git-worktree isolation` names only `implement`, though `test` also accepts `worktree` (`engine.ts:393`, `types.ts:53-54`). See Finding 2.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing**: strong. The description leads with the non-blocking dispatch idiom, states the independence contract in two forms ("did NOT write the code under test" + "does NOT modify the implementation to make tests pass"), lists the concrete test targets (edge cases, error paths, acceptance criteria as executable checks), and documents the worktree/diff path plus the no-git HARD ERROR. A model can tell when to reach for it (independent adversarial test authoring) vs `implement` (produce the impl).
- **Accuracy vs implementation**: verified accurate on every load-bearing claim.
  - Default model `gpt-5.5` at xhigh — matches `IMPLEMENT_DEFAULT_MODEL` (`engine.ts:168`) selected via `isWriteCapable` (`engine.ts:320,329`) and default thinking (`engine.ts:339-340`).
  - "Same read+write toolset as `implement` (the explore set plus edit, write, bash, codex_review)" — matches `buildWorkerTools` (test = implement's 13 tools, `tools.ts:1908`, `types.ts:52-54`) and the write-set assembly (`TEST_MODE_NOTE` reuses `READ_TOOL_NOTES + WRITE_TOOL_NOTES`, `prompts.ts:87`).
  - Independence frame — matches `TEST_ROLE` (`prompts.ts:81`) verbatim in intent.
  - `worktree: true` diff + HARD-ERROR-if-no-git — matches `engine.ts:392-407` (`useWorktree` requires `mode === "test"` and `worktree === true`; `createWorktree` throws → `isError` envelope).
- **Schema minimality** (per "ruthlessly minimal MCP tool surface", `docs/peer-mcp-design.md`):
  - `prompt` — required, load-bearing. Keep.
  - `worktree` — actionable, changes execution + return shape. Keep.
  - `model` — model-tunable override. Keep.
  - `thinking` — model-tunable. Keep.
  - `workspace` — actionable for multi-workspace parents; absolute-only enforced at the MCP boundary. Keep.
  - `maxWallClockMs` — model-tunable budget; effective value echoed back only when clamped, which is actionable. Keep.
  - No echoed-input or diagnostic-only fields. Surface is minimal.

### 3b. System-prompt coverage

- **Named**, not omitted — `worker-test (independent test author)` in the `worker-*` list (`:600`).
- **Accurate & non-redundant**: the snippet's four-word gloss complements, not duplicates, the fuller tool description. It correctly conveys the distinguishing property (independence) in the smallest space.
- **Framing-constraint compliance**: the clause is descriptive, no imperatives, no "Lead with", no hedges, no anchors disguised as description. Consistent with the framing discipline the snippet tests enforce (`tests/peer-mcp-personas.test.ts:295+`). Compliant.

### 3c. CLAUDE.md coverage

- Peer-awareness block (mirrored) is accurate for this tool.
- Root checked-in `CLAUDE.md:133` has the two drifts noted in 2c (three-vs-five count + enumeration omits `plan`/`test`; worktree sentence names only `implement`). The per-mode-defaults clause and tool-surface claims themselves are correct.

### 3d. Cross-surface consistency

- Tool description ↔ system prompt ↔ dispatcher blurb ↔ `TEST_ROLE` ↔ code: **consistent**. All four model-facing strings agree that test is an independent author that writes breaking tests and does not touch the impl, on the gpt-5.5/xhigh write surface, with worktree isolation.
- The only inconsistency is the checked-in root `CLAUDE.md:133` narrative (three-vs-five; worktree-implement-only) vs the code + `docs/peer-mcp-design.md:380`. This is a maintainer-doc drift, not a model-facing defect (the mirrored peer-awareness block the model actually sees is correct).

## 4. Findings

- **[Important]** `CLAUDE.md:133` — the worker-tools paragraph says "`/mcp` also exposes **three** worker tools (group `workers`: `explore` read-only, `review` read-only, `implement` read+write ...)", omitting `plan` and `test` from both the count and the parenthetical. The `workers` group exposes five (confirmed: `peer-mcp-personas.ts` tool entries + `worker-dispatch.ts:205-216` + `peer-mcp-design.md:380`). Fix: change "three" → "five" and add `plan` (read-only) and `test` (read+write, independent author) to the enumeration so the checked-in doc matches the code and the design doc.
- **[Suggestion]** `CLAUDE.md:133` — "`implement` accepts `worktree: boolean` for git-worktree isolation ..." names only `implement`, but `test` also honors `worktree` (`engine.ts:392-394`, `types.ts:53-54`, and the tool schema). Fix: "`implement`/`test` accept `worktree: boolean` ..." to match the write-capable pair.
- **[Suggestion]** Tool description (`peer-mcp-personas.ts:1533`) — the independence contract is stated well, but it does not name the natural pairing (run `test` after `implement` on the same change so a different author writes the checks). `docs/peer-mcp-design.md` and the floor-keeper/orchestrate skills already treat "different lab than the implementer" as the intended usage. A one-clause when-to-use hint ("pair with `implement` to get breaking tests authored by a worker that did not write the code") would sharpen routing without adding an imperative. Non-blocking; the current text is already correct and the independence property is clear.

No Critical findings: no surface tells the model to do something the code rejects; the git-repo HARD ERROR, model gate, and independence frame all match the implementation.

## 5. Verdict

**Y** — the model-facing surface (tool description, schema, awareness snippet, dispatcher blurb) is correct, minimal, consistent, and well-routed; the independence contract and worktree behavior are conveyed accurately across all four strings. Single most important fix: correct the checked-in `CLAUDE.md:133` "three worker tools" count and enumeration to five (add `plan` and `test`) so the maintainer doc stops drifting from the code and the design doc.
