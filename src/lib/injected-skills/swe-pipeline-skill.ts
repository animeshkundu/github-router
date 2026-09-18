export const SWE_PIPELINE_SKILL = {
  name: "gh-swe-pipeline",
  md: `---
name: gh-swe-pipeline
description: Strict sequential SWE pipeline for non-trivial code changes: runs gather-context to completion, then plan with user approval, then implement with staged review. Each stage waits for the previous to finish fully, stopping leftover workers before advancing. Use when the user wants the full structured engineering workflow in one command.
user-invocable: true
---

# gh-swe-pipeline: strict sequential SWE workflow

Use this skill when the user invokes /gh-swe-pipeline for a non-trivial code
change. It coordinates the three pipeline stages in STRICT SEQUENCE. No two
stages ever overlap: each stage runs to completion, its workers are all
finished or explicitly stopped, and its completion artifact exists before the
next stage starts.

All work runs at the 200K default window with bare slugs (no 1M accounting):
gather-context uses Luna high, plan uses Sol medium, implement and review
pass 1 use Luna max, review pass 2 uses Sol medium.

## The one rule

WATERFALL ONLY. Never start a stage while the previous stage still has running
workers or an unwritten completion artifact. If a stage already has enough
evidence to proceed, FIRST stop every still-running worker from the previous
stage (let their maxWallClockMs reap them or send no further follow-ups and
treat their partial output as superseded), record what was stopped and why,
THEN advance. Overlapping stages waste money and produce plans built on
shifting evidence. This is the failure the pipeline exists to prevent.

## Stage 0: triage (no workers)

1. Restate the ask in one sentence.
2. Decide trivial versus non-trivial. Trivial (typo, one-line config read,
   obvious three-line fix, pure explanation) SKIPS the pipeline: say why and
   do the work directly. Do not pay orchestration cost as ritual.
3. For non-trivial work, derive a run slug and create
   .github-router/swe/<slug>/run.md with the ask, the triage verdict, and
   per-stage status (pending, running, complete, skipped).

## Stage 1: gather context (to completion)

1. Invoke the gh-gather-context skill and WAIT for its full return. Do not
   plan, sketch tasks, or dispatch plan workers while it runs.
2. Its completion artifact is
   .github-router/context/<slug>/context.md plus context.compact.md and a
   .complete marker. If the marker is missing, the stage is NOT complete:
   keep waiting or re-invoke; never advance on a partial brief.
3. Early-stop rule: if the returned brief already saturates the ask (root
   cause at least verified-source, no material unknowns), stop any
   still-running explore workers (no follow-ups; record them as stopped),
   accept the brief, and advance. Do not keep searching after saturation.
4. Cap-hit rule: if the brief reports cap-hit with residuals, surface the
   residuals in run.md and ask the user whether to proceed to planning with
   the gap or to spend one more bounded round. Do not silently treat a
   cap-hit brief as complete.

## Stage 2: plan (to user approval)

1. Precondition check BEFORE invoking gh-plan: the context .complete marker
   exists AND every gather-context explore worker has returned or been
   recorded as stopped. If either is false, do not invoke planning. Fix
   stage 1 first.
2. Invoke the gh-plan skill and WAIT for its full return. Do not dispatch
   implement workers, sketch diffs, or edit implementation files while it
   runs. Plan mode means plan and acceptance criteria only.
3. Its completion artifact is .github-router/plans/<slug>/plan.md with a
   user-approval record (.complete marker written only after explicit
   approval). A plan without explicit user approval is NOT complete.
4. Present the goal, acceptance criteria, task-to-group map, residual risks,
   and cost estimate. Wait for explicit approval. If the user rejects scope
   or cost, downshift to the smallest plan that kills the important blind
   spots and re-seek approval. NEVER advance to implementation without
   approval recorded in run.md.

## Stage 3: implement (to reviewed diff)

1. Precondition check BEFORE invoking gh-implement: plan.md exists, its
   .complete marker exists, and run.md records explicit user approval. If
   any is missing, do not invoke implementation. Fix stage 2 first.
2. Stop any lingering plan workers (worker-plan follow-ups) before the
   first implement dispatch; record them as stopped.
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

- Do not run stages in parallel or overlap workers across stages.
- Do not advance past a missing completion artifact or a missing approval.
- Do not nest pipeline invocations: workers are internal sessions and must
  not re-invoke /gh-swe-pipeline or any /gh-* pipeline skill.
- Do not present judgment-only conclusions as executable guarantees.
`,
} as const
