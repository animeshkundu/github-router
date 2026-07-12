# Subagent: `worker-test`

> Non-blocking background dispatcher for the read+write `test` worker (independent adversarial test author).

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `worker-test` (`worker-dispatch.ts:58-60`) |
| Subagent's OWN model | inherited (Claude); the WORKER runs `IMPLEMENT_DEFAULT_MODEL` = `gpt-5.6-sol` at xhigh (test shares the implement default — repo CLAUDE.md) |
| Gate | `workerToolsAvailable` (`codex-mcp-config.ts:326-335`) |
| Description | `dispatcherDescription("test")` (`worker-dispatch.ts:213-214` + suffix) |
| System prompt | `dispatcherPrompt("test", workersKey)` |
| Tools | `["mcp__<workersKey>__*"]` |

`test` is read+write (writes and runs tests) and accepts `worktree: true`; the dispatcher prompt adds the `worktree` passthrough for implement/test (`worker-dispatch.ts:241`). The worker is framed as an INDEPENDENT author that did NOT write the code under test and does NOT modify the implementation to make tests pass (repo CLAUDE.md).

## 2. Description (verbatim)

> Non-blocking `test` worker: dispatches an independent test author that writes tests trying to break the implementation, in the background, and delivers pass/fail as a completion notification. Use proactively for any test-mode worker task so a long run never blocks your turn: it returns immediately and notifies you when done.

## 3. System-prompt summary

Standard thin-dispatcher body with the `worktree` passthrough (`worker-dispatch.ts:241`): call `mcp__<workersKey>__test` once, pass `prompt` verbatim + optional workspace/model/thinking/maxWallClockMs/worktree, relay verbatim.

## 4. Routing-trigger assessment

- **States trigger — strong.** Explicit proactive trigger; "writes tests trying to break the implementation" and "delivers pass/fail" are concrete, adversarial, and honest about the worker's role.
- **Specific — good.** independent author, break-it intent, pass/fail delivery, non-blocking.
- **Accurately previews body — yes.** The "independent / try to break / does not modify the implementation" framing maps to the worker's role frame.
- **Overtrigger — LOW-MODERATE, enforced-mechanism reasoning.** The adversarial "independent author" framing is a useful, non-blanket trigger.

## 5. Don't-nerf / right-balance

The "independent, tries to break, does not touch the implementation" framing is exactly the floor-raiser: it keeps test authorship decorrelated from implementation (which trends gpt-5.6-sol) — an honest adversarial test pass. The `worktree` option isolates the test run. Right balance.

## 6. Findings + verdict

- No Critical/Important/Suggestion findings. Field passthrough (`prompt`) matches the test tool's required schema. The adversarial-independence framing is a clean differentiator.

**Verdict: Y.** Explicit proactive trigger, honest adversarial framing, tight tool-pin.
