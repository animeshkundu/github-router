import { randomUUID } from "node:crypto"

import type { State } from "./state"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

const DEFAULT_COPILOT_VERSION = "0.43.2026033101"

export function copilotVersion(state: State): string {
  return state.copilotVersion ?? DEFAULT_COPILOT_VERSION
}

const API_VERSION = "2026-01-09"

export const copilotBaseUrl = (state: State) =>
  state.copilotApiUrl ?? "https://api.githubcopilot.com"
export const copilotHeaders = (
  state: State,
  vision: boolean = false,
  integrationId: string = "vscode-chat",
) => {
  const version = copilotVersion(state)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": integrationId,
    "editor-version": `vscode/${state.vsCodeVersion}`,
    "editor-plugin-version": `copilot-chat/${version}`,
    "user-agent": `GitHubCopilotChat/${version}`,
    "openai-intent": "conversation-panel",
    "x-interaction-type": "conversation-panel",
    "x-github-api-version": API_VERSION,
    "x-request-id": randomUUID(),
    "x-vscode-user-agent-library-version": "electron-fetch",
    "VScode-SessionId": state.sessionId,
    "VScode-MachineId": state.machineId,
  }

  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}

export const GITHUB_API_BASE_URL =
  process.env.GITHUB_API_URL ?? "https://api.github.com"
export const githubHeaders = (state: State) => ({
  ...standardHeaders(),
  authorization: `token ${state.githubToken}`,
  "editor-version": `vscode/${state.vsCodeVersion}`,
  "editor-plugin-version": `copilot-chat/${copilotVersion(state)}`,
  "user-agent": `GitHubCopilotChat/${copilotVersion(state)}`,
  "x-github-api-version": API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")

// --- First-mate agent-orchestration write identity (`--agents`) ---------
// The Copilot device-login token above (a GitHub *App* token, read:user)
// can READ the agent surface but 403s on any write/push. The first-mate
// controller needs a WRITE-capable token to create issues, assign cloud
// coding agents, comment, dispatch workflows, and merge. We mint a second,
// isolated token via a separate device-flow login against the GitHub CLI's
// public OAuth client (a classic OAuth App that honors the requested
// scopes — verified to accept `repo workflow read:org` at
// `/login/device/code`). Stored apart at PATHS.GITHUB_AGENT_TOKEN_PATH;
// never mixed with `state.githubToken`.
export const GITHUB_AGENT_CLIENT_ID = "178c6fc778ccc68e1d6a"
export const GITHUB_AGENT_SCOPES = ["repo", "workflow", "read:org"].join(" ")
export const GITHUB_GRAPHQL_URL =
  process.env.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql"
// GitHub's documented REST/GraphQL API version for the general-purpose
// (non-Copilot) surface the first-mate layer drives. The Agent-Tasks
// preview client overrides this per-call with its own dated version.
export const GITHUB_REST_API_VERSION = "2022-11-28"
export const githubAgentHeaders = (state: State) => ({
  ...standardHeaders(),
  authorization: `token ${state.githubAgentToken}`,
  "x-github-api-version": GITHUB_REST_API_VERSION,
  "user-agent": "github-router-first-mate",
})
export const githubAgentGraphQLHeaders = (state: State, features?: string) => ({
  ...githubAgentHeaders(state),
  ...(features ? { "GraphQL-Features": features } : {}),
})
