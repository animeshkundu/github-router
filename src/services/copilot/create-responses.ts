import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const createResponses = async (payload: ResponsesPayload) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = detectVision(payload.input)

  const isAgentCall = detectAgentCall(payload.input)

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const filteredPayload = filterUnsupportedTools(payload)

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(filteredPayload),
  })

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

function filterUnsupportedTools(payload: ResponsesPayload): ResponsesPayload {
  if (!payload.tools || !Array.isArray(payload.tools)) return payload

  const supported = payload.tools.filter((tool) => {
    const isSupported = tool.type === "function"
    if (!isSupported) {
      consola.debug(`Stripping unsupported tool type: ${tool.type}`)
    }
    return isSupported
  })

  let toolChoice = payload.tool_choice
  if (supported.length === 0) {
    toolChoice = undefined
  } else if (
    toolChoice
    && typeof toolChoice === "object"
  ) {
    const supportedNames = new Set(
      supported.map((tool) => tool.name).filter(Boolean),
    )
    const toolChoiceName = getToolChoiceName(toolChoice)
    if (toolChoiceName && !supportedNames.has(toolChoiceName)) {
      toolChoice = undefined
    }
  }

  return {
    ...payload,
    tools: supported.length > 0 ? supported : undefined,
    tool_choice: toolChoice,
  }
}

function getToolChoiceName(
  toolChoice: NonNullable<ResponsesPayload["tool_choice"]>,
): string | undefined {
  if (typeof toolChoice !== "object") return undefined
  if (
    "function" in toolChoice
    && toolChoice.function
    && typeof toolChoice.function === "object"
  ) {
    return (toolChoice.function as { name?: string }).name
  }
  if ("name" in toolChoice) {
    return toolChoice.name
  }
  return undefined
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
