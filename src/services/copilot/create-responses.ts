import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { UPSTREAM_FETCH_TIMEOUT_MS } from "~/lib/port"
import { MAX_RESPONSE_BODY_BYTES, readResponseBodyCapped } from "~/lib/response-cap"
import { state } from "~/lib/state"
import { tryRefreshAndRetry } from "~/lib/token"
import { fetchWithTransientRetry } from "~/lib/upstream-retry"

/**
 * `retryTransient` (opt-in, default false) adds a bounded pre-first-byte
 * transient retry (429/5xx/network) AROUND the 401-refresh path. Safe
 * because the body is not consumed until AFTER the `!response.ok` check —
 * `events()` (streaming) and `readResponseBodyCapped` (non-streaming) both
 * run later, so a retry re-issues a fresh request and never duplicates
 * already-streamed output. Only user-facing route handlers pass `true`;
 * internal callers (`dispatchModelCall`) already have their own outer
 * `withTransientRetry` and MUST omit it to avoid nested retry.
 */
export const createResponses = async (
  payload: ResponsesPayload,
  modelHeaders?: Record<string, string>,
  callerSignal?: AbortSignal,
  retryTransient = false,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = detectVision(payload.input)

  const isAgentCall = detectAgentCall(payload.input)

  const url = `${copilotBaseUrl(state)}/responses`
  const doFetch = (): Promise<Response> => {
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
    tryRefreshAndRetry(doFetch, "/responses")
  const response =
    retryTransient ?
      await fetchWithTransientRetry(withRefresh, {
        signal: callerSignal,
        label: "/responses",
      })
    : await withRefresh()

  if (!response.ok) {
    // Read the body BEFORE throwing so the actual upstream error is
    // visible in the proxy log. Without this we'd interpolate
    // `[object Response]` and have no idea what Copilot rejected.
    // Clone first because `response.text()` consumes the body and the
    // HTTPError handler in callers may want to read it again.
    let bodyText: string
    try {
      bodyText = await response.clone().text()
    } catch {
      bodyText = "(failed to read body)"
    }
    consola.error(
      `Failed to create responses: HTTP ${response.status} ${response.statusText} `
        + `from ${url} — body: ${bodyText.slice(0, 2000)}`,
    )
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return events(response)
  }

  const cappedResult = await readResponseBodyCapped<ResponsesApiResponse>(
    response,
    "/v1/responses",
    MAX_RESPONSE_BODY_BYTES,
  )
  if (!cappedResult.ok) {
    throw new HTTPError(
      "Upstream /v1/responses response exceeded 10 MiB size cap",
      new Response(JSON.stringify(cappedResult.errorResponse), {
        status: cappedResult.status,
        headers: { "content-type": "application/json" },
      }),
    )
  }
  return cappedResult.value
}

function detectVision(input: ResponsesPayload["input"]): boolean {
  if (typeof input === "string") return false
  if (!Array.isArray(input)) return false

  return input.some((item) => {
    if ("content" in item && Array.isArray(item.content)) {
      return item.content.some(
        (part: Record<string, unknown>) => part.type === "input_image",
      )
    }
    return false
  })
}

function detectAgentCall(input: ResponsesPayload["input"]): boolean {
  if (typeof input === "string") return false
  if (!Array.isArray(input)) return false

  return input.some((item) => {
    if ("role" in item && item.role === "assistant") return true
    if (
      "type" in item
      && (item.type === "function_call" || item.type === "function_call_output")
    ) {
      return true
    }
    return false
  })
}

// Types

export interface ResponsesInputItem {
  role?: "user" | "assistant" | "system"
  type?: "message" | "function_call" | "function_call_output"
  content?: string | Array<Record<string, unknown>>
  name?: string
  call_id?: string
  arguments?: string
  output?: string
  [key: string]: unknown
}

export interface ResponsesTool {
  type: string
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  [key: string]: unknown
}

export interface ResponsesPayload {
  model: string
  input: string | Array<ResponsesInputItem>
  instructions?: string
  tools?: Array<ResponsesTool>
  tool_choice?:
    | string
    | { type: string; name?: string; function?: { name?: string } }
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  store?: boolean
  metadata?: Record<string, string>
  previous_response_id?: string
  reasoning?: { effort?: string; summary?: string }
  [key: string]: unknown
}

export interface ResponsesApiResponse {
  id: string
  object: "response"
  status: string
  output: Array<unknown>
  [key: string]: unknown
}
