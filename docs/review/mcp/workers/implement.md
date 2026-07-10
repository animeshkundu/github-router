# Review: `mcp__workers__implement`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__workers__implement` |
| Group / server | `workers` (serverInfo `github-router-workers`) |
| Wire tool name | `implement` |
| Definition | `src/lib/peer-mcp-personas.ts:1276` (NON_PERSONA_MCP_TOOLS entry) |
| Always-on? | gated |
| Capability gate | `worker` → `workerToolsEnabled()` (`src/lib/mcp-capabilities.ts:99`) |
| Backing model / endpoint | `gpt-5.6-sol` at `xhigh` (`IMPLEMENT_DEFAULT_MODEL`, `src/lib/worker-agent/engine.ts:168`); Copilot `/responses` or `/chat/completions` via the worker stream (model-resolved) |
| Write-capable | yes — `edit`/`write`/`bash`/`codex_review` on top of the 9 read-only tools (13 total, `src/lib/worker-agent/tools.ts:6-12`) |
| Dispatcher subagent | `worker-implement` (`dispatcherAgentName`, `src/lib/worker-dispatch.ts:57-60`) |

Dual surface: the MCP tool `description` AND the `worker-implement` background dispatcher subagent. The raw `mcp__workers__implement` call is DENIED from the main agent by the PreToolUse guard and redirected to the `worker-implement` dispatcher (`decideWorkerGuard`, `src/lib/worker-dispatch.ts:154-197`); only the dispatcher (or a caller passing `agent_type === "worker-implement"`) is allowed through.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/peer-mcp-personas.ts:1279-1294`), verbatim:

> Runs as the background `worker-implement` agent. Dispatch via the Agent tool (subagent_type: worker-implement) so your turn is never blocked; the result arrives as a completion notification. Delegates a scoped coding task to an autonomous worker (Pi runtime; default model `gpt-5.6-sol` at xhigh reasoning, override via the `model` arg with any Copilot-catalog model that advertises `tool_calls`). Tools: the explore read-only set (read, glob, grep, code_search, web_search, fetch_url, advisor, update_plan, toolbelt) plus edit, write, bash, and codex_review (code review by codex-reviewer / gpt-5.3-codex). The worker's system prompt sandboxes it and gives one-line descriptions of each tool, so brief it on the task, not on tool semantics. With `worktree: false` (default) edits in place — concurrent worker_implement calls and Claude's own edits to the same files will race. With `worktree: true` runs in an isolated git worktree and returns the diff for review. HARD ERROR if true and the workspace is not a git repository.

Input-schema fields (`src/lib/peer-mcp-personas.ts:1295-1354`):

- `prompt` (string, **required**): "The coding task — what to change, build, or fix. The worker plans its own edit/write/bash sequence."
- `worktree` (boolean): "When true, run inside a fresh git worktree and return Pi's final text followed by the unified diff (so the lead can review before merging). When false/omitted, edits the workspace in place — concurrent worker calls and Claude's own edits will race. HARD ERROR if true and the workspace is not a git repository."
- `model` (string): "Optional Copilot catalog model id (defaults to gpt-5.6-sol). Must advertise tool_calls support; the engine emits an isError envelope listing the eligible catalog models on mismatch."
- `thinking` (string enum `off|minimal|low|medium|high|xhigh`): "Optional reasoning depth (default xhigh). Silently clamped to the model's allowed range; \"off\" drops the parameter entirely."
- `workspace` (string): "Optional absolute path to the workspace the worker operates in. Defaults to the proxy's launch cwd. Use this when the parent agent has multiple workspaces open and the worker must operate in a specific one. Must be absolute (relative paths rejected). For worktree:true, must be inside a git repo."
- `maxWallClockMs` (integer): "Optional per-call wall-clock budget in ms; default 6h (21600000). Clamped just under the MCP tool-call ceiling (the injected MCP tool-call timeout minus a 15-min teardown headroom) so the worker aborts gracefully with its partial work rather than being hard-killed; the effective value is reported in the result when a larger value is clamped down."

`required: ["prompt"]`, `additionalProperties: false` (`src/lib/peer-mcp-personas.ts:1297-1298`).

### 2a-bis. Dispatcher subagent (`worker-implement`)

One-line description (`dispatcherDescription`, `src/lib/worker-dispatch.ts:207-208`), verbatim:

> Non-blocking `implement` worker: dispatches an autonomous coding worker (read/write/bash, optional git worktree) in the background and delivers its result as a completion notification.

...followed by the shared suffix (`:219-221`): "Use proactively for any implement-mode worker task so a long run never blocks your turn: it returns immediately and notifies you when done."

Dispatcher system prompt (`dispatcherPrompt`, `src/lib/worker-dispatch.ts:226-254`): a thin relay that calls `mcp__workers__implement` exactly once, passing through `prompt`/`workspace`/`model`/`thinking`/`maxWallClockMs`, and — implement/test only — `worktree` ("pass `true` if the lead asked for isolated-worktree execution", `:241`). Hard rules forbid it doing the task itself, reading/editing, spawning agents, or paraphrasing the output. `tools:` allowlist is `mcp__workers__*` only (`dispatcherTools`, `:263-265`) — no Agent/Read/Bash, so it cannot recurse or do side work.

### 2b. System prompt (`--append-system-prompt`)

The worker sentence in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:600`), verbatim clause naming this tool:

> `worker-*` are background Agent subagents (subagent_type) that run the matching worker in its own context and deliver the result as a completion notification, so a long run never blocks the turn: `worker-explore` (read-only research), `worker-review` (reads the code to verify a change or claim), `worker-plan` (ordered implementation plan), `worker-implement` (edit/write/bash; `worktree: true` isolates in a git worktree and returns the diff), `worker-test` (independent test author). The raw `mcp__workers__*` tools they call are guarded (a direct main-thread call is redirected to the matching agent); Workers themselves have `code_search`.

Gated on `opts.workerToolsAvailable` (`src/lib/peer-mcp-personas.ts:598-602`), so the clause only appears when the live `tools/list` actually serves the worker tools.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The mirrored peer-awareness block is the SAME text as 2b (injected via `src/lib/claude-md-injection.ts`, sourced from `buildPeerAwarenessSnippet`). No separate CLAUDE.md clause is dedicated to this tool.

The checked-in repo root `CLAUDE.md` documents the tool in its "worker tools" paragraph (`CLAUDE.md:133`): "`implement` read+write", the 13-tool surface ("implement adds `edit`/`write`/`bash`/`codex_review` (13 total)"), `IMPLEMENT_DEFAULT_MODEL = gpt-5.6-sol at xhigh`, "`implement` accepts `worktree: boolean` for git-worktree isolation (per-call auto-clean `finally` + session-end SIGINT/SIGTERM sweep + boot-time PID+UUID-gated sweep)", the strict bash env allowlist, and the absolute-only workspace enforcement at the MCP boundary. `docs/peer-mcp-design.md:361` carries the per-mode table row and `:408-412` the worktree-orphan safety-net writeup. All three agree with the code (`engine.ts:329`, `tools.ts:6-12`, `worktree.ts`, `lifecycle.ts`).

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: Strong. The description leads with the non-blocking dispatch contract, states the model (gpt-5.6-sol xhigh) and override rule, enumerates the 13-tool surface, and explicitly signals write/exec scope ("edit, write, bash") plus the worktree isolation trade-off. The in-place race warning is present and correct: "concurrent worker_implement calls and Claude's own edits to the same files will race" (`:1290-1292`). This is exactly the write/exec-scope disclosure the task asked me to scrutinize, and it is well done — the one weakness (a stale tool name in that sentence) is flagged below.
- **When NOT to use**: The description does not draw a line against the two sibling implementation surfaces (native `implementer` subagent, `codex_implementer`), the largest routing gap — see Findings.
- **Accuracy vs implementation**: Verified accurate. `gpt-5.6-sol` default (`engine.ts:168,329`); `tool_calls` requirement and isError-with-catalog-list on mismatch (`engine.ts:342-348`, `resolveModelAndThinking`); the 13-tool set (`tools.ts:6-12`); `worktree:true` returns text + unified diff (`engine.ts:52,431-454`, docs `:408`); HARD ERROR when `worktree:true` and no git (`engine.ts:387-389`, `createWorktree` throws); default `thinking` xhigh with `off` dropping the param (`engine.ts:333-341`); absolute-only workspace (`runWorkerToolCall`, `src/lib/peer-mcp-personas.ts:2226-2234`); `maxWallClockMs` clamp with effective value reported (`:2259-2267`).
- **Schema minimality** (per "ruthlessly minimal MCP tool surface", `docs/peer-mcp-design.md`): all six fields pass.
  - `prompt` — required, the payload.
  - `worktree` — actionable and load-bearing; toggles the isolation-vs-in-place trade-off the model must choose per call. Justified.
  - `model` / `thinking` — model-tunable, caller override always wins (`engine.ts:342-344`).
  - `workspace` — actionable when the parent has multiple workspaces open; absolute-only enforced.
  - `maxWallClockMs` — model-tunable budget; the clamp note is actionable feedback the model can act on next call. Justified.
  No echoed-input or diagnostic-only fields. Surface is minimal.

### 3b. System-prompt coverage

- **Named**: Yes — `worker-implement` is named in the snippet (`:600`) with its capability tag "(edit/write/bash; `worktree: true` isolates in a git worktree and returns the diff)". Accurate and compact.
- **Non-redundant**: The snippet is a routing map across all worker modes; it complements rather than duplicates the per-tool description. Good.
- **Framing-constraint compliance**: The clause is descriptive, no imperatives ("Lead with…"), no hedges, no anchors. It states capability and mechanism only. Compliant with the framing constraint pinned by `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

- **Accurate, not drifted**: The mirrored block equals the awareness snippet (2b). The checked-in root `CLAUDE.md:133` and `docs/peer-mcp-design.md:361,408-412` match the code on model, tool count, worktree behavior, and cleanup layers. No drift found.
- **Injected vs checked-in consistency**: Consistent. The injected block is a subset (routing map); the checked-in doc is the full spec. No contradiction.

### 3d. Cross-surface consistency

Description, dispatcher body, awareness snippet, root CLAUDE.md, and design doc all agree on: model (gpt-5.6-sol xhigh), the 13-tool write-capable surface, `worktree` semantics (isolate + return diff; HARD ERROR without git), and the in-place race. The one cross-surface inconsistency is cosmetic and internal to the description string (stale `worker_implement` name in one clause — Finding 2). No behavioral contradiction between any surface and the code.

## 4. Findings

- **[Important]** `src/lib/peer-mcp-personas.ts:1279-1294` — No when-NOT-to-use signal disambiguating the THREE overlapping implementation surfaces. A model that wants "implement a scoped coding task" sees three near-synonymous entries with no line drawn between them: (1) this `mcp__workers__implement` (gpt-5.6-sol xhigh, autonomous Pi worker, optional worktree, background 6h dispatch); (2) the native `implementer` subagent ("Bounded implementation subagent running gpt-5.6-sol… well-scoped coding tasks — edits, small features, fixes", `src/lib/codex-mcp-config.ts:311`); (3) `codex_implementer` (gpt-5.3-codex workspace-write via codex CLI, `--codex-cli` only, `src/claude.ts:119`). Misroute scenario: the model reaches for `worker-implement` (heavyweight background dispatch + completion-notification round-trip) for a two-line edit that the integrated `implementer` subagent would finish inline, or vice-versa picks the integrated `implementer` for a long autonomous multi-file build that wants the worker's worktree isolation and 6h budget. Fix: add one when-to-prefer clause to the description, e.g. "Prefer for long / autonomous / worktree-isolated runs; for a bounded inline edit the native `implementer` subagent is lighter." (Root CLAUDE.md already states this distinction at `CLAUDE.md` "Native implementation subagent" — "workers stay for long / autonomous / worktree-isolated runs" — but that line is not in the model-facing description or snippet.) Note the boundary between description and snippet is fuzzy for this: the snippet is the natural home for cross-tool routing, so the fix could land in either, but today NEITHER carries it.

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:1290-1291` — Stale tool name inside the description: "concurrent worker_implement calls and Claude's own edits". The MCP-facing wire name is `implement` (renamed from `worker_implement`; the rename is documented at `CLAUDE.md:129` and `docs/peer-mcp-design.md:129`). The `worktree` field's own description already uses the corrected phrasing ("concurrent worker calls", `:1311-1312`). Harmless (the model still parses intent) but inconsistent with the rename convention every other surface follows. Fix: change "worker_implement calls" → "worker calls" to match the `worktree`-field wording.

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:1289-1290` — "The worker's system prompt sandboxes it and gives one-line descriptions of each tool, so brief it on the task, not on tool semantics." This is a correct and useful steer, but "sandboxes it" slightly oversells the isolation for the default `worktree:false` path, where the worker edits the real workspace in place (the very race the next sentence warns about). The sandbox claim is accurate for filesystem confinement (`confineToWorkspace`) and the bash env allowlist, not for write isolation. Minor; consider "confines it to the workspace" to avoid implying edits are isolated by default.

## 5. Verdict

Y — the injected surface is correct, minimal, consistent across all surfaces, and clearly signals write/exec scope, the worktree isolation trade-off, and the in-place race. Single most important fix: add a when-to-prefer clause disambiguating this worker from the native `implementer` subagent and `codex_implementer`, so the model routes bounded inline edits away from the heavyweight background dispatch.
