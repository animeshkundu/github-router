# Pi vendor provenance

This tree is a verbatim copy (with the minimal trims documented below) of the
[`pi-mono`](https://github.com/earendil-works/pi-mono) monorepo, lifted into
github-router so the worker-tools surface can drive a Pi agent without pulling
the upstream npm packages (which would bring `@anthropic-ai/sdk`,
`@google/genai`, `openai`, `@aws-sdk/client-bedrock-runtime`, and friends as
runtime dependencies). All worker LLM traffic flows through this proxy's
existing Copilot route via a custom `streamFn`.

## Upstream

- Repository: <https://github.com/earendil-works/pi-mono>
- Commit pinned: `fc51a40d02256e892053f7edd0810bd1f0325b0b`
  (`Merge pull request #4922 from earendil-works/horrifying-terminal-hack`,
  2026-05-23)
- Subtrees imported:
  - `packages/agent/src/` → `src/vendor/pi/agent/` (verbatim, no edits)
  - selected files from `packages/ai/src/` → `src/vendor/pi/ai/` (see "Slice"
    below)
- License: MIT — see `./LICENSE` (copied verbatim from upstream, copyright
  preserved).

## Slice

`@earendil-works/pi-agent-core` (`packages/agent/src/`) is vendored verbatim,
files unchanged. Path aliases in `tsconfig.json` route the
`@earendil-works/pi-agent-core` and `@earendil-works/pi-agent-core/*` specifiers
into this copy so upstream-shaped imports keep working.

`@earendil-works/pi-ai` (`packages/ai/src/`) is vendored as a **minimal slice**.
We only keep the pieces pi-agent-core touches at runtime plus the public
typings:

| File                                | Status   | Notes |
| ----------------------------------- | -------- | ----- |
| `api-registry.ts`                   | verbatim | Registry surface only; nothing pre-registers. |
| `env-api-keys.ts`                   | verbatim | Lightweight env-var helpers. |
| `models.ts`                         | verbatim | Pure helpers (`clampThinkingLevel`, etc.). |
| `models.generated.ts`               | **stub** | Replaced with `export const MODELS = {} as Record<string, Record<string, Model<Api>>>`. The upstream file is the 16k-line auto-generated catalog; the worker resolves models against `state.models?.data` from Copilot's live catalog instead, so the static registry stays empty. To restore, copy `packages/ai/src/models.generated.ts` from the pinned commit verbatim. |
| `stream.ts`                         | **trimmed** | Identical to upstream **except** the top-of-file side-effect import `import "./providers/register-builtins.ts";` is removed. That import eagerly instantiates every provider (Anthropic, Google, OpenAI, Bedrock, Mistral, …) and would re-introduce the SDK deps we vendored to avoid. We always supply a custom `streamFn` to `Agent`, so the registry path is dead code. |
| `types.ts`                          | verbatim | Public surface (`Message`, `Tool`, `Model`, `Usage`, …). |
| `utils/event-stream.ts`             | verbatim | `EventStream` + `AssistantMessageEventStream`. |
| `utils/json-parse.ts`               | verbatim | `parseStreamingJson` (consumed by `proxy.ts`). |
| `utils/validation.ts`               | verbatim | `validateToolArguments` (consumed by `agent-loop.ts`). |
| `index.ts`                          | **rewritten** | Re-exports only the slice above plus typebox primitives. See file-top comment for the per-section rationale. |

What we explicitly **drop**:

- `providers/*` — anthropic, google, google-vertex, openai-completions,
  openai-responses, openai-codex-responses, azure-openai-responses,
  amazon-bedrock, mistral, cloudflare, faux, register-builtins, transform-messages,
  google-shared, openai-prompt-cache, openai-responses-shared, simple-options,
  github-copilot-headers, and the `images/*` subtree. Each pulls a vendor SDK
  the proxy doesn't need.
- `bedrock-provider.ts`, `cli.ts`, `images.ts`, `image-models.ts`,
  `image-models.generated.ts`, `images-api-registry.ts`, `session-resources.ts`,
  `oauth.ts`, and the `utils/oauth/*` tree.
- `utils/diagnostics.ts`, `utils/headers.ts`, `utils/hash.ts`,
  `utils/node-http-proxy.ts`, `utils/overflow.ts`, `utils/sanitize-unicode.ts`,
  `utils/typebox-helpers.ts` — provider-coupled diagnostics or CLI helpers.

## Sync protocol

When bumping Pi:

1. Re-clone (or `git pull`) `pi-mono` into a scratch dir, e.g.
   `/tmp/pi-mono-bump`.
2. Capture the new SHA: `git -C /tmp/pi-mono-bump rev-parse HEAD`.
3. Regenerate `src/vendor/pi/agent/` by copying
   `packages/agent/src/` verbatim (e.g. via `cp -R`).
4. Regenerate `src/vendor/pi/ai/` by re-copying each row in the "Slice" table
   above. Re-apply the `stream.ts` provider-import trim and re-stub
   `models.generated.ts` (keep the comment header pointing back here).
5. Update `Commit pinned` above to the new SHA and bump any commit-context
   notes.
6. Run the project gate: `bun run typecheck && bun test`. The worker-agent
   test suite (`tests/worker-agent/**`) exercises pi-agent-core's surface
   end-to-end, so any upstream breaking change will surface here.
7. Commit with `vendor: bump pi-mono to <short-sha>` and link the upstream
   diff in the body.

## Why vendor (not depend on npm)?

The user-facing reason: `@earendil-works/pi-ai` is a unified-LLM-API library;
installing it pulls in five vendor SDKs (~80MB unpacked) the proxy never uses
because we route every request through Copilot. Vendoring the small slice we
actually need keeps the proxy's install footprint and bundle clean.

The architectural reason: github-router's worker tools want pi-agent-core's
loop semantics (events, hooks, tool execution modes, abort plumbing) without
inheriting the provider registry's failure modes (SDK initialization warnings,
unfamiliar telemetry, surprise environment-variable lookups). The vendored copy
ships only what the loop actually executes.
