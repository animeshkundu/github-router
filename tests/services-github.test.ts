import { test, expect, mock, afterEach } from "bun:test"

import { HTTPError } from "../src/lib/error"
import { state, type State } from "../src/lib/state"
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

test("getCopilotToken honors allowlisted endpoints.api", async () => {
  const saved = state.copilotApiUrl
  try {
    state.copilotApiUrl = undefined
    const fetchMock = mock(() => ({
      ok: true,
      json: () => ({
        token: "copilot",
        refresh_in: 100,
        expires_at: 200,
        endpoints: { api: "https://api.enterprise.githubcopilot.com" },
      }),
    }))
    // @ts-expect-error - mock fetch
    globalThis.fetch = fetchMock

    await getCopilotToken()
    expect((state as State).copilotApiUrl).toBe(
      "https://api.enterprise.githubcopilot.com",
    )
  } finally {
    state.copilotApiUrl = saved
  }
})

test("getCopilotToken rejects disallowed endpoints.api but does NOT clobber an existing override", async () => {
  // Regression: prior behavior set state.copilotApiUrl=undefined when the
  // token-response value failed the allowlist, even if the user had already
  // set state.copilotApiUrl via the COPILOT_API_URL env var (a deliberate
  // opt-in for local testing / CI mocks). That broke the node-compat smoke
  // test. The allowlist gates the token-response value only — env-var
  // overrides are user-trusted and must survive an allowlist miss.
  const saved = state.copilotApiUrl
  try {
    state.copilotApiUrl = "http://127.0.0.1:19877" // simulate env-var override
    const fetchMock = mock(() => ({
      ok: true,
      json: () => ({
        token: "copilot",
        refresh_in: 100,
        expires_at: 200,
        endpoints: { api: "http://127.0.0.1:19877" }, // allowlist-failing
      }),
    }))
    // @ts-expect-error - mock fetch
    globalThis.fetch = fetchMock

    await getCopilotToken()
    expect(state.copilotApiUrl).toBe("http://127.0.0.1:19877")
  } finally {
    state.copilotApiUrl = saved
  }
})

test("getCopilotToken leaves state.copilotApiUrl undefined when no env override and disallowed endpoint", async () => {
  const saved = state.copilotApiUrl
  try {
    state.copilotApiUrl = undefined
    const fetchMock = mock(() => ({
      ok: true,
      json: () => ({
        token: "copilot",
        refresh_in: 100,
        expires_at: 200,
        endpoints: { api: "https://attacker.example.com" },
      }),
    }))
    // @ts-expect-error - mock fetch
    globalThis.fetch = fetchMock

    await getCopilotToken()
    // No prior override → still undefined → consumers fall back to the default
    expect((state as State).copilotApiUrl).toBeUndefined()
  } finally {
    state.copilotApiUrl = saved
  }
})

test("getCopilotUsage throws on failure", async () => {
  const fetchMock = mock(() => new Response("fail", { status: 403 }))
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  await expect(getCopilotUsage()).rejects.toBeInstanceOf(HTTPError)
})
