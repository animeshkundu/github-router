import { randomUUID } from "node:crypto"

import type { State } from "./state"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

const DEFAULT_COPILOT_VERSION = "0.43.2026033101"

function copilotVersion(state: State): string {
  return state.copilotVersion ?? DEFAULT_COPILOT_VERSION
}

const API_VERSION = "2025-10-01"

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
