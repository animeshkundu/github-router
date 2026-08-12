# Subagent: `worker-plan`

> Non-blocking background dispatcher for the read-only `plan` worker.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `worker-plan` (`worker-dispatch.ts:58-60`) |
| Subagent's OWN model | inherited (Claude); the WORKER runs `PLAN_DEFAULT_MODEL` = `claude-opus-5` (exact catalog id) at high by default; callers can restore a higher tier per call or via `worker_defaults` |
| Gate | `workerToolsAvailable` (`codex-mcp-config.ts:326-335`) |
| Description | `dispatcherDescription("plan")` (`worker-dispatch.ts:211-212` + suffix) |
| System prompt | `dispatcherPrompt("plan", workersKey)` |
| Tools | `["mcp__<workersKey>__*"]` |

## 2. Description (verbatim)

> Non-blocking `plan` worker: dispatches a read-only planner that returns an ordered implementation plan, in the background, and delivers it as a completion notification. Use proactively for any plan-mode worker task so a long run never blocks your turn: it returns immediately and notifies you when done.

## 3. System-prompt summary

Standard thin-dispatcher body: call `mcp__<workersKey>__plan` once, pass `prompt` verbatim + optional workspace/model/thinking/maxWallClockMs (no `worktree` — read-only), relay verbatim.

## 4. Routing-trigger assessment

- **States trigger — strong.** Explicit proactive trigger; "returns an ordered implementation plan" is a concrete deliverable.
- **Specific — good.** read-only planner, ordered plan output, non-blocking.
- **Accurately previews body — yes.**
- **Overtrigger — LOW-MODERATE.** "for any plan-mode worker task" is broad but scoped by the non-blocking rationale. Potential overlap: worker-plan vs Claude Code's own Plan-mode / native Plan subagent. The description does not differentiate; a lead could reach for either. The differentiator (worker-plan runs opus-5 in its own context and is non-blocking) is not stated. Minor — see finding.

## 5. Don't-nerf / right-balance

Reserving the strongest model (opus-5) for the highest-leverage step (planning) is a deliberate, floor-raising choice. The non-blocking framing keeps a long plan from stalling the turn. It does not force planning through the worker (the native Plan path stays available). Balance is right; the only gap is that the description does not say WHY to pick this over native planning.

## 6. Findings + verdict

- **[Suggestion]** The description does not differentiate worker-plan from Claude Code's native Plan-mode / Plan subagent. Since the worker's edge is "opus-5, own context, non-blocking, reads the actual code", one clause naming that edge would sharpen the route. Non-blocking; the proactive trigger already works, this only reduces ambiguity.
- Field passthrough (`prompt`) matches the plan tool's required schema.

**Verdict: Y (minor differentiation gap).** Explicit proactive trigger, strong-model rationale, accurate preview. The only soft spot is no stated edge over native planning.
