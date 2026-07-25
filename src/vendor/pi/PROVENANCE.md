# Pi vendor provenance

This tree vendors the Pi agent runtime and the minimal Pi AI dependency closure needed by github-router's Copilot-backed worker agents. Concrete provider implementations and their SDK dependencies remain excluded.

## Upstream

- Repository: <https://github.com/earendil-works/pi-mono>
- Tag: `v0.82.0`
- Commit pinned: `083e61621276bff9f6faefab87ce07fcd98734e2` (`Release v0.82.0`, 2026-07-24)
- Imported:
  - `packages/agent/src/` → `src/vendor/pi/agent/`, with the `proxy.ts` patches and `agent.ts` hook exposure below
  - selected transitive closure from `packages/ai/src/` → `src/vendor/pi/ai/`
- License: MIT, preserved in `./LICENSE`.

## Slice

Path aliases in `tsconfig.json` route `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` imports into this tree.

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
| `utils/retry.ts` | verbatim | Retry contracts/helpers used by the harness. |
| `utils/text.ts` | verbatim | Content text helpers used by compaction. |
| `utils/uuid.ts` | verbatim | UUIDv7 used by agent/session code. |
| `utils/provider-env.ts` | verbatim | Provider environment lookup. |
| `utils/diagnostics.ts` | patched stub | Preserves the diagnostic type boundary without provider-side diagnostic helpers; the custom stream never emits diagnostics. |
| `index.ts` | rewritten | Re-exports exactly this closure plus TypeBox primitives. |

`stream.ts`, `api-registry.ts`, and `models.generated.ts` no longer exist in upstream v0.82.0's required closure and are not vendored. Provider APIs, images, CLI, OAuth, and concrete provider implementations remain excluded.

## Intentional divergences

### `agent/proxy.ts`

Three recovered local patches must be re-applied after every full agent-directory replacement:

1. Widen `reader` from `ReadableStreamDefaultReader<Uint8Array>` to `ReadableStreamDefaultReader<unknown>` because Bun's reader typing requires `readMany` while the DOM `getReader()` type does not expose it.
2. Cast `response.body!.getReader()` through `unknown`, then narrow to `ReadableStreamDefaultReader<Uint8Array>` at `read()`. This is type-only and leaves runtime behavior unchanged.
3. Replace the unused `const _exhaustiveCheck: never = proxyEvent` binding with `proxyEvent satisfies never` for this repo's `noUnusedLocals` setting.

### `agent/agent.ts`

Expose the low-level `shouldStopAfterTurn` hook through `AgentOptions` and pass it through `Agent.createLoopConfig`. github-router uses this graceful post-turn stop to make hard worker budget caps terminal before another provider call. Upstream v0.82.0 exposes the hook only on `AgentLoopConfig`, so this minimal local patch must be re-applied after every agent-directory replacement.

### `ai/types.ts`

The ten concrete option types (`AnthropicOptions`, `AzureOpenAIResponsesOptions`, `BedrockOptions`, `GoogleOptions`, `GoogleVertexOptions`, `MistralOptions`, `OpenAICodexResponsesOptions`, `OpenAICompletionsOptions`, `OpenAIResponsesOptions`, and `PiMessagesOptions`) are type-only `Record<string, unknown>` aliases. Copying their upstream modules would pull concrete provider SDKs into the vendor closure.

### `ai/utils/diagnostics.ts`

A type-only diagnostic stub is retained instead of upstream's provider-side helper implementation. github-router's custom stream function does not populate diagnostics.

### `ai/index.ts`

The index is rewritten to export only the retained closure and TypeBox primitives.

## Sync protocol

1. Clone upstream into a temporary directory outside this repository and check out the exact target tag or commit.
2. Record the target SHA and diff the currently vendored `agent/proxy.ts` and `ai/utils/diagnostics.ts` against the previously pinned upstream commit before overwriting anything.
3. Replace `src/vendor/pi/agent/` completely from `packages/agent/src/`, then re-apply all three documented `proxy.ts` patches and the minimal `agent.ts` `shouldStopAfterTurn` exposure.
4. Rebuild `src/vendor/pi/ai/` from the transitive import closure required by the new agent tree and `src/lib/worker-agent/`. Re-apply the option-type aliases in `types.ts`, retain the diagnostics stub, and rewrite `index.ts` for the resulting closure. Do not assume the previous file list still closes.
5. Update this provenance record and `docs/pi-vendor-sync.md` with the tag, full SHA, date, closure, and divergences.
6. Run `bun run typecheck`, `bun run lint:all`, the focused worker suite, and `bun run build`.
7. Run the wider `bun test` suite and investigate any delta. Never weaken Pi contract tests to accommodate an upgrade.
8. Review the vendor diff against the exact upstream tag, confirm no temporary clone or generated artifact entered the repository, and include the upstream comparison range in the PR.

## Why vendor

Installing the full unified-provider Pi AI package pulls large provider SDKs that github-router never invokes. The worker loop always routes model traffic through the proxy's custom Copilot stream function, so retaining only the closed dependency slice preserves Pi's agent semantics without provider initialization, auth, telemetry, or dependency footprint.
