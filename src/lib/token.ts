import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import {
  GITHUB_AGENT_CLIENT_ID,
  GITHUB_AGENT_SCOPES,
  GITHUB_API_BASE_URL,
  githubAgentHeaders,
} from "./api-config"
import { HTTPError } from "./error"
import { state } from "./state"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

const readGithubAgentToken = () =>
  fs.readFile(PATHS.GITHUB_AGENT_TOKEN_PATH, "utf8")

const writeGithubAgentToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_AGENT_TOKEN_PATH, token, { mode: 0o600 })

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
// Cooldowns are keyed off the OUTCOME of the last refresh, not the attempt:
//   - lastRefreshSuccess: throttles 401-retries when the token is fresh
//     (don't pointlessly re-fetch a token we just got).
//   - lastRefreshFailure: shorter backoff so a transient upstream blip
//     doesn't suppress legitimate refresh attempts for a full 30s, but
//     still prevents a thundering-herd refresh-storm against an upstream
//     that's persistently failing.
let lastRefreshSuccess = 0
let lastRefreshFailure = 0
const REFRESH_SUCCESS_COOLDOWN_MS = 30_000
const REFRESH_FAILURE_COOLDOWN_MS = 5_000

export async function refreshCopilotToken(
  reason: "interval" | "401-retry",
): Promise<void> {
  if (inflightRefresh) return inflightRefresh
  // Refresh-storm protection: if a recent refresh already completed,
  // decline new 401-retry attempts. Interval refreshes always proceed
  // (they're spaced by `refresh_in - 60s` which is well outside the
  // window). 401-retry attempts respect both cooldowns:
  //   - skip if a refresh succeeded within the last 30s (token is fresh)
  //   - skip if a refresh failed within the last 5s (back off briefly)
  if (reason === "401-retry") {
    const now = Date.now()
    if (now - lastRefreshSuccess < REFRESH_SUCCESS_COOLDOWN_MS) {
      consola.debug(
        `refreshCopilotToken(${reason}) skipped: prior success within ${REFRESH_SUCCESS_COOLDOWN_MS}ms`,
      )
      return
    }
    if (now - lastRefreshFailure < REFRESH_FAILURE_COOLDOWN_MS) {
      consola.debug(
        `refreshCopilotToken(${reason}) skipped: prior failure within ${REFRESH_FAILURE_COOLDOWN_MS}ms`,
      )
      return
    }
  }

  inflightRefresh = (async () => {
    consola.debug(`Refreshing Copilot token (reason=${reason})`)
    try {
      const { token } = await getCopilotToken()
      state.copilotToken = token
      lastRefreshSuccess = Date.now()
      consola.debug("Copilot token refreshed")
      if (state.showToken) {
        consola.info("Refreshed Copilot token:", token)
      }
    } catch (error) {
      lastRefreshFailure = Date.now()
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

/**
 * Set up the SECOND, write-capable GitHub token used by the first-mate
 * agent-orchestration surface (`--agents`). Mirrors `setupGitHubToken`
 * but authenticates against the GitHub CLI's OAuth client
 * (`GITHUB_AGENT_CLIENT_ID`) requesting `repo workflow read:org`, and
 * stores the result apart at `PATHS.GITHUB_AGENT_TOKEN_PATH`. The Copilot
 * App token (`state.githubToken`) is left completely untouched — this is
 * a distinct identity for a distinct capability.
 *
 * Long-lived (device-flow user token) → no refresh loop; a later 401 is
 * surfaced to the caller as a revoked grant to re-run the login. Called
 * once from `setupAndServe` when `state.agentsEnabled` is true.
 */
export async function setupGitHubAgentToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const existing = (await readGithubAgentToken().catch(() => "")).trim()

    if (existing && !options?.force) {
      state.githubAgentToken = existing
      if (state.showToken) {
        consola.info("GitHub agent token:", existing)
      }
      await warnIfAgentScopesInsufficient()
      return
    }

    consola.info(
      "Agent mode (--agents): a second GitHub login is required for a write-capable token (repo, workflow, read:org).",
    )
    const response = await getDeviceCode({
      clientId: GITHUB_AGENT_CLIENT_ID,
      scope: GITHUB_AGENT_SCOPES,
    })
    consola.debug("Agent device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri} to authorize github-router's cloud-agent orchestration to act on your repositories.`,
    )

    const token = await pollAccessToken(response, GITHUB_AGENT_CLIENT_ID)
    await writeGithubAgentToken(token)
    state.githubAgentToken = token

    if (state.showToken) {
      consola.info("GitHub agent token:", token)
    }
    await warnIfAgentScopesInsufficient()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error(
        "Failed to get GitHub agent token:",
        await error.response.json(),
      )
      throw error
    }

    consola.error("Failed to get GitHub agent token:", error)
    throw error
  }
}

/**
 * Best-effort check that the agent token actually carries the scopes we
 * asked for. The GitHub CLI OAuth client is a classic OAuth App, so the
 * granted scopes are echoed in the `x-oauth-scopes` response header on
 * any authenticated call. Warn loudly (not fatal) if `repo`/`workflow`
 * are missing so the failure is diagnosable at login rather than at the
 * first write 403.
 */
async function warnIfAgentScopesInsufficient(): Promise<void> {
  try {
    const res = await fetch(`${GITHUB_API_BASE_URL}/user`, {
      headers: githubAgentHeaders(state),
    })
    if (res.status === 401) {
      consola.warn(
        "GitHub agent token was rejected (401) — the grant may have been revoked. Re-run with --agents to log in again.",
      )
      return
    }
    const scopes = (res.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    const missing = ["repo", "workflow"].filter((s) => !scopes.includes(s))
    if (missing.length > 0) {
      consola.warn(
        `GitHub agent token is missing scope(s): ${missing.join(", ")}. `
          + "The first-mate surface needs 'repo' + 'workflow' to create issues, "
          + "assign cloud agents, and dispatch workflows. Re-run the agent login "
          + "and grant the requested scopes.",
      )
    }
  } catch (err) {
    consola.debug("Agent token scope check skipped:", err)
  }
}
