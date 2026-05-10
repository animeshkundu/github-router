import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { UPSTREAM_FETCH_TIMEOUT_MS } from "~/lib/port"
import { state } from "~/lib/state"
import { tryRefreshAndRetry } from "~/lib/token"

export const createResponses = async (
  payload: ResponsesPayload,
  modelHeaders?: Record<string, string>,
  callerSignal?: AbortSignal,
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
  const response = await tryRefreshAndRetry(doFetch, "/responses")

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesApiResponse
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
