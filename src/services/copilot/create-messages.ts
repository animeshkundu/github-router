import { randomUUID } from "node:crypto"

import consola from "consola"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { UPSTREAM_FETCH_TIMEOUT_MS } from "~/lib/port"
import { state } from "~/lib/state"
import { tryRefreshAndRetry } from "~/lib/token"
import { fetchWithTransientRetry } from "~/lib/upstream-retry"
import {
  hasLearnedImageCeilings,
  imagesInAnthropicMessages,
  learnedImageCeiling,
  logImagePlan,
  parseUpstreamImageCeiling,
  peekErrorBody,
  planOutboundImages,
  pruneImagesFromAnthropicMessages,
  rememberImageCeiling,
} from "~/lib/vision-preflight"

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
 * We intentionally omit copilot-vision-request. VS Code only sends it when
 * images are present, and the native /v1/messages endpoint handles vision
 * without it — VERIFIED live (2026-08-03) rather than assumed: the same
 * base64 image sent to claude-opus-5 with the header omitted and with it set
 * both returned 200 AND the model named the image's colour in each case, so
 * the pixels genuinely reach it either way. Probe `passthrough_image_claude`
 * in scripts/probe-copilot-compat.sh keeps that verified; if Copilot ever
 * starts gating vision on the header, that probe fails rather than images
 * silently degrading on the lead model's own path.
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
 * Prune the images in a parsed Anthropic request body down to `ceiling` and
 * re-serialize. Returns `undefined` when nothing needed dropping.
 *
 * Never throws. A latent traversal bug in the pruner must not convert an error
 * we could have forwarded into a proxy crash — the entire point of this change
 * is that an image problem stops being fatal.
 *
 * This is the one place the proxy re-serializes a `/v1/messages` body it would
 * otherwise forward byte-for-byte, so it inherits the usual JSON round-trip
 * caveat for integers beyond 2^53. It runs only when a ceiling is in hand:
 * either one upstream just stated, or one learned earlier in this process.
 */
function applyCeiling(
  parsed: { model?: unknown; messages?: unknown },
  ceiling: number,
): string | undefined {
  const model = typeof parsed.model === "string" ? parsed.model : ""
  try {
    const plan = planOutboundImages(model, imagesInAnthropicMessages(parsed.messages), {
      maxImages: ceiling,
    })
    if (plan.dropped === 0) return undefined
    logImagePlan(model, plan)
    return JSON.stringify({
      ...parsed,
      messages: pruneImagesFromAnthropicMessages(parsed.messages, plan.verdicts),
    })
  } catch (error) {
    consola.warn(`Image pruning skipped for ${model || "unknown model"}: ${String(error)}`)
    return undefined
  }
}

function parseBody(body: string): { model?: unknown; messages?: unknown } | undefined {
  try {
    return JSON.parse(body) as { model?: unknown; messages?: unknown }
  } catch {
    return undefined
  }
}

/** Prune to a ceiling this process already learned for the body's own model. */
function pruneToLearnedCeiling(body: string): string | undefined {
  const parsed = parseBody(body)
  if (!parsed) return undefined
  const model = typeof parsed.model === "string" ? parsed.model : ""
  if (model.length === 0) return undefined
  const ceiling = learnedImageCeiling(model)
  return ceiling === undefined ? undefined : applyCeiling(parsed, ceiling)
}

/** Prune to a ceiling upstream just stated, and remember it for next time. */
function pruneToStatedCeiling(body: string, ceiling: number): string | undefined {
  const parsed = parseBody(body)
  if (!parsed) return undefined
  const model = typeof parsed.model === "string" ? parsed.model : ""
  // Attribute from the PARSED model on both the read and the write side. A
  // regex over the raw body would match the first `"model":"..."` anywhere in
  // it, which in a replayed transcript is easily a quoted snippet or a tool
  // schema rather than the request's own field.
  if (model.length > 0) rememberImageCeiling(model, ceiling)
  return applyCeiling(parsed, ceiling)
}

/**
 * Cheap pre-parse gate for the proactive path only. Whitespace-tolerant: a
 * client that pretty-prints its JSON still matches. Deliberately NOT used to
 * gate the recovery path — gating recovery on a string probe means a probe miss
 * silently restores the fatal 400 this whole mechanism removes.
 */
function mayCarryImages(body: string): boolean {
  return /"type"\s*:\s*"image"/.test(body)
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

  // Prune proactively only once upstream has already told us this model's real
  // ceiling. Until then there is nothing to prune to, and parsing every body on
  // the hot path to discover that would cost more than the round trip it saves.
  if (hasLearnedImageCeilings() && mayCarryImages(body)) {
    body = pruneToLearnedCeiling(body) ?? body
  }

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
  const send = (): Promise<Response> =>
    retryTransient ?
      fetchWithTransientRetry(withRefresh, {
        signal: callerSignal,
        label: "/v1/messages",
      })
    : withRefresh()

  let response = await send()

  // Copilot owns the image ceiling and names the real number when it refuses.
  // Prune to it and retry ONCE; a second rejection or an unparseable one is
  // forwarded untouched, so this can never loop. Deliberately NOT gated on a
  // "does this body carry images" probe: `parseUpstreamImageCeiling` is already
  // image-specific, and a probe miss would silently restore the fatal 400.
  if (!response.ok) {
    const ceiling = parseUpstreamImageCeiling(await peekErrorBody(response))
    if (ceiling !== undefined) {
      const pruned = pruneToStatedCeiling(body, ceiling)
      if (pruned !== undefined) {
        void response.body?.cancel()
        body = pruned
        response = await send()
      }
    }
  }

  if (!response.ok) {
    let errorBody: string
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
    let errorBody: string
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
