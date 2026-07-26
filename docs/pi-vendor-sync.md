# Pi vendor sync protocol

This document is the operational guide for refreshing `src/vendor/pi/`. The exact pin, closure, and per-file divergences live in [`src/vendor/pi/PROVENANCE.md`](../src/vendor/pi/PROVENANCE.md).

## Current shape

The Pi runtime backs github-router's worker agents. Two upstream slices are retained:

| Subtree | Upstream source | Rule |
| --- | --- | --- |
| `src/vendor/pi/agent/` | `packages/agent/src/` | Full directory replacement, followed by the three documented `proxy.ts` type-check patches and the minimal `agent.ts` `shouldStopAfterTurn` exposure. It is not verbatim. |
| `src/vendor/pi/ai/` | `packages/ai/src/` | Minimal transitive closure required by the agent tree and `src/lib/worker-agent/`, with documented type-only stubs and a rewritten index. |

The current pin is upstream tag `v0.82.0`, commit `083e61621276bff9f6faefab87ce07fcd98734e2` (2026-07-24).

Path aliases in `tsconfig.json` route the upstream package specifiers into this vendored tree.

## Why vendor

The full Pi AI package supports many providers and therefore pulls concrete Anthropic, Google, OpenAI, Bedrock, and Mistral SDKs. github-router never invokes those providers: every worker model call uses the custom Copilot-backed `streamFn`. Vendoring the closed slice keeps Pi's agent loop, hooks, tool execution, retries, compaction, and stream contracts without the unused provider dependency and initialization surface.

## Current AI closure

The retained files are:

- `types.ts`, `models.ts`, `models-store.ts`, `env-api-keys.ts`
- `api/lazy.ts`
- `auth/types.ts`, `auth/context.ts`, `auth/credential-store.ts`, `auth/resolve.ts`
- `utils/event-stream.ts`, `utils/json-parse.ts`, `utils/validation.ts`, `utils/diagnostics.ts`, `utils/retry.ts`, `utils/text.ts`, `utils/uuid.ts`, `utils/provider-env.ts`
- rewritten `index.ts`

This list is a record, not an assumption for the next bump. Follow imports again on every refresh until the closure closes. In v0.82.0, `stream.ts` and `api-registry.ts` are no longer part of the closure, and `models.generated.ts` leaves it entirely.

## Intentional divergences

These must survive every refresh:

| File | Divergence |
| --- | --- |
| `agent/proxy.ts` | Bun reader typing: widen the reader element to `unknown`, cast `getReader()` through `unknown`, and narrow at `read()`. Also use `proxyEvent satisfies never` instead of an unused exhaustiveness binding. |
| `agent/agent.ts` | Add `shouldStopAfterTurn` to `AgentOptions`, store it, and pass it into `AgentLoopConfig`. This makes Pi's existing graceful post-turn stop reachable by worker hard-budget wiring. |
| `ai/types.ts` | Replace the ten concrete provider-option imports with type-only `Record<string, unknown>` aliases so their SDK-bearing modules are not copied. Keep the rest of the file verbatim. |
| `ai/utils/diagnostics.ts` | Keep the shallow type stub used at the `AssistantMessage.diagnostics` boundary; the custom stream never emits provider diagnostics. |
| `ai/index.ts` | Re-export only the closed slice plus TypeBox primitives. |

The `proxy.ts` patches are especially easy to lose because `agent/` otherwise arrives via a full directory copy. Recover them from the old pin before deleting the directory.

## Hook & option surface — wiring decisions

This is the durable wiring review for the current pin. Status describes github-router's worker engine, not whether Pi implements the item. Re-derive this table from the new pin on every refresh; the exact-key contract in `tests/worker-pi-contract.test.ts` is an alarm, not a substitute for the decision.

### `AgentOptions`

| Item | What it does | Status | Evidence | Decision + rationale |
| --- | --- | --- | --- | --- |
| `initialState` | Seeds prompt, model, thinking, tools, and transcript state. | wired | `src/lib/worker-agent/engine.ts:513-519` | KEEP: the worker supplies all run identity and tool state here. |
| `convertToLlm` | Converts/filter Pi transcript messages before a model call. | unwired | `src/vendor/pi/agent/agent.ts:99,217` | DELIBERATE SKIP: Pi's default already preserves the three wire-relevant roles. |
| `transformContext` | Rewrites the send-time transcript before conversion. | wired | `src/lib/worker-agent/engine.ts:526-558` | KEEP: owns structural compaction and the current-plan reminder. |
| `streamFn` | Replaces Pi's provider transport. | wired | `src/lib/worker-agent/engine.ts:520-524` | KEEP: all model traffic must use the Copilot-backed stream function. |
| `getApiKey` | Resolves a provider API key before each turn. | unwired | `src/vendor/pi/agent/agent.ts:102,220` | DELIBERATE SKIP: the custom `streamFn` owns requests and Copilot token refresh happens below the agent layer. |
| `onPayload` | Observes/mutates Pi provider payload construction. | unwired | `src/vendor/pi/agent/agent.ts:103,221` | DELIBERATE SKIP: the custom `streamFn` owns payload construction. |
| `onResponse` | Observes Pi provider responses. | unwired | `src/vendor/pi/agent/agent.ts:104,222` | DELIBERATE SKIP: the custom `streamFn` owns response handling. |
| `beforeToolCall` | Audits and may block a validated tool call. | wired | `src/lib/worker-agent/engine.ts:559-589` | KEEP: this is the pre-execution budget gate and browse-terminal capture seam. |
| `afterToolCall` | Rewrites/account tool results before they enter history. | wired | `src/lib/worker-agent/engine.ts:594-616` | KEEP: cumulative byte accounting and per-result context caps live here. |
| `shouldStopAfterTurn` | Gracefully terminates after the completed turn. | wired | `src/lib/worker-agent/engine.ts:590-593` | KEEP LOCAL PATCH: makes latched hard budget caps terminal before another provider call. |
| `prepareNextTurn` | Updates/counts state between completed turns. | wired | `src/lib/worker-agent/engine.ts:617-625` | KEEP: increments the turn budget exactly once per model turn. |
| `prepareNextTurnWithContext` | Variant exposing Pi's full next-turn context to the callback. | unwired | `src/vendor/pi/agent/agent.ts:112-115,197-200` | DELIBERATE SKIP: turn counting needs no context; do not wire both competing variants. |
| `steeringMode` | Sets how many queued steering messages drain per poll. | unwired | `src/vendor/pi/agent/agent.ts:116,228` | DELIBERATE SKIP: workers do not accept interactive mid-run steering. |
| `followUpMode` | Sets how many queued follow-ups drain per poll. | unwired | `src/vendor/pi/agent/agent.ts:117,229` | DELIBERATE SKIP: bounded nudges enqueue singly, so the default one-at-a-time mode is correct. |
| `sessionId` | Forwards provider session identity for cache-aware backends. | unwired | `src/vendor/pi/agent/agent.ts:118,230` | INVESTIGATE: measure whether Copilot honors a session-affinity header and yields a prompt-cache win before wiring it. |
| `thinkingBudgets` | Supplies Pi per-level thinking-token budgets. | unwired | `src/vendor/pi/agent/agent.ts:119,231` | DELIBERATE SKIP: model/thinking translation belongs to the custom `streamFn`. |
| `transport` | Chooses Pi's provider transport. | unwired | `src/vendor/pi/agent/agent.ts:120,232` | DELIBERATE SKIP: the custom `streamFn` chooses the Copilot endpoint and transport. |
| `maxRetryDelayMs` | Caps Pi provider-requested retry delays. | unwired | `src/vendor/pi/agent/agent.ts:121,233` | DELIBERATE SKIP: retries occur below the agent in the custom request stack. |
| `toolExecution` | Selects parallel versus sequential tool batches. | wired | `src/lib/worker-agent/engine.ts:506-525` | KEEP: global parallelism plus per-tool `executionMode: "sequential"` preserves safe writes with fast reads. |

### `AgentLoopConfig` hooks and public `Agent` surface

| Item | What it does | Status | Evidence | Decision + rationale |
| --- | --- | --- | --- | --- |
| `shouldStopAfterTurn` config hook | Stops after `turn_end`, before queue polling or another model call. | unreachable-without-patch | `src/vendor/pi/agent/agent-loop.ts:247-257`; `src/vendor/pi/agent/agent.ts:107-108,225,452` | KEEP LOCAL PATCH: upstream had the loop hook but no `AgentOptions` route to it; our exposure is the fourth `agent/` patch. |
| `getSteeringMessages` config hook | Polls steering messages after a turn. | partially wired | `src/vendor/pi/agent/agent.ts:465-471` | KEEP INTERNAL: Pi's `Agent` always maps its private queue; the worker deliberately does not call `steer`. |
| `getFollowUpMessages` config hook | Polls follow-ups when the loop would stop. | wired | `src/vendor/pi/agent/agent.ts:472`; `src/lib/worker-agent/engine.ts:663-680` | KEEP: bounded no-output nudges use `followUp`. |
| `prepareNextTurn` config hook | Applies context/model/thinking updates before stop/queue checks. | wired | `src/vendor/pi/agent/agent.ts:453-461`; `src/lib/worker-agent/engine.ts:622-625` | KEEP: `Agent` adapts our no-context callback to the low-level hook. |
| `continue()` | Resumes an existing transcript or queued message. | unwired | `src/vendor/pi/agent/agent.ts:353-381` | SKIP WIRING: each worker invocation is one owned prompt lifecycle; retries start a fresh run. |
| `reset()` | Clears transcript, runtime state, and both queues. | unwired | `src/vendor/pi/agent/agent.ts:329-338` | SKIP WIRING: the engine constructs a new `Agent` per run. |
| `steer()` | Enqueues an interactive mid-run steering message. | unwired | `src/vendor/pi/agent/agent.ts:279-282` | SKIP WIRING: MCP worker calls have no interactive steering channel. |
| `clearFollowUpQueue()` | Drops queued follow-ups. | unwired | `src/vendor/pi/agent/agent.ts:294-297` | SKIP WIRING: nudges are run-local and the `Agent` is discarded after completion. |
| `clearAllQueues()` | Drops both message queues. | unwired | `src/vendor/pi/agent/agent.ts:299-303` | SKIP WIRING: no reusable agent survives a worker call. |
| `hasQueuedMessages()` | Reports whether either queue has work. | unwired | `src/vendor/pi/agent/agent.ts:305-308` | SKIP WIRING: Pi owns queue polling; engine termination uses events and budget state. |
| `steeringMode` / `followUpMode` setters | Changes queue drain policy after construction. | unwired | `src/vendor/pi/agent/agent.ts:261-276` | SKIP WIRING: no interactive steering and nudges must remain one-at-a-time. |
| `state.errorMessage` | Retains the last assistant turn error. | unwired | `src/vendor/pi/agent/agent.ts:563-566`; `src/lib/worker-agent/engine.ts:654-692` | KEEP VENDORED, SKIP WIRING: engine derives terminal failure from `message_end.stopReason`, preserving partial diagnostics without a second state channel. |

The engine does call the other lifecycle surface it needs: `subscribe`, `followUp`, `abort`, `prompt`, `waitForIdle`, and `state.messages` (`src/lib/worker-agent/engine.ts:489-492,628-705,720-721`). Do not mistake omission from the table above for an unaudited method.

### Router knobs and timeout paths

| Item | What it does | Status | Evidence | Decision + rationale |
| --- | --- | --- | --- | --- |
| `GH_ROUTER_WORKER_MAX_TURNS` | Caps completed model turns. | wired | `src/lib/worker-agent/budget.ts:146-150`; `src/lib/worker-agent/engine.ts:622-625` | KEEP: read into `Budget`, incremented per turn, and made terminal by the stop hook. |
| `GH_ROUTER_WORKER_MAX_WALLCLOCK_MS` | Caps total run time. | wired | `src/lib/worker-agent/budget.ts:141-150`; `src/lib/worker-agent/engine.ts:695-706` | KEEP: resolved value is clamped to the MCP timeout ceiling and drives the abort timer. |
| `GH_ROUTER_WORKER_MAX_TOOL_BYTES` | Caps cumulative tool-result bytes. | wired | `src/lib/worker-agent/budget.ts:151-154`; `src/lib/worker-agent/engine.ts:594-600` | KEEP: results are counted after every tool and the next gate latches a terminal stop. |
| `GH_ROUTER_WORKER_MAX_TOOL_CALLS` | Caps total tool calls. | wired | `src/lib/worker-agent/budget.ts:155-158,245-260` | KEEP: checked on every `beforeToolCall` path. |
| `GH_ROUTER_WORKER_MAX_REPEATED_CALLS` | Blocks consecutive identical calls. | wired | `src/lib/worker-agent/budget.ts:159-162,262-284` | KEEP: non-terminal anti-loop guard lets the model recover. |
| `GH_ROUTER_WORKER_MODEL_CALL_TIMEOUT_MS` | Bounds each whole model turn, including SSE consumption. | wired | `src/lib/worker-agent/budget.ts:109-113`; `src/lib/worker-agent/engine.ts:520-524`; `src/lib/worker-agent/stream-fn.ts:296,725` | KEEP: one resolved value reaches both Responses and Chat stream paths. |
| `GH_ROUTER_WORKER_MAX_NUDGES` | Bounds in-run retries after clean empty output. | wired | `src/lib/worker-agent/engine.ts:306-325,654-680` | KEEP: read per run; `0` deliberately disables nudging. |
| `GH_ROUTER_WORKER_MAX_INFLIGHT` | Caps concurrent workers without queueing. | wired | `src/lib/worker-agent/semaphore.ts:27-33,52-58`; `src/lib/worker-agent/engine.ts:383-389` | KEEP: read once at module load and applied before any run allocation. |
| `GH_ROUTER_WORKER_MAX_RESULT_BYTES` | Spills oversized MCP results to a file with a bounded preview. | wired | `src/lib/worker-agent/relay-cap.ts:62-70`; `src/lib/peer-mcp-personas.ts:2486,2629` | KEEP: final MCP-boundary transform covers filesystem and browse worker results. |
| `GH_ROUTER_WORKER_ADVISOR_MAX_CHARS` | Caps transcript characters sent to the advisor tool. | wired | `src/lib/worker-agent/tools.ts:1616-1625` | KEEP: applied when rendering the live transcript for advisor calls. |
| `GH_ROUTER_WORKER_DISABLE_NETWORK` | Refuses worker network-bearing tools and common network shell commands. | wired | `src/lib/worker-agent/tools.ts:145-151,198` | KEEP: one shared switch is checked by tool and bash gates. |
| `UPSTREAM_FETCH_TIMEOUT_MS` streaming paths | Bounds fetch-to-headers; `0` disables it for long streaming completions. | wired | `src/lib/port.ts:192-202`; `src/services/copilot/create-responses.ts:47-49`; `src/services/copilot/create-messages.ts:81-83` | KEEP: opt-out prevents truncating legitimate long reasoning streams. |
| `UPSTREAM_INACTIVITY_TIMEOUT_MS` | Bounds silence between streamed body chunks. | wired | `src/lib/port.ts:204-218`; `src/routes/responses/handler.ts:139,216`; `src/routes/chat-completions/handler.ts:155,220` | KEEP: applied to both Responses and Chat body-read loops. |
| `UPSTREAM_FETCH_TIMEOUT_MS` on `/responses/compact` | Always bounds the short non-streaming compact request. | partially wired | `src/routes/responses/handler.ts:411-426` | **DELIBERATE — DO NOT UNIFY:** uses `UPSTREAM_FETCH_TIMEOUT_MS || 300_000`, so `0` does not disable this path. The streaming opt-out prevents truncation; compact should never hang. An audit “consistency” fix reintroduced regression E1 and `tests/isolated/responses-compact-timeout.test.ts` caught it. General rule: an apparent inconsistency may be a prior fix; establish why before changing it. |

### Local-patch and dependency retention checklist

| Item | What it does | Status | Evidence | Decision + rationale |
| --- | --- | --- | --- | --- |
| `proxy.ts`: reader element widened to `unknown` | Reconciles Bun's `readMany` reader type with DOM `getReader()`. | wired | `src/vendor/pi/agent/proxy.ts:141-145` | KEEP LOCAL PATCH 1 of 4. |
| `proxy.ts`: `getReader()` cast through `unknown` | Makes the Bun/DOM reader conversion type-safe enough for this build. | wired | `src/vendor/pi/agent/proxy.ts:185-189` | KEEP LOCAL PATCH 2 of 4. |
| `proxy.ts`: `proxyEvent satisfies never` | Preserves exhaustiveness without an unused local. | wired | `src/vendor/pi/agent/proxy.ts:379-381` | KEEP LOCAL PATCH 3 of 4. |
| `agent.ts`: expose `shouldStopAfterTurn` | Routes the existing loop hook through `AgentOptions`. | wired | `src/vendor/pi/agent/agent.ts:107-108,193,225,452` | KEEP LOCAL PATCH 4 of 4: hard caps otherwise block one call but cannot end the run. |
| `diff`, `yaml`, `ignore` dependencies | Runtime imports of the vendored, currently unused `agent/harness/` tree. | wired | `src/vendor/pi/agent/harness/tools/edit-diff.ts:5`; `src/vendor/pi/agent/harness/prompt-templates.ts:1`; `src/vendor/pi/agent/harness/skills.ts:1-2`; `package.json:65,69,79` | KEEP EXACT PINS: the harness typechecks but is not invoked today; pruning these as “unused” breaks a production install if the vendored harness is loaded. |

## Ten-step refresh protocol

1. **Clone outside the repository.** Clone `pi-mono` into a system temporary directory and check out the exact requested tag or commit. Never copy `.git`, build output, or scratch patches into this working tree.
2. **Record and compare pins.** Capture `git rev-parse HEAD`, verify it matches the intended tag, and inspect the upstream range from the currently pinned SHA.
3. **Recover local patches before overwrite.** Diff the current `src/vendor/pi/agent/proxy.ts` against that file at the old upstream pin. Do the same for `src/vendor/pi/ai/utils/diagnostics.ts`. Save the resulting divergences outside the repository.
4. **Replace agent and rebuild AI closure.** Replace `agent/` from `packages/agent/src/`, then re-apply the three `proxy.ts` patches and the `agent.ts` `shouldStopAfterTurn` exposure. Recreate `ai/` by following imports from the new agent tree and `src/lib/worker-agent/` until closed. Re-apply the provider-option aliases, diagnostics stub, and rewritten index. Do not carry obsolete files forward merely because they existed at the prior pin.
5. **Audit upstream runtime dependencies.** Diff upstream's `packages/agent/package.json` and `packages/ai/package.json` `dependencies` against ours. Every bare specifier imported by the new closure MUST be an explicit entry in our own `dependencies` — a package that resolves only transitively (through a devDependency, say) works locally and breaks a production install. Pin Pi's dependencies EXACTLY at upstream's version, matching the existing `ignore` / `partial-json` / `typebox` / `yaml` entries; carets are for this repo's own dependencies, not vendored ones. This step exists because the v0.82.0 sync initially missed `diff`, which `harness/tools/edit-diff.ts` imports at runtime and which was resolving only via `tsdown`.
6. **Update documentation.** Update PROVENANCE.md and this document with the exact tag, full SHA, date, final closure, files added/dropped, and every divergence. Never call `agent/` verbatim while `proxy.ts` differs.
7. **Re-derive the configuration surface.** Re-derive the `AgentOptions` / `AgentLoopConfig` / `Agent`-method surface from the new pin and diff it against the wiring table. Any field added, removed or renamed upstream is an explicit accept/reject decision recorded in the table BEFORE the PR — never a silent default.
8. **Run the focused gate.** Run typecheck, lint, the complete focused worker/Pi contract suite, and build. A failing constructor-option or runtime execution-mode assertion is an upgrade finding; diagnose it rather than weakening or skipping the test.
9. **Run the wider suite.** Run `bun test` and compare pass/fail counts with the old pin. CI runs isolated tests separately, so report exclusions and any environmental failure accurately.
10. **Audit and clean up.** Diff the vendor tree against the exact upstream tag, permitting only documented divergences and the deliberate AI slice. Remove the temporary clone. Confirm git status contains no temporary or generated artifact before review/PR.

## Verification commands

```bash
bun run typecheck
bun run lint:all
bun test tests/worker-tool-matrix.test.ts tests/worker-pi-contract.test.ts tests/worker-agent-context-mgmt.test.ts tests/worker-agent-engine.test.ts tests/worker-agent-browse-mode.test.ts tests/worker-agent-g1-invariant.test.ts tests/worker-agent-backstop.test.ts tests/worker-agent-tools.test.ts tests/worker-agent-browse-tools.test.ts
bun run build
bun test
```

## License

Upstream Pi is MIT licensed. Preserve [`src/vendor/pi/LICENSE`](../src/vendor/pi/LICENSE) and its copyright. A future upstream license change requires explicit review rather than an automatic sync.
