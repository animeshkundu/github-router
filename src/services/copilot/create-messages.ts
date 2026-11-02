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
 * base64 image sent to claude-opus-5.5 with the header omitted and with it set
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
 * Egress for the `-m local` / `-m local2` profiles: the MAIN agent loop's
 * `/v1/messages` traffic goes to a locally running Anthropic-compatible server
 * instead of Copilot.
 *
 * Both fields are required because both are facts the local server does not
 * let us infer: the base URL is the only endpoint knowledge the profile is
 * allowed to carry, and the session id is mandatory upstream (a request
 * without it is a 400).
 *
 * Deliberately NOT a flag on the module or on `state`: this is a per-call
 * option, so every internal caller (Advisor, peer personas, `stand_in`) keeps
 * hitting Copilot by simply not passing it. That is what keeps `local2`'s
 * Advisor on the real `gpt-6.1-sol` while its lead turns stay local.
 */
export interface LocalMessagesEgress {
  /** e.g. `https://localhost:11111/v1` — the `/messages` suffix is appended. */
  baseUrl: string
  /** Forwarded as `x-claude-code-session-id`; must be stable per conversation. */
  sessionId: string
}

/**
 * Headers for a local-endpoint call.
 *
 * Nothing Copilot-specific is sent: no `Authorization`, no
 * `copilot-integration-id`, no VS Code editor/user-agent headers and no
 * `X-Initiator`. The local server was never asked to authenticate us, and
 * sending Copilot's credentials to it would leak a live token to an endpoint
 * the operator merely pointed us at.
 *
 * `extraHeaders` (the client's own `anthropic-beta` / `anthropic-version`) is
 * applied last so the client's values win over our defaults.
 */
function buildLocalHeaders(
  egress: LocalMessagesEgress,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    "anthropic-version": "2023-06-01",
    "x-claude-code-session-id": egress.sessionId,
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
 *
 * `local` (optional, trailing) redirects the call to a local
 * Anthropic-compatible server. Omitted — the default for every caller — the
 * function behaves exactly as before.
 */
export async function createMessages(
  body: string,
  extraHeaders?: Record<string, string>,
  callerSignal?: AbortSignal,
  retryTransient = false,
  local?: LocalMessagesEgress,
): Promise<Response> {
  // A local session needs no Copilot credential for its lead turns, and
  // demanding one would make `-m local` unusable with a dead GitHub token.
  if (!local && !state.copilotToken) throw new Error("Copilot token not found")

  const url = local ?
    `${local.baseUrl}/messages`
  : `${copilotBaseUrl(state)}/v1/messages?beta=true`
  const target = local ? "Local /v1/messages" : "Copilot /v1/messages"
  consola.debug(`Forwarding to ${url}`)

  // Prune proactively only once upstream has already told us this model's real
  // ceiling. Until then there is nothing to prune to, and parsing every body on
  // the hot path to discover that would cost more than the round trip it saves.
  // Skipped entirely for local: the ceiling is Copilot's, and pruning a body
  // the local server accepted would be a silent content change on a path we
  // promised to forward verbatim.
  if (!local && hasLearnedImageCeilings() && mayCarryImages(body)) {
    body = pruneToLearnedCeiling(body) ?? body
  }

  // Re-build headers per attempt so a 401-retry picks up the refreshed token.
  const doFetch = (): Promise<Response> => {
    const headers =
      local ? buildLocalHeaders(local, extraHeaders) : buildHeaders(extraHeaders)
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
  // `tryRefreshAndRetry` is Copilot token semantics; a local endpoint has no
  // token to refresh, so the 401 path is bypassed rather than made a no-op.
  const withRefresh = (): Promise<Response> =>
    local ? doFetch() : tryRefreshAndRetry(doFetch, "/v1/messages")
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
  if (!local && !response.ok) {
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
    consola.error(`${target} error: ${response.status} ${errorBody}`)
    const reconstructed = new Response(errorBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
    throw new HTTPError(
      local ? "Local messages request failed" : "Copilot messages request failed",
      reconstructed,
    )
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
 *
 * `local` (optional, trailing) redirects to a local Anthropic-compatible
 * server, exactly as `createMessages` does. Omitted, behaviour is unchanged.
 */
export async function countTokens(
  body: string,
  extraHeaders?: Record<string, string>,
  callerSignal?: AbortSignal,
  retryTransient = false,
  local?: LocalMessagesEgress,
): Promise<Response> {
  if (!local && !state.copilotToken) throw new Error("Copilot token not found")

  const url = local ?
    `${local.baseUrl}/messages/count_tokens`
  : `${copilotBaseUrl(state)}/v1/messages/count_tokens?beta=true`
  const target = local ? "Local /v1/messages/count_tokens" : "Copilot count_tokens"
  consola.debug(`Forwarding to ${url}`)

  const doFetch = (): Promise<Response> => {
    const headers =
      local ? buildLocalHeaders(local, extraHeaders) : buildHeaders(extraHeaders)
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
    local ? doFetch() : tryRefreshAndRetry(doFetch, "/v1/messages/count_tokens")
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
    consola.error(`${target} error: ${response.status} ${errorBody}`)
    const reconstructed = new Response(errorBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
    throw new HTTPError(
      local ? "Local count_tokens request failed" : "Copilot count_tokens request failed",
      reconstructed,
    )
  }

  return response
}
