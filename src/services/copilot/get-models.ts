import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { tryRefreshAndRetry } from "~/lib/token"
import { fetchWithTransientRetry } from "~/lib/upstream-retry"

export const getModels = async () => {
  // Startup catalog fetch — a transient 429/5xx/network blip here leaves
  // the model catalog empty for the whole session, so retry it. This is a
  // Copilot-token GET, so it keeps the 401-refresh path
  // (`tryRefreshAndRetry`) nested INSIDE the transient retry: 401 →
  // refresh once (never retried by the transient layer); 429/5xx/network
  // → bounded retry with backoff. A consumed (non-streamed) GET body is
  // safe to replay.
  const response = await fetchWithTransientRetry(
    () =>
      tryRefreshAndRetry(
        () =>
          fetch(`${copilotBaseUrl(state)}/models`, {
            headers: copilotHeaders(state),
          }),
        "/models",
      ),
    { label: "/models" },
  )

  if (!response.ok) throw new HTTPError("Failed to get models", response)

  return (await response.json()) as ModelsResponse
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
  max_non_streaming_output_tokens?: number
  vision?: {
    max_prompt_image_size?: number
    max_prompt_images?: number
    supported_media_types?: string[]
  }
}

interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
  streaming?: boolean
  vision?: boolean
  structured_outputs?: boolean
  adaptive_thinking?: boolean
  max_thinking_budget?: number
  min_thinking_budget?: number
  reasoning_effort?: Array<string>
}

interface ModelCapabilities {
  family: string
  limits?: ModelLimits
  object: string
  supports?: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  supported_endpoints?: Array<string>
  requestHeaders?: Record<string, string>
  policy?: {
    state: string
    terms: string
  }
  billing?: {
    is_premium: boolean
    multiplier: number
    restricted_to?: string[]
  }
  is_chat_default?: boolean
  is_chat_fallback?: boolean
  model_picker_category?: string
  info_messages?: Array<{ code: string; message: string }>
}
