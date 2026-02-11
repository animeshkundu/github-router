import { test, expect, mock, afterEach } from "bun:test"

import { HTTPError } from "../src/lib/error"
import { state } from "../src/lib/state"
import { getDeviceCode } from "../src/services/github/get-device-code"
import { getGitHubUser } from "../src/services/github/get-user"
import { getCopilotToken } from "../src/services/github/get-copilot-token"
import { getCopilotUsage } from "../src/services/github/get-copilot-usage"

state.githubToken = "gh-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("getDeviceCode returns device response", async () => {
  const fetchMock = mock(() => ({
    ok: true,
    json: () => ({
      device_code: "device",
      user_code: "user",
      verification_uri: "https://example.com",
      expires_in: 100,
      interval: 1,
    }),
  }))
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  globalThis.fetch = fetchMock

  const response = await getDeviceCode()
  expect(response.device_code).toBe("device")
})

test("getGitHubUser throws on failure", async () => {
  const fetchMock = mock(() => new Response("fail", { status: 500 }))
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  await expect(getGitHubUser()).rejects.toBeInstanceOf(HTTPError)
})

test("getCopilotToken returns token response", async () => {
  const fetchMock = mock(() => ({
    ok: true,
    json: () => ({ token: "copilot", refresh_in: 100, expires_at: 200 }),
  }))
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  globalThis.fetch = fetchMock

  const response = await getCopilotToken()
  expect(response.token).toBe("copilot")
})

test("getCopilotUsage throws on failure", async () => {
  const fetchMock = mock(() => new Response("fail", { status: 403 }))
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  await expect(getCopilotUsage()).rejects.toBeInstanceOf(HTTPError)
})
