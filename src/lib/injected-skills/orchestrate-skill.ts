export const ORCHESTRATE_SKILL = {
  name: "gh-orchestrate",
  md: `---
name: gh-orchestrate
description: Right-sized blind-spot-elimination for non-trivial implementation asks: capture user-blessed acceptance criteria, delegate bounded research, decompose and plan, compose a native Workflow with explicit deterministic/advisory annotations, verify the workflow, checkpoint residual risks and cost, then run only when the pipeline actually raises the floor.
user-invocable: true
---

# gh-orchestrate: right-sized blind-spot elimination

Use this skill when the user asks for a non-trivial change and the composed workflow can reduce real blind spots.
The sole objective is: how does the composed workflow deterministically raise the floor for THIS ask, and what blind spots does it eliminate with which tools?

## Right-size first

- For trivial asks, skip this pipeline and say why.
- A three-line obvious fix, typo, small config read, or simple explanation should not pay orchestration cost.
- If the ask has multiple files, unclear behavior, risky migration, uncertain tests, or high user impact, orchestration is likely worth it.
- The pipeline is a tool, not a ritual.

## Honest limits

- User-blessed acceptance criteria are the only defense against the wrong-spec hole.
- Executable gates do not catch a model solving the wrong task.
- Cross-lab review is advisory unless a code rule or executable gate consumes its output.
- The native Workflow path approximates but does not carry the kernel's hard max(orchestrated, baseline) guarantee.
- Use mcp__orchestrate__run_workflow instead when the user wants the hard floor from the frozen kernel.

## Phase 0: scope and acceptance criteria

1. Restate the user's goal in one sentence.
2. Capture explicit USER-BLESSED acceptance criteria before planning.
3. If acceptance criteria are missing or ambiguous, ask the user or present a short candidate list for confirmation.
4. State plainly: these criteria are the only guard against wrong-spec; green tests can still be green for the wrong interpretation.
5. Identify constraints: files, APIs, compatibility, performance, security, release risk, and forbidden changes.

## Phase 1: delegate research

1. Invoke /gh-research for the ask and acceptance criteria.
2. Wait for its bounded saturated brief.
3. If the brief is cap-hit-with-residuals, surface that status; do not treat it as complete.
4. Read the persisted research file by pointer when needed and check freshness metadata.
5. If HEAD or the working-tree diff hash moved, re-verify stale load-bearing claims.

## Phase 2: blind-spot analysis

Create a blind-spot table before decomposing:

- Wrong-spec risk: judgment-only, mitigated only by user-blessed acceptance criteria and checkpoint.
- Root-cause risk: executable-checkable if reproduced or covered by a failing test; otherwise advisory.
- Integration risk: usually source-verified plus tests where possible.
- Regression risk: executable-checkable when tests/typecheck/lint cover it.
- Review risk: advisory cross-lab reviewers reduce correlated blind spots.
- Concurrency or merge risk: source-verified and sometimes executable-checkable.
- Missing-test risk: executable-checkable only after a test exists and runs.

Tag every blind spot as executable-checkable or judgment-only.

## Phase 3 and 4: decompose and plan (run in parallel)

These two are INDEPENDENT: mcp__orchestrate__decompose consumes { ask, context: research brief plus blind-spots }, and mcp__workers__plan consumes the ask, acceptance criteria, research pointer, and blind-spot table. Neither needs the other's output. So issue BOTH calls in a SINGLE parallel batch (same turn) — do not wait for decompose before calling plan.

- decompose: mcp__orchestrate__decompose({ ask, context: research brief plus blind-spots }). Treat the output as a proposal, not gospel; reject or revise nodes that do not map to a real blind spot.
- plan: mcp__workers__plan with the ask, acceptance criteria, research pointer, and blind-spot table. Ask for files, tests, rollback concerns, and minimal safe increments; keep it bounded and suited to the change size.

## Phase 5: compose a native Workflow

Compose a native Workflow using the Workflow tool where every node has:

- goal
- input artifacts
- output artifact
- gh-router tool to call
- blind spot it kills
- deterministic or advisory annotation
- producer and checker lab where relevant

Parallelism (the Workflow tool's core optimization rule):

- DEFAULT to pipeline(): items flow through stages with NO barrier, so the slowest single item, not the slowest stage, sets wall-clock.
- Use parallel() ONLY at a genuine barrier — a stage that needs ALL prior results at once (dedup/merge across the set, an early-exit on the total, or a cross-item comparison). "It is cleaner" or "I need to map/flatten first" is NOT a barrier; do that transform inside a pipeline stage.
- Independent nodes within a phase run concurrently; never serialize work that has no data dependency.

Role to tool mapping:

- research: mcp__workers__explore and mcp__search__code for focused follow-ups.
- plan: mcp__workers__plan.
- implement: mcp__workers__implement, with worktree:true for parallel writers.
- test: mcp__workers__test, authored by a DIFFERENT LAB than the implementer when possible. This is an advisory practice, not enforced provenance.
- review: mcp__peers__codex_reviewer plus mcp__peers__gemini_reviewer. Advisory unless findings are converted into executable checks or code changes.
- baseline and selector: OPT-IN only because it doubles cost. Choose max(orchestrated, baseline) by EXECUTABLE gate result, not model judgment. If no executable oracle exists, say the selector is advisory.
- verify: cross-lab checker plus mcp__orchestrate__attest_step with producer not equal to checker lab.

No nesting:

- A Workflow node must not invoke /gh-orchestrate.
- Workflow-spawned workers are internal sessions.
- Internal sessions must not get prompt steering or stop-gate blocking.
- Carry a depth or call budget and stop with a diagnostic if it would recurse.

## Phase 6: verify the workflow

1. Call mcp__orchestrate__verify_workflow.
2. Fix drift between the ask, acceptance criteria, research, plan, and node graph.
3. Bound this repair loop to at most 3 verification rounds.
4. If drift remains after the cap, checkpoint with the drift as residual risk instead of pretending it is solved.

## Phase 7: checkpoint, then run

Before running, present:

- Goal and user-blessed acceptance criteria.
- Node to tool map.
- Per-node blind spot killed.
- Per-node deterministic or advisory annotation.
- Residual-risk list, including the wrong-spec residual.
- Research saturation status and any open residual unknowns.
- Cost estimate: workers, peer calls, tests, and whether baseline plus selector is enabled.
- The statement that native Workflow approximates, but does not guarantee, hard max(orchestrated, baseline).

After the checkpoint, run the Workflow only if it still appears right-sized for the ask.
If the user rejects scope or cost, downshift to the smallest workflow that kills the important blind spots.

## Return format

Return:

- Whether orchestration was skipped or run, with the right-sizing reason.
- Acceptance criteria used.
- Research brief pointer and freshness status.
- Workflow summary and node annotations.
- Executable gate results, if any.
- Advisory review results, if any.
- Final residual risks and next action.
`,
} as const
