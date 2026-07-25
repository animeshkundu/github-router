# Pi vendor sync protocol

This document is the operational guide for refreshing `src/vendor/pi/`. The exact pin, closure, and per-file divergences live in [`src/vendor/pi/PROVENANCE.md`](../src/vendor/pi/PROVENANCE.md).

## Current shape

The Pi runtime backs github-router's worker agents. Two upstream slices are retained:

| Subtree | Upstream source | Rule |
| --- | --- | --- |
| `src/vendor/pi/agent/` | `packages/agent/src/` | Full directory replacement, followed by the three documented `proxy.ts` type-check patches. It is not verbatim. |
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
| `ai/types.ts` | Replace the ten concrete provider-option imports with type-only `Record<string, unknown>` aliases so their SDK-bearing modules are not copied. Keep the rest of the file verbatim. |
| `ai/utils/diagnostics.ts` | Keep the shallow type stub used at the `AssistantMessage.diagnostics` boundary; the custom stream never emits provider diagnostics. |
| `ai/index.ts` | Re-export only the closed slice plus TypeBox primitives. |

The `proxy.ts` patches are especially easy to lose because `agent/` otherwise arrives via a full directory copy. Recover them from the old pin before deleting the directory.

## Eight-step refresh protocol

1. **Clone outside the repository.** Clone `pi-mono` into a system temporary directory and check out the exact requested tag or commit. Never copy `.git`, build output, or scratch patches into this working tree.
2. **Record and compare pins.** Capture `git rev-parse HEAD`, verify it matches the intended tag, and inspect the upstream range from the currently pinned SHA.
3. **Recover local patches before overwrite.** Diff the current `src/vendor/pi/agent/proxy.ts` against that file at the old upstream pin. Do the same for `src/vendor/pi/ai/utils/diagnostics.ts`. Save the resulting divergences outside the repository.
4. **Replace agent and rebuild AI closure.** Replace `agent/` from `packages/agent/src/`, then re-apply the three `proxy.ts` patches. Recreate `ai/` by following imports from the new agent tree and `src/lib/worker-agent/` until closed. Re-apply the provider-option aliases, diagnostics stub, and rewritten index. Do not carry obsolete files forward merely because they existed at the prior pin.
5. **Update documentation.** Update PROVENANCE.md and this document with the exact tag, full SHA, date, final closure, files added/dropped, and every divergence. Never call `agent/` verbatim while `proxy.ts` differs.
6. **Run the focused gate.** Run typecheck, lint, the complete focused worker/Pi contract suite, and build. A failing constructor-option or runtime execution-mode assertion is an upgrade finding; diagnose it rather than weakening or skipping the test.
7. **Run the wider suite.** Run `bun test` and compare pass/fail counts with the old pin. CI runs isolated tests separately, so report exclusions and any environmental failure accurately.
8. **Audit and clean up.** Diff the vendor tree against the exact upstream tag, permitting only documented divergences and the deliberate AI slice. Remove the temporary clone. Confirm git status contains no temporary or generated artifact before review/PR.

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
