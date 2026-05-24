# Pi vendor sync protocol

This doc covers the operational rules for keeping `src/vendor/pi/` in sync with upstream `pi-mono`. The verbatim provenance record (commit SHA, per-file status table, what's dropped and why) lives at [`src/vendor/pi/PROVENANCE.md`](../src/vendor/pi/PROVENANCE.md); this doc is the design-doc-style "how and when" wrapper around it.

## What lives in `src/vendor/pi/`

The [Pi agent runtime](https://github.com/earendil-works/pi-mono) backs the `worker_explore` and `worker_implement` MCP tools (see [`peer-mcp-design.md`](peer-mcp-design.md) "Worker tools"). Two slices:

| Subtree | Upstream source | Slice rule |
| --- | --- | --- |
| `src/vendor/pi/agent/` | `pi-mono/packages/agent/src/` | **Verbatim, full copy.** Bumping = full directory replace. |
| `src/vendor/pi/ai/` | `pi-mono/packages/ai/src/` | **Minimal slice** — only the files pi-agent-core touches at runtime plus the public typings. See PROVENANCE.md's "Slice" table. |

Path aliases in `tsconfig.json` route the `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` specifiers (used by upstream-shaped imports) into the vendored tree so the runtime never reaches into `node_modules` for these.

## Why vendor (not depend on npm)?

Two reasons.

1. **Install footprint.** `@earendil-works/pi-ai` is a unified-LLM-API library; installing it pulls in `@anthropic-ai/sdk`, `@google/genai`, `openai`, `@aws-sdk/client-bedrock-runtime`, and a Mistral SDK — ~80 MB unpacked of vendor SDKs that the proxy never invokes. Every worker LLM call goes through Copilot via the existing `createMessages` / `createResponses` paths via a custom `streamFn` we hand to Pi's `Agent` constructor.
2. **Failure-mode containment.** We want pi-agent-core's loop semantics — events, `beforeToolCall` / `afterToolCall` / `prepareNextTurn` hooks, parallel-vs-sequential tool execution, abort plumbing, validated tool params — without inheriting the provider registry's surprises (SDK initialization warnings on first use, unfamiliar telemetry, surprise environment-variable lookups). The vendored copy ships only what the loop actually executes.

## What's deliberately omitted

PROVENANCE.md has the complete drop list. The headline categories:

- **`packages/ai/src/providers/*`** — Every concrete provider (Anthropic, Google, Vertex, OpenAI Chat/Responses/Codex, Azure, Bedrock, Mistral, Cloudflare, faux) is dropped, including `register-builtins.ts` (the eager-registration side-effect module). Re-adding any of these would re-introduce the SDK deps we vendored to avoid.
- **CLI / image / OAuth infrastructure** — `cli.ts`, `bedrock-provider.ts`, `images.ts`, `image-models*.ts`, `images-api-registry.ts`, `oauth.ts`, `utils/oauth/*`, `session-resources.ts`. The worker tools are server-side and use the proxy's auth, not Pi's OAuth.
- **Provider-coupled utilities** — `utils/diagnostics.ts`, `utils/headers.ts`, `utils/hash.ts`, `utils/node-http-proxy.ts`, `utils/overflow.ts`, `utils/sanitize-unicode.ts`, `utils/typebox-helpers.ts`.

## What's deliberately modified

Two files diverge from upstream verbatim — these are the only spots a refresh **must** re-apply, and the only spots a future bisect against upstream needs to know about:

| File | Modification | Why |
| --- | --- | --- |
| `src/vendor/pi/ai/stream.ts` | Top-of-file `import "./providers/register-builtins.ts";` removed. | The import is a side-effect-only eager registration of every provider. Without it, the registry stays empty — fine, because we always supply our own `streamFn` to `Agent`. With it, every provider SDK we dropped becomes a missing-module error at boot. |
| `src/vendor/pi/ai/models.generated.ts` | Replaced with `export const MODELS = {} as Record<string, Record<string, Model<Api>>>` (single line). | Upstream is a 16k-line auto-generated catalog of every model on every provider. The worker resolves models against Copilot's live catalog (`state.models?.data`) instead, so the static registry is dead code; keeping the stub means tsc still type-checks the unused `MODELS` references in untouched upstream code. |

Every modified file carries a comment header pointing back at this doc + PROVENANCE.md so a future contributor running `diff` against upstream knows the divergence is intentional.

## Sync protocol

When bumping Pi:

1. **Re-clone (or `git pull`)** `pi-mono` into a scratch dir, e.g. `/tmp/pi-mono-bump`. The current pinned SHA is in PROVENANCE.md — diff your scratch HEAD against it (`git -C /tmp/pi-mono-bump log <pinned-sha>..HEAD --oneline`) to scope the bump.
2. **Capture the new SHA**: `git -C /tmp/pi-mono-bump rev-parse HEAD`.
3. **Regenerate `src/vendor/pi/agent/`** by copying `packages/agent/src/` verbatim (`rm -rf src/vendor/pi/agent && cp -R /tmp/pi-mono-bump/packages/agent/src src/vendor/pi/agent`).
4. **Regenerate `src/vendor/pi/ai/`** by re-copying each row from PROVENANCE.md's "Slice" table. Re-apply the `stream.ts` provider-import trim and re-stub `models.generated.ts`. The trim and stub are the most-likely-to-be-forgotten steps in a hurried bump — every CI run that fails with "Cannot find module '../providers/register-builtins'" or "MODELS is not iterable" traces back to skipping one of these two.
5. **Update PROVENANCE.md's `Commit pinned` line** to the new SHA, with the new commit's title and date for orientation.
6. **Project gate**: `bun run typecheck && bun run lint:all && bun run build && bun test` — all four must be GREEN. The worker-agent test suite under `tests/worker-agent-*.test.ts` exercises pi-agent-core's surface end-to-end (foundations, lifecycle, bash, worktree, stream-fn) so any upstream breaking change to a touched type surfaces here.
7. **Commit** with `vendor: bump pi-mono to <short-sha>` in the title. The body should link the upstream commit-range diff (`https://github.com/earendil-works/pi-mono/compare/<old-sha>...<new-sha>`) and call out any breaking changes you had to adapt for in the proxy's worker-agent integration (the `streamFn` signature, the hook context shapes, the tool-execution-mode enum, etc.).
8. **Open a PR** that explicitly names the new SHA in the title. Cross-lab reviewers (codex / gemini / opus critics) catch a sync that silently drops the `stream.ts` trim — make the diff easy for them to verify.

## What's NOT in scope for a sync

- **The proxy-side adapter (`src/lib/worker-agent/*`)** is NOT a vendor. It's our code, written against Pi's stable interfaces (`Agent` constructor, `streamFn` signature, `AgentTool<TParameters, TDetails>` contract, the `BeforeToolCallContext` / `AfterToolCallContext` / `PrepareNextTurnContext` types). A Pi bump CAN require changes here when upstream evolves the interface, but those changes are part of the bump PR, not a sync step.
- **Copilot-side translation (`src/lib/worker-agent/stream-fn.ts`)** is also NOT a vendor. It translates Copilot's SSE event format into Pi's `AssistantMessageEventStream` and is owned by this repo. A Pi bump that changes the assistant-stream event vocabulary will require updating this file; that's a code change, not a vendor sync.

## Attribution & license

Upstream `pi-mono` is MIT. The license is preserved verbatim at [`src/vendor/pi/LICENSE`](../src/vendor/pi/LICENSE) (copyright Mario Zechner, 2025) and every vendored file carries an attribution header. **Do not strip these.** A vendor bump preserves the LICENSE file unchanged; if upstream ever re-licenses, that change MUST be discussed in the bump PR (potentially a fork rather than a sync).
