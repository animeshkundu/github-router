// VENDOR INDEX (github-router): trimmed slice of upstream pi-ai's `index.ts`.
//
// What we keep:
// - All types from `./types.ts` (Message, AssistantMessage, Tool, Model, …) —
//   pi-agent-core's public surface re-exports them and our worker code consumes
//   them via the `@earendil-works/pi-ai` alias.
// - The `stream.ts` dispatch helpers (`streamSimple`, `completeSimple`,
//   `stream`, `complete`, `getEnvApiKey`) — pi-agent-core imports them as
//   runtime fallbacks when no custom `streamFn` is supplied. We always supply
//   one, so the registry-resolution path is dead code; we keep the exports so
//   upstream Pi code referencing them resolves through the alias.
// - The `api-registry.ts` surface (`registerApiProvider`, `getApiProvider`, …)
//   in case a future caller wants to plug a real provider in.
// - `models.ts` helpers (`clampThinkingLevel`, `getModel`, `getModels`,
//   `calculateCost`, `modelsAreEqual`, `getSupportedThinkingLevels`) — the
//   static catalog is stubbed (see `models.generated.ts`), so registry-backed
//   calls return undefined, but the helpers themselves are pure utilities the
//   worker layer may use.
// - `env-api-keys.ts` helpers — small, no extra deps.
// - The streaming primitives `EventStream` / `AssistantMessageEventStream`,
//   `parseStreamingJson`, and `validateToolArguments` — pi-agent-core's
//   `agent.ts` / `agent-loop.ts` / `proxy.ts` import them as runtime values.
// - `typebox` re-exports (`Static`, `TSchema`, `Type`) so callers of upstream
//   pi-ai don't need to depend on typebox directly.
//
// What we drop:
// - `./providers/*` (anthropic / google / openai / mistral / bedrock / …) — the
//   load-bearing reason we vendor in the first place. Pulling them in would
//   add @anthropic-ai/sdk, @google/genai, openai, @aws-sdk/client-bedrock-runtime,
//   and @mistralai/mistralai as runtime deps; we route via Copilot only.
// - `./images*`, `./session-resources.ts` — only used by image and session
//   features the worker tools don't touch.
// - `./utils/diagnostics.ts`, `./utils/overflow.ts`, `./utils/typebox-helpers.ts`,
//   and the `oauth/*` tree — they're either provider-coupled or part of the
//   pi-ai CLI surface; the worker doesn't need them.
//
// See `../PROVENANCE.md` for the upstream commit hash this slice was lifted
// from and the sync protocol for future bumps.

export type { Static, TSchema } from "typebox";
export { Type } from "typebox";

export * from "./api-registry.ts";
export * from "./env-api-keys.ts";
export * from "./models.ts";
export * from "./stream.ts";
export * from "./types.ts";
export * from "./utils/event-stream.ts";
export * from "./utils/json-parse.ts";
export * from "./utils/validation.ts";
