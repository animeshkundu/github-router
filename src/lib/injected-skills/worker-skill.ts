/**
 * The `/gh-worker` skill: the operating model for the NON-BLOCKING workers
 * surface. Materialized into the per-launch mirror whenever `workerToolsEnabled()`
 * (same gate as the other floor-raising skills). Discoverability + playbook; the
 * load-bearing enforcement is the PreToolUse guard + the `worker-*` dispatcher
 * subagents (see src/lib/worker-dispatch.ts).
 */
export const WORKER_SKILL = {
  name: "gh-worker",
  md: `---
name: gh-worker
description: How to run github-router workers without blocking your turn. Workers (explore/implement/review/plan/test) can run up to 30 minutes; dispatch the matching worker-* background subagent so you get a completion notification instead of waiting. Use whenever you would reach for a worker.
user-invocable: true
---

# gh-worker: non-blocking workers

Worker tasks (explore, implement, review, plan, test) can run for up to 30
minutes. In this session they are NON-BLOCKING BY DESIGN: you dispatch a
background \`worker-*\` subagent, get control back immediately, and receive the
worker's result as a completion notification when it finishes. Your turn is
never blocked waiting on a worker, and the worker's tool output never fills your
context (only its final result comes back).

## How to run a worker

Dispatch the matching dispatcher subagent with the Agent tool:

- worker-explore: read-only investigation / codebase gathering, returns a summary.
- worker-review: reads the code itself to verify a change or claim; findings with severity + file:line.
- worker-plan: returns an ordered implementation plan from a task + acceptance criteria.
- worker-implement: read/write/bash coding worker; pass worktree: true for isolated-worktree execution + a returned diff.
- worker-test: independent test author that writes tests trying to break the implementation and reports pass/fail.

Put the full worker brief in the subagent's prompt (and an absolute workspace
path, or model/thinking/worktree, only if you need to override the defaults).
The dispatcher calls the worker once and relays its result verbatim.

## What to expect

- The dispatch returns immediately; you can keep working or start other workers.
- When the worker finishes you get a completion notification carrying its result.
- Up to 8 workers run concurrently (the worker-semaphore cap); further dispatches queue.
- You do NOT call the raw mcp__...__ worker tools from the main thread: a guard
  denies that and points you at the matching worker-* subagent. That guard is the
  guarantee your turn never blocks; dispatching worker-* directly is the normal path.

## Notes

- Large worker output may be summarized by the dispatcher relay; for a big
  artifact, have the worker write it to a file and return the path.
- Dispatching the same worker twice runs it twice (no dedup); avoid double-dispatch
  for side-effecting work like worker-implement.
- Background subagents + completion notifications are the interactive default. In
  headless (claude -p) runs the task surface behaves differently; prefer interactive
  for long worker fan-out.
`,
} as const
