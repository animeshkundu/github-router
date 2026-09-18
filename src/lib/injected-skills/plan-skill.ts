export const PLAN_SKILL = {
  name: "gh-plan",
  md: `---
name: gh-plan
description: Holistic planning from gathered context: reassesses triviality, dispatches the profile-pinned Plan subagent for non-trivial work with an implementation-ready brief, validates file:line tasks and runnable acceptance criteria, surfaces open questions for user approval, and persists plan.md. Use when a non-trivial change needs a reviewed plan before implementation.
user-invocable: true
---

# gh-plan: native Plan-subagent planning

Use this skill after /gh-gather-context (or when equivalent context is already
available) and before any implementation. For non-trivial work, dispatch the
native Plan subagent (subagent_type Plan) present on every pipeline profile
roster; profile frontmatter pins its model and effort (Sol at the 200K default
window). The plan must be scoped, modular, non-overlapping, and ordered, with
enough detail for a native General-Purpose (or implementer, where the profile
provides one) subagent to execute each task in isolation. User approval is
mandatory before implementation. This skill dispatches ONLY the native Plan
subagent via the Agent tool, never worker-* MCP dispatchers. Plan self-serves
Explore follow-ups per its delegation graph; the skill does not dispatch
Explore directly.

## Prerequisites

- A freshness-stamped context brief from /gh-gather-context, or equivalent context.
- Read context.compact.md first; read context.md sections on demand (residual unknowns, evidence table).

## Stage gate 0 (do this BEFORE any planning)

1. Verify the context stage is finished: .github-router/context/<slug>/.complete
   exists. If the marker is missing, STOP: do not plan on a partial brief.
   Finish or re-invoke gathering first.
2. Check freshness: if HEAD or the working-tree diff hash moved since the
   brief's stamp, re-verify stale load-bearing claims before using them.
3. Close the previous stage: send no further follow-ups to any lingering
   gather-context Explore dispatches and record them as superseded with the
   reason. Native subagents cannot be killed mid-run: let them finish but do
   not wait on or use their output. Planning while Explore subagents still run
   builds on shifting evidence and wastes both stages. Only advance once every
   Explore dispatch has returned or is recorded as superseded.

## Triviality reassessment (do this AFTER gate 0, BEFORE dispatching Plan)

1. Reassess with fresh context: if the ask is trivial (typo, one-line config
   read, obvious change of at most a few lines, pure explanation) or the
   context shows no multi-file, risky, uncertain, or high-impact work, STOP.
   Do NOT dispatch Plan. Do NOT write plan.md or .complete.
2. Return a trivial verdict: one-sentence reason, the recommended direct
   action, and an explicit statement that no downstream stage (/gh-implement,
   /gh-swe-pipeline stage 3) may run. A trivial ask must never pay planning
   cost as ritual.

## Hard bounds

- Maximum tasks: 20.
- Maximum parallel groups: 5.
- Keep planner input well under the 200K window (target at most around 150K tokens of context) so there is headroom for reasoning and output. This is self-discipline, not an enforced cap: prefer the compact brief and read full sections only on demand.
- Advisory budget: keep the Plan dispatch under ~5 minutes; the Task tool enforces no wall-clock. At most 2 bounded follow-up rounds to the same Plan dispatch for gaps.

## Procedure (non-trivial work only)

1. Ingest context.
   - Read context.compact.md fully.
   - Read the evidence table and residual unknowns from context.md.
   - Identify acceptance criteria, constraints, integration seams, and forbidden changes.

2. Compose the Plan dispatch brief. Include every item below; a vague brief
   produces a vague plan, and a vague plan fails downstream:
   - Ask summary and acceptance criteria (or candidates where ambiguous).
   - Constraints, integration seams, and forbidden changes.
   - Context pointers: context.compact.md path, the evidence table and
     residual sections of context.md, plus the freshness stamp.
   - Required output shape: objective; architectural invariants; interface
     contracts; execution steps with files touched plus a done condition per
     step; acceptance commands with the observable pass result; critical files
     as file:line; a blind-spot table tagging each risk executable-checkable
     or judgment-only (wrong-spec, root-cause, integration, regression,
     review, concurrency or merge, missing-test); open questions as options
     with a recommendation; cost estimate (task count, parallel groups,
     context tokens).
   - Plan-mode rule: plan and acceptance criteria only, no implementation
     file edits.
   - Permission to use Explore and reviewer per the delegation graph.
   - Advisory ~5 minute budget.

3. Dispatch ONE Plan subagent via the Agent tool (subagent_type Plan) with
   that brief, then WAIT for its full return. Do not plan inline in parallel
   and do not dispatch implementation subagents while it runs.

4. Validate the returned plan. Every task must name files, state the change
   and its done condition, and carry runnable acceptance commands;
   trade-offs must appear as options with a recommendation. If gaps remain,
   send ONE bounded follow-up to the same Plan dispatch naming the exact gaps
   (at most 2 follow-up rounds total). If still underspecified, checkpoint
   with the gaps as residual risk instead of pretending the plan is complete.

5. Persist the validated plan to .github-router/plans/<slug>/plan.md.
   - Ask summary and user-blessed acceptance criteria.
   - Blind-spot table with executable-checkable or judgment-only tags.
   - Ordered task list with ids, files, dependencies, parallel groups, acceptance criteria, verification commands, rollback concerns, and estimated context tokens.
   - Open questions and user answers.
   - Cost estimate: task count, parallel groups, and context tokens.
   - Residual risks.

6. Checkpoint with the user and wait for explicit approval.
   - Present the goal, acceptance criteria, task-to-group map, per-task blind spot killed, residual risks, and cost estimate.
   - If the user rejects scope or cost, downshift to the smallest plan that kills the important blind spots.
   - Do not proceed to implementation without approval.
   - Write .github-router/plans/<slug>/.complete ONLY after explicit user approval, recording the approval in the marker. A plan without an approval record is NOT complete, and no downstream stage (/gh-implement, /gh-swe-pipeline stage 3) may start without it.

## Return format

Return:

- Trivial exit: yes with the recommended direct action and no plan file, or no with the plan below.
- Plan file: path to the durable plan.md.
- Task count and parallel groups.
- Open questions and user answers.
- Cost estimate.
- Residual risks and next action (implementation only after approval).

## Non-goals

- Do not dispatch Plan for a trivial ask; exit with a trivial verdict instead.
- Do not edit implementation files while planning; in plan mode, produce the plan and acceptance criteria only.
- Do not present judgment-only conclusions as executable guarantees.
- Do not hide open unknowns because the plan looks complete.
- Do not start planning while gather-context Explore subagents still run; record them superseded first.
- Do not dispatch implementation subagents from planning: stages never overlap.
`,
} as const
