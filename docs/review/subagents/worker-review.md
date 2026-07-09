# Subagent: `worker-review`

> Non-blocking background dispatcher for the read-only `review` worker.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `worker-review` (`worker-dispatch.ts:58-60`) |
| Subagent's OWN model | inherited (Claude); the WORKER runs `REVIEW_DEFAULT_MODEL` = `gemini-3.1-pro-preview` at high (cross-lab, decorrelated from the gpt-5.5 implementers — repo CLAUDE.md) |
| Gate | `workerToolsAvailable` (`codex-mcp-config.ts:326-335`) |
| Description | `dispatcherDescription("review")` (`worker-dispatch.ts:209-210` + suffix) |
| System prompt | `dispatcherPrompt("review", workersKey)` |
| Tools | `["mcp__<workersKey>__*"]` |

The review worker has the SAME read-only tool surface as explore but a reviewer role-frame; unlike the stateless `peers` critics it can navigate the repo to check surrounding context itself (repo CLAUDE.md "worker tools").

## 2. Description (verbatim)

> Non-blocking `review` worker: dispatches a read-only reviewer that reads the code itself to verify a change or claim, in the background, and delivers findings as a completion notification. Use proactively for any review-mode worker task so a long run never blocks your turn: it returns immediately and notifies you when done.

## 3. System-prompt summary

Standard thin-dispatcher body (`worker-dispatch.ts:229-253`): call `mcp__<workersKey>__review` once, pass `prompt` verbatim + optional workspace/model/thinking/maxWallClockMs (no `worktree` — review is read-only), relay verbatim.

## 4. Routing-trigger assessment

- **States trigger — strong.** Explicit proactive trigger. The "reads the code itself to verify a change or claim" clause is a genuine differentiator from the stateless `peers` critics (which only see the pasted artifact).
- **Specific — good.** read-only, self-verifying (reads the repo), findings delivery, non-blocking.
- **Accurately previews body — yes.**
- **Overtrigger — LOW-MODERATE, enforced-mechanism reasoning.** The "self-navigating reviewer vs paste-only critic" distinction is the useful routing signal that keeps worker-review from competing with the peer critics.

## 5. Don't-nerf / right-balance

Correctly positions worker-review as the "reviewer that reads the code itself" — complementary to the paste-only peer critics and the coordinator, not a replacement. The cross-lab default model (gemini) is a deliberate decorrelation from the gpt-5.5 implementers. Raises the floor without nerfing the critic path. Right balance.

## 6. Findings + verdict

- No Critical/Important/Suggestion findings. Field passthrough (`prompt`) matches the review tool's required schema. The self-navigating-reviewer framing is a clean differentiator from the `peers` critics.

**Verdict: Y.** Explicit proactive trigger, clear differentiation from paste-only critics, tight tool-pin.
