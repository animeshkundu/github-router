import { randomUUID } from "node:crypto"

import consola from "consola"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

/**
 * Build headers that match what VS Code Copilot Chat sends to the Copilot API.
 *
 * copilotHeaders() provides: Authorization, content-type, copilot-integration-id,
 * editor-version, editor-plugin-version, user-agent, openai-intent,
 * x-github-api-version, x-request-id, x-vscode-user-agent-library-version.
 *
 * We add the remaining headers VS Code sends for /v1/messages:
 * - X-Initiator (VS Code sets dynamically; "agent" is safe for CLI use)
 * - anthropic-version (VS Code's Anthropic SDK sends this)
 * - X-Interaction-Id (VS Code sends a session-scoped UUID)
 *
 * We intentionally omit copilot-vision-request — VS Code only sends it when
 * images are present, and the native /v1/messages endpoint handles vision
 * without requiring the header.
 *
 * extraHeaders allows callers to forward client-supplied beta headers
 * (anthropic-beta, capi-beta-1) so Copilot enables extended features.
 */
function buildHeaders(
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    ...copilotHeaders(state),
    "X-Initiator": "agent",
    "anthropic-version": "2023-06-01",
    "X-Interaction-Id": randomUUID(),
    ...extraHeaders,
  }
}

/**
 * Forward an Anthropic Messages API request to Copilot's native /v1/messages endpoint.
 * Returns the raw Response so callers can handle streaming vs non-streaming.
 */
export async function createMessages(
  body: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const headers = buildHeaders(extraHeaders)
  const url = `${copilotBaseUrl(state)}/v1/messages?beta=true`
  consola.debug(`Forwarding to ${url}`)

  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
  })

  if (!response.ok) {
    let errorBody = ""
    try {
      errorBody = await response.text()
    } catch {
      errorBody = "(could not read error body)"
    }
    consola.error(
      `Copilot /v1/messages error: ${response.status} ${errorBody}`,
    )
    const reconstructed = new Response(errorBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
    throw new HTTPError("Copilot messages request failed", reconstructed)
  }

  return response
}

/**
 * Forward an Anthropic count_tokens request to Copilot's native endpoint.
 * Returns the raw Response.
 */
export async function countTokens(
  body: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const headers = buildHeaders(extraHeaders)
  const url = `${copilotBaseUrl(state)}/v1/messages/count_tokens?beta=true`
  consola.debug(`Forwarding to ${url}`)

  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
  })

  if (!response.ok) {
    let errorBody = ""
    try {
      errorBody = await response.text()
    } catch {
      errorBody = "(could not read error body)"
    }
    consola.error(
      `Copilot count_tokens error: ${response.status} ${errorBody}`,
    )
    const reconstructed = new Response(errorBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
    throw new HTTPError("Copilot count_tokens request failed", reconstructed)
  }

  return response
}
