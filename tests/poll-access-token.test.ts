import { test, expect, mock, afterEach } from "bun:test"

import { pollAccessToken } from "../src/services/github/poll-access-token"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("pollAccessToken stops when device code is expired", async () => {
  const fetchMock = mock(() => ({
    ok: true,
    json: () => ({}),
  }))
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  globalThis.fetch = fetchMock

  await expect(
    pollAccessToken({
      device_code: "device",
      user_code: "user",
      verification_uri: "https://example.com",
      expires_in: 0,
      interval: 0,
    }),
  ).rejects.toThrow("expired")

  expect(fetchMock).not.toHaveBeenCalled()
})

test("pollAccessToken returns access token when available", async () => {
  const fetchMock = mock(() => ({
    ok: true,
    json: () => ({ access_token: "token" }),
  }))
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  globalThis.fetch = fetchMock

  const token = await pollAccessToken({
    device_code: "device",
    user_code: "user",
    verification_uri: "https://example.com",
    expires_in: 10,
    interval: 0,
  })
  expect(token).toBe("token")
})

test("pollAccessToken retries after non-ok response", async () => {
  let calls = 0
  const fetchMock = mock(() => {
    calls += 1
    if (calls === 1) {
      return {
        ok: false,
        text: () => "error",
      }
    }
    return {
      ok: true,
      json: () => ({ access_token: "token-2" }),
    }
  })
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  globalThis.fetch = fetchMock

  const token = await pollAccessToken({
    device_code: "device",
    user_code: "user",
    verification_uri: "https://example.com",
    expires_in: 10,
    interval: 0,
  })
  expect(token).toBe("token-2")
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
