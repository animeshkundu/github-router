/**
 * Entry point for the non-Claude Anthropic-translation shim.
 *
 * `handleNonClaudeResponses` is the diversion `POST /v1/messages` takes when the
 * resolved model is a non-Claude `/responses` model (gpt-5.5, gpt-5.3-codex);
 * `handleNonClaudeChat` is the twin for a non-Claude `/chat/completions` model
 * (gemini). Each translates the Anthropic Messages request into the matching
 * Copilot request, calls the existing streaming-capable client, and translates
 * the response back to the Anthropic wire shape — streaming (synthesized SSE) or
 * non-streaming (a single Anthropic Messages object), per the request's
 * `stream` flag.
 *
 * The Claude passthrough (`createMessages`) is untouched: this module is only
 * reached via `classifyMessagesRoute(...)` returning `responses-shim` /
 * `chat-shim`.
 */

import type { Context } from "hono"

import consola from "consola"

import { UPSTREAM_INACTIVITY_TIMEOUT_MS } from "~/lib/port"
import { logRequest } from "~/lib/request-log"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"
import { createResponses } from "~/services/copilot/create-responses"
import type { ResponsesApiResponse } from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

import { anthropicSseStreamFromEvents } from "./anthropic-sse"
import {
  parseAnthropicRequest,
  parsedToResponsesPayload,
} from "./anthropic-request"
import type { ParsedAnthropicRequest } from "./anthropic-request"
import { parsedToChatPayload } from "./chat-request"
import {
  chatResponseToAnthropicMessage,
  synthAnthropicFromChat,
} from "./chat-egress"
import {
  responsesResponseToAnthropicMessage,
  synthAnthropicFromResponses,
} from "./responses-egress"

type AnyRecord = Record<string, unknown>

export { classifyMessagesRoute, isClaudeModel } from "./classifier"
export type { MessagesRoute } from "./classifier"
export { parseAnthropicRequest } from "./anthropic-request"
export type { ParsedAnthropicRequest } from "./anthropic-request"

/** Shared options for both non-Claude shim entry points. */
export interface NonClaudeShimOptions {
  /** The resolved request body (post model-resolution), as a JSON string. */
  rawBody: string
  /** The resolved Copilot catalog model id the request runs on. */
  modelId: string
  /** The catalog entry (for request headers + reasoning-effort allowlist). */
  model?: Model
  /** The model id the client originally sent (for logging). */
  originalModel?: string
  startTime: number
}

/** Back-compat alias (the Responses handler predates the shared name). */
export type NonClaudeResponsesOptions = NonClaudeShimOptions

const STREAM_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  "transfer-encoding": "chunked",
  connection: "keep-alive",
}

function isAsyncIterable(x: unknown): x is AsyncIterable<{ data?: string }> {
  return (
    x != null
    && typeof (x as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  )
}

/** Which Copilot endpoint a shim turn dispatches on. */
export type ShimEndpoint = "responses" | "chat"

/** Per-turn options for the shared shim core (below). */
export interface ShimTurnOptions {
  modelId: string
  model?: Model
  /**
   * Diagnostic label for `anthropicSseStreamFromEvents`'s stall/error log
   * lines. The initial-request handlers pass the real `c.req.path`; the
   * advisor continuation (context-free, no `Context`) omits it and gets a
   * fixed descriptive label instead.
   */
  routePath?: string
  /**
   * Invoked when the RETURNED stream's consumer cancels (mirrors
   * `anthropicSseStreamFromEvents`'s own `onCancel`). Omit when the caller
   * already owns/aborts the signal through some other path (the advisor
   * translate-loop's injected continuation: its outer `aborter.abort()` is
   * driven by `buildAdvisorStream`'s OWN `cancel()`, not by this stream's).
   */
  onCancel?: () => void
}

/**
 * Context-free, caller-abortable core of the non-Claude shim's STREAMING
 * path for one already-parsed Anthropic request.
 *
 * "Context-free": no Hono `Context` dependency, unlike
 * `handleNonClaudeResponses`/`handleNonClaudeChat` below (which need one to
 * build their JSON error responses and read `c.req.path` for logging).
 * "Caller-abortable": takes the caller's OWN `AbortSignal` rather than
 * constructing an internal `AbortController` — this function never creates
 * one — and forwards an optional `onCancel` so a caller that DOES own a
 * controller (the two handlers below, for the initial request) can still
 * tear it down when the stream it returns is cancelled.
 *
 * Shared by:
 *   - `handleNonClaudeResponses` / `handleNonClaudeChat` (this module), for
 *     the initial request — each already knows its own endpoint statically
 *     (they are dispatched by `classifyMessagesRoute`), so this function
 *     takes `endpoint` as an explicit argument rather than re-deriving it
 *     from the catalog (which would also mean re-parsing/re-picking work the
 *     caller already did).
 *   - `makeShimContinueTurn` (below), which `buildAdvisorStream`
 *     (`src/services/advisor/advisor.ts`) injects as its `continueTurn` for
 *     the fast Luna-lead profile, so an advisor continuation on a non-Claude
 *     lead runs through the SAME translation + SSE-synthesis machinery as
 *     the initial turn instead of a parallel, divergent implementation.
 */
export async function streamParsedRequestViaShim(
  parsed: ParsedAnthropicRequest,
  endpoint: ShimEndpoint,
  opts: ShimTurnOptions,
  signal: AbortSignal,
): Promise<Response> {
  const routePath = opts.routePath ?? "/v1/messages (advisor lead shim)"
  if (endpoint === "chat") {
    const payload = parsedToChatPayload(parsed)
    const result = await createChatCompletions(payload, opts.model?.requestHeaders, signal, true)
    if (!isAsyncIterable(result)) {
      throw new Error(
        "Upstream /chat/completions did not return an SSE stream (stream: true expected)",
      )
    }
    const events = synthAnthropicFromChat(result, { modelId: opts.modelId })
    const stream = anthropicSseStreamFromEvents(events, {
      routePath,
      onCancel: opts.onCancel,
      inactivityTimeoutMs: UPSTREAM_INACTIVITY_TIMEOUT_MS,
    })
    return new Response(stream, { status: 200, headers: STREAM_HEADERS })
  }

  const payload = parsedToResponsesPayload(parsed)
  const result = await createResponses(payload, opts.model?.requestHeaders, signal, true)
  if (!isAsyncIterable(result)) {
    throw new Error("Upstream /responses did not return an SSE stream (stream: true expected)")
  }
  const events = synthAnthropicFromResponses(result, { modelId: opts.modelId })
  const stream = anthropicSseStreamFromEvents(events, {
    routePath,
    onCancel: opts.onCancel,
    inactivityTimeoutMs: UPSTREAM_INACTIVITY_TIMEOUT_MS,
  })
  return new Response(stream, { status: 200, headers: STREAM_HEADERS })
}

/**
 * Build an injectable `continueTurn(body, signal)` for `buildAdvisorStream`
 * (`src/services/advisor/advisor.ts`) that routes a continuation turn
 * through THIS module's non-Claude shim instead of Claude passthrough — used
 * for the fast Luna-lead profile's advisor translate-loop. No `onCancel` is
 * threaded through: the advisor loop's own `aborter` (shared with `signal`
 * here) already tears down on consumer cancel via `buildAdvisorStream`'s
 * `cancel()`, so this stream needs no independent teardown hook.
 */
export function makeShimContinueTurn(
  endpoint: ShimEndpoint,
  opts: { modelId: string; model?: Model },
): (body: AnyRecord, signal: AbortSignal) => Promise<Response> {
  return (body, signal) => {
    const parsed = parseAnthropicRequest(body, opts.modelId, opts.model)
    return streamParsedRequestViaShim(parsed, endpoint, opts, signal)
  }
}

/**
 * Handle a `/v1/messages` request targeting a non-Claude `/responses` model.
 * Returns a streaming or non-streaming Anthropic-format Response. Upstream
 * non-2xx / abort errors are thrown (as HTTPError) and handled by the route's
 * `forwardError`, exactly like the passthrough path.
 */
export async function handleNonClaudeResponses(
  c: Context,
  opts: NonClaudeResponsesOptions,
): Promise<Response> {
  const routePath = c.req.path

  let body: AnyRecord
  try {
    body = JSON.parse(opts.rawBody) as AnyRecord
  } catch {
    return c.json(
      {
        type: "error",
        error: { type: "invalid_request_error", message: "Request body is not valid JSON" },
      },
      400,
    )
  }

  const parsed = parseAnthropicRequest(body, opts.modelId, opts.model)

  const debugEnabled = consola.level >= 4
  if (debugEnabled) {
    consola.debug(
      `Anthropic-translate → /responses model=${opts.modelId} stream=${parsed.stream} `
      + `tools=${parsed.tools?.length ?? 0} effort=${parsed.reasoningEffort ?? "none"}`,
    )
  }

  if (parsed.stream) {
    // Compose a caller-controlled aborter so consumer-cancel tears down the
    // upstream fetch. Do NOT use c.req.raw.signal (Bun aborts it after body
    // consumption — see CLAUDE.md "Bun request-signal quirk").
    const aborter = new AbortController()
    const stream = await streamParsedRequestViaShim(
      parsed,
      "responses",
      {
        modelId: opts.modelId,
        model: opts.model,
        routePath,
        onCancel: () => aborter.abort(),
      },
      aborter.signal,
    )

    logRequest(
      {
        method: "POST",
        path: routePath,
        model: opts.originalModel,
        resolvedModel: opts.modelId,
        status: 200,
        streaming: true,
      },
      opts.model,
      opts.startTime,
    )

    return stream
  }

  // Non-streaming. The upstream fetch is NOT consumer-abortable here and
  // completes regardless — matching the repo's documented pattern (streaming
  // tears down via ReadableStream.cancel(); non-streaming is a no-op on
  // consumer cancel). c.req.raw.signal is unusable (Bun aborts it once the
  // request body is consumed — already done in handleCompletion via
  // c.req.text(); see CLAUDE.md "Bun request-signal quirk"), and a bare
  // AbortController would never fire (no cancel hook for a buffered response),
  // so we pass no signal rather than an inert one that implies cancellation.
  const payload = parsedToResponsesPayload(parsed)
  const result = await createResponses(
    payload,
    opts.model?.requestHeaders,
    undefined,
    true,
  )
  const anthropic = responsesResponseToAnthropicMessage(
    result as ResponsesApiResponse,
    opts.modelId,
  )
  const usage = anthropic.usage

  logRequest(
    {
      method: "POST",
      path: routePath,
      model: opts.originalModel,
      resolvedModel: opts.modelId,
      inputTokens:
        usage.input_tokens
        + usage.cache_read_input_tokens
        + usage.cache_creation_input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
      status: 200,
    },
    opts.model,
    opts.startTime,
  )

  return c.json(anthropic, 200)
}

/**
 * Handle a `/v1/messages` request targeting a non-Claude `/chat/completions`
 * model (gemini). Twin of `handleNonClaudeResponses` — same lifecycle, abort,
 * and logging contract, but assembles a chat/completions payload and translates
 * the chat response (object or SSE) back to the Anthropic wire shape.
 */
export async function handleNonClaudeChat(
  c: Context,
  opts: NonClaudeShimOptions,
): Promise<Response> {
  const routePath = c.req.path

  let body: AnyRecord
  try {
    body = JSON.parse(opts.rawBody) as AnyRecord
  } catch {
    return c.json(
      {
        type: "error",
        error: { type: "invalid_request_error", message: "Request body is not valid JSON" },
      },
      400,
    )
  }

  const parsed = parseAnthropicRequest(body, opts.modelId, opts.model)

  const debugEnabled = consola.level >= 4
  if (debugEnabled) {
    consola.debug(
      `Anthropic-translate → /chat/completions model=${opts.modelId} stream=${parsed.stream} `
      + `tools=${parsed.tools?.length ?? 0} effort=${parsed.reasoningEffort ?? "none"}`,
    )
  }

  if (parsed.stream) {
    // Caller-controlled aborter so consumer-cancel tears down the upstream
    // fetch. Do NOT use c.req.raw.signal (Bun aborts it after body consumption
    // — see CLAUDE.md "Bun request-signal quirk").
    const aborter = new AbortController()
    const stream = await streamParsedRequestViaShim(
      parsed,
      "chat",
      {
        modelId: opts.modelId,
        model: opts.model,
        routePath,
        onCancel: () => aborter.abort(),
      },
      aborter.signal,
    )

    logRequest(
      {
        method: "POST",
        path: routePath,
        model: opts.originalModel,
        resolvedModel: opts.modelId,
        status: 200,
        streaming: true,
      },
      opts.model,
      opts.startTime,
    )

    return stream
  }

  // Non-streaming: not consumer-abortable (see the Responses twin above and
  // CLAUDE.md "Bun request-signal quirk"); the upstream fetch completes
  // regardless. Pass no signal rather than an inert AbortController.
  const payload = parsedToChatPayload(parsed)
  const result = await createChatCompletions(
    payload,
    opts.model?.requestHeaders,
    undefined,
    true,
  )
  const anthropic = chatResponseToAnthropicMessage(
    result as ChatCompletionResponse,
    opts.modelId,
  )
  const usage = anthropic.usage

  logRequest(
    {
      method: "POST",
      path: routePath,
      model: opts.originalModel,
      resolvedModel: opts.modelId,
      inputTokens:
        usage.input_tokens
        + usage.cache_read_input_tokens
        + usage.cache_creation_input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
      status: 200,
    },
    opts.model,
    opts.startTime,
  )

  return c.json(anthropic, 200)
}
