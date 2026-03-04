import consola from "consola"

import { logMismatchToFile } from "./error-log"
import { state } from "./state"

type Endpoint = "/chat/completions" | "/responses" | "/v1/messages"

const ENDPOINT_ALIASES: Record<string, Endpoint> = {
  "/chat/completions": "/chat/completions",
  "/v1/chat/completions": "/chat/completions",
  "/responses": "/responses",
  "/v1/responses": "/responses",
  "/v1/messages": "/v1/messages",
}

/**
 * Check whether a model supports the given endpoint, based on cached
 * `supported_endpoints` metadata from the Copilot `/models` response.
 *
 * Returns `true` (allow) when:
 * - the model is not found in the cache (don't block unknown models)
 * - the model has no `supported_endpoints` field (backward-compat)
 * - the endpoint is listed in `supported_endpoints`
 */
export function modelSupportsEndpoint(
  modelId: string,
  path: string,
): boolean {
  const endpoint = ENDPOINT_ALIASES[path] ?? path
  const model = state.models?.data.find((m) => m.id === modelId)
  if (!model) return true

  const supported = model.supported_endpoints
  if (!supported || supported.length === 0) return true

  return supported.includes(endpoint)
}

/**
 * Log an error when a model is used on an endpoint it doesn't support.
 * Returns `true` if a mismatch was detected (for testing).
 */
export function logEndpointMismatch(
  modelId: string,
  path: string,
): boolean {
  if (modelSupportsEndpoint(modelId, path)) return false

  const model = state.models?.data.find((m) => m.id === modelId)
  const supported = model?.supported_endpoints ?? []

  consola.error(
    `Model "${modelId}" does not support ${path}. `
    + `Supported endpoints: ${supported.join(", ")}`,
  )
  logMismatchToFile(modelId, path, supported)
  return true
}

/**
 * Return model IDs that support the given endpoint.
 */
export function listModelsForEndpoint(path: string): string[] {
  const endpoint = ENDPOINT_ALIASES[path] ?? path
  const models = state.models?.data ?? []

  return models
    .filter((m) => {
      const supported = m.supported_endpoints
      if (!supported || supported.length === 0) return true
      return supported.includes(endpoint)
    })
    .map((m) => m.id)
}
