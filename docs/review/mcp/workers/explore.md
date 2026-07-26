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
| Capability gate | `worker` → `workerToolsEnabled()` (`src/lib/mcp-capabilities.ts:99`): `GH_ROUTER_DISABLE_WORKER_TOOLS !== "1"` AND the sentinel `WORKER_DEFAULT_MODEL` = `gpt-5.4-mini` is in the live catalog with `tool_calls` |
| Backing model / endpoint | default `EXPLORE_DEFAULT_MODEL` = `gemini-3.6-flash` at `high`; fast/cheap 1M read-only research over the `/chat/completions` shim. Caller `model`/`thinking` args win. |
| Write-capable | no (read-only 9-tool surface, `buildWorkerTools` `src/lib/worker-agent/tools.ts:1925-1938`) |

Dual model-facing surface: the raw MCP tool `mcp__workers__explore` is guarded for the main agent (a direct call is denied + redirected — `decideWorkerGuard` `src/lib/worker-dispatch.ts:154-197`); the main agent reaches it through the `worker-explore` background dispatcher subagent (`dispatcherDescription`/`dispatcherPrompt` `src/lib/worker-dispatch.ts:203-254`). Both surfaces are reviewed below.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

`src/lib/peer-mcp-personas.ts:1198-1213`:

> "Runs as the background `worker-explore` agent. Dispatch via the Agent tool (subagent_type: worker-explore) so your turn is never blocked; the result arrives as a completion notification. Read-only investigation by an autonomous worker (Pi runtime; default model `gemini-3.6-flash` at high reasoning, override via the `model` arg with any Copilot-catalog model that advertises `tool_calls`). Tools: read, glob, grep, code_search (semantic-first), web_search, fetch_url, advisor (consult a stronger cross-lab model), update_plan (planning checklist), and toolbelt (run a read-only analysis CLI: rg/fd/jq/yq/sg/gron/tokei/difft/git). The worker's system prompt sandboxes it and gives one-line descriptions of each tool, so brief it on the investigation, not on tool semantics. Offloads bounded research that would otherwise eat your context window — the worker plans its own tool calls and returns a single text answer. Examples: \"find files matching X then summarize\", \"how does library Y handle Z\", \"survey this codebase for usages of deprecated API\"."

Input schema (`personas.ts:1214-1263`):
- `prompt` (string, **required**): "The investigation brief — what to find, read, or explain. The worker plans its own tool calls and returns a single text answer."
- `model` (string, optional): "Optional Copilot catalog model id (defaults to gemini-3.6-flash). Must advertise tool_calls support; the engine emits an isError envelope listing the eligible catalog models on mismatch."
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

Checked-in root `CLAUDE.md:133` ("worker tools" paragraph) documents explore accurately:

> "read-only `explore` → `EXPLORE_DEFAULT_MODEL` = `gemini-3.6-flash` at `high` (fast/cheap 1M read-only research over the `/chat/completions` shim; NOT a gate input — errors at call time if absent)"

and the 9-tool read-only surface: "explore/review expose 9 read-only tools — `read`/`glob`/`grep`/`code_search` … `web_search`/`fetch_url` plus a read-only `toolbelt` tool …, `advisor` … and `update_plan`". This agrees with `engine.ts:146` and `tools.ts:1925-1938`.

`/gh-worker` skill (`src/lib/injected-skills/worker-skill.ts:29`): "worker-explore: read-only investigation / codebase gathering, returns a summary." Accurate, no model claim.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: Strong. The lead is told (1) to dispatch via the `worker-explore` Agent subagent, not call the raw tool; (2) that it is read-only; (3) the exact tool inventory; (4) the "brief the investigation, not tool semantics" instruction; (5) three concrete example briefs. The when-to-use signal ("Offloads bounded research that would otherwise eat your context window") is present. A when-NOT signal is implicit only (read-only → not for edits); the sibling `worker-implement`/`worker-review` descriptions carry the disambiguation, and the awareness snippet lists all five side by side, so cross-tool routing is adequately covered.
- **Accuracy vs implementation**: Two stale facts. (i) The description and the `model` field both name `gpt-5.4-mini` as the default; the actual explore default is `claude-sonnet-5` (`engine.ts:146`). `gpt-5.4-mini` is now only the gate SENTINEL / unmatched-mode fallback (`DEFAULT_MODEL` `engine.ts:135`), no longer explore's default. (ii) The `thinking` field says "default high"; explore's actual default thinking is `xhigh` (`DEFAULT_THINKING` `engine.ts:136`, reached via the default branch `engine.ts:341` since explore is not browse/plan/review/write-capable). Everything else (read-only, tool list, semantic-first code_search, `tool_calls` requirement, isError-on-unknown-model, workspace absolute-only, wall-clock clamp) matches code.
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
- **Checked-in root `CLAUDE.md:133`** — accurate and agrees with code (`claude-sonnet-5 at xhigh`, 9-tool surface, gate semantics). This is the one surface that got the model default RIGHT, which makes the description drift stand out.
- **`/gh-worker` skill** — accurate.

### 3d. Cross-surface consistency

One contradiction cluster, all pointing the same way: the MCP `description` + `model`/`thinking` schema fields (`personas.ts:1200,1229-1230,1238`) AND `docs/peer-mcp-design.md:365` (+ the stale comment at `:444`) say explore defaults to `gpt-5.4-mini` at high, while `engine.ts:146`, root `CLAUDE.md:133`, and the code path say `claude-sonnet-5` at `xhigh`. The awareness snippet, the dispatcher description, and the gh-worker skill all sidestep the conflict by not naming a model. The dispatcher and MCP descriptions do NOT say the same thing twice with drift — the dispatcher description is model-silent, so the DUAL surfaces are complementary (dispatch mechanics vs tool inventory), not duplicated. No behavioral contradiction: the code ignores these strings and uses the constant, so the drift misleads the model's expectations but does not misroute execution.

## 4. Findings

- **[Important]** `src/lib/peer-mcp-personas.ts:1200` and `:1229-1230` — the tool `description` and the `model` field both state the explore default is `gpt-5.4-mini`, but `EXPLORE_DEFAULT_MODEL = "claude-sonnet-5"` (`engine.ts:146`). Per the review-checklist rule "a model default named in the description that doesn't match engine.ts is Important." Fix: change both occurrences to `claude-sonnet-5`. Not regression-locked — `tests/peer-mcp-personas.test.ts:12-24` pins only the `worker-<mode>` string / "Agent tool" / "completion notification", not the model, so the edit is free.
- **[Important]** `src/lib/peer-mcp-personas.ts:1238` — the `thinking` field says "Optional reasoning depth (default high)"; explore's actual default is `xhigh` (`DEFAULT_THINKING` `engine.ts:136`, used by the default branch at `engine.ts:341`). Fix: "(default xhigh)". (Note the sibling `worker-review`/`worker-implement` `thinking` fields carry the same "default high" wording; review is xhigh→high-clamped and implement is xhigh, so those are separately worth checking — out of scope for this doc.)
- **[Suggestion resolved]** `docs/peer-mcp-design.md` and the worker description now agree on `gemini-3.6-flash` at high for explore and `gemini-3.1-pro-preview` for review.
- **[Suggestion resolved]** The worker-tool source comment now records explore → `gemini-3.6-flash` at high.

## 5. Verdict

**N** — the injected surface is minimal, well-routed, framing-compliant, and consistent across every surface EXCEPT the model/thinking default: the MCP `description` (and its `model`/`thinking` schema fields, plus a code comment and the design doc) still name `gpt-5.4-mini` at high while the code defaults explore to `claude-sonnet-5` at `xhigh`. Single most important fix: correct the `gpt-5.4-mini`→`claude-sonnet-5` and "default high"→"default xhigh" drift in `peer-mcp-personas.ts:1200,1229-1230,1238` (the root `CLAUDE.md` already has it right).
