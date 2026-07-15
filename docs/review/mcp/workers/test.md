# Review: `mcp__workers__test`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__workers__test` |
| Group / server | `workers` (serverInfo `github-router-workers`) |
| Wire tool name | `test` |
| Definition | `src/lib/peer-mcp-personas.ts:1592` (tool entry); handler routes to `runWorkerToolCall({ mode: "test" })` at `:1679` |
| Always-on? | gated by `capability: "worker"` (`src/lib/peer-mcp-personas.ts:1594`) |
| Capability gate | `worker` → `workerToolsEnabled()` (`src/lib/mcp-capabilities.ts:99`): `GH_ROUTER_DISABLE_WORKER_TOOLS` unset and catalog has `WORKER_DEFAULT_MODEL` (`gpt-5.4-mini`) with `tool_calls`. The resolved test model is `gpt-5.6-sol` (`IMPLEMENT_DEFAULT_MODEL`), which is not a gate input; if absent, the mode errors at call time. |
| Backing model / endpoint | `gpt-5.6-sol` at `xhigh` (`IMPLEMENT_DEFAULT_MODEL`, `src/lib/worker-agent/engine.ts:168,329`); Pi runtime over the model-resolved Copilot endpoint |
| Write-capable | yes: same 13-tool read+write surface as `implement` (`src/lib/worker-agent/types.ts`, `src/lib/worker-agent/tools.ts`, `buildWorkerTools`) |
| Dual dispatcher surface | `worker-test` background subagent (`dispatcherDescription`, `src/lib/worker-dispatch.ts:206-224`), invoked as `Agent(subagent_type: "worker-test")` |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

`src/lib/peer-mcp-personas.ts:1595-1610`:

> Runs as the background `worker-test` agent. Dispatch via the Agent tool (subagent_type: worker-test) so the turn is never blocked; the result arrives as a completion notification. Independent adversarial test authoring by an autonomous worker (Pi runtime; default model `gpt-5.6-sol` at xhigh reasoning, override via `model` with any Copilot-catalog model that advertises `tool_calls`). It has the same read/write toolset as implement and writes tests that try to break the implementation through edge cases, error paths, and acceptance criteria, then runs them and reports pass/fail. Use when a separate test author should challenge an implementation without modifying the production code to make tests pass. Not for implementing fixes, broad research, or code review; use implement, explore, or review for those scopes. ALWAYS runs in an isolated git worktree and returns the test diff via a saved patch file (a `--stat` summary + a bounded preview + the patch path; a small diff is inlined in full) — it never edits your working tree, and it HARD-ERRORS if the workspace is not a git repository. For in-place test authoring, use the native `implementer` subagent.

Input-schema fields (`src/lib/peer-mcp-personas.ts:1611-1670`):

- **`prompt`** (required, string): "What to test — the feature or change and its acceptance criteria. The worker authors and runs tests that try to break it and reports which pass and fail."
- **`worktree`** (boolean): "Ignored — worker_test ALWAYS runs in an isolated git worktree and returns the diff (retained for compatibility; worktree:false is overridden with a note). For in-place test authoring, use the `implementer` subagent."
- **`model`** (string): "Optional Copilot catalog model id (defaults to gpt-5.6-sol). Must advertise tool_calls support; the engine emits an isError envelope listing the eligible catalog models on mismatch."
- **`thinking`** (string enum `off|minimal|low|medium|high|xhigh`): "Optional reasoning depth (default xhigh). Silently clamped to the model's allowed range; \"off\" drops the parameter entirely."
- **`workspace`** (string): "Optional absolute path to the workspace the worker operates in. Defaults to the proxy's launch cwd. Use this when the parent agent has multiple workspaces open and the worker must operate in a specific one. Must be absolute (relative paths rejected). Must be inside a git repo (test always runs in a worktree)."
- **`maxWallClockMs`** (integer): "Optional per-call wall-clock budget in ms; default 6h (21600000). Clamped just under the MCP tool-call ceiling (the injected MCP tool-call timeout minus a 15-min teardown headroom) so the worker aborts gracefully with its partial work rather than being hard-killed; the effective value is reported in the result when a larger value is clamped down."

`required: ["prompt"]`, `additionalProperties: false` (`src/lib/peer-mcp-personas.ts:1612-1614`). The `worktree` field remains accepted for cached-client compatibility. It is not an execution choice: `runWorkerToolCall` validates its type, forces `worktree = true`, and prepends this note only when the caller supplied `false`: "worker_test always runs in an isolated git worktree; the requested worktree:false was overridden. For in-place edits, use the `implementer` subagent." (`src/lib/peer-mcp-personas.ts:2252-2274`).

### 2a-bis. Dispatcher subagent (`worker-test`)

Dispatcher subagent blurb (`dispatcherDescription`, `src/lib/worker-dispatch.ts:206-224`), verbatim:

> Non-blocking `test` worker: dispatches an independent test author (in an isolated git worktree) that writes tests trying to break the implementation, in the background, and delivers pass/fail as a completion notification.

This is followed by the shared suffix at `src/lib/worker-dispatch.ts:221-223`: "Use proactively for any test-mode worker task so a long run never blocks your turn: it returns immediately and notifies you when done."

The dispatcher system prompt (`dispatcherPrompt`, `src/lib/worker-dispatch.ts:227-261`) calls `mcp__workers__test` exactly once and passes through `prompt`/`workspace`/`model`/`thinking`/`maxWallClockMs`. It no longer accepts or forwards a `worktree` field; isolation is enforced at the MCP boundary. Hard rules prohibit doing the task itself, reading or editing files, spawning agents, or paraphrasing the result. Its `tools:` allowlist is `mcp__workers__*` only (`dispatcherTools`, `src/lib/worker-dispatch.ts:264-272`).

### 2b. System prompt (`--append-system-prompt`)

`buildPeerAwarenessSnippet`, `src/lib/peer-mcp-personas.ts:613-624`, includes this verbatim worker sentence:

> `worker-*` are background Agent subagents (subagent_type) that run the matching worker in its own context and deliver the result as a completion notification, so a long run never blocks the turn: `worker-explore` (read-only research), `worker-review` (reads the code to verify a change or claim), `worker-plan` (ordered implementation plan), `worker-implement` (edit/write/bash; ALWAYS runs in an isolated git worktree and returns the diff via a saved patch file; for in-place edits use the `implementer` subagent), `worker-test` (independent test author; also always worktree-isolated). The raw `mcp__workers__*` tools they call are guarded (a direct main-thread call is redirected to the matching agent); Workers themselves have `code_search`.

The tool is named as `worker-test` with both distinguishing properties: independent test authoring and mandatory worktree isolation. The clause is gated behind `opts.workerToolsAvailable`.

Worker-side role frame (`systemPromptFor("test")` → `TEST_ROLE`, `src/lib/worker-agent/prompts.ts:81`), verbatim:

> You are an INDEPENDENT test author; you did NOT write the code under test. From the task and acceptance criteria, write tests that try to BREAK the implementation (edge cases, error paths, and the acceptance criteria as executable checks), then run them and report which pass and which fail. Do NOT modify the implementation to make tests pass.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covered by the peer-awareness block, which is the same text as 2b and is mirrored through `src/lib/claude-md-injection.ts`.

The checked-in root `CLAUDE.md:134` still opens by saying the MCP surface exposes "three" worker tools and omits `plan`/`test` from that opening enumeration, as recorded in Finding 1. Later in the same paragraph it now accurately documents `implement`/`test` mandatory worktree isolation, compatibility-only ignored `worktree`, saved-patch delivery, in-place routing to `implementer`, and universal relay-safe result spill. `docs/peer-mcp-design.md:406-412` records the mandatory worktree and cleanup contract.

### 2d. Result delivery and relay cap

`WorktreeHandle.finalize()` (`src/lib/worker-agent/worktree.ts:400-498`) inlines a test diff at or below `PREVIEW_CAP` (8 KiB). Above that threshold it saves the full `git diff --binary --full-index HEAD` patch under `PATHS.WORKER_DIFFS_DIR/<pid>-<8hex>.patch` and returns a `--stat` summary, a UTF-8-safe bounded preview, and the absolute patch path.

The result body then passes through `relaySafeText` as the final worker-body transform at the MCP boundary (`runWorkerToolCall`, `src/lib/peer-mcp-personas.ts:2362-2369`). A body over `GH_ROUTER_WORKER_MAX_RESULT_BYTES`, default 16 KiB and clamped to 8 through 20 KiB, is saved in full as `PATHS.WORKER_DIFFS_DIR/<pid>-<8hex>.txt`; the inline result becomes a bounded preview plus the path (`src/lib/worker-agent/relay-cap.ts:32-65,119-155`). This protects model prose and patch metadata as well as the diff itself.

## 3. Assessment

### 3a. Description quality

- **Clarity and routing**: Strong. The description leads with non-blocking dispatch, preserves the independent-adversarial-author contract, names edge cases and error paths, makes worktree isolation unconditional, explains saved-patch versus inline diff delivery, states the no-git hard error, and routes in-place test authoring to `implementer`.
- **Accuracy vs implementation**: Verified accurate. `runWorkerToolCall` always passes `worktree:true` for test and reports a requested `false` override (`src/lib/peer-mcp-personas.ts:2252-2274`); the engine provisions the isolated worktree (`src/lib/worker-agent/engine.ts:387-410`); `finalize()` persists large binary-capable patches (`src/lib/worker-agent/worktree.ts:400-498`); `relaySafeText` spills any oversized result body (`src/lib/worker-agent/relay-cap.ts:128-155`). The model, write surface, independence role, workspace validation, and wall-clock behavior remain accurate.
- **Schema minimality**: `prompt`, `model`, `thinking`, `workspace`, and `maxWallClockMs` are actionable. `worktree` is no longer actionable and would ordinarily be removed, but `additionalProperties:false` makes removal breaking for cached clients. Its explicit "Ignored" description and deterministic override note make it a documented compatibility exception rather than a misleading choice.

### 3b. System-prompt coverage

- **Named**: Yes. The snippet identifies `worker-test` as an independent test author and states that it is always worktree-isolated.
- **Accurate and non-redundant**: The compact snippet carries routing and isolation; the tool description carries output-file and no-git details; `TEST_ROLE` carries the adversarial authoring contract.
- **Framing-constraint compliance**: The awareness clause is factual and compact. The worker-side role frame is appropriately imperative because it defines execution behavior rather than cross-tool routing.

### 3c. CLAUDE.md coverage

- The mirrored peer-awareness block is accurate for this tool.
- The checked-in root `CLAUDE.md:134` now accurately documents test's mandatory worktree behavior, patch output, relay spill, and in-place route. Its opening "three worker tools" count still omits `plan` and `test`; that pre-existing maintainer-doc drift remains.

### 3d. Cross-surface consistency

The tool description, schema, dispatcher blurb and prompt, awareness snippet, `TEST_ROLE`, checked-in worktree documentation, and code agree that test is an independent author running in mandatory isolation. The compatibility-only `worktree` input is accepted but ignored; the dispatcher no longer forwards it and the MCP boundary forces true. Large test diffs persist as `.patch` files, while any still-oversized worker body can spill as a relay-safe `.txt` file. In-place test authoring is routed to `implementer`.

## 4. Findings

- **[Important]** `CLAUDE.md:134`: the worker-tools paragraph still says the MCP surface exposes "three" worker tools and opens with only `explore`, `review`, and `implement`, omitting `plan` and `test` from the count and enumeration. The same paragraph later documents both omitted modes correctly. Fix: change the count to five and include `plan` (read-only) and `test` (read+write independent author) in the opening list.
- **[Suggestion]** Tool description at `src/lib/peer-mcp-personas.ts:1595-1610`: the independence contract and mandatory isolation now give a clear routing signal, including an explicit in-place alternative. It still does not name the natural pairing of running `test` after an independently authored implementation, but the current text already says to use it when a separate test author should challenge an implementation. No change is required for correctness.

The former worktree Finding is resolved. Test no longer merely honors an optional `worktree` argument: the MCP boundary always forces isolation, retains the field only for compatibility, and reports any `worktree:false` override.

No Critical findings. No surface promises in-place operation or exposes a race with the caller's working tree.

## 5. Verdict

**Y**. The model-facing surface accurately conveys independent test authorship, mandatory git-worktree isolation, saved-patch diff delivery, relay-safe result spill, no-git failure, and the `implementer` route for in-place test authoring. The remaining Important finding is the checked-in root CLAUDE.md's pre-existing three-versus-five worker count, not a defect in this tool's execution contract.
