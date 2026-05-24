// VENDOR STUB (github-router): the upstream `models.generated.ts` is a 16k-line
// auto-generated catalog (Anthropic / Google / OpenAI / Bedrock / etc.) used by
// `models.ts` to seed `getModel` / `getModels`. We drive Copilot via a custom
// `streamFn` and resolve models against the live Copilot catalog
// (`state.models.data`) in our own code, so the static catalog is unused.
//
// Keeping the export shape lets `models.ts` typecheck and run; the registry
// just starts empty. Any caller asking `getModel("openai", "gpt-5")` against
// the vendored slice will receive `undefined` — by design.
//
// To restore the full catalog, copy `packages/ai/src/models.generated.ts`
// verbatim from the upstream Pi checkout recorded in `../PROVENANCE.md`.

import type { Api, Model } from "./types.ts";

export const MODELS: Record<string, Record<string, Model<Api>>> = {};
