# Pi vendor sync protocol

This document is the operational guide for refreshing `src/vendor/pi/`. The exact pin, closure, and per-file divergences live in [`src/vendor/pi/PROVENANCE.md`](../src/vendor/pi/PROVENANCE.md).

## Current shape

The Pi runtime backs github-router's worker agents. Two upstream slices are retained:

| Subtree | Upstream source | Rule |
| --- | --- | --- |
| `src/vendor/pi/agent/` | `packages/agent/src/` | Full directory replacement plus a four-hunk `proxy.ts` type patch and an `index.ts` comment header. Five of the six files are byte-identical upstream. |
| `src/vendor/pi/ai/` | `packages/ai/src/` | Minimal transitive closure required by the agent tree and `src/lib/worker-agent/`, with documented type-only stubs and a rewritten index. |

The current pin is upstream tag `v1.3.0`, commit `71023aec1546d6d677a65669c5665c0927ce0dd0` (2026-10-15).

Path aliases in `tsconfig.json` route the upstream package specifiers into this vendored tree.

At v1.3.0 `packages/agent/src/` is exactly `agent.ts`, `agent-loop.ts`, `index.ts`, `proxy.ts`, `stream-fn.ts`, `types.ts`, and its `dependencies` are exactly `@earendil-works/pi-ai@1.3.0` (satisfied by the alias) and `typebox@1.3.27`. The `harness/` subtree and `node.ts` that earlier pins carried under `packages/agent/src/` are no longer in that package at all; upstream relocated them to `packages/durable/src/harness` and `packages/chord/src/node.ts`.

## Why vendor

The full Pi AI package supports many providers and therefore pulls concrete Anthropic, Google, OpenAI, Bedrock, and Mistral SDKs. github-router never invokes those providers: every worker model call uses the custom Copilot-backed `streamFn`. Vendoring the closed slice keeps Pi's agent loop, hooks, tool execution, retries, compaction, and stream contracts without the unused provider dependency and initialization surface.

## Current AI closure

The retained files are:

- `types.ts`, `models.ts`, `models-store.ts`, `env-api-keys.ts`
- `api/lazy.ts`
- `auth/types.ts`, `auth/context.ts`, `auth/credential-store.ts`, `auth/resolve.ts`
- `utils/event-stream.ts`, `utils/json-parse.ts`, `utils/validation.ts`, `utils/diagnostics.ts`, `utils/retry.ts`, `utils/text.ts`, `utils/transcript.ts`, `utils/uuid.ts`, `utils/provider-env.ts`
- rewritten `index.ts`

This list is a record, not an assumption for the next bump. Follow imports again on every refresh until the closure closes. `utils/transcript.ts` entered the closure at v1.3.0 (it is where `normalizeContext` and the current-prompt/tool replay helpers live); `stream.ts`, `api-registry.ts`, and `models.generated.ts` remain outside it.

The only bare specifiers the closure imports are `partial-json` (`utils/json-parse.ts`) and `typebox`. Both are explicit exact pins in our own `dependencies`.

## Intentional divergences

These must survive every refresh:

| File | Divergence |
| --- | --- |
| `agent/proxy.ts` | Bun reader typing: widen the reader element to `unknown`, cast `getReader()` through `unknown`, re-narrow at `read()`, and use `proxyEvent satisfies never` instead of an unused exhaustiveness binding. |
| `agent/index.ts` | A comment header above upstream's unchanged exports. |
| `ai/types.ts` | Replace the ten concrete provider-option imports with type-only `Record<string, unknown>` aliases so their SDK-bearing modules are not copied. Keep the rest of the file verbatim. |
| `ai/utils/diagnostics.ts` | Keep the shallow type stub used at the `AssistantMessage.diagnostics` boundary; the custom stream never emits provider diagnostics. |
| `ai/index.ts` | Re-export only the closed slice plus TypeBox primitives. |

The `proxy.ts` patches are especially easy to lose because `agent/` otherwise arrives via a full directory copy. Recover them from the old pin before deleting the directory.

A local divergence that upstream has adopted must be **withdrawn**, not carried forward. The `agent/agent.ts` patch from the v0.82.0 era is the precedent: it exposed `shouldStopAfterTurn` through `AgentOptions` because upstream offered the hook only on `AgentLoopConfig`. At v1.3.0 upstream routes its replacement, `finishTurn`, through `AgentOptions` natively (`agent.ts:114,125,209,243,482`), so the patch is gone and `agent.ts` is byte-identical upstream.

## Consumer-facing contract changes

The vendored tree's *type-shaped* changes are cheap to re-apply. The ones that reach the worker agent are not, because two of them fail SILENTLY rather than at compile time. Re-read this section on every refresh.

### v1.3.0: `StreamFn` takes a `TranscriptContext`, not a `Context`

`StreamFn`'s context parameter is now a normalized `TranscriptContext`, produced only by `normalizeContext`. The system prompt and the tool declarations no longer sit on the context object; they live in a leading `SystemMessage` that `normalizeContext` folds in, and are read back with `getCurrentSystemPrompt(messages)` / `getCurrentTools(messages)`.

**This is the silent-failure hazard.** A `StreamFn` written as `(model, context: Context, options)` remains contravariantly assignable to `StreamFn`, so the compiler accepts it. Every read of `context.systemPrompt` or `context.tools` inside such a function then yields `undefined` at runtime, and the proxy sends every request with no system prompt and no tools while still returning HTTP 200. There is no type error and no runtime error — only a model that has stopped behaving like an agent.

`src/lib/worker-agent/stream-fn.ts` therefore derives the prompt and tools with `getCurrentSystemPrompt(context.messages)` and `getCurrentTools(context.messages)`, and `translateMessages` skips `role === "system"` explicitly (the prompt is already on the wire as an `instructions` field or a leading system message, and re-emitting it as a transcript turn would double it). The import block carries a comment naming the hazard. `tests/worker-agent-responses-payload-golden.test.ts`, `tests/worker-agent-backstop.test.ts`, and five sibling suites call `normalizeContext(...)` at their single call boundary so their fixtures stay in the natural `Context` shape while the exercised path is the real one.

Corollary for tests: a suite that passes a raw `Context` where a `TranscriptContext` is expected still compiles, and its assertions about prompts and tools then pass for the wrong reason. Normalize at the boundary.

### v1.3.0: `shouldStopAfterTurn` becomes `finishTurn`

The boolean stop hook is replaced by `finishTurn: (turn) => {action:"continue"} | {action:"end"} | undefined`. The two are **not** interchangeable: `{action:"continue"}` forces one more provider request, while `undefined` preserves normal scheduling and the old `false` only declined to stop. `src/lib/worker-agent/engine.ts:654-661` latches `{action:"end"}` when the budget has a hard-stop reason and returns `undefined` otherwise — returning `"continue"` there would add a model call to every turn the budget had already allowed. `tests/worker-pi-contract.test.ts` pins both branches.

### v1.3.0: the transcript now carries system messages

Any code that walks the transcript and scores, prunes, or renders message content must decide what to do with `role === "system"`:

- `src/lib/worker-agent/compaction.ts` counts it (`case "system"` in `messageTextBytes`) so the byte accounting includes the prompt rather than scoring it 0 and computing every trigger and prune threshold against a prompt-free volume.
- `src/lib/worker-agent/tools.ts` excludes it from the advisor transcript, which renders model turns for a cross-lab consult.

Both decisions are recorded in the wiring table below. A future refresh that adds another transcript walker must make the same call explicitly.

## Hook & option surface — wiring decisions

This is the durable wiring review for the current pin. Status describes github-router's worker engine, not whether Pi implements the item. Re-derive this table from the new pin on every refresh; the exact-key contract in `tests/worker-pi-contract.test.ts` is an alarm, not a substitute for the decision.

The Evidence column anchors on a symbol plus a line range verified at the pin date. Line numbers drift; the symbol is authoritative.

### `AgentOptions`

| Item | What it does | Status | Evidence | Decision + rationale |
| --- | --- | --- | --- | --- |
| `initialState` | Seeds prompt, model, thinking, tools, and transcript state. | wired | `src/lib/worker-agent/engine.ts:570` | KEEP: the worker supplies all run identity and tool state here. |
| `convertToLlm` | Converts/filter Pi transcript messages before a model call. | unwired | `agent.ts` `AgentOptions` | DELIBERATE SKIP: Pi's default already preserves the three wire-relevant roles. |
| `transformContext` | Rewrites the send-time transcript before conversion. | wired | `src/lib/worker-agent/engine.ts:602` | KEEP: owns structural compaction and the current-plan reminder. |
| `streamFn` | Replaces Pi's provider transport. | wired | `src/lib/worker-agent/engine.ts:580` | KEEP: all model traffic must use the Copilot-backed stream function. |
| `getApiKey` | Resolves a provider API key before each turn. | unwired | `agent.ts` `AgentOptions` | DELIBERATE SKIP: the custom `streamFn` owns requests and Copilot token refresh happens below the agent layer. |
| `onPayload` | Observes/mutates Pi provider payload construction. | unwired | `agent.ts` `AgentOptions` | DELIBERATE SKIP: the custom `streamFn` owns payload construction. |
| `onResponse` | Observes Pi provider responses. | unwired | `agent.ts` `AgentOptions` | DELIBERATE SKIP: the custom `streamFn` owns response handling. |
| `beforeToolCall` | Audits and may block a validated tool call. | wired | `src/lib/worker-agent/engine.ts:619` | KEEP: this is the pre-execution budget gate and browse-terminal capture seam. |
| `afterToolCall` | Rewrites/accounts tool results before they enter history. | wired | `src/lib/worker-agent/engine.ts:662` | KEEP: cumulative byte accounting and per-result context caps live here. |
| `finishTurn` | Gracefully ends or continues after the completed turn. | wired | `src/lib/worker-agent/engine.ts:654-661` | KEEP: makes latched hard budget caps terminal before another provider call. Replaces the pre-v1.3.0 `shouldStopAfterTurn` local patch, which upstream has now adopted in a different shape. |
| `prepareNextTurn` | Updates/counts state between completed turns. | wired | `src/lib/worker-agent/engine.ts:690` | KEEP: increments the turn budget exactly once per model turn. |
| `prepareNextTurnWithContext` | Variant exposing Pi's full next-turn context to the callback. | unwired | `agent.ts` `AgentOptions` | DELIBERATE SKIP: turn counting needs no context; do not wire both competing variants. |
| `steeringMode` | Sets how many queued steering messages drain per poll. | unwired | `agent.ts` `AgentOptions` | DELIBERATE SKIP: workers do not accept interactive mid-run steering. |
| `followUpMode` | Sets how many queued follow-ups drain per poll. | unwired | `agent.ts` `AgentOptions` | DELIBERATE SKIP: bounded nudges enqueue singly, so the default one-at-a-time mode is correct. |
| `sessionId` | Forwards provider session identity for cache-aware backends. | unwired | `agent.ts` `AgentOptions` | INVESTIGATE: measure whether Copilot honors a session-affinity header and yields a prompt-cache win before wiring it. |
| `thinkingBudgets` | Supplies Pi per-level thinking-token budgets. | unwired | `agent.ts` `AgentOptions` | DELIBERATE SKIP: model/thinking translation belongs to the custom `streamFn`. |
| `transport` | Chooses Pi's provider transport. | unwired | `agent.ts` `AgentOptions` | DELIBERATE SKIP: the custom `streamFn` chooses the Copilot endpoint and transport. |
| `maxRetryDelayMs` | Caps Pi provider-requested retry delays. | unwired | `agent.ts` `AgentOptions` | DELIBERATE SKIP: retries occur below the agent in the custom request stack. |
| `toolExecution` | Selects parallel versus sequential tool batches. | wired | `src/lib/worker-agent/engine.ts:585` | KEEP: global parallelism plus per-tool `executionMode: "sequential"` preserves safe writes with fast reads. |

### `AgentLoopConfig` hooks and public `Agent` surface

| Item | What it does | Status | Evidence | Decision + rationale |
| --- | --- | --- | --- | --- |
| `finishTurn` config hook | Ends or continues after `turn_end`, before queue polling or another model call. | wired | `src/lib/worker-agent/engine.ts:654-661` | KEEP: the only route by which a latched hard budget cap ends the run instead of merely blocking one call. Exposed on `AgentOptions` upstream since v1.3.0; no local patch is required. |
| `getSteeringMessages` config hook | Polls steering messages after a turn. | partially wired | `agent.ts` loop config | KEEP INTERNAL: Pi's `Agent` always maps its private queue; the worker deliberately does not call `steer`. |
| `getFollowUpMessages` config hook | Polls follow-ups when the loop would stop. | wired | `src/lib/worker-agent/engine.ts:757` | KEEP: bounded no-output nudges use `followUp`. |
| `prepareNextTurn` config hook | Applies context/model/thinking updates before stop/queue checks. | wired | `src/lib/worker-agent/engine.ts:690` | KEEP: `Agent` adapts our no-context callback to the low-level hook. |
| `continue()` | Resumes an existing transcript or queued message. | unwired | `agent.ts` public surface | SKIP WIRING: each worker invocation is one owned prompt lifecycle; retries start a fresh run. |
| `reset()` | Clears transcript, runtime state, and both queues. | unwired | `agent.ts` public surface | SKIP WIRING: the engine constructs a new `Agent` per run. |
| `steer()` | Enqueues an interactive mid-run steering message. | unwired | `agent.ts` public surface | SKIP WIRING: MCP worker calls have no interactive steering channel. |
| `clearFollowUpQueue()` | Drops queued follow-ups. | unwired | `agent.ts` public surface | SKIP WIRING: nudges are run-local and the `Agent` is discarded after completion. |
| `clearAllQueues()` | Drops both message queues. | unwired | `agent.ts` public surface | SKIP WIRING: no reusable agent survives a worker call. |
| `hasQueuedMessages()` | Reports whether either queue has work. | unwired | `agent.ts` public surface | SKIP WIRING: Pi owns queue polling; engine termination uses events and budget state. |
| `steeringMode` / `followUpMode` setters | Changes queue drain policy after construction. | unwired | `agent.ts` public surface | SKIP WIRING: no interactive steering and nudges must remain one-at-a-time. |
| `state.errorMessage` | Retains the last assistant turn error. | unwired | `src/lib/worker-agent/engine.ts:868-890` | KEEP VENDORED, SKIP WIRING: engine derives terminal failure from `message_end.stopReason`, preserving partial diagnostics without a second state channel. |

The engine does call the other lifecycle surface it needs: `subscribe` (`engine.ts:744`), `followUp` (`:757`), `abort` (`:706,:789`), `prompt` (`:804`), `waitForIdle` (`:805`), and `state.messages` (`:545`). Do not mistake omission from the table above for an unaudited method.

### Router knobs and timeout paths

| Item | What it does | Status | Evidence | Decision + rationale |
| --- | --- | --- | --- | --- |
| `GH_ROUTER_WORKER_MAX_TURNS` | Caps completed model turns. | wired | `src/lib/worker-agent/budget.ts:146`; `src/lib/worker-agent/engine.ts:690` | KEEP: read into `Budget`, incremented per turn, and made terminal by the stop hook. |
| `GH_ROUTER_WORKER_MAX_WALLCLOCK_MS` | Caps total run time. | wired | `src/lib/worker-agent/budget.ts:150`; `src/lib/worker-agent/engine.ts:786-791` | KEEP: resolved value is clamped to the MCP timeout ceiling and drives the abort timer. |
| `GH_ROUTER_WORKER_MAX_TOOL_BYTES` | Caps cumulative tool-result bytes. | wired | `src/lib/worker-agent/budget.ts:151`; `src/lib/worker-agent/engine.ts:662-668` | KEEP: results are counted after every tool and the next gate latches a terminal stop. |
| `GH_ROUTER_WORKER_MAX_TOOL_CALLS` | Caps total tool calls. | wired | `src/lib/worker-agent/budget.ts:155` | KEEP: checked on every `beforeToolCall` path. |
| `GH_ROUTER_WORKER_MAX_REPEATED_CALLS` | Blocks consecutive identical calls. | wired | `src/lib/worker-agent/budget.ts:159,261` | KEEP: non-terminal anti-loop guard lets the model recover. |
| `GH_ROUTER_WORKER_MODEL_CALL_TIMEOUT_MS` | Bounds each whole model turn, including SSE consumption. | wired | `src/lib/worker-agent/budget.ts:110`; `src/lib/worker-agent/engine.ts:583`; `src/lib/worker-agent/stream-fn.ts` request path | KEEP: one resolved value reaches both Responses and Chat stream paths. |
| `GH_ROUTER_WORKER_MAX_NUDGES` | Bounds in-run retries after clean empty output. | wired | `src/lib/worker-agent/engine.ts:359,372,748` | KEEP: read per run; `0` deliberately disables nudging. |
| `GH_ROUTER_WORKER_MAX_INFLIGHT` | Caps concurrent workers without queueing. | wired | `src/lib/worker-agent/semaphore.ts:27-33,52-58`; `src/lib/worker-agent/engine.ts:436` | KEEP: read once at module load and applied before any run allocation. |
| `GH_ROUTER_WORKER_MAX_RESULT_BYTES` | Spills oversized MCP results to a file with a bounded preview. | wired | `src/lib/worker-agent/relay-cap.ts:64,168`; `src/lib/peer-mcp-personas.ts:3416,3559` | KEEP: final MCP-boundary transform covers filesystem and browse worker results. |
| `GH_ROUTER_WORKER_ADVISOR_MAX_CHARS` | Caps transcript characters sent to the advisor tool. | wired | `src/lib/worker-agent/tools.ts:1789` | KEEP: applied when rendering the live transcript for advisor calls. |
| `GH_ROUTER_WORKER_DISABLE_NETWORK` | Refuses worker network-bearing tools and common network shell commands. | wired | `src/lib/worker-agent/tools.ts:153,198` | KEEP: one shared switch is checked by tool and bash gates. |
| `UPSTREAM_FETCH_TIMEOUT_MS` streaming paths | Bounds fetch-to-headers; `0` disables it for long streaming completions. | wired | `src/lib/port.ts:362-377`; `src/services/copilot/create-responses.ts:96-97`; `src/services/copilot/create-messages.ts:180-181` | KEEP: opt-out prevents truncating legitimate long reasoning streams. |
| `UPSTREAM_INACTIVITY_TIMEOUT_MS` | Bounds silence between streamed body chunks. | wired | `src/lib/port.ts:378-392`; `src/routes/responses/handler.ts:206,339`; `src/routes/chat-completions/handler.ts:211,322` | KEEP: applied to both Responses and Chat body-read loops. |
| `UPSTREAM_FETCH_TIMEOUT_MS` on `/responses/compact` | Always bounds the short non-streaming compact request. | partially wired | `src/routes/responses/handler.ts:541` | **DELIBERATE — DO NOT UNIFY:** uses `UPSTREAM_FETCH_TIMEOUT_MS || 300_000`, so `0` does not disable this path. The streaming opt-out prevents truncation; compact should never hang. An audit “consistency” fix reintroduced regression E1 and `tests/isolated/responses-compact-timeout.test.ts` caught it. General rule: an apparent inconsistency may be a prior fix; establish why before changing it. |

### Local-patch and dependency retention checklist

| Item | What it does | Status | Evidence | Decision + rationale |
| --- | --- | --- | --- | --- |
| `proxy.ts`: reader element widened to `unknown` | Reconciles Bun's `readMany` reader type with DOM `getReader()`. | wired | `src/vendor/pi/agent/proxy.ts:134-139` | KEEP LOCAL PATCH 1 of 4. |
| `proxy.ts`: `getReader()` cast through `unknown` | Makes the Bun/DOM reader conversion type-safe enough for this build. | wired | `src/vendor/pi/agent/proxy.ts:179-181` | KEEP LOCAL PATCH 2 of 4. |
| `proxy.ts`: re-narrow at `read()` | Control-flow analysis loses the widened reader's non-nullness. | wired | `src/vendor/pi/agent/proxy.ts:199-204` | KEEP LOCAL PATCH 3 of 4. |
| `proxy.ts`: `proxyEvent satisfies never` | Preserves exhaustiveness without an unused local. | wired | `src/vendor/pi/agent/proxy.ts:400-404` | KEEP LOCAL PATCH 4 of 4. |
| `agent.ts`: expose `shouldStopAfterTurn` | Routed the loop hook through `AgentOptions`. | **retired at v1.3.0** | upstream `agent.ts:114,125,209,243,482` | WITHDRAWN: upstream replaced the hook with `finishTurn` and routes it through `AgentOptions` itself, so `agent.ts` is verbatim again. The intent moved to the `finishTurn` wiring above; the shape is not interchangeable. |
| `diff`, `ignore` dependencies | Runtime imports of the vendored `agent/harness/` tree. | **removed at v1.3.0** | `package.json` dependencies | REMOVED: the harness left `packages/agent/src/` upstream, so nothing in the vendored closure imports either package. Re-add both from the pinned tag if the harness is ever vendored again. `yaml` is unaffected — `src/lib/orchestration/harness-parse.ts` uses it at runtime and it stays an exact pin. |

## Ten-step refresh protocol

1. **Clone outside the repository.** Clone `pi-mono` into a system temporary directory and check out the exact requested tag or commit. Never copy `.git`, build output, or scratch patches into this working tree.
2. **Record and compare pins.** Capture `git rev-parse HEAD`, verify it matches the intended tag, and inspect the upstream range from the currently pinned SHA.
3. **Recover local patches before overwrite.** Diff the current `src/vendor/pi/agent/proxy.ts` against that file at the old upstream pin. Do the same for `src/vendor/pi/ai/utils/diagnostics.ts`. Save the resulting divergences outside the repository.
4. **Replace agent and rebuild AI closure.** Replace `agent/` from `packages/agent/src/`, then re-apply the four `proxy.ts` patches and restore the `index.ts` header. Recreate `ai/` by following imports from the new agent tree and `src/lib/worker-agent/` until closed. Re-apply the provider-option aliases, diagnostics stub, and rewritten index. Do not carry obsolete files forward merely because they existed at the prior pin, and withdraw any local patch upstream has since adopted.
5. **Audit upstream runtime dependencies, both directions.** Every bare specifier imported by the new closure MUST be an explicit entry in our own `dependencies` — a package that resolves only transitively (through a devDependency, say) works locally and breaks a production install. Pin Pi's dependencies EXACTLY at upstream's version, matching the existing `partial-json` / `typebox` entries; carets are for this repo's own dependencies, not vendored ones. Conversely, an entry that only the departed tree needed must be removed: `knip` reports both directions, and `diff` / `ignore` were retired this way at v1.3.0.
6. **Re-derive the consumer contract before the wiring table.** Read `StreamFn`'s signature and the `AgentOptions` shape at the new pin and check them against `src/lib/worker-agent/stream-fn.ts` and `engine.ts` by hand. A contravariantly-assignable parameter type will NOT produce a compile error; see “Consumer-facing contract changes”.
7. **Update documentation.** Update PROVENANCE.md and this document with the exact tag, full SHA, date, final closure, files added/dropped, and every divergence. Never call `agent/` verbatim while `proxy.ts` differs.
8. **Re-derive the configuration surface.** Re-derive the `AgentOptions` / `AgentLoopConfig` / `Agent`-method surface from the new pin and diff it against the wiring table. Any field added, removed or renamed upstream is an explicit accept/reject decision recorded in the table BEFORE the PR — never a silent default.
9. **Run the focused gate, then the wider suite.** Run typecheck, lint, the complete focused worker/Pi contract suite, build, then `bun test` and compare pass/fail counts with the old pin. A failing constructor-option or runtime execution-mode assertion is an upgrade finding; diagnose it rather than weakening or skipping the test. CI runs isolated tests separately, so report exclusions and any environmental failure accurately.
10. **Audit and clean up.** Diff the vendor tree against the exact upstream tag, permitting only documented divergences and the deliberate AI slice. Remove the temporary clone. Confirm git status contains no temporary or generated artifact before review/PR.

## Verification commands

```bash
bun run typecheck
bun run lint:all
bun test tests/worker-tool-matrix.test.ts tests/worker-pi-contract.test.ts tests/worker-agent-context-mgmt.test.ts tests/worker-agent-engine.test.ts tests/worker-agent-browse-mode.test.ts tests/worker-agent-g1-invariant.test.ts tests/worker-agent-backstop.test.ts tests/worker-agent-tools.test.ts tests/worker-agent-browse-tools.test.ts tests/worker-agent-stream-fn.test.ts tests/worker-agent-responses-payload-golden.test.ts
bun run build
bun test
```

## License

Upstream Pi is MIT licensed. Preserve [`src/vendor/pi/LICENSE`](../src/vendor/pi/LICENSE) and its copyright. A future upstream license change requires explicit review rather than an automatic sync.
