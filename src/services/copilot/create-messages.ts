import { randomUUID } from "node:crypto"

import consola from "consola"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { UPSTREAM_FETCH_TIMEOUT_MS } from "~/lib/port"
import { state } from "~/lib/state"
import { tryRefreshAndRetry } from "~/lib/token"
import { fetchWithTransientRetry } from "~/lib/upstream-retry"

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
 * (anthropic-beta) so Copilot enables extended features.
 */
function buildHeaders(
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    ...copilotHeaders(state),
    accept: "application/json",
    "openai-intent": "messages-proxy",
    "x-interaction-type": "conversation-agent",
    "X-Initiator": "agent",
    "anthropic-version": "2023-06-01",
    "X-Interaction-Id": randomUUID(),
    ...extraHeaders,
  }
}

/**
 * Forward an Anthropic Messages API request to Copilot's native /v1/messages endpoint.
 * Returns the raw Response so callers can handle streaming vs non-streaming.
 *
 * `callerSignal` (optional) is composed with the standard
 * UPSTREAM_FETCH_TIMEOUT_MS via AbortSignal.any so callers (e.g. the
 * peer-MCP `opus-critic` persona) can cancel the upstream call when
 * Claude Code's MCP per-tool-call ceiling fires. Mirrors the pattern
 * in createResponses / createChatCompletions.
 *
 * `retryTransient` (opt-in, default false) wraps the upstream fetch in a
 * bounded transient-failure retry (429/5xx/network, backoff+jitter) AROUND
 * the 401-refresh path — this is the PRE-FIRST-BYTE window: the response
 * body is never read here (the caller streams or parses it later), so a
 * retry re-issues a fresh request without risk of duplicating already-
 * streamed output. Only user-facing route handlers pass `true`; internal
 * callers (e.g. `dispatchModelCall`) already wrap this function in their own
 * `withTransientRetry`, so they MUST omit it to avoid nested retry.
 */
export async function createMessages(
  body: string,
  extraHeaders?: Record<string, string>,
  callerSignal?: AbortSignal,
  retryTransient = false,
): Promise<Response> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const url = `${copilotBaseUrl(state)}/v1/messages?beta=true`
  consola.debug(`Forwarding to ${url}`)

  // Re-build headers per attempt so a 401-retry picks up the refreshed token.
  const doFetch = (): Promise<Response> => {
    const headers = buildHeaders(extraHeaders)
    const fetchInit: RequestInit = { method: "POST", headers, body }
    const signals: Array<AbortSignal> = []
    if (UPSTREAM_FETCH_TIMEOUT_MS > 0) {
      signals.push(AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS))
    }
    if (callerSignal) signals.push(callerSignal)
    if (signals.length === 1) fetchInit.signal = signals[0]
    else if (signals.length > 1) fetchInit.signal = AbortSignal.any(signals)
    return fetch(url, fetchInit)
  }
  const withRefresh = (): Promise<Response> =>
    tryRefreshAndRetry(doFetch, "/v1/messages")
  const response =
    retryTransient ?
      await fetchWithTransientRetry(withRefresh, {
        signal: callerSignal,
        label: "/v1/messages",
      })
    : await withRefresh()

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
 *
 * `callerSignal` is composed with UPSTREAM_FETCH_TIMEOUT_MS — same pattern
 * as createMessages. `retryTransient` (opt-in) adds the same pre-first-byte
 * transient retry — count_tokens is non-streaming, so the whole call is in
 * the safe window.
 */
export async function countTokens(
  body: string,
  extraHeaders?: Record<string, string>,
  callerSignal?: AbortSignal,
  retryTransient = false,
): Promise<Response> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const url = `${copilotBaseUrl(state)}/v1/messages/count_tokens?beta=true`
  consola.debug(`Forwarding to ${url}`)

  const doFetch = (): Promise<Response> => {
    const headers = buildHeaders(extraHeaders)
    const fetchInit: RequestInit = { method: "POST", headers, body }
    const signals: Array<AbortSignal> = []
    if (UPSTREAM_FETCH_TIMEOUT_MS > 0) {
      signals.push(AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS))
    }
    if (callerSignal) signals.push(callerSignal)
    if (signals.length === 1) fetchInit.signal = signals[0]
    else if (signals.length > 1) fetchInit.signal = AbortSignal.any(signals)
    return fetch(url, fetchInit)
  }
  const withRefresh = (): Promise<Response> =>
    tryRefreshAndRetry(doFetch, "/v1/messages/count_tokens")
  const response =
    retryTransient ?
      await fetchWithTransientRetry(withRefresh, {
        signal: callerSignal,
        label: "/v1/messages/count_tokens",
      })
    : await withRefresh()

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
