import type { InjectedSkill } from "./index"

export function buildImplementSkill(_searchEnabled?: boolean): InjectedSkill {
  return {
  name: "gh-implement",
  md: `---
name: gh-implement
description: Execute an approved plan with parallel subagents and self-validation. Use when a user-approved plan.md is ready for execution. Reviewer only on low-confidence or risky changes. Not for unapproved plans or exploration.
user-invocable: true
requires: [approved plan.md with .complete marker]
produces: [unified diff, implementation-report.md]
consumes: [plan.md]
excludes: [unapproved plans, exploration, trivial changes]
---

# gh-implement: bounded parallel implementation with staged review

Use this skill only after /gh-plan produced a user-approved plan.md. All
implementation runs at the 200K default window with bare slugs (no 1M
accounting): the lead dispatches native subagents present on the profile
roster. If an implementer subagent exists (max profile), use it first for
implementation tasks, then General-Purpose for handoffs; otherwise use
General-Purpose for all tasks. Review is conditional, never staged by default:
each task subagent self-tests, self-reviews, and reports an explicit confidence
verdict; the lead dispatches a reviewer only on low-confidence validation or
complex and risky changes, then a General-Purpose fix pass only for major
reviewer findings. This skill dispatches ONLY native subagents via the Agent
tool, never worker-* MCP dispatchers.

## Hard bounds

- Maximum concurrent implementation subagents: 8 (advisory; the Task tool
  enforces no concurrency cap, so count your own dispatches).
- Maximum retries per task: 2.
- Maximum review-fix cycles: 2.
- Advisory budget: keep each task under ~10 minutes; the Task tool enforces
  no wall-clock, so terminate at acceptance, not at a clock.
- Worktrees are opt-in, not default: pass worktree:true to
  General-Purpose when parallel tasks require isolation or git-history
  protection. In-place tasks must be sequentialized to avoid collisions;
  parallel in-place edits to the same files will conflict.

## Stage gate 0 (do this BEFORE any implementation)

1. Verify the plan stage is finished: .github-router/plans/<slug>/plan.md AND
   its .complete marker both exist, with an explicit user-approval record. If
   any is missing, STOP: do not implement an unapproved plan. Finish or
   re-invoke planning first.
2. Check freshness: if HEAD or the working-tree diff hash moved since the
   plan was approved, re-verify stale load-bearing assumptions before
   dispatching subagents.
3. Close the previous stage: send no further follow-ups to any lingering Plan
   dispatches (Explore follow-ups) and record them as superseded with the
   reason. Native subagents cannot be killed mid-run: let them finish but do
   not wait on or use their output. Implementing while planning still runs
   builds on a moving target and wastes both stages. Only advance once every
   Plan dispatch has returned or is recorded as superseded.

## Procedure

1. Parse the approved plan.
   - Read plan.md fully.
   - Group tasks by parallelGroup; order groups by dependency.
   - For each group, prepare a narrow task brief (task spec, relevant context excerpt, acceptance criteria, verification commands). Write every brief as plain directives, never reflective first-person prose: Gemini-run subagents may suppress tool calls when the prompt contains reflective text. If parallel tasks in the group require isolation, prepare one git worktree per task and pass worktree:true; otherwise tasks run in-place and must be sequentialized within shared files.

2. Dispatch bounded implementation subagents, one parallel batch per group.
   - Dispatch ALL tasks in the group in a single turn via the Agent tool. Use subagent_type implementer first where the profile provides one (max), otherwise subagent_type General-Purpose for every task. Advisory: keep each task under ~10 minutes; the Task tool enforces no wall-clock.
    - Each subagent runs at the 200K default window and must self-contain its work:
     a. Implement the change.
     b. Run the task verification commands (tests, typecheck, lint).
     c. Self-review against the acceptance criteria.
     d. Fix any self-found issues (at most 2 internal fix cycles).
     e. Return the patch plus test results, self-review notes, and an explicit confidence verdict (high or low) with reasons. Low confidence means the subagent itself doubts the result: flaky or incomplete verification, untested edge cases, or behavior it could not directly observe. Keep the return compact: patch plus results, no full-file echoes; output tokens cost several times input on every profile.
   - Do NOT dispatch the same task twice (no dedup exists); a retry is a new dispatch only after a recorded failure.
   - For a big artifact, have the subagent write it to a file and return the path.

3. Aggregate and validate.
   - Collect all patches and apply them sequentially to the main worktree (or merge the worktrees when worktree isolation was used).
   - Run the full relevant validation: test suite, typecheck, and lint.
   - If any task fails validation, route it back to a General-Purpose subagent (at most 2 retries per task). If it still fails, checkpoint with the failure as residual risk instead of pretending it is solved.

4. Decide whether external review is warranted (default: skip it).
   - Skip the reviewer when every task reports high confidence AND full validation (tests, typecheck, lint) passes AND the change avoids high-risk areas (auth, user input, database queries, crypto, serialization, data migration, cross-boundary contracts) AND the lead judges the change non-complex. Record the skip with reasons in the implementation report; self-validation plus green checks is the default path, not a shortcut.
   - Dispatch the reviewer subagent (via the Agent tool, subagent_type reviewer) ONLY when a task reports low confidence, validation is incomplete or unconvincing, the change touches high-risk areas, or the lead explicitly requested review. Scope the brief to the uncertain areas, the acceptance criteria, and the failing or insufficient checks. Categorize findings as minor (style, nits) or major (logic, architecture). Advisory: keep the review under ~5 minutes.
   - If the reviewer finds no major issues (or review was skipped with recorded reasons), finish here.
   - Fix pass (major reviewer findings only): dispatch a General-Purpose subagent (via the Agent tool) at the 200K default window with the flagged areas, the failing checks, and the reviewer findings. It returns fixed patches or an explicit escalate-to-user with reasons. At most 2 review-fix cycles.

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
- Review summary (skipped with recorded reasons, or reviewer findings; fix-pass findings and fixes if used).
- Final residual risks and next action.

## Non-goals

- Do not start without a user-approved plan.md plus its .complete approval record.
- Do not start while Plan dispatches still run; record them superseded first.
- Do not dispatch a reviewer by default; self-validation plus green checks is the default path.
- Do not serialize work that has no data dependency; independent tasks in a group run concurrently (sequentialize only in-place edits to shared files).
- Do not nest workflow invocations: subagents must not re-invoke /gh-implement (or any /gh-* pipeline skill).
- Do not claim completeness when retries or review cycles are exhausted with open failures.
`,
  }
}

export const IMPLEMENT_SKILL = buildImplementSkill(true)
