# Subagent: `worker-implement`

> Non-blocking background dispatcher for the read+write `implement` worker.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `worker-implement` (`worker-dispatch.ts:58-60`) |
| Subagent's OWN model | inherited (Claude); the WORKER runs `IMPLEMENT_DEFAULT_MODEL` = `gpt-5.6-sol` at high (repo CLAUDE.md) |
| Gate | `workerToolsAvailable` (`codex-mcp-config.ts:326-335`) |
| Description | `dispatcherDescription("implement")` (`worker-dispatch.ts:207-208` + suffix `218-221`) |
| System prompt | `dispatcherPrompt("implement", workersKey)` (`worker-dispatch.ts:226-254`) |
| Tools | `["mcp__<workersKey>__*"]` (`worker-dispatch.ts:263-265`) |

The worker is read/write/bash-capable and accepts `worktree: true` for git-worktree isolation; the dispatcher prompt adds the `worktree` passthrough only for implement/test (`worker-dispatch.ts:241`).

## 2. Description (verbatim)

> Non-blocking `implement` worker: dispatches an autonomous coding worker (read/write/bash, optional git worktree) in the background and delivers its result as a completion notification. Use proactively for any implement-mode worker task so a long run never blocks your turn: it returns immediately and notifies you when done.

## 3. System-prompt summary

Same thin-dispatcher body as worker-explore, plus one extra passthrough field: "`worktree` (optional): pass `true` if the lead asked for isolated-worktree execution" (`worker-dispatch.ts:241`). Calls `mcp__<workersKey>__implement` exactly once, relays verbatim, does not attempt the task itself, cannot spawn agents.

## 4. Routing-trigger assessment

- **States trigger — strong.** Explicit "Use proactively for any implement-mode worker task so a long run never blocks your turn."
- **Specific — good.** Names read/write/bash + optional worktree + non-blocking delivery.
- **Accurately previews body — yes.** worktree passthrough is the only mode-specific body detail and the description names it.
- **Overtrigger — LOW-MODERATE, same enforced-mechanism reasoning as worker-explore.** The raw tool is guarded so the dispatcher is the only path; "for any implement-mode worker task" is broad but the differentiator vs the integrated `implementer` subagent lives in the word "autonomous… background" (long/autonomous/worktree runs). See README S3.

## 5. Don't-nerf / right-balance

Correctly reserved for "long / autonomous / worktree-isolated" implementation (repo CLAUDE.md), leaving the integrated common case to the native `implementer`. Raises the floor (non-blocking autonomous coding) without nerfing the integrated path. The `tools:` pin prevents the dispatcher from editing files itself. Balance is right, MODULO the three-way implement overlap (S3): the description differentiates from the native implementer via "autonomous… background" but not from `codex-implementer`.

## 6. Findings + verdict

- **[Note] Part of S3 (three-way implement overlap).** worker-implement is the "autonomous/background/worktree" corner and differentiates from the native `implementer` cleanly; the unresolved overlap is between the two FOREGROUND writers (native `implementer` vs `codex-implementer`), not this one. worker-implement's own routing line is clear.
- Field passthrough (`prompt`) matches the implement tool's required schema. No worker-implement-specific defect.

**Verdict: Y.** Clear proactive trigger, correct "autonomous/background" niche vs the integrated implementer, tight tool-pin.
