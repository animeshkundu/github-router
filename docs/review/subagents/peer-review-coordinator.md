# Subagent: `peer-review-coordinator`

> The meta-subagent that fans out to the peer critics in parallel and aggregates findings by severity. The strongest "use proactively" auto-invocation lever in the injected set.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `peer-review-coordinator` |
| Subagent's OWN model | inherited (Claude — no `model:` frontmatter) |
| Gate | ALWAYS registered (unconditionally appended by `buildPeerAgentDefinitions`, `src/lib/codex-mcp-config.ts:304`) |
| Built by | `buildCoordinatorAgent({codexCli, geminiAvailable})` (`codex-mcp-config.ts:196-278`) |
| Description source | inline literal (`codex-mcp-config.ts:212-213`) |
| Tools | none declared → inherits parent's full toolset, so it can invoke the peer-critic subagents |

It is not a peer-MCP tool; it is a regular Claude Code subagent that runs in the spawned context, has access to the peer-critic subagents, and fans out + aggregates (`codex-mcp-config.ts:180-188`).

## 2. Description (verbatim)

`codex-mcp-config.ts:212-213`:

> Coordinates cross-lab adversarial review across codex-critic, opus-critic, gemini-critic, codex-reviewer. Use proactively before non-trivial plans and after non-trivial commits. Always pass artifacts verbatim — peers are fresh-context.

Pinned by `tests/codex-mcp-config.test.ts:187,193,194` (must contain "Use proactively", "verbatim", "fresh-context").

## 3. System-prompt summary

`buildCoordinatorAgent` prompt (`codex-mcp-config.ts:217-275`): lists the available peer subagents (order: codex-critic, opus-critic, then gemini-critic / gemini-reviewer if `geminiAvailable`, then codex-reviewer); a routing table by artifact type (plan/design → codex-critic [+ gemini-critic]; concrete diff → codex-reviewer [+ gemini-reviewer + gemini-critic]; large artifact → only codex-critic ~1M / opus-critic ≈936K windows; formal reasoning → gemini-critic; tie-breaker → gemini/opus; fast sanity → opus-critic); a decomposition section (route by real prompt window, split large artifacts BY CONCERN, never summarize to fit a small-window peer, up to 8 in-flight); a severity-grouped/deduplicated aggregation contract with cross-lab-confirmation callouts; and a "what NOT to do" list (do not paraphrase before aggregating, do not fan out serially, do not consult yourself). When gemini is absent the gemini routing lines become "(NOT REGISTERED in this session)" (`codex-mcp-config.ts:237,240`; pinned by `tests/codex-mcp-config.test.ts:215`).

## 4. Routing-trigger assessment

- **States trigger — strongest in the set.** "Use proactively before non-trivial plans and after non-trivial commits" is the canonical Claude Code auto-delegation idiom (`codex-mcp-config.ts:188` calls it "the documented Claude Code idiom for subagents the parent should delegate to without explicit user request"). It names TWO explicit checkpoints (before plans, after commits) and scopes them ("non-trivial"), which is exactly the third-person trigger the rubric wants.
- **Specific not vague — good.** Names the four critics it coordinates, the two trigger checkpoints, and the verbatim/fresh-context contract (the load-bearing reason to pass artifacts whole).
- **Accurately previews the body — yes.** "Coordinates cross-lab adversarial review", "fan out in parallel", "aggregate by severity" all map to the prompt.
- **Overtrigger risk on Opus 4.5+ — MODERATE, and this is the crux.** "Use proactively before non-trivial plans and after non-trivial commits" is a recurring, checkpoint-anchored imperative. On a stronger auto-delegating model it could fire on borderline-trivial plans/commits (over-review), OR — the empirically observed failure — under-fire because "use proactively" is a soft steer the model may skip. See F1.

## 5. The soft-steer reliability question (F1)

The code itself documents the reliability gap (`codex-mcp-config.ts:189-194`):

> Empirically the polling-loop reliability for "use proactively" is ~60% (claude-code-guide expert estimate); the plan calls for an acceptance test (>=7/10 sessions delegate at the right checkpoints) before declaring "auto-invoked". If <7/10 we flip the optional PreToolUse hook on ExitPlanMode to default-on (env-disable-able).

**Verified: that ExitPlanMode fallback hook is NOT wired.** The only ExitPlanMode hook registered in `src/claude.ts` is the artifact-auto-open hook (`claude.ts:817-823`), which opens the finalized plan in the ai-or-die human review panel via `buildArtifactOpenHookCommand` — it does NOT invoke the peer-review-coordinator, and it is gated on `AIORDIE_SESSION_ID` being set (`claude.ts:807`). A repo-wide search for coordinator-invoking hooks (`ExitPlanMode|exit-plan|coordinator` over `src/`) finds no PreToolUse/PostToolUse hook that calls `peer-review-coordinator`. So the "before non-trivial plans" trigger rests ENTIRELY on the ~60%-reliable soft steer; the deterministic backstop the comment describes was never turned on.

Consequence: "before non-trivial plans" delegates roughly 6 times in 10 by the code's own estimate. The "after non-trivial commits" checkpoint has no plausible hook anchor at all (no commit hook exists), so it is soft-steer-only by construction.

## 6. Don't-nerf / right-balance

The coordinator is the correct entry point for critic fan-out (it centralizes routing, parallelism, and aggregation, and lets the individual critic descriptions stay as soft leaves — see S1). That design is sound and floor-raising. The imbalance is reliability, not framing: the description promises proactive review at two checkpoints, but only ~60% of sessions honor the plan checkpoint and the commit checkpoint has no anchor. This is under-delivery against the description's own promise, not overtrigger.

## 7. Findings + verdict

- **[Important] F1 — the "use proactively before non-trivial plans" trigger is unbacked.** The description promises proactive delegation at two checkpoints; the code comment estimates ~60% reliability and describes an ExitPlanMode PreToolUse fallback to fix it, but that fallback is NOT wired (`claude.ts:817-823` only wires artifact-open, gated on ai-or-die). The described acceptance test (>=7/10) and the fallback flip are both unimplemented. Either wire the deterministic ExitPlanMode PreToolUse hook the comment specifies (env-disable-able), or soften the description to stop promising proactive plan review the harness does not reliably deliver. The "after non-trivial commits" half has no hook anchor and is soft-steer-only.
- **[Suggestion]** On Opus 4.5+ the doubled checkpoint imperative ("before… and after…") is the highest-overtrigger phrasing in the injected set. If the fallback hook IS wired, consider dropping one checkpoint from the description to reduce redundant fan-out; if it is not wired, the phrasing over-promises. Either way the description and the harness behavior should be reconciled.
- **[Note]** The aggregation contract and window-aware decomposition in the prompt are strong and correct; no finding there.

**Verdict: N (blocked on F1).** The routing TRIGGER is the best-written in the set, but it is materially unbacked: the harness does not deliver the proactive plan/commit review the description promises, and the documented deterministic fallback was never enabled. Reconcile the description with the actual (soft-steer-only) delivery, or wire the fallback.
