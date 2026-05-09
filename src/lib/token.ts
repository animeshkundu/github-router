import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

export const setupCopilotToken = async () => {
  const { token, refresh_in } = await getCopilotToken()
  state.copilotToken = token

  // Display the Copilot token to the screen
  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", token)
  }

  const refreshInterval = Math.max((refresh_in - 60) * 1000, 1000)
  setInterval(() => {
    void refreshCopilotToken("interval")
  }, refreshInterval)
}

// Single-flight mutex around the refresh fetch. Concurrent triggers (interval
// + a 401-retry path) share one in-flight refresh promise so we never
// overlap network calls or race writes to state.copilotToken.
let inflightRefresh: Promise<void> | undefined
let lastRefreshAttemptAt = 0
const REFRESH_STORM_WINDOW_MS = 30_000

export async function refreshCopilotToken(
  reason: "interval" | "401-retry",
): Promise<void> {
  if (inflightRefresh) return inflightRefresh
  // Refresh-storm protection: if we attempted a refresh within the
  // window, decline new attempts. Interval refreshes always proceed
  // (they're spaced by `refresh_in - 60s` which is well outside the
  // window); 401-retry attempts respect the window.
  if (
    reason === "401-retry"
    && Date.now() - lastRefreshAttemptAt < REFRESH_STORM_WINDOW_MS
  ) {
    consola.debug(
      `refreshCopilotToken(${reason}) skipped: prior refresh within ${REFRESH_STORM_WINDOW_MS}ms`,
    )
    return
  }
  lastRefreshAttemptAt = Date.now()

  inflightRefresh = (async () => {
    consola.debug(`Refreshing Copilot token (reason=${reason})`)
    try {
      const { token } = await getCopilotToken()
      state.copilotToken = token
      consola.debug("Copilot token refreshed")
      if (state.showToken) {
        consola.info("Refreshed Copilot token:", token)
      }
    } catch (error) {
      consola.error(
        `Failed to refresh Copilot token (reason=${reason}):`,
        error,
      )
    } finally {
      inflightRefresh = undefined
    }
  })()
  return inflightRefresh
}

/**
 * Try `request()`. If it returns a 401, refresh the Copilot token (subject
 * to the single-flight + refresh-storm-protection of `refreshCopilotToken`)
 * and retry once. After one retry, propagate whatever the second attempt
 * returned — the caller's existing 401-handling path is preserved.
 *
 * The `request` callback is responsible for capturing `state.copilotToken`
 * locally before any await; this helper does NOT re-build the request
 * itself, just re-invokes the callback after a refresh.
 */
export async function tryRefreshAndRetry(
  request: () => Promise<Response>,
  routePath: string,
): Promise<Response> {
  const first = await request()
  if (first.status !== 401) return first

  consola.warn(
    `${routePath}: upstream returned 401, attempting one token refresh + retry`,
  )
  await refreshCopilotToken("401-retry")
  // Re-invoke the request with the (possibly) new token in state.
  return request()
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      if (state.showToken) {
        consola.info("GitHub token:", githubToken)
      }
      await logUser()

      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    state.githubToken = token

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

async function logUser() {
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)
}
