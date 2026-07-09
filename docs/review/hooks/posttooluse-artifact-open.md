# Hook 5: `PostToolUse(ExitPlanMode)` artifact auto-open

## 1. Identity

| Field | Value |
|---|---|
| Event | `PostToolUse` |
| Matcher | `ExitPlanMode` |
| Executable | `github-router internal-artifact-open` (`src/internal-artifact-open.ts`; command built by `buildArtifactOpenHookCommand`, `src/lib/orchestration/stop-gate-hook.ts:642-646`) |
| Gate | `AIORDIE_SESSION_ID` env set and non-empty (`src/claude.ts:807`) |
| Registration | `src/claude.ts:823` |
| Blocks the turn? | No, side-effect only, never writes stdout, always exit 0 |
| Model-facing text | None |

When running inside an ai-or-die tab, this hook fires after the model finalizes a plan via `ExitPlanMode` and auto-opens that plan in the ai-or-die Artifact review panel: so the human reviews it without the model having to call `artifact_open` itself.

## 2. Model-facing text (verbatim)

None. The hook opens the plan in the human review panel over loopback HTTP; it writes nothing to stdout and injects nothing into the model context. Auth is a mode-600 mirror creds file (`.aiordie-artifact.json`): `AIORDIE_TOKEN` is stripped from the child env so it can't leak via env or argv (`src/internal-artifact-open.ts:9-11`).

## 3. Firing logic

- Fires on `PostToolUse` with matcher `ExitPlanMode`: i.e. after the plan is finalized, on plan-mode turns only.
- Skips subagent payloads (`isSubagent`, `:60-66`, `:152`).
- Resolves the plan from `tool_input.planFilePath` (per-session source of truth), falling back to inline `tool_input.plan` markdown (`parseExitPlanPayload` / `resolvePlanMarkdown`, `:69-112`); renders it to a self-contained styled HTML and opens THAT `.html` in the panel (`:157-160`).
- Side-effect only: never throws, always exits 0 (`:161-163`).

## 4. Firing-appropriateness verdict

**Fires correctly for what it does, but the plan lifecycle UNDER-fires on review.**

- As an auto-open, it is correct: `PostToolUse(ExitPlanMode)` is precisely the moment a finalized plan exists to show, and opening it in the panel with no model action is a clean UX win. The per-session `planFilePath` (not the globally-newest plan file) is the right source, avoiding a race in the shared plans dir.
- The UNDER-fire is at the lifecycle level, not this hook's own action: NO cross-lab peer review fires before a plan finalizes. `ExitPlanMode` is the single highest-leverage review moment (catch a wrong plan before any code is written), and the only thing wired there is a display action. The model's plan reaches the human panel unreviewed by any critic.
- The team's own code names the missing contingency: `src/lib/codex-mcp-config.ts:190-194` says if the `peer-review-coordinator` subagent's proactive-delegation reliability is under 7/10, "we flip the optional PreToolUse hook on ExitPlanMode to default-on (env-disable-able)." That hook was never built. Plan review today depends entirely on the model choosing to call the coordinator subagent (~60% reliable per that same comment).
- **What should fire instead / additionally:** a `PreToolUse(ExitPlanMode)` (or a second `PostToolUse(ExitPlanMode)`) bounded cross-lab critic pass: advisory, fail-open: so every finalized plan is offered a review, not only the ~60% where the model remembers to ask.

## 5. Injected-text quality (5a)

Not applicable: no model-facing text. Correct for a display side effect; it has nothing to tell the model and tells it nothing.

## 6. Intelligent-hook analysis

The AUTO-OPEN itself is deterministic and should stay so: showing the plan is unconditional, no inference needed.

The lifecycle GAP, however, is the suite's single best intelligent-hook opportunity. A deterministic `ExitPlanMode` trigger + a bounded-inference review gate would:
- **Deterministic trigger:** plan finalized (the event already fires reliably).
- **Bounded-inference gate:** one cross-lab critic call (e.g. codex_critic) over the plan text, wall-clock bounded, fail-open: decides whether to surface concerns.
- **Honors the non-negotiables:** fail-open (a gate error/timeout never blocks the plan or the turn: the plan still opens in the panel); advisory (concerns are surfaced NON-authoritatively, exactly like hook #7's findings); bounded latency (one call, capped); widen-not-narrow (it ADDS a review, never suppresses the plan).

This is the same monotone, advisory-only shape hook #7 uses at the Stop end, moved to the plan end where it is cheaper and higher-leverage (no code written yet). The team already scoped it; it is unshipped.

## 7. Findings

- **[Important] No cross-lab review fires before a plan finalizes.** `src/claude.ts:819-826` wires only a display action (`internal-artifact-open`) to `ExitPlanMode`. The planned advisory review hook (`src/lib/codex-mcp-config.ts:193-194`) was never shipped, so plan review depends on the model voluntarily calling `peer-review-coordinator` (~60% reliable). Fix: add a bounded, advisory, fail-open cross-lab critic pass at `ExitPlanMode` (the design the team already named), surfacing concerns non-authoritatively the way hook #7 does. This is the highest-leverage floor raise in the hook suite.
- **[Suggestion] The auto-open is ai-or-die-tab-only; non-tab sessions get no plan surfacing.** `src/claude.ts:807` gates on `AIORDIE_SESSION_ID`. Intended (the panel only exists in a tab), but worth noting that in a plain terminal session the finalized plan is neither auto-shown nor auto-reviewed: the review gap above is total there.

**Verdict:** The auto-open action is correct and clean, but the plan lifecycle under-fires: `ExitPlanMode` is the best place in the turn to catch a wrong plan cheaply, and no review fires there. Ship the scoped advisory `ExitPlanMode` review.
