export const IMPLEMENT_SKILL = {
  name: "gh-implement",
  md: `---
name: gh-implement
description: Parallel implementation of an approved plan using bounded Luna workers with isolated worktrees: each worker implements its task, self-tests, self-reviews, and returns a patch; the lead aggregates into a unified diff, runs staged review, and returns the final diff with a report. Use when a user-approved plan is ready for execution.
user-invocable: true
---

# gh-implement: bounded parallel implementation with staged review

Use this skill only after /gh-plan produced a user-approved plan.md. All
implementation runs at the 200K default window: the lead and every task worker
use the Luna model at max effort with bare slugs (no 1M accounting). Review is
staged: a Luna max pass first, then a Sol medium pass only for major issues.

## Hard bounds

- Maximum concurrent implement workers: 8.
- Maximum retries per task: 2.
- Maximum review-fix cycles: 2.
- Worktrees are auto-removed on success and retained on failure for debugging.

## Stage gate 0 (do this BEFORE any implementation)

1. Verify the plan stage is finished: .github-router/plans/<slug>/plan.md AND
   its .complete marker both exist, with an explicit user-approval record. If
   any is missing, STOP: do not implement an unapproved plan. Finish or
   re-invoke planning first.
2. Check freshness: if HEAD or the working-tree diff hash moved since the
   plan was approved, re-verify stale load-bearing assumptions before
   dispatching workers.
3. Stop the previous stage: send no further follow-ups to any lingering plan
   workers (worker-plan follow-ups) and record them as stopped with the
   reason. Implementing while planning still runs builds on a moving target
   and wastes both stages. Only advance once every plan worker has returned
   or is recorded as stopped.

## Procedure

1. Parse the approved plan.
   - Read plan.md fully.
   - Group tasks by parallelGroup; order groups by dependency.
   - For each group, prepare an isolated git worktree per task plus a narrow task brief (task spec, relevant context excerpt, acceptance criteria, verification commands).

2. Dispatch bounded implement workers, one parallel batch per group.
   - Dispatch ALL tasks in the group in a single turn via the Agent tool (subagent_type worker-implement, with worktree isolation, maxWallClockMs 600000 per task so a hung worker is reaped after 10 minutes instead of blocking its slot).
   - Each worker runs at the 200K default window and must self-contain its work:
     a. Implement the change.
     b. Run the task verification commands (tests, typecheck, lint).
     c. Self-review against the acceptance criteria.
     d. Fix any self-found issues (at most 2 internal fix cycles).
     e. Return the patch plus test results and self-review notes.
   - Do NOT dispatch the same task twice (no dedup exists); a retry is a new dispatch only after a recorded failure.
   - For a big artifact, have the worker write it to a file and return the path.

3. Aggregate and validate.
   - Collect all patches and apply them sequentially to the main worktree (or merge the worktrees).
   - Run the full relevant validation: test suite, typecheck, and lint.
   - If any task fails validation, route it back to an implement worker (at most 2 retries per task). If it still fails, checkpoint with the failure as residual risk instead of pretending it is solved.

4. Run staged review.
   - Pass 1 (always): dispatch the worker-review subagent (via the Agent tool, maxWallClockMs 300000) over the unified diff for correctness against acceptance criteria, code quality and consistency, security and performance regressions, and test coverage. Categorize findings as minor (style, nits) or major (logic, architecture).
   - If pass 1 finds no major issues, finish here.
   - Pass 2 (major issues only): dispatch a fix worker (via the Agent tool, maxWallClockMs 300000) at the 200K default window using the Sol model at medium effort with the flagged areas, the failing checks, and the pass-1 findings. It returns fixed patches or an explicit escalate-to-user with reasons.

5. Finalize.
   - Apply any review fixes and re-run full validation.
   - Produce the unified diff for the whole plan.
   - Write .github-router/plans/<slug>/implementation-report.md with task completion status, test results summary, review findings and resolutions, the final diff path, and residual risks.

## Return format

Return:

- Unified diff path.
- Implementation report path.
- Task completion status per task id.
- Test, typecheck, and lint results.
- Review summary (pass 1 findings; pass 2 findings and fixes if used).
- Final residual risks and next action.

## Non-goals

- Do not start without a user-approved plan.md plus its .complete approval record.
- Do not start while plan workers still run; stop them first.
- Do not serialize work that has no data dependency; independent tasks in a group run concurrently.
- Do not nest workflow invocations: workers are internal sessions and must not re-invoke /gh-implement (or any /gh-* pipeline skill).
- Do not claim completeness when retries or review cycles are exhausted with open failures.
`,
} as const
