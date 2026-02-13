import { test, expect } from "bun:test"

import type { State } from "../src/lib/state"
import {
  copilotBaseUrl,
  copilotHeaders,
  githubHeaders,
  standardHeaders,
} from "../src/lib/api-config"

const baseState: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  sessionId: "test-session-id",
  machineId: "test-machine-id",
}

test("copilotBaseUrl uses individual and enterprise formats", () => {
  expect(copilotBaseUrl({ ...baseState, accountType: "individual" })).toBe(
    "https://api.githubcopilot.com",
  )
  expect(copilotBaseUrl({ ...baseState, accountType: "enterprise" })).toBe(
    "https://api.enterprise.githubcopilot.com",
  )
})

test("copilotHeaders include auth and vision flag", () => {
  const headers = copilotHeaders(
    {
      ...baseState,
      copilotToken: "token",
      vsCodeVersion: "1.2.3",
    },
    true,
  )

  expect(headers.Authorization).toBe("Bearer token")
  expect(headers["copilot-vision-request"]).toBe("true")
  expect(headers["content-type"]).toBe(standardHeaders()["content-type"])
})

test("githubHeaders include token and version headers", () => {
  const headers = githubHeaders({
    ...baseState,
    githubToken: "gh",
    vsCodeVersion: "2.0.0",
  })
  expect(headers.authorization).toBe("token gh")
  expect(headers["editor-version"]).toBe("vscode/2.0.0")
})
