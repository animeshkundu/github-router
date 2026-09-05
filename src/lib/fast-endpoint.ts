import type { Model } from "~/services/copilot/get-models"

// Fast endpoint policy is intentionally kept separate from the standard
// pickEndpoint() resolver. See fastEndpointRequirement below.

/** Endpoint clients used by the fast profile's fixed roster. */
export type FastEndpoint = "chat" | "responses" | "messages"

const ENDPOINTS: Readonly<Record<FastEndpoint, ReadonlySet<string>>> = {
  chat: new Set(["/chat/completions", "/v1/chat/completions"]),
  responses: new Set(["/responses", "/v1/responses"]),
  messages: new Set(["/messages", "/v1/messages"]),
}

/**
 * Return the endpoint mandated by a fast-profile roster model.
 *
 * This is intentionally independent of the standard `pickEndpoint`: that
 * resolver prefers chat when a catalog entry advertises both clients, while
 * fast roles have a fixed provider contract. Gemini stays on chat; Luna, Sol,
 * and Grok stay on Responses; the Opus Oracle stays on native Messages.
 * Unknown ids return undefined so a fast caller cannot guess a transport.
 */
export function fastEndpointRequirement(modelId: string): FastEndpoint | undefined {
  const id = modelId.replace(/(?:\[1m\])+$/i, "")
  if (id === "gemini-3.8-flash") return "chat"
  if (id === "gpt-5.6-luna" || id === "gpt-5.6-sol" || id === "grok-4.6") {
    return "responses"
  }
  if (id === "claude-opus-5" || id === "claude-sonnet-5") return "messages"
  return undefined
}

/**
 * Resolve the fixed fast transport only when the catalog explicitly advertises
 * the required endpoint. An entry that advertises both still resolves to the
 * policy endpoint, regardless of advertisement order.
 */
export function fastEndpointForModel(model: Model): FastEndpoint | undefined {
  const required = fastEndpointRequirement(model.id)
  if (!required) return undefined
  const advertised = model.supported_endpoints
  if (!Array.isArray(advertised) || advertised.length === 0) return undefined
  return advertised.some((endpoint) => ENDPOINTS[required].has(endpoint))
    ? required
    : undefined
}

/** Resolve a fast endpoint from a catalog id, without selecting a fallback. */
export function fastEndpointForCatalogId(
  modelId: string,
  catalog: ReadonlyArray<Model> | undefined,
): FastEndpoint | undefined {
  const found = catalog?.find((model) => model.id === modelId)
  return found ? fastEndpointForModel(found) : undefined
}

/** Human-readable endpoint name for prerequisite diagnostics. */
export function fastEndpointLabel(endpoint: FastEndpoint): string {
  return endpoint === "chat"
    ? "Chat Completions"
    : endpoint === "responses"
      ? "Responses"
      : "Messages"
}
