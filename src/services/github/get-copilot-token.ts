import consola from "consola"

import { GITHUB_API_BASE_URL, githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { fetchWithTransientRetry } from "~/lib/upstream-retry"

/**
 * Allowlist of hosts the router will trust as the Copilot API base URL.
 * Anything else returned in `endpoints.api` (e.g. via a tampered or
 * misconfigured token-exchange response) is rejected — otherwise a
 * malicious value would receive the long-lived GitHub PAT we send to
 * `/mcp` for web search (see `src/services/copilot/web-search.ts`).
 */
const COPILOT_HOST_ALLOWLIST = [
  "api.githubcopilot.com",
  "api.individual.githubcopilot.com",
  "api.business.githubcopilot.com",
  "api.enterprise.githubcopilot.com",
]

function isAllowedCopilotHost(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== "https:") return false
  return COPILOT_HOST_ALLOWLIST.includes(parsed.hostname)
}

export const getCopilotToken = async () => {
  // GitHub PAT → Copilot token exchange. A transient 429/5xx/network blip
  // here aborts launch (and the interval-driven refresh that keeps the
  // session alive), so retry the transient class with bounded backoff. NO
  // 401-refresh compose: this call IS the token source, and a 401 means a
  // bad/expired GitHub PAT — deterministic, fail fast (retrying would burn
  // budget against a credential that can't recover without re-auth).
  const response = await fetchWithTransientRetry(
    () =>
      fetch(`${GITHUB_API_BASE_URL}/copilot_internal/v2/token`, {
        headers: githubHeaders(state),
      }),
    { label: "/copilot_internal/v2/token" },
  )

  if (!response.ok) throw new HTTPError("Failed to get Copilot token", response)

  const data = (await response.json()) as GetCopilotTokenResponse

  // Use the API base URL from the token response if available, matching
  // how VS Code determines the CAPI endpoint dynamically — but only when
  // it points at a github-controlled host (see allowlist above).
  // We deliberately do NOT clobber an existing `state.copilotApiUrl` in
  // the disallowed branch: when the user sets `COPILOT_API_URL` themselves
  // (e.g. for local testing or a CI mock), that's an explicit opt-in and
  // a different threat model than a tampered token-exchange response.
  // Allowlist-failing token-response values are simply ignored.
  if (data.endpoints?.api) {
    if (isAllowedCopilotHost(data.endpoints.api)) {
      state.copilotApiUrl = data.endpoints.api
    } else {
      consola.warn(
        `Refusing to honor Copilot API endpoint "${data.endpoints.api}" from ` +
        `the token-exchange response — not in allowlist ` +
        `(${COPILOT_HOST_ALLOWLIST.join(", ")}). ` +
        (state.copilotApiUrl
          ? `Keeping existing override "${state.copilotApiUrl}".`
          : `Falling back to the default api.githubcopilot.com.`),
      )
    }
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
