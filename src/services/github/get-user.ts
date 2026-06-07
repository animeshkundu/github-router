import { GITHUB_API_BASE_URL, standardHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { fetchWithTransientRetry } from "~/lib/upstream-retry"

export async function getGitHubUser() {
  // GitHub PAT GET — retry transient 429/5xx/network; a 401 (bad PAT) fails
  // fast (not retried by the helper).
  const response = await fetchWithTransientRetry(
    () =>
      fetch(`${GITHUB_API_BASE_URL}/user`, {
        headers: {
          authorization: `token ${state.githubToken}`,
          ...standardHeaders(),
        },
      }),
    { label: "/user" },
  )

  if (!response.ok) throw new HTTPError("Failed to get GitHub user", response)

  return (await response.json()) as GithubUserResponse
}

// Trimmed for the sake of simplicity
interface GithubUserResponse {
  login: string
}
