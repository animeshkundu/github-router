import consola from "consola"

import { githubAgentHeaders, GITHUB_API_BASE_URL } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { fetchWithTransientRetry } from "~/lib/upstream-retry"

import { AgentError, type AgentErrorCode } from "./types"

export type GhRestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export interface GhRestOptions {
  body?: unknown
  signal?: AbortSignal
  apiVersion?: string
}

function restHeaders(apiVersion?: string): Record<string, string> {
  const headers = githubAgentHeaders(state)
  if (apiVersion) headers["x-github-api-version"] = apiVersion
  return headers
}

export async function ghRestRaw(
  method: GhRestMethod,
  path: string,
  opts: GhRestOptions = {},
): Promise<Response> {
  const url = `${GITHUB_API_BASE_URL}${path}`
  const requestInit: RequestInit = {
    method,
    headers: restHeaders(opts.apiVersion),
    signal: opts.signal,
  }

  if (opts.body !== undefined) requestInit.body = JSON.stringify(opts.body)

  try {
    return await fetchWithTransientRetry(
      () => fetch(url, requestInit),
      { label: `github-rest ${method} ${path}`, signal: opts.signal },
    )
  } catch (err) {
    consola.warn(`GitHub REST ${method} ${path} failed before response`, err)
    throw new AgentError("UPSTREAM", `GitHub REST ${method} ${path} failed`, {
      cause: err,
    })
  }
}

function rateLimitMessage(response: Response): string {
  const reset = response.headers.get("x-ratelimit-reset")
  const retryAfter = response.headers.get("retry-after")
  const suffix = reset
    ? `; reset at ${reset}`
    : retryAfter
      ? `; retry after ${retryAfter}s`
      : ""
  return `GitHub API rate limit exceeded${suffix}`
}

export function agentErrorFromResponse(
  response: Response,
  message = `GitHub API request failed with HTTP ${response.status}`,
): AgentError {
  let code: AgentErrorCode
  let errorMessage = message

  if (response.status === 401) {
    code = "AUTH_REVOKED"
    errorMessage = "GitHub agent token was revoked or is invalid"
  } else if (
    response.status === 403 &&
    response.headers.get("x-ratelimit-remaining") === "0"
  ) {
    code = "RATE_LIMITED"
    errorMessage = rateLimitMessage(response)
  } else if (response.status === 403) {
    code = "NO_WRITE_ACCESS"
    errorMessage = "GitHub agent token does not have write access"
  } else if (response.status === 404) {
    code = "NOT_FOUND"
    errorMessage = "GitHub resource was not found"
  } else if (response.status === 429) {
    code = "RATE_LIMITED"
    errorMessage = rateLimitMessage(response)
  } else {
    code = "UPSTREAM"
  }

  return new AgentError(code, errorMessage, {
    cause: new HTTPError(errorMessage, response),
  })
}

async function parseJsonOrEmpty<T>(response: Response): Promise<T> {
  if (response.status === 204) return {} as T

  const text = await response.text()
  if (!text.trim()) return {} as T

  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new AgentError("UPSTREAM", "GitHub API returned invalid JSON", {
      cause: err,
    })
  }
}

export async function ghRest<T>(
  method: GhRestMethod,
  path: string,
  opts: GhRestOptions = {},
): Promise<T> {
  const response = await ghRestRaw(method, path, opts)
  if (!response.ok) throw agentErrorFromResponse(response)
  return parseJsonOrEmpty<T>(response)
}
