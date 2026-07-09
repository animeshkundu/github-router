# Hook 6: `Stop` structural gate

## 1. Identity

| Field | Value |
|---|---|
| Event | `Stop` (no matcher, runs on every stop) |
| Executable | `github-router internal-stop-hook` (`src/internal-stop-hook.ts`) |
| Decision logic | `decideStopHook` (`src/lib/orchestration/stop-gate-hook.ts:294-526`) → `evaluateStopGate` (`src/lib/orchestration/stop-gate.ts:40-60`) |
| Gate | Per-repo consent (`--trust-gate` / auto-trust-on-detection / `GH_ROUTER_ENABLE_STOP_GATE`), re-checked at runtime (`src/claude.ts:829-995`, runtime `isEnabledForRepo` at `stop-gate-hook.ts:396`) |
| Registration | `src/claude.ts:907` |
| Blocks the stop? | Yes, exit code 2 (reason on stderr) refuses "done"; hard-capped at `maxBlocks` = 2 per prompt |
| Model-facing text | Block reason on stderr; loud stand-down on budget-exhaustion |
| Opt-out | `GH_ROUTER_DISABLE_STOP_GATE=1` / `--no-stop-gate` (`stop-gate-hook.ts:194-199`) |

The deterministic floor: runs the repo's canonical checks (sealed `default-ci` typecheck/test/lint, or a parsed/discovered multi-language set) and scans the working-tree diff for gate-weakening (added `.skip`, `as any`, lint-disable). A red gate OR a weakening diff blocks the stop until fixed. It is baseline-isolated (blocks only on REGRESSIONS vs the launch-captured pre-mutation baseline, `stop-gate-hook.ts:85-101`), consent-gated per repo, and has a hard per-prompt block budget so it can never wedge the session.

## 2. Model-facing text (verbatim)

Two stderr strings, both shown to the model.

### 2a. Block reason (exit 2): `stop-gate-hook.ts:519-525`

> structural gate failed (block N/2): regressed gates: <ids>; gate-weakening in the diff: <patterns>. Fix the failing checks and revert any gate-weakening (no new .skip / as any / lint-disable) before finishing.

### 2b. Budget-exhaustion stand-down (exit 0, but loud): `stop-gate-hook.ts:415-421`

> structural gate: reached the 2-block limit for this prompt; allowing the stop WITHOUT re-running the checks. If the failures from the last block are unfixed, they are shipping — run the checks manually to verify.

## 3. Firing logic

- No matcher → the hook process runs on EVERY stop. It stands down (exit 0) in these cases, in order (`decideStopHook`, `:359-410`):
  1. unparseable stdin (`:373`);
  2. subagent/teammate context (`:377`);
  3. no `session_id` (can't budget-track, `:380`);
  4. repo not trusted at runtime (`:400`);
  5. block budget already `>= maxBlocks` for this prompt → loud stand-down (`:410-422`).
- Otherwise it runs the gate under a 300s absolute timeout (fail-open on timeout, `:489`); captures `git diff HEAD` INSIDE the raced promise; evaluates checks + weakening; reads/writes the baseline only on a COMPLETED eval (`:496-500`); blocks (exit 2) on a regression or weakening, else exit 0 (`:503-525`).
- On a GREEN stop with a substantive diff it fires the detached advisory review (hook #7) via `maybeSpawnReview`: the ONLY diff-gated branch in the hook (`:508`, `maybeSpawnReview` returns on empty diff, `:554`).
- Plan-mode carve-out (`planMode`, `:452`): when active, plans/ and memory/ diff hunks are stripped from the WEAKENING scan only (the executable gate still runs, non-plan hunks still scanned). Activated by `GH_ROUTER_STOP_GATE_PLAN_MODE` OR a `plan_mode` payload field: BOTH currently dead (see §7).

## 4. Firing-appropriateness verdict

**Over-fires on no-op turns; correct and monotone on code turns.**

- On a turn that changed code, the gate is exactly right: it is the deterministic floor, blocks only regressions (baseline-isolated), and cannot wedge (3-way termination guarantee + hard block budget). This is the proven, correct core.
- **Over-fire:** the gate runs the full typecheck/test/lint suite on EVERY stop, with no empty-diff short-circuit. A plan-only turn, a Q&A turn, a read-only investigation, or a "explain this" turn all pay the full suite cost for zero code change. The design doc's V2 spec literally opens with "No diff → nothing" (`docs/hook-v2-design.md:18`), but the implemented `decideStopHook` has no such branch: only the advisory review (#7) is diff-gated. An empty diff cannot regress a check, so running the suite there is pure waste (latency at turn-end, CPU, and on a slow suite a multi-second stall on every conversational stop).
- The plan-mode carve-out was designed to reduce false weakening-blocks on exactly this class of turn, but it is dead (§7), so plan-only turns get neither the short-circuit nor the carve-out.

## 5. Injected-text quality (5a)

- **Block reason (2a):** excellent. States precisely what failed (regressed ids, weakening patterns) and the exact remediation (fix the checks, revert weakening, no new skip/any/lint-disable). Actionable, specific, no padding. The firmness ("before finishing") is correct: this is a hard deterministic block, not a steer, so imperative phrasing is right and does not over-trigger.
- **Budget-exhaustion (2b):** a strong example of honest, non-silent degradation. Rather than a silent exit 0, it tells the model (and the user reading stderr) that broken work MAY be shipping and to verify manually. This is the right amount of alarm for a deliberate termination trade-off.
- Both strings are diagnostic feedback the model can act on next attempt: they meet the minimality bar.

## 6. Intelligent-hook analysis

This hook is the SUITE'S BEST candidate for a deterministic-trigger + bounded-inference upgrade, and the cheapest win is not even inference: it is a missing deterministic short-circuit:

- **Deterministic pre-check (do this first):** `git diff HEAD` empty AND no staged/unstaged changes → exit 0 immediately, skip the suite. An empty diff cannot regress a check, so this is free floor (the worst case is unchanged, the common case is cheaper). This alone removes the no-op over-fire.
- **Bounded-inference gate (optional, on top):** for a NON-empty diff, a cheap classifier could decide WHICH checks the turn's changes could plausibly affect (e.g. a docs-only diff need not run the test suite) and run a subset: fail-open to running ALL checks on any doubt, so it can only ever run FEWER checks when it is confident, never skip a check that could catch a regression. This must stay fail-open in the widen-not-narrow direction: the gate may reduce the common-case cost but must never let a real regression through, so "on uncertainty, run everything" is the required default.
- **Non-negotiables honored:** the empty-diff short-circuit is pure and deterministic (no latency, no failure surface). The subset classifier, if added, must fail-open to the FULL suite (a classifier error runs all checks: the safe direction), stay advisory only in the sense that it never weakens the block decision, and be bounded. The hard blocker (the executable gate on the checks it does run) is untouched.

The existing termination guarantee (`decideStopHook` §3) is already a model of the fail-open discipline this pattern needs; extending it with an empty-diff short-circuit is a small, safe change.

## 7. Findings

- **[Important] No empty-diff short-circuit: the gate over-fires on no-op turns.** `decideStopHook` (`stop-gate-hook.ts:294-526`) runs the full check suite on every stop regardless of whether the turn changed code; `evaluateStopGate` (`stop-gate.ts:40-45`) runs `runGateChecks` unconditionally. The V2 design's "No diff → nothing" (`docs/hook-v2-design.md:18`) was not implemented for the executable gate (only the advisory review is diff-gated). Fix: before running checks, capture the diff and exit 0 immediately if it is empty (an empty diff cannot regress a check). This removes the plan-only / Q&A / read-only-turn tax with zero floor cost.
- **[Important] The plan-mode carve-out is dead code.** `stopGatePlanMode()` reads `GH_ROUTER_STOP_GATE_PLAN_MODE` (`stop-gate-hook.ts:143`), `decideStopHook` honors it (`:452`), and it is unit-tested (`tests/orchestration-stop-gate-hook.test.ts:571-575`): but NOTHING in `src/` ever sets that env var. `src/claude.ts` never adds `GH_ROUTER_STOP_GATE_PLAN_MODE` to `envVars`, and the `plan_mode` payload field is not populated by current Claude Code. So the plans/memory weakening-scan carve-out only activates if a user manually exports the env. Fix: either detect plan mode at launch and set the env (wire it), or remove the dead path + its tests. As-is it is a designed-but-inert feature that a reader will assume protects plan/memory scratch edits.
- **[Suggestion] The gate is MCP-independent but nested under the `codexMcpEnabled` master switch.** Per the comment at `src/claude.ts:651-661`, the Stop-gate could live outside the MCP-injection block; `--no-codex-mcp` currently opts out of the whole layer including the gate. Decoupling is a noted clean follow-up. Not a defect, but it couples the deterministic floor to an unrelated flag.

**Verdict:** The gate's block logic is correct, monotone, and its stderr is a model of actionable feedback: but it over-fires on no-op turns (no empty-diff short-circuit) and its plan-mode carve-out is dead code. Ship the empty-diff short-circuit; wire or delete the plan-mode path.
