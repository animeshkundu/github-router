# Auto-injected hooks review

A per-hook audit of every Claude Code lifecycle hook `github-router claude` writes into the spawned session's mirrored `settings.json`. The precedent is [`docs/review/mcp/`](../mcp/README.md): for each hook we verify the model-facing surface (when there is one) and the FIRING behavior against the code, then apply the governing lens.

## Governing lens

Two rules, from the approved review plan:

1. **Raise the floor, never nerf.** A hook should make the worst case better without degrading the common case. Over-injection is as harmful as under-injection: a steer that fires on every trivial prompt, or a gate that re-runs the whole test suite on a plan-only turn, spends the user's latency/tokens/attention for no floor gain.
2. **The right thing, at the right time, in the right amount.** Two independent axes per hook:
   - **(5a) model-facing TEXT quality**: Anthropic's tool/prompt authoring guidance: descriptive not coercive, conditional phrasing, no `MUST`/`ALWAYS` over-trigger, specific and concrete, minimal.
   - **(5b) FIRING appropriateness**: does it fire at the right lifecycle moment? Over-fire, under-fire, or wrong-action?

## The 8 hooks

Fast launches add one separate hook, `PreToolUse` matching `^(Task|Agent)$`, which enforces only the fast native delegation graph. It is registered after fast runtime generation and its installation is fatal for fast launches; standard launches do not register it. The hook uses a compiled policy and synchronous stdin parsing, so it is not a shell sandbox: Bash remains governed by each native role's toolset and the hook only controls in-session Task/Agent ACL edges.

All are registered in `src/claude.ts` into `<CLAUDE_CONFIG_DIR>/settings.json` via `injectStopHookIntoSettingsFile` (`src/lib/orchestration/stop-gate-hook.ts:656`). All key off the same discriminator, the `agent_type`/`agent_id` fields Claude Code sets only inside a subagent context, but in two different ways:

- The four non-guard hooks (#1 prompt-submit, #4 session-bind, #5 artifact-open, #6 stop) are TOP-LEVEL-ONLY: they stand down on ANY subagent/teammate payload via `isSubagentContext` (`src/lib/orchestration/stop-gate-policy.ts:43`), so they never recurse into spawned workers.
- The three PreToolUse guards (#2, #3, and the fast-only hook) are the INVERSE, and deliberately not blanket top-level-only. #2 INSPECTS `agent_type` to ALLOW the exact `worker-<mode>` dispatcher subagent while denying everyone else (`decideWorkerGuard`, `src/lib/worker-dispatch.ts:183-196`). #3 does NOT inspect agent context at all, it hardcodes `operatorMode=true` (`src/internal-first-mate-guard.ts:62`) and denies by tool-name prefix regardless of caller (see that doc for the subagent-over-block risk this creates). The fast-only guard recognizes only `Task`/`Agent`, resolves caller identity from the hook payload, and enforces the fast native graph.

| # | Event · matcher | Executable | Gate (registration) | Model text? | Doc |
|---|---|---|---|---|---|
| 1 | `UserPromptSubmit` · none | `internal-prompt-submit` | `workerToolsEnabled()` (`src/claude.ts:670-689`) | yes | [prompt-submit-steer](./prompt-submit-steer.md) |
| 2 | `PreToolUse` · `^mcp__<workersKey>__(explore\|implement\|review\|plan\|test)$` (adds `\|browse` when the browse agent is on) | `internal-worker-guard` | `workerToolsEnabled()` + `injected.ok` (`src/claude.ts:711-740`) | deny-reason only | [pretooluse-workers-guard](./pretooluse-workers-guard.md) |
| 3 | `PreToolUse` · `mcp__workers__.*\|mcp__orchestrate__.*` | `internal-first-mate-guard` | `agentToolsEnabled()` / `--agents` (`src/claude.ts:753-772`) | deny-reason only | [pretooluse-operator-guard](./pretooluse-operator-guard.md) |
| 4 | `SessionStart` + `SessionEnd` · none | `internal-session-bind` | `AIORDIE_CLAUDE_BIND` set (`src/claude.ts:790-799`) | none (side-effect) | [session-bind](./session-bind.md) |
| 5 | `PostToolUse` · `ExitPlanMode` | `internal-artifact-open` | `AIORDIE_SESSION_ID` set (`src/claude.ts:819-826`) | none (side-effect) | [posttooluse-artifact-open](./posttooluse-artifact-open.md) |
| 6 | `Stop` · none | `internal-stop-hook` | per-repo consent (`src/claude.ts:829-995`) | block-reason only | [stop-structural-gate](./stop-structural-gate.md) |
| 7 | (spawned by #6) detached | `internal-stop-review` | `stopReviewEnabled()` + runtime wired (`src/internal-stop-hook.ts:213`) | findings → next prompt | [stop-review-detached](./stop-review-detached.md) |

Hook #7 is not directly registered in `settings.json`: it is a detached child the Stop hook (#6) spawns on a green gate, delivered back to the model on the next `UserPromptSubmit` (#1). It is included because it is a distinct lifecycle actor with its own model-facing text.

## Lifecycle map: where each fires, and where a review SHOULD fire

```
turn N:
  UserPromptSubmit  ── #1 steer: reset gate budget, inject grounded goal + prior-turn findings
        │
        ▼
   [ model works: tools, edits, Agent subagents ]
        │  #2 fires on each raw mcp__workers__* call  → deny + redirect to worker-* agent
        │  #3 fires on each mcp__workers__*/orchestrate__* call in --agents → exit-2 block
        │
   ExitPlanMode (plan-mode turns only)
        │  #5 PostToolUse → opens the plan in the ai-or-die panel
        │  ┌─────────────────────────────────────────────────────────┐
        │  │ GAP: no cross-lab peer review fires before a plan        │
        │  │ finalizes. The planned PreToolUse(ExitPlanMode) review   │
        │  │ hook (codex-mcp-config.ts:193-194) was never shipped.    │
        │  └─────────────────────────────────────────────────────────┘
        ▼
  Stop  ── #6 structural gate: typecheck/test/lint + gate-weakening scan
        │        exit 2 blocks the stop (max 2/prompt); exit 0 allows
        │        on GREEN + substantive diff → spawns #7 (detached)
        ▼
  #7 detached gpt-5.6-sol review of the live tree vs the user's ask → findings file
        │
        ▼
turn N+1:
  UserPromptSubmit  ── #1 surfaces #7's findings NON-authoritatively, then re-steers
```

Two review moments matter for the floor, and the current wiring covers only one of them at the output end:

- **Before a plan finalizes** (`ExitPlanMode`): the strongest, cheapest leverage point: catch a wrong plan before any code is written. Currently NO review fires here. The team's own code comment names the contingency (`src/lib/codex-mcp-config.ts:193-194`): if the `peer-review-coordinator` subagent's proactive-delegation reliability falls under 7/10, flip a default-on `PreToolUse(ExitPlanMode)` peer-review hook. That hook was never built; plan-review currently depends entirely on the model choosing to call the coordinator subagent (~60% reliable per the same comment).
- **Before done** (`Stop`): covered by the deterministic gate (#6, hard blocker) + the advisory detached review (#7, non-blocking). This is the monotone design from [`docs/hook-v2-design.md`](../../hook-v2-design.md): a blocking LLM reviewer was rejected twice in 3-lab review as non-monotone (it coerces the model into degrading correct code under a confident-wrong test).

## Intelligent-hook design synthesis

Several hooks fire deterministically at a lifecycle event but then run a FIXED action regardless of turn context. The highest-leverage upgrade is a **deterministic trigger + a bounded-inference gate** that decides, per turn, whether to run the full action, a subset, or nothing: honoring four non-negotiables:

- **Fail-open**: a gate error/timeout NEVER blocks the turn (the Stop gate's own termination guarantee already models this).
- **Advisory, not coercive**: the gate widens what the model may consider; it never forces.
- **Bounded latency**: a fixed wall-clock budget with fail-open on overrun (the prompt-submit hook already does this at 22s; the pattern generalizes).
- **Widen, not narrow**: the gate may add a review or add context, never suppress a hard deterministic check.

Where this pays off, ranked:

1. **`Stop` gate should short-circuit on a no-op turn (highest leverage).** The gate runs typecheck/test/lint on EVERY stop with no no-diff short-circuit: a plan-only turn, a Q&A turn, or a read-only investigation pays the full suite cost for zero code change. A trivial deterministic pre-check (`git diff HEAD` empty AND no staged changes → exit 0 immediately) plus a bounded classifier for "did this turn touch code the gate covers" would cut the common-case tax without touching the floor (an empty diff cannot regress a check). The plan-mode carve-out was designed for exactly this class of turn but is dead (see below).
2. **`UserPromptSubmit` steer's static tip should be gated like the enrichment.** The V2 model-call enrichment is correctly non-trivial-gated, but the static `PROMPT_SEARCH_TIP` fires on EVERY trivial prompt (`git commit -m fix`, "yes", "thanks"). A one-line bounded classifier ("does this prompt plausibly need code context") would suppress the tip on conversational turns: the same fail-open pattern the enrichment already uses.
3. **`ExitPlanMode` should gate a bounded peer review.** A deterministic `PostToolUse(ExitPlanMode)` trigger + a bounded cross-lab critic (advisory, fail-open, one call) is the unshipped contingency the team already scoped. It raises the plan-review floor from "~60% the model remembers to ask" to "always offered, model evaluates."

## Cross-hook systemic findings

- **[Important] Operator mode (#3) likely blocks the `worker-*` path it recommends (a #2/#3 interaction).** In `--agents` mode both PreToolUse guards register. #2 allows the `worker-<mode>` dispatcher subagent by inspecting `agent_type`; #3 denies any `mcp__workers__*`/`mcp__orchestrate__*` by PREFIX without checking the caller (`internal-first-mate-guard.ts:62,72`). Since PreToolUse fires inside the dispatcher subagent (the premise #2 relies on) and one deny wins across matching hooks, the dispatcher's worker call is denied by #3, breaking the exact delegation the operator banner + #3's own reason recommend. Fix: #3 must allow the dispatcher `agent_type` too. See [pretooluse-operator-guard](./pretooluse-operator-guard.md) §7.
- **[Important] The `Stop` gate over-fires on no-op turns.** `evaluateStopGate` (`src/lib/orchestration/stop-gate.ts:40-45`) runs `runGateChecks` unconditionally; `decideStopHook` has no empty-diff short-circuit. The design doc's V2 spec opens with "No diff → nothing" (`docs/hook-v2-design.md:18`), but the implemented gate has no such branch: only the advisory REVIEW (#7) is diff-gated (`maybeSpawnReview` returns on an empty diff, `stop-gate-hook.ts:554`). A plan-only or Q&A stop still spends the full typecheck/test/lint cost.
- **[Important] The plan-mode carve-out is dead code.** `stopGatePlanMode()` reads `GH_ROUTER_STOP_GATE_PLAN_MODE` (`src/lib/orchestration/stop-gate-hook.ts:143`) and `decideStopHook` honors it (`:452`), with full tests (`tests/orchestration-stop-gate-hook.test.ts:571-575`). But NOTHING in `src/` ever sets that env var: `src/claude.ts` never adds it to `envVars`. The plans/memory diff-hunk stripping only activates if a user manually exports it. The forward-compat `plan_mode` payload field is also never populated by current Claude Code.
- **[Suggestion] `OPERATOR_MODE_BANNER` is unwired dead text.** The constant (`src/lib/first-mate/operator-shaping.ts:36-43`) is defined and asserted by a test (`tests/first-mate/operator-shaping.test.ts:63`) but is never injected into any model surface: `internal-first-mate-guard.ts` imports `operatorPreToolUse`, not the banner, and no `--append-system-prompt` / CLAUDE.md path references it. Operator steering reaches the model only via the `/gh-first-mate` skill; the banner constant is either a stale artifact or an unfinished wiring.
- **[Suggestion] The plan-review lifecycle gap.** No hook fires a cross-lab review before `ExitPlanMode` finalizes a plan. This is the single highest-value intelligent-hook opportunity (see synthesis) and the team already scoped its shape.

## Method

Every claim in these docs was verified against the cited `file:line`. Hook text is quoted verbatim from source. Firing logic was traced through the internal subcommand, its pure decision function, and the `settings.json` registration. Severity uses the repo ladder (Critical / Important / Suggestion).
