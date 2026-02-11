import { test, expect, mock } from "bun:test"

import { pollAccessToken } from "../src/services/github/poll-access-token"

const fetchMock = mock(() => {
  return {
    ok: true,
    json: () => ({}),
  }
})
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

test("pollAccessToken stops when device code is expired", async () => {
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
