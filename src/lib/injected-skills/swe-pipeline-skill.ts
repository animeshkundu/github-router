export const SWE_PIPELINE_SKILL = {
  name: "gh-swe-pipeline",
  md: `---
name: gh-swe-pipeline
description: Strict sequential SWE pipeline for non-trivial code changes: runs gather-context to completion, then plan with user approval, then implement with staged review. Each stage waits for the previous to finish fully, superseding leftover subagents before advancing. Use when the user wants the full structured engineering workflow in one command.
user-invocable: true
---

# gh-swe-pipeline: strict sequential SWE workflow

Use this skill when the user invokes /gh-swe-pipeline for a non-trivial code
change. It coordinates the three pipeline stages in STRICT SEQUENCE. No two
stages ever overlap: each stage runs to completion, its subagents are all
finished or explicitly superseded, and its completion artifact exists before
the next stage starts. Every stage dispatches ONLY native subagents present on
the profile roster (Explore, Plan, General-Purpose, reviewer, implementer
where provided) via the Agent tool, never worker-* MCP dispatchers.

All work runs at the 200K default window with bare slugs (no 1M accounting).
Advisory budgets (the Task tool enforces no wall-clock): gather ~3 minutes
per round, plan ~5 minutes total, implement ~10 minutes per task.

## The one rule

WATERFALL ONLY. Never start a stage while the previous stage still has running
subagents or an unwritten completion artifact. If a stage already has enough
evidence to proceed, FIRST record every still-running subagent from the
previous stage as superseded (native subagents cannot be killed mid-run: send
no further follow-ups, let them finish, and do not use their output), record
what was superseded and why, THEN advance. Overlapping stages waste money and
produce plans built on shifting evidence. This is the failure the pipeline
exists to prevent.

## Stage 0: triage (no subagents)

1. Restate the ask in one sentence.
2. Decide trivial versus non-trivial. Trivial (typo, one-line config read,
   obvious three-line fix, pure explanation) SKIPS the pipeline: say why and
   do the work directly. Do not pay orchestration cost as ritual.
3. For non-trivial work, derive a run slug and create
   .github-router/swe/<slug>/run.md with the ask, the triage verdict, and
   per-stage status (pending, running, complete, skipped).

## Stage 1: gather context (to completion)

1. Invoke the gh-gather-context skill and WAIT for its full return. Do not
   plan, sketch tasks, or dispatch Plan subagents while it runs.
2. Its completion artifact is
   .github-router/context/<slug>/context.md plus context.compact.md and a
   .complete marker. If the marker is missing, the stage is NOT complete:
   keep waiting or re-invoke; never advance on a partial brief.
3. Early-stop rule: if the returned brief already saturates the ask (root
   cause at least verified-source, no material unknowns), record any
   still-running Explore dispatches as superseded (no follow-ups), accept the
   brief, and advance. Do not keep searching after saturation.
4. Cap-hit rule: if the brief reports cap-hit with residuals, surface the
   residuals in run.md and ask the user whether to proceed to planning with
   the gap or to spend one more bounded round. Do not silently treat a
   cap-hit brief as complete.

## Stage 2: plan (to user approval, or trivial exit)

1. Precondition check BEFORE invoking gh-plan: the context .complete marker
   exists AND every gather-context Explore dispatch has returned or been
   recorded as superseded. If either is false, do not invoke planning. Fix
   stage 1 first.
2. Invoke the gh-plan skill and WAIT for its full return. For non-trivial
   work gh-plan dispatches the native Plan subagent with an
   implementation-ready brief; do not dispatch implementation subagents,
   sketch diffs, or edit implementation files while it runs. Plan mode means
   plan and acceptance criteria only.
3. Trivial exit: if gh-plan returns a trivial verdict (no plan.md, no
   .complete), STOP the pipeline here. Record the verdict and the recommended
   direct action in run.md and do NOT advance to implementation.
4. Its completion artifact is .github-router/plans/<slug>/plan.md with a
   user-approval record (.complete marker written only after explicit
   approval). A plan without explicit user approval is NOT complete.
5. Present the goal, acceptance criteria, task-to-group map, residual risks,
   and cost estimate. Wait for explicit approval. If the user rejects scope
   or cost, downshift to the smallest plan that kills the important blind
   spots and re-seek approval. NEVER advance to implementation without
   approval recorded in run.md.

## Stage 3: implement (to reviewed diff)

1. Precondition check BEFORE invoking gh-implement: plan.md exists, its
   .complete marker exists, and run.md records explicit user approval. If
   any is missing, do not invoke implementation. Fix stage 2 first.
2. Record any lingering Plan dispatches (Explore follow-ups) as superseded
   before the first implement dispatch.
3. Invoke the gh-implement skill and WAIT for its full return: unified diff,
   implementation report, test/typecheck/lint results, and review summary.
4. If retries or review cycles exhaust with open failures, checkpoint with
   the failure as residual risk instead of pretending it is solved.

## Return format

Return:

- Run file: path to .github-router/swe/<slug>/run.md with per-stage status.
- Context files: paths to context.md and context.compact.md, freshness
  (HEAD commit, diff hash, timestamp), termination (saturated or cap-hit).
- Plan file: path to plan.md, task count, parallel groups, open questions
  and user answers, cost estimate, approval record.
- Implement output: unified diff path, report path, per-task status, test
  results, review summary.
- Residual risks and next action.

## Non-goals

- Do not run stages in parallel or overlap subagents across stages.
- Do not advance past a missing completion artifact or a missing approval.
- Do not nest pipeline invocations: subagents must not re-invoke
  /gh-swe-pipeline or any /gh-* pipeline skill.
- Do not present judgment-only conclusions as executable guarantees.
`,
} as const
