# Review: `mcp__workers__explore`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__workers__explore` |
| Group / server | `workers` (serverInfo `github-router-workers`) |
| Wire tool name | `explore` |
| Definition | `src/lib/peer-mcp-personas.ts:1193` (`NON_PERSONA_MCP_TOOLS`) |
| Always-on? | gated by capability `worker` |
| Capability gate | `worker` → `workerToolsEnabled()` (`src/lib/mcp-capabilities.ts:99`): `GH_ROUTER_DISABLE_WORKER_TOOLS !== "1"` AND a model in `DEFAULT_MODEL_CHAIN` (`gpt-5.6-luna` → `gpt-5.4-mini`) is in the live catalog with `tool_calls` |
| Backing model / endpoint | default `EXPLORE_DEFAULT_MODEL` = `gpt-5.6-luna` at `high`; 1M read-only research. Caller `model`/`thinking` args win. |
| Write-capable | no (read-only 9-tool surface, `buildWorkerTools` `src/lib/worker-agent/tools.ts:1925-1938`) |

Dual model-facing surface: the raw MCP tool `mcp__workers__explore` is guarded for the main agent (a direct call is denied + redirected — `decideWorkerGuard` `src/lib/worker-dispatch.ts:154-197`); the main agent reaches it through the `worker-explore` background dispatcher subagent (`dispatcherDescription`/`dispatcherPrompt` `src/lib/worker-dispatch.ts:203-254`). Both surfaces are reviewed below.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

`src/lib/peer-mcp-personas.ts:1198-1213`:

> "Runs as the background `worker-explore` agent. Dispatch via the Agent tool (subagent_type: worker-explore) so your turn is never blocked; the result arrives as a completion notification. Read-only investigation by an autonomous worker (Pi runtime; default model `gpt-5.6-luna` at high reasoning, override via the `model` arg with any Copilot-catalog model that advertises `tool_calls`). Tools: read, glob, grep, code_search (semantic-first), web_search, fetch_url, advisor (consult a stronger cross-lab model), update_plan (planning checklist), and toolbelt (run a read-only analysis CLI: rg/fd/jq/yq/sg/gron/tokei/difft/git). The worker's system prompt sandboxes it and gives one-line descriptions of each tool, so brief it on the investigation, not on tool semantics. Offloads bounded research that would otherwise eat your context window — the worker plans its own tool calls and returns a single text answer. Examples: \"find files matching X then summarize\", \"how does library Y handle Z\", \"survey this codebase for usages of deprecated API\"."

Input schema (`personas.ts:1214-1263`):
- `prompt` (string, **required**): "The investigation brief — what to find, read, or explain. The worker plans its own tool calls and returns a single text answer."
- `model` (string, optional): "Optional Copilot catalog model id (defaults to gpt-5.6-luna). Must advertise tool_calls support; the engine emits an isError envelope listing the eligible catalog models on mismatch."
- `thinking` (string enum `off|minimal|low|medium|high|xhigh`, optional): "Optional reasoning depth (default high). Silently clamped to the model's allowed range; \"off\" drops the parameter entirely."
- `workspace` (string, optional): "Optional absolute path to the workspace the worker operates in. Defaults to the proxy's launch cwd. Use this when the parent agent has multiple workspaces open and the worker must operate in a specific one. Must be absolute (relative paths rejected)."
- `maxWallClockMs` (integer, optional): "Optional per-call wall-clock budget in ms; default 6h (21600000). Clamped just under the MCP tool-call ceiling (the injected MCP tool-call timeout minus a 15-min teardown headroom) so the worker aborts gracefully with its partial work rather than being hard-killed; the effective value is reported in the result when a larger value is clamped down."

### 2a-bis. Dispatcher subagent `worker-explore` description (Agent-tool registry)

`dispatcherDescription("explore")` `src/lib/worker-dispatch.ts:205-206` + the shared suffix at `:218-221`:

> "Non-blocking `explore` worker: dispatches a read-only autonomous worker (its own context) in the background and delivers its summary as a completion notification. Use proactively for any explore-mode worker task so a long run never blocks your turn: it returns immediately and notifies you when done."

Dispatcher system prompt (`dispatcherPrompt("explore")` `src/lib/worker-dispatch.ts:226-254`): a thin relay — call `mcp__workers__explore` exactly once passing through `prompt`/`workspace`/`model`/`thinking`/`maxWallClockMs`, output the result verbatim, do not attempt the task, do not spawn agents. `tools:` frontmatter is `mcp__workers__*` only (`dispatcherTools` `:263-264`), so it has no Read/Bash/Agent.

### 2b. System prompt (`--append-system-prompt`)

`buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:598-601`), emitted only when `workerToolsAvailable`:

> "`worker-*` are background Agent subagents (subagent_type) that run the matching worker in its own context and deliver the result as a completion notification, so a long run never blocks the turn: `worker-explore` (read-only research), `worker-review` (reads the code to verify a change or claim), `worker-plan` (ordered implementation plan), `worker-implement` (edit/write/bash; `worktree: true` isolates in a git worktree and returns the diff), `worker-test` (independent test author). The raw `mcp__workers__*` tools they call are guarded (a direct main-thread call is redirected to the matching agent); Workers themselves have `code_search`."

`worker-explore` is named as "read-only research". No model id, no imperative — description-only framing.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering block: peer-awareness (same `buildPeerAwarenessSnippet` text as 2b, mirrored via `src/lib/claude-md-injection.ts`). No separate marker block for this tool.

The authoritative current configuration is `EXPLORE_DEFAULT_MODEL = "gpt-5.6-luna"` at `high`; it is not a gate input, so an absent Luna model fails the explore call without disabling the whole worker surface. The worker exposes the nine read-only tools `read`, `glob`, `grep`, `code_search`, `web_search`, `fetch_url`, `toolbelt`, `advisor`, and `update_plan`.

`/gh-worker` skill (`src/lib/injected-skills/worker-skill.ts:29`): "worker-explore: read-only investigation / codebase gathering, returns a summary." Accurate, no model claim.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: Strong. The lead is told (1) to dispatch via the `worker-explore` Agent subagent, not call the raw tool; (2) that it is read-only; (3) the exact tool inventory; (4) the "brief the investigation, not tool semantics" instruction; (5) three concrete example briefs. The when-to-use signal ("Offloads bounded research that would otherwise eat your context window") is present. A when-NOT signal is implicit only (read-only → not for edits); the sibling `worker-implement`/`worker-review` descriptions carry the disambiguation, and the awareness snippet lists all five side by side, so cross-tool routing is adequately covered.
- **Accuracy vs implementation**: The description, model field, and thinking field all match the current explore default: `gpt-5.6-luna` at `high`. `gpt-5.4-mini` remains only as the second member of the general gate and unmatched-mode fallback chain (`DEFAULT_MODEL_CHAIN`), not as explore's default. Everything else (read-only, tool list, semantic-first code_search, `tool_calls` requirement, isError-on-unknown-model, workspace absolute-only, wall-clock clamp) matches code.
- **Schema minimality** (per "ruthlessly minimal MCP tool surface", `docs/peer-mcp-design.md`): all five fields justified.
  - `prompt` (required) — the task. Required to call.
  - `model` (optional) — model-tunable; overrides the default, validated against the live catalog. Actionable.
  - `thinking` (optional) — model-tunable reasoning depth. Actionable.
  - `workspace` (optional) — needed only in the multi-workspace case; absolute-only enforced at the boundary. Actionable.
  - `maxWallClockMs` (optional) — tunable budget; the description explains the clamp and the reported effective value. Actionable.
  No echoed-input or diagnostic-only fields. Surface is minimal.

### 3b. System-prompt coverage

- **Named**: yes — `worker-explore` is named with a one-word role ("read-only research"). By design (the snippet lists all five worker dispatchers).
- **Accurate & non-redundant**: accurate. It does not repeat the model/tool-list detail from the description, so it is complementary, not redundant. It adds the guarded-plumbing fact ("The raw `mcp__workers__*` tools … are guarded … redirected to the matching agent") that the description also states — a deliberate reinforcement of the load-bearing routing invariant, not drift.
- **Framing-constraint compliance**: compliant. The clause is descriptive ("`worker-explore` (read-only research)"), no imperative ("Lead with…"), no hedge, no anchor. Consistent with the framing pinned by `tests/peer-mcp-personas.test.ts`.

### 3c. CLAUDE.md coverage

- **Injected block** (peer-awareness) = same text as 2b — accurate, non-redundant, not drifted.
- **Checked-in root CLAUDE.md and the tool surface** agree that explore uses `gpt-5.6-luna` at `high`, with the nine-tool read-only surface and the same gate semantics.
- **`/gh-worker` skill** — accurate.

### 3d. Cross-surface consistency

The model and thinking-default descriptions are consistent: explore uses `gpt-5.6-luna` at `high`. The gate and unmatched-mode fallback retain `gpt-5.4-mini` only as the second member of `DEFAULT_MODEL_CHAIN`, which is intentionally distinct from the explore default.

## 4. Findings

- **[Resolved]** The explore worker now consistently documents `gpt-5.6-luna` at `high`. References to `gpt-5.4-mini` are retained only for its deliberate gate and unmatched-mode fallback role.
- **[Suggestion]** No test pins the explore description's model string. Consider a focused assertion or a shared constant reference so the documentation cannot silently drift from the engine default.

## 5. Verdict

**Y** — the injected surface is minimal, well-routed, framing-compliant, and consistent with the current explore model and reasoning default.
