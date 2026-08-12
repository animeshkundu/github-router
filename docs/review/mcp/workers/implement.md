# Review: `mcp__workers__implement`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__workers__implement` |
| Group / server | `workers` (serverInfo `github-router-workers`) |
| Wire tool name | `implement` |
| Definition | `src/lib/peer-mcp-personas.ts:1347` (NON_PERSONA_MCP_TOOLS entry) |
| Always-on? | gated |
| Capability gate | `worker` → `workerToolsEnabled()` (`src/lib/mcp-capabilities.ts:99`) |
| Backing model / endpoint | `gpt-5.6-sol` at `xhigh` (`IMPLEMENT_DEFAULT_MODEL`, `src/lib/worker-agent/engine.ts:168`); Copilot `/responses` or `/chat/completions` via the worker stream (model-resolved) |
| Write-capable | yes: `edit`/`write`/`bash`/`codex_review` on top of the 9 read-only tools (13 total, `src/lib/worker-agent/tools.ts`, `buildWorkerTools`) |
| Dispatcher subagent | `worker-implement` (`dispatcherAgentName`, `src/lib/worker-dispatch.ts:57-60`) |

Dual surface: the MCP tool `description` and the `worker-implement` background dispatcher subagent. The raw `mcp__workers__implement` call is denied from the main agent by the PreToolUse guard and redirected to the `worker-implement` dispatcher (`decideWorkerGuard`, `src/lib/worker-dispatch.ts:153-199`); only the matching dispatcher is allowed through.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/peer-mcp-personas.ts:1350-1364`), verbatim:

> Runs as the background `worker-implement` agent. Dispatch via the Agent tool (subagent_type: worker-implement) so the turn is never blocked; the result arrives as a completion notification. Delegates a scoped coding task to an autonomous worker (Pi runtime; default model `gpt-5.6-sol` at high reasoning, override via `model` with any Copilot-catalog model that advertises `tool_calls`). It has the explore read-only tools plus edit, write, bash, and codex_review, and it returns its final text with any changed files or worktree diff. Use for bounded implementation work that may take a while or benefits from isolated worker context. Not for pure research, planning, review, or independent test authoring; use explore, plan, review, or test for those scopes. ALWAYS runs in an isolated git worktree and returns the diff via a saved patch file (a `--stat` summary + a bounded preview + the patch path; a small diff is inlined in full) — it never edits your working tree, and it HARD-ERRORS if the workspace is not a git repository. For in-place edits, use the native `implementer` subagent.

Input-schema fields (`src/lib/peer-mcp-personas.ts:1365-1423`):

- `prompt` (string, **required**): "The coding task — what to change, build, or fix. The worker plans its own edit/write/bash sequence."
- `worktree` (boolean): "Ignored — worker_implement ALWAYS runs in an isolated git worktree and returns the diff (retained for compatibility; worktree:false is overridden with a note). For in-place edits, use the `implementer` subagent."
- `model` (string): "Optional Copilot catalog model id (defaults to gpt-5.6-sol). Must advertise tool_calls support; the engine emits an isError envelope listing the eligible catalog models on mismatch."
- `thinking` (string enum `off|minimal|low|medium|high|xhigh`): "Optional reasoning depth (default xhigh). Silently clamped to the model's allowed range; \"off\" drops the parameter entirely."
- `workspace` (string): "Optional absolute path to the workspace the worker operates in. Defaults to the proxy's launch cwd. Use this when the parent agent has multiple workspaces open and the worker must operate in a specific one. Must be absolute (relative paths rejected). Must be inside a git repo (implement always runs in a worktree)."
- `maxWallClockMs` (integer): "Optional per-call wall-clock budget in ms; default 6h (21600000). Clamped just under the MCP tool-call ceiling (the injected MCP tool-call timeout minus a 15-min teardown headroom) so the worker aborts gracefully with its partial work rather than being hard-killed; the effective value is reported in the result when a larger value is clamped down."

`required: ["prompt"]`, `additionalProperties: false` (`src/lib/peer-mcp-personas.ts:1366-1368`). The `worktree` field remains accepted for cached-client compatibility, but it is not an execution choice. `runWorkerToolCall` validates its type, forces `worktree = true`, and prepends this note only when the caller supplied `false`: "worker_implement always runs in an isolated git worktree; the requested worktree:false was overridden. For in-place edits, use the `implementer` subagent." (`src/lib/peer-mcp-personas.ts:2252-2274`).

### 2a-bis. Dispatcher subagent (`worker-implement`)

One-line description (`dispatcherDescription`, `src/lib/worker-dispatch.ts:206-224`), verbatim:

> Non-blocking `implement` worker: dispatches an autonomous coding worker (read/write/bash) that ALWAYS runs in an isolated git worktree and returns the diff (for in-place edits use the `implementer` subagent), in the background, and delivers its result as a completion notification.

This is followed by the shared suffix at `src/lib/worker-dispatch.ts:221-223`: "Use proactively for any implement-mode worker task so a long run never blocks your turn: it returns immediately and notifies you when done."

The dispatcher system prompt (`dispatcherPrompt`, `src/lib/worker-dispatch.ts:227-261`) calls `mcp__workers__implement` exactly once and passes through `prompt`/`workspace`/`model`/`thinking`/`maxWallClockMs`. It no longer accepts or forwards a `worktree` field; isolation is enforced at the MCP boundary instead. Hard rules forbid doing the task itself, reading or editing files, spawning agents, or paraphrasing the output. Its `tools:` allowlist is `mcp__workers__*` only (`dispatcherTools`, `src/lib/worker-dispatch.ts:264-272`), so it cannot recurse or do side work.

### 2b. System prompt (`--append-system-prompt`)

The worker sentence in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:613-624`), verbatim:

> `worker-*` are background Agent subagents (subagent_type) that run the matching worker in its own context and deliver the result as a completion notification, so a long run never blocks the turn: `worker-explore` (read-only research), `worker-review` (reads the code to verify a change or claim), `worker-plan` (ordered implementation plan), `worker-implement` (edit/write/bash; ALWAYS runs in an isolated git worktree and returns the diff via a saved patch file; for in-place edits use the `implementer` subagent), `worker-test` (independent test author; also always worktree-isolated). The raw `mcp__workers__*` tools they call are guarded (a direct main-thread call is redirected to the matching agent); Workers themselves have `code_search`.

A second routing sentence in the same block says:

> For a bounded, well-scoped implementation, prefer the `implementer` subagent over `worker-implement`; reach for `worker-implement` only when you specifically need git-worktree isolation, parallel variants, or a throwaway experiment.

The clauses are gated on `opts.workerToolsAvailable`, so they appear only when the live `tools/list` serves worker tools.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored peer-awareness block is the same text as 2b, injected through `src/lib/claude-md-injection.ts` from `buildPeerAwarenessSnippet`. No separate mirrored CLAUDE.md clause is dedicated to this tool.

The checked-in root `CLAUDE.md:134` documents mandatory isolation for `implement`/`test`, the compatibility-only ignored `worktree` argument, the override note, routing in-place edits to `implementer`, saved `.patch` output for diffs above 8 KiB, and universal relay-safe `.txt` spill behavior. `docs/peer-mcp-design.md:406-412` records the mandatory worktree and cleanup contract. These claims match `runWorkerToolCall`, `worktree.ts`, and `relay-cap.ts`.

### 2d. Result delivery and relay cap

`WorktreeHandle.finalize()` (`src/lib/worker-agent/worktree.ts:400-498`) inlines a diff at or below `PREVIEW_CAP` (8 KiB). Above that threshold it saves the full `git diff --binary --full-index HEAD` patch under `PATHS.WORKER_DIFFS_DIR/<pid>-<8hex>.patch` and returns a `--stat` summary, a UTF-8-safe bounded preview, and the absolute patch path.

All worker modes then pass the worker body through `relaySafeText` at the MCP boundary (`runWorkerToolCall`, `src/lib/peer-mcp-personas.ts:2362-2369`). If the assembled body exceeds `GH_ROUTER_WORKER_MAX_RESULT_BYTES`, default 16 KiB and clamped to 8 through 20 KiB, the full result is saved as `PATHS.WORKER_DIFFS_DIR/<pid>-<8hex>.txt`; the inline result becomes a bounded preview plus the file path (`src/lib/worker-agent/relay-cap.ts:32-65,119-155`). This second cap protects any large result, including model prose around a patch summary.

## 3. Assessment

### 3a. Description quality

- **Clarity and routing signal**: Strong. The description leads with the non-blocking dispatch contract, states the model and override rule, identifies the write-capable surface, makes isolation unconditional, explains large versus small diff delivery, states the no-git hard error, and routes in-place edits to the native `implementer` subagent.
- **When NOT to use**: Substantially improved. The tool description excludes research, planning, review, and independent test authoring, while both the description and awareness block draw the key `worker-implement` versus `implementer` boundary. The earlier Important finding about no routing distinction across implementation surfaces is therefore addressed for the common path. A minor `codex_implementer` distinction remains only when `--codex-cli` is enabled; see Findings.
- **Accuracy vs implementation**: Verified accurate. `runWorkerToolCall` always supplies `worktree:true` for implement/test and reports a requested `false` override (`src/lib/peer-mcp-personas.ts:2252-2274`); the engine provisions the worktree and hard-errors on creation failure (`src/lib/worker-agent/engine.ts:387-410`); `finalize()` saves large binary-capable patches and inlines small diffs (`src/lib/worker-agent/worktree.ts:400-498`); `relaySafeText` spills oversized worker bodies to `.txt` (`src/lib/worker-agent/relay-cap.ts:128-155`). Model selection, thinking clamping, absolute workspace validation, and wall-clock clamping remain accurate.
- **Schema minimality**: Five fields are active inputs; `worktree` is now a compatibility tombstone rather than a model-tunable control. In isolation it would fail the minimality rule, but removing it while `additionalProperties:false` is in force would break cached clients. Retaining it with an explicit "Ignored" description and deterministic override note is the narrow compatibility exception. `prompt`, `model`, `thinking`, `workspace`, and `maxWallClockMs` remain actionable.

### 3b. System-prompt coverage

- **Named**: Yes. `worker-implement` is named with mandatory worktree isolation, saved-patch delivery, and the in-place `implementer` route.
- **Non-redundant**: The snippet supplies the cross-surface routing map; the tool description carries execution and output details. The separate preference sentence resolves the lightweight bounded-edit versus isolated worker choice.
- **Framing-constraint compliance**: The capability clause is factual. The explicit preference sentence is intentional routing guidance and matches the tool description's boundary.

### 3c. CLAUDE.md coverage

- **Accurate, not drifted for this tool**: The mirrored block equals the awareness snippet. The checked-in root `CLAUDE.md:134` and `docs/peer-mcp-design.md:406-412` match the MCP boundary, patch persistence, relay spill, and cleanup behavior.
- **Injected vs checked-in consistency**: Consistent. The injected block is the compact routing surface; the checked-in documentation carries the full operational contract.

### 3d. Cross-surface consistency

The tool description, schema, dispatcher description and prompt, awareness snippet, checked-in docs, and implementation agree that `worker-implement` always uses an isolated git worktree, never edits the caller's working tree, hard-errors outside a git repository, and routes in-place work to `implementer`. The compatibility-only `worktree` field is accepted but not forwarded by the dispatcher; the MCP boundary forces it true. Large diffs persist as `.patch` files, and any still-oversized worker body can spill as a relay-safe `.txt` file.

## 4. Findings

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:1350-1364` and `PERSONAS_WRITE` at `src/lib/peer-mcp-personas.ts:427-442`: the earlier Important finding about no when-NOT-to-use guidance is mostly resolved. In-place work now routes explicitly to the native `implementer`, and the awareness block prefers that subagent for bounded work. The remaining overlap is `codex_implementer` when `--codex-cli` is enabled: both it and the native `implementer` can perform in-place scoped implementation, but the worker description does not distinguish them. This is a narrow conditional routing ambiguity, not a worktree-safety defect.

No Critical or Important findings. The prior in-place race no longer exists on the MCP implement path because the boundary forces isolation; `worktree:false` is only a compatibility input that produces an override note.

## 5. Verdict

Y. The injected surface is accurate, compatibility-safe, and consistent about mandatory worktree isolation, saved-patch diff delivery, relay-safe result spill, no-git failure, and routing in-place edits to `implementer`. The previous most important routing gap is addressed for the normal surface; only the conditional `codex_implementer` distinction remains as a suggestion.
