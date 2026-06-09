import { state } from "~/lib/state"

import type { Model } from "./get-models"

/**
 * Which Copilot endpoint a model is driven through. The proxy has two
 * tool-calling clients: `createChatCompletions` (`/chat/completions`) and
 * `createResponses` (`/responses`). A model serves one or both.
 */
export type CopilotEndpoint = "chat" | "responses"

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
  if (eps.includes("/chat/completions")) return "chat"
  if (eps.includes("/responses")) return "responses"
  return undefined
}

/**
 * `pickEndpoint` by model id against the live catalog. Returns "chat" when
 * the id isn't in the catalog (unknown models default to the chat shape,
 * matching the field-absent rule above) — callers that need a hard
 * presence check should look the model up themselves.
 */
export function endpointForModelId(id: string): CopilotEndpoint {
  const found = state.models?.data?.find((m: Model) => m.id === id)
  if (!found) return "chat"
  return pickEndpoint(found) ?? "chat"
}
