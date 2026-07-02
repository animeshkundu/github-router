import consola from "consola"

import { githubAgentGraphQLHeaders, GITHUB_GRAPHQL_URL } from "~/lib/api-config"
import { state } from "~/lib/state"
import { fetchWithTransientRetry } from "~/lib/upstream-retry"

import { agentErrorFromResponse } from "./rest"
import { AgentError } from "./types"

export interface GhGraphQLOptions {
  features?: string
  signal?: AbortSignal
}

interface GraphQLErrorShape {
  message?: string
  type?: string
  extensions?: {
    code?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

interface GraphQLResponseShape<T> {
  data?: T
  errors?: GraphQLErrorShape[]
}

function graphQLErrorMessage(error: GraphQLErrorShape): string {
  return String(error.message ?? error.type ?? error.extensions?.code ?? "GraphQL error")
}

function isFeatureError(error: GraphQLErrorShape): boolean {
  const message = String(error.message ?? "").toLowerCase()
  const type = String(error.type ?? "").toLowerCase()
  const code = String(error.extensions?.code ?? "").toLowerCase()
  const haystack = `${message} ${type} ${code}`

  if (
    haystack.includes("unknown feature") ||
    haystack.includes("disabled feature") ||
    haystack.includes("feature flag") ||
    haystack.includes("graphql-features") ||
    haystack.includes("issues_copilot_assignment_api_support") ||
    haystack.includes("does not exist on type") ||
    haystack.includes("cannot query field") ||
    haystack.includes("undefined field")
  ) {
    return true
  }

  return (
    (type.includes("forbidden") || code.includes("forbidden")) &&
    (message.includes("feature") ||
      message.includes("preview") ||
      message.includes("copilot assignment"))
  )
}

async function parseGraphQLJson<T>(response: Response): Promise<GraphQLResponseShape<T>> {
  const text = await response.text()
  if (!text.trim()) return {}

  try {
    return JSON.parse(text) as GraphQLResponseShape<T>
  } catch (err) {
    throw new AgentError("UPSTREAM", "GitHub GraphQL returned invalid JSON", {
      cause: err,
    })
  }
}

export async function ghGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  opts: GhGraphQLOptions = {},
): Promise<T> {
  let response: Response
  try {
    response = await fetchWithTransientRetry(
      () =>
        fetch(GITHUB_GRAPHQL_URL, {
          method: "POST",
          headers: githubAgentGraphQLHeaders(state, opts.features),
          body: JSON.stringify({ query, variables }),
          signal: opts.signal,
        }),
      { label: "github-graphql", signal: opts.signal },
    )
  } catch (err) {
    consola.warn("GitHub GraphQL failed before response", err)
    throw new AgentError("UPSTREAM", "GitHub GraphQL request failed", {
      cause: err,
    })
  }

  if (!response.ok) throw agentErrorFromResponse(response, "GitHub GraphQL request failed")

  const payload = await parseGraphQLJson<T>(response)
  const errors = payload.errors?.filter(Boolean) ?? []
  if (errors.length > 0) {
    const message = errors.map(graphQLErrorMessage).join("; ")
    if (errors.some(isFeatureError)) {
      throw new AgentError("GRAPHQL_FEATURE", message)
    }
    throw new AgentError("UPSTREAM", message)
  }

  if (payload.data === undefined) {
    throw new AgentError("UPSTREAM", "GitHub GraphQL response did not include data")
  }

  return payload.data
}
