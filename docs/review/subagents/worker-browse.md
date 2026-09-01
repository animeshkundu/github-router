# Subagent: `worker-browse`

> Non-blocking background dispatcher for the autonomous `browse` worker.

## Identity and availability

| Field | Value |
|---|---|
| Subagent name | `worker-browse` |
| Model | Fast/Max frontmatter pins Luna 1M/high; standard launches use the normal dispatcher assignment |
| Gate | `browseAgentEnabled()` (`--browse`, installed browser, reachable Luna default) |
| Description | `dispatcherDescription("browse")` |
| Prompt | `dispatcherPrompt("browse", workersKey)` |
| Tools | `mcp__<resolved-workers-key>__*` only, with an inline scoped workers server |

Fast and Max project the `workers` group down to `browse`; core worker modes remain hidden and hard calls return `-32601`. The Fast native ACL admits `worker-browse` only when the launch emitted it, and the dispatcher is terminal.

## Routing contract

The dispatcher calls `mcp__<workersKey>__browse` exactly once, passes the lead's brief as the required `task` argument, forwards explicitly supplied workspace/model/thinking/wall-clock fields, and relays the result unchanged. It runs in the background so multi-step browser work does not block the lead's turn.

## A3 resolution

The earlier A3 finding was that the shared dispatcher prompt said to pass `prompt`, while `browse` requires `task` and rejects unknown properties. `dispatcherPrompt` now branches for browse and emits `task`; `tests/worker-dispatch.test.ts` pins that contract. Fast and Max reuse the corrected helper instead of maintaining profile-specific copies.

## Review verdict

**Y.** The description, schema, dispatcher prompt, profile projection, and non-blocking behavior now agree. Keep the `task` regression assertion whenever dispatcher fields change.
