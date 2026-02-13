import { GITHUB_API_BASE_URL, githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const getCopilotToken = async () => {
  const response = await fetch(
    `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(state),
    },
  )

  if (!response.ok) throw new HTTPError("Failed to get Copilot token", response)

  const data = (await response.json()) as GetCopilotTokenResponse

  // Use the API base URL from the token response if available,
  // matching how VS Code determines the CAPI endpoint dynamically.
  if (data.endpoints?.api) {
    state.copilotApiUrl = data.endpoints.api
  }

  return data
}

interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
  endpoints?: {
    api?: string
    proxy?: string
    telemetry?: string
    "origin-tracker"?: string
  }
}
