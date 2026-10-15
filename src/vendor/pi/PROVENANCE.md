# Pi vendor provenance

This tree vendors the Pi agent runtime and the minimal Pi AI dependency closure needed by github-router's Copilot-backed worker agents. Concrete provider implementations and their SDK dependencies remain excluded.

## Upstream

- Repository: <https://github.com/earendil-works/pi-mono>
- Tag: `v1.3.0`
- Commit pinned: `71023aec1546d6d677a65669c5665c0927ce0dd0` (`Release v1.3.0`, 2026-10-15)
- Imported:
  - `packages/agent/src/` → `src/vendor/pi/agent/`, six files, with the `proxy.ts` type patches and the index header below
  - selected transitive closure from `packages/ai/src/` → `src/vendor/pi/ai/`
- License: MIT, preserved in `./LICENSE`.

## Slice

Path aliases in `tsconfig.json` route `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` imports into this tree.

At v1.3.0 `packages/agent/src/` is exactly `agent.ts`, `agent-loop.ts`, `index.ts`, `proxy.ts`, `stream-fn.ts`, `types.ts`. Five of the six are byte-identical upstream; only `proxy.ts` carries runtime-neutral type patches and only `index.ts` carries a comment header.

The agent package's own `dependencies` at v1.3.0 are two entries: `@earendil-works/pi-ai@1.3.0` (satisfied by the alias into this tree) and `typebox@1.3.27`. No import in the vendored agent files reaches any other package.

The AI closure is:

| File | Status | Purpose |
| --- | --- | --- |
| `types.ts` | patched | Public types; ten concrete provider option imports are local `Record<string, unknown>` aliases to avoid provider SDK dependencies. |
| `models.ts` | verbatim | Model resolution and thinking helpers. |
| `models-store.ts` | verbatim | In-memory model-store interfaces and implementation. |
| `env-api-keys.ts` | verbatim | Provider environment helpers. |
| `api/lazy.ts` | verbatim | Lazy stream adapter used by `models.ts`. |
| `auth/types.ts` | verbatim | Auth contracts. |
| `auth/context.ts` | verbatim | Default auth context. |
| `auth/credential-store.ts` | verbatim | In-memory credentials. |
| `auth/resolve.ts` | verbatim | Provider auth resolution used by `models.ts`. |
| `utils/event-stream.ts` | verbatim | Agent event stream. |
| `utils/json-parse.ts` | verbatim | Streaming JSON parser used by `proxy.ts`. |
| `utils/validation.ts` | verbatim | Tool argument validation. |
| `utils/retry.ts` | verbatim | Retry contracts/helpers. |
| `utils/text.ts` | verbatim | Content text helpers; gained the system-message helpers at v1.3.0. |
| `utils/transcript.ts` | verbatim | NEW at v1.3.0: `normalizeContext`, the `TranscriptContext` factory, and the current-prompt/tool replay helpers the vendored agent loop is built on. |
| `utils/uuid.ts` | verbatim | UUIDv7 used by agent/session code. |
| `utils/provider-env.ts` | verbatim | Provider environment lookup. |
| `utils/diagnostics.ts` | patched stub | Preserves the diagnostic type boundary without provider-side diagnostic helpers; the custom stream never emits diagnostics. |
| `index.ts` | rewritten | Re-exports exactly this closure plus TypeBox primitives. |

`stream.ts`, `api-registry.ts`, and `models.generated.ts` are not in the closure and are not vendored. Provider APIs, images, CLI, OAuth, and concrete provider implementations remain excluded.

## Intentional divergences

### `agent/proxy.ts`

Four recovered local patches must be re-applied after every full agent-directory replacement. All are type-only and leave runtime behavior unchanged:

1. Widen `reader` from `ReadableStreamDefaultReader<Uint8Array>` to `ReadableStreamDefaultReader<unknown>` because Bun's reader typing requires `readMany` while the DOM `getReader()` type does not expose it.
2. Cast `response.body!.getReader()` through `unknown` to reach the widened type.
3. Re-narrow with `as ReadableStreamDefaultReader<Uint8Array>` at `read()` because control-flow analysis loses the widened reader's non-nullness.
4. Replace the unused `const _exhaustiveCheck: never = proxyEvent` binding with `proxyEvent satisfies never` for this repo's `noUnusedLocals` setting.

### `agent/index.ts`

A comment header is prepended to the upstream file. The exports below it are upstream's own and unchanged — at v1.3.0 the agent package no longer contains the `harness/` subtree or `node.ts` (upstream moved them to `packages/durable/src/harness` and `packages/chord/src/node.ts`), so the slice this repo vendors is exactly the upstream package.

### `ai/types.ts`

The ten concrete option types (`AnthropicOptions`, `AzureOpenAIResponsesOptions`, `BedrockOptions`, `GoogleOptions`, `GoogleVertexOptions`, `MistralOptions`, `OpenAICodexResponsesOptions`, `OpenAICompletionsOptions`, `OpenAIResponsesOptions`, and `PiMessagesOptions`) are type-only `Record<string, unknown>` aliases. Copying their upstream modules would pull concrete provider SDKs into the vendor closure.

### `ai/utils/diagnostics.ts`

A type-only diagnostic stub is retained instead of upstream's provider-side helper implementation. github-router's custom stream function does not populate diagnostics.

### `ai/index.ts`

The index is rewritten to export only the retained closure and TypeBox primitives.

### Retired divergences

- **`agent/agent.ts` `shouldStopAfterTurn` exposure (removed at v1.3.0).** Upstream replaced the `shouldStopAfterTurn: () => boolean` hook with `finishTurn: (turn) => { action: "continue" | "end" } | undefined` and now routes it through `AgentOptions` natively (`agent.ts:125,209,243,482`), so the local patch that routed it there is gone and `agent.ts` is byte-identical upstream. The worker's hard-budget stop is unchanged in intent and is wired to `finishTurn` in `src/lib/worker-agent/engine.ts`; `docs/pi-vendor-sync.md` records the accept decision. **The two hooks are not interchangeable:** `{action:"continue"}` FORCES one extra provider request, whereas the old `false` only declined to stop.
- **`diff` and `ignore` dependencies (removed at v1.3.0).** Earlier pins vendored `agent/harness/`, whose `tools/edit-diff.ts`, `prompt-templates.ts`, and `skills.ts` import those packages at runtime. The harness is no longer part of the agent package, so both entries were retired from `package.json`. Re-add them from the pinned tag if the harness is ever vendored again.

## Sync protocol

1. Clone upstream into a temporary directory outside this repository and check out the exact target tag or commit.
2. Record the target SHA and diff the currently vendored `agent/proxy.ts` and `ai/utils/diagnostics.ts` against the previously pinned upstream commit before overwriting anything.
3. Replace `src/vendor/pi/agent/` completely from `packages/agent/src/`, then re-apply the four documented `proxy.ts` patches and restore the `index.ts` comment header. Check whether a patch has become unnecessary — a local divergence that upstream has adopted must be withdrawn, not carried forward.
4. Rebuild `src/vendor/pi/ai/` from the transitive import closure required by the new agent tree and `src/lib/worker-agent/`. Re-apply the option-type aliases in `types.ts`, retain the diagnostics stub, and rewrite `index.ts` for the resulting closure. Do not assume the previous file list still closes.
5. Diff the new agent tree's `packages/agent/package.json` dependencies against ours. Every bare specifier the closure imports MUST be an explicit entry in our `dependencies`, and an entry that only the departed tree needed MUST be removed.
6. Update this provenance record and `docs/pi-vendor-sync.md` with the tag, full SHA, date, closure, and divergences.
7. Run `bun run typecheck`, `bun run lint:all`, the focused worker suite, and `bun run build`.
8. Run the wider `bun test` suite and investigate any delta. Never weaken Pi contract tests to accommodate an upgrade.
9. Review the vendor diff against the exact upstream tag, confirm no temporary clone or generated artifact entered the repository, and include the upstream comparison range in the PR.

## Why vendor

Installing the full unified-provider Pi AI package pulls large provider SDKs that github-router never invokes. The worker loop always routes model traffic through the proxy's custom Copilot stream function, so retaining only the closed dependency slice preserves Pi's agent semantics without provider initialization, auth, telemetry, or dependency footprint.
