import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import {
  imagesInChatPayload,
  learnedImageCeiling,
  logImagePlan,
  parseUpstreamImageCeiling,
  peekErrorBody,
  planOutboundImages,
  pruneImagesFromChatMessages,
  rememberImageCeiling,
} from "~/lib/vision-preflight"
import { UPSTREAM_FETCH_TIMEOUT_MS } from "~/lib/port"
import { MAX_RESPONSE_BODY_BYTES, readResponseBodyCapped } from "~/lib/response-cap"
import { state } from "~/lib/state"
import { tryRefreshAndRetry } from "~/lib/token"
import { fetchWithTransientRetry } from "~/lib/upstream-retry"

/**
 * `retryTransient` (opt-in, default false) adds a bounded pre-first-byte
 * transient retry (429/5xx/network) AROUND the 401-refresh path. Safe
 * because the body is not consumed until AFTER the `!response.ok` check.
 * Only user-facing route handlers pass `true`; internal callers
 * (`dispatchModelCall`) already have their own outer `withTransientRetry`
 * and MUST omit it to avoid nested retry.
 */
export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  modelHeaders?: Record<string, string>,
  callerSignal?: AbortSignal,
  retryTransient = false,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const carriesImages = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )
  let enableVision = carriesImages

  /**
   * Apply a cardinality budget plus the per-image checks on the fully assembled
   * payload — the single outbound chokepoint, so every path that can introduce
   * an image (top-level block, nested tool_result, the shim's synthetic
   * follow-up user message, replayed history, peer attachments) is covered
   * without each of them re-deriving the rules.
   *
   * `enableVision` is recomputed: if nothing survives, sending
   * `copilot-vision-request: true` would trade one 400 for another.
   */
  const applyImagePlan = (maxImages: number | undefined): boolean => {
    try {
      const plan = planOutboundImages(
        payload.model,
        imagesInChatPayload(payload.messages),
        maxImages === undefined ? undefined : { maxImages },
      )
      if (plan.dropped === 0) return false
      logImagePlan(payload.model, plan)
      payload = {
        ...payload,
        messages: pruneImagesFromChatMessages(
          payload.messages,
          plan.verdicts,
        ) as ChatCompletionsPayload["messages"],
      }
      enableVision = plan.kept > 0
      return true
    } catch (error) {
      // A latent pruner bug must not turn a forwardable upstream error into a
      // proxy crash — not failing on images is the whole point of this path.
      consola.warn(`Image pruning skipped for ${payload.model}: ${String(error)}`)
      return false
    }
  }

  // Prune proactively when an earlier request already learned this model's real
  // ceiling from upstream. Saves the round trip; costs one walk.
  if (carriesImages) applyImagePlan(learnedImageCeiling(payload.model))

  // Agent/user check for X-Initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  const url = `${copilotBaseUrl(state)}/chat/completions`
  const doFetch = (): Promise<Response> => {
    // Re-build headers per attempt so a 401-retry picks up the refreshed token.
    const headers: Record<string, string> = {
      ...copilotHeaders(state, enableVision),
      ...modelHeaders,
      "X-Initiator": isAgentCall ? "agent" : "user",
    }
    const fetchInit: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }
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
    tryRefreshAndRetry(doFetch, "/chat/completions")
  const send = (): Promise<Response> =>
    retryTransient ?
      fetchWithTransientRetry(withRefresh, {
        signal: callerSignal,
        label: "/chat/completions",
      })
    : withRefresh()

  let response = await send()

  // Copilot owns the image ceiling — the catalog's `max_prompt_images` was
  // measured wrong for 20 of 23 models — and its rejection names the real
  // number. Prune to it and retry ONCE. A second rejection is forwarded, and an
  // unparseable one is forwarded untouched, so this can never loop.
  if (!response.ok && carriesImages) {
    const ceiling = parseUpstreamImageCeiling(await peekErrorBody(response))
    if (ceiling !== undefined) {
      rememberImageCeiling(payload.model, ceiling)
      if (applyImagePlan(ceiling)) {
        void response.body?.cancel()
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
    const claudeModels = state.models?.data
      .filter((m) => m.id.startsWith("claude"))
      .map((m) => m.id)
      .join(", ") ?? "(models not loaded)"
    consola.error(
      `Copilot rejected model "${payload.model}": ${response.status} ${errorBody} (available Claude models: ${claudeModels})`,
    )
    // Re-create the response so downstream error handlers can still read the body
    const reconstructed = new Response(errorBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
    throw new HTTPError("Failed to create chat completions", reconstructed)
  }

  if (payload.stream) {
    return events(response)
  }

  const cappedResult = await readResponseBodyCapped<ChatCompletionResponse>(
    response,
    "/v1/chat/completions",
    MAX_RESPONSE_BODY_BYTES,
  )
  if (!cappedResult.ok) {
    throw new HTTPError(
      "Upstream /v1/chat/completions response exceeded 10 MiB size cap",
      new Response(JSON.stringify(cappedResult.errorResponse), {
        status: cappedResult.status,
        headers: { "content-type": "application/json" },
      }),
    )
  }
  return cappedResult.value
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
      cache_write_tokens?: number
      cache_creation_tokens?: number
      cache_ttl_seconds?: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  /** Streaming counterpart of `ResponseMessage.refusal`. */
  refusal?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
      cache_write_tokens?: number
      cache_creation_tokens?: number
      cache_ttl_seconds?: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  /**
   * Model refusal text. Distinct from `content` and populated instead of it, so
   * a consumer that reads only `content` renders a refusal as an empty message.
   */
  refusal?: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  /**
   * Disable parallel tool calls. Copilot's `/chat/completions` accepts this;
   * only ever set to `false` (honor Anthropic's `disable_parallel_tool_use`),
   * omitted otherwise — never sent as `true`.
   */
  parallel_tool_calls?: boolean
  user?: string | null
  /**
   * OpenAI-compatible reasoning effort knob. Copilot accepts low/medium/high/xhigh
   * for OpenAI-routed models; for non-OpenAI models (e.g. gemini-3.x routed via
   * /v1/chat/completions) the upstream may silently ignore this or 400 — the proxy
   * forwards it as-is and surfaces any 400 through the existing tool-error path.
   */
  reasoning_effort?: string | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
