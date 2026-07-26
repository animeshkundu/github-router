# Subagent: `worker-explore`

> Non-blocking background dispatcher for the read-only `explore` worker. Reviews the routing line as a DELEGATION TRIGGER.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `worker-explore` (`dispatcherAgentName("explore")`, `src/lib/worker-dispatch.ts:58-60`) |
| Subagent's OWN model | inherited (Claude — no `model:` frontmatter); the WORKER it dispatches runs `EXPLORE_DEFAULT_MODEL` = `gemini-3.6-flash` at high (repo CLAUDE.md "worker tools") |
| Gate | `workerToolsAvailable` — the five core dispatchers are generated iff `workerToolsEnabled()` (worker default `gpt-5.4-mini` present with `tool_calls`, and `GH_ROUTER_DISABLE_WORKER_TOOLS` unset). See `buildPeerAgentDefinitions` (`codex-mcp-config.ts:326-335`) |
| Description source | `dispatcherDescription("explore")` (`worker-dispatch.ts:203-222`) |
| System prompt | `dispatcherPrompt("explore", workersKey)` (`worker-dispatch.ts:226-254`) |
| Tools | `["mcp__<workersKey>__*"]` (`dispatcherTools`, `worker-dispatch.ts:263-265`) — the workers server wildcard ONLY. No Agent/Read/Bash → cannot recurse or do extra work. Pinned by `tests/codex-mcp-config.test.ts:289` |

The dispatcher is a thin shim: Claude Code runs it in the BACKGROUND so the lead's turn never blocks while the (up-to-6h) worker runs; on completion the worker's output is delivered as a notification. This is the ONLY sanctioned way to run a worker — a raw `mcp__<workersKey>__explore` call from the main agent is denied by the PreToolUse guard and redirected here (`decideWorkerGuard`, `worker-dispatch.ts:154-197`).

## 2. Description (verbatim)

`dispatcherDescription("explore")` = `blurb.explore` + shared suffix (`worker-dispatch.ts:205-206,218-221`):

> Non-blocking `explore` worker: dispatches a read-only autonomous worker (its own context) in the background and delivers its summary as a completion notification. Use proactively for any explore-mode worker task so a long run never blocks your turn: it returns immediately and notifies you when done.

## 3. System-prompt summary

`dispatcherPrompt` (`worker-dispatch.ts:229-253`): "# Subagent: worker-explore… You are a thin DISPATCHER for the `explore` worker. You run in the background so the lead agent's turn is never blocked." Its only job: call `mcp__<workersKey>__explore` EXACTLY ONCE, passing through `prompt` (verbatim), optional `workspace`/`model`/`thinking`/`maxWallClockMs`; output the tool result VERBATIM as the final message; hard rules (call once, do not attempt the task, do not read/edit files, do not spawn agents, relay verbatim incl. errors).

## 4. Routing-trigger assessment

- **States trigger — strong.** "Use proactively for any explore-mode worker task so a long run never blocks your turn" is an explicit proactive trigger with a clear rationale (non-blocking). It is the correct idiom for a background dispatcher.
- **Specific not vague — good.** Names the mode (explore), the worker's nature (read-only, own context), and the delivery model (completion notification).
- **Accurately previews the body — yes.** Thin dispatcher, background, relay-verbatim all map to the prompt.
- **Overtrigger risk — LOW-MODERATE.** "for ANY explore-mode worker task" is broad, but the qualifier "so a long run never blocks your turn" scopes it to the non-blocking use case rather than mandating a worker for every research question. Because the raw tool is guarded, "use this dispatcher instead of the raw tool" is a correctness steer, not gratuitous overtrigger — the model MUST go through the dispatcher to run the worker at all.

## 5. Don't-nerf / right-balance

This is the intended and enforced path (the guard denies the alternative), so a strong proactive trigger is right: it raises the floor by making long research non-blocking, and the `tools:` pin (`mcp__<workersKey>__*` only) prevents the dispatcher from doing anything but relaying. Correct balance — the trigger is broad because the mechanism requires it, not because of overreach.

## 6. Findings + verdict

- No Critical/Important/Suggestion findings specific to worker-explore. Description, prompt, and tool-pin are consistent and the field it tells the worker to pass (`prompt`) matches the explore tool's required schema field. See README S2 for the systemic worker-dispatcher structure and the browse-only exception (A3).

**Verdict: Y.** Explicit proactive trigger justified by the enforced non-blocking mechanism, tightly pinned toolset, accurate body preview.
