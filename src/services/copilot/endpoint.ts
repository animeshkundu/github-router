import { state } from "~/lib/state"

import type { Model } from "./get-models"

/**
 * Which Copilot endpoint a model is driven through. The proxy has two
 * tool-calling clients: `createChatCompletions` (`/chat/completions`) and
 * `createResponses` (`/responses`). A model serves one or both.
 */
export type CopilotEndpoint = "chat" | "responses"

/**
 * Catalog spellings that mean each of our two clients. Copilot is not
 * self-consistent about the `/v1` prefix — the live catalog advertises
 * `/v1/messages` prefixed but `/chat/completions` bare, and this repo's own
 * fixtures carry both forms — so an exact-match on the bare spelling alone
 * silently misses a real shape. `src/lib/model-validation.ts` already
 * normalizes the same way (`ENDPOINT_ALIASES`); this keeps the two agreeing.
 *
 * Matching is EXACT against this set, never a suffix/`includes` test: a
 * `ws:/responses` (websocket transport) entry is NOT the `/responses` HTTP
 * client and must keep resolving to "serves neither".
 */
const CHAT_ENDPOINTS: ReadonlySet<string> = new Set([
  "/chat/completions",
  "/v1/chat/completions",
])
const RESPONSES_ENDPOINTS: ReadonlySet<string> = new Set([
  "/responses",
  "/v1/responses",
])

/**
 * Decide which endpoint to call for a model from its catalog
 * `supported_endpoints`. Prefers `/chat/completions` when available (the
 * simpler, more widely-supported shape) and falls back to `/responses` for
 * models that ONLY serve the Responses API — the gpt-5.x family except
 * `gpt-5-mini` / `gpt-5.4` (e.g. `gpt-5.4-mini`, `gpt-5.5`, the
 * `*-codex` models). Returns undefined when the model serves neither, so a
 * caller can skip it rather than 400 on `unsupported_api_for_model`.
 *
 * A model that OMITS `supported_endpoints` is treated as chat-eligible: the
 * catalog historically omits the field for chat-default models, and
 * excluding those would be a worse regression than the gap this guards.
 */
export function pickEndpoint(model: Model): CopilotEndpoint | undefined {
  const eps = model.supported_endpoints
  if (!eps || eps.length === 0) return "chat"
  if (eps.some((e) => CHAT_ENDPOINTS.has(e))) return "chat"
  if (eps.some((e) => RESPONSES_ENDPOINTS.has(e))) return "responses"
  return undefined
}

/**
 * The three genuinely different answers to "which client drives this model id".
 *
 * - `endpoint` — the model resolves to one of our two clients.
 * - `unknown-model` — the id isn't in the live catalog. NOT an error: the
 *   catalog may not be populated yet, and an id we've never seen is chat-shaped
 *   by convention (same rule as a model that omits `supported_endpoints`). A
 *   caller that just needs something to call should default to "chat" here.
 * - `unreachable` — the model IS in the catalog and serves NEITHER
 *   `/chat/completions` nor `/responses`. There is no correct default: any
 *   client we pick will 400 upstream with `unsupported_api_for_model`. The
 *   `endpoints` field carries what the catalog actually advertises (e.g.
 *   `["/v1/messages"]` for a Claude entry that only serves Copilot's native
 *   Anthropic endpoint) so the caller can say so out loud instead of guessing.
 */
export type EndpointResolution =
  | { kind: "endpoint"; endpoint: CopilotEndpoint }
  | { kind: "unknown-model" }
  | { kind: "unreachable"; endpoints: ReadonlyArray<string> }

/**
 * `pickEndpoint` by model id against the live catalog, WITHOUT collapsing
 * "absent from the catalog" into "serves neither of our endpoints".
 *
 * This function deliberately has no default. The predecessor
 * (`endpointForModelId`) returned `pickEndpoint(found) ?? "chat"`, which
 * coerced both cases to "chat" — defensible for an unknown id, silently wrong
 * for a catalog model serving only, say, `/v1/messages`: the caller would drive
 * it through the chat client and get an opaque upstream 400 with no local
 * signal about the real cause. `src/lib/browser-mcp/compressor.ts` already
 * treats that case correctly (`if (!endpoint) continue`); this makes the same
 * distinction available to callers that resolve by id.
 *
 * Callers that legitimately want the chat default for an unknown id can still
 * have it — they just have to write it, per case, on purpose.
 */
export function resolveEndpointForModelId(id: string): EndpointResolution {
  const found = state.models?.data?.find((m: Model) => m.id === id)
  if (!found) return { kind: "unknown-model" }
  const endpoint = pickEndpoint(found)
  if (endpoint) return { kind: "endpoint", endpoint }
  return { kind: "unreachable", endpoints: found.supported_endpoints ?? [] }
}
