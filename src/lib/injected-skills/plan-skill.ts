export const PLAN_SKILL = {
  name: "gh-plan",
  md: `---
name: gh-plan
description: Holistic planning from gathered context: ingests the context brief, creates a scoped modular ordered implementation plan with explicit tasks for cheap implementation workers, surfaces open questions for user approval, and persists plan.md. Use when a non-trivial change needs a reviewed plan before implementation.
user-invocable: true
---

# gh-plan: holistic planning for cheap implementation

Use this skill after /gh-gather-context (or when equivalent context is already
available) and before any implementation. The planner runs at the 200K default
window using the Sol model at medium effort. The plan must be scoped, modular,
non-overlapping, and ordered, with enough detail for Luna implementation
workers to execute each task in isolation. User approval is mandatory before
implementation.

## Prerequisites

- A freshness-stamped context brief from /gh-gather-context, or equivalent context.
- Read context.compact.md first; read context.md sections on demand (residual unknowns, evidence table).

## Hard bounds

- Maximum tasks: 20.
- Maximum parallel groups: 5.
- Planner input budget: at most 150K context tokens, leaving headroom in the 200K window.

## Procedure

1. Ingest context.
   - Read context.compact.md fully.
   - Read the evidence table and residual unknowns from context.md.
   - Identify acceptance criteria, constraints, integration seams, and forbidden changes.

2. Build a blind-spot table before decomposing.
   - Wrong-spec risk: judgment-only, mitigated only by user-blessed acceptance criteria.
   - Root-cause risk: executable-checkable if reproduced or covered by a failing test; otherwise advisory.
   - Integration risk: usually source-verified plus tests where possible.
   - Regression risk: executable-checkable when tests, typecheck, or lint cover it.
   - Review risk: advisory cross-lab review reduces correlated blind spots.
   - Concurrency or merge risk: source-verified and sometimes executable-checkable.
   - Missing-test risk: executable-checkable only after a test exists and runs.
   - Tag every blind spot as executable-checkable or judgment-only.

3. Decompose into minimal safe increments.
   - Each task touches a single file or a tightly coupled file group.
   - Each task states input artifacts, output artifact, acceptance criteria, verification commands, and rollback concern.
   - Order tasks by dependency (topological sort); tasks with no data dependency share a parallel group.
   - Keep each task small enough for one Luna worker at the 200K window (target at most 50K context tokens of relevant files per task).
   - If the ask needs discovery follow-ups, delegate them to worker-explore background subagents (via the Agent tool) rather than bloating the plan.

4. Surface open questions before finalizing.
   - Ask about ambiguous acceptance criteria, design decisions with multiple valid approaches, risk tolerance, and test strategy.
   - Present a short candidate list for confirmation where possible.

5. Persist the plan to .github-router/plans/<slug>/plan.md.
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

## Return format

Return:

- Plan file: path to the durable plan.md.
- Task count and parallel groups.
- Open questions and user answers.
- Cost estimate.
- Residual risks and next action (implementation only after approval).

## Non-goals

- Do not edit implementation files while planning; in plan mode, produce the plan and acceptance criteria only.
- Do not present judgment-only conclusions as executable guarantees.
- Do not hide open unknowns because the plan looks complete.
`,
} as const
