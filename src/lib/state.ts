import { randomBytes, randomUUID } from "node:crypto"

import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  copilotApiUrl?: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Persistent session identifiers to match VS Code fingerprint
  sessionId: string
  machineId: string
}

export const state: State = {
  accountType: "enterprise",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  sessionId: randomUUID(),
  machineId: randomBytes(32).toString("hex"),
}
