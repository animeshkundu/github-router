import { test, expect } from "bun:test"

import type { State } from "../src/lib/state"
import { HTTPError } from "../src/lib/error"
import { checkRateLimit } from "../src/lib/rate-limit"

test("checkRateLimit returns when disabled", async () => {
  const state = {
    accountType: "individual",
    manualApprove: false,
    rateLimitWait: false,
    showToken: false,
  } as State
  await checkRateLimit(state)
})

test("checkRateLimit initializes timestamp on first request", async () => {
  const state = {
    accountType: "individual",
    manualApprove: false,
    rateLimitWait: false,
    showToken: false,
    rateLimitSeconds: 10,
  } as State
  await checkRateLimit(state)
  expect(typeof state.lastRequestTimestamp).toBe("number")
})

test("checkRateLimit throws when limit exceeded without wait", async () => {
  const state = {
    accountType: "individual",
    manualApprove: false,
    rateLimitWait: false,
    showToken: false,
    rateLimitSeconds: 10,
    lastRequestTimestamp: Date.now(),
  } as State
  await expect(checkRateLimit(state)).rejects.toBeInstanceOf(HTTPError)
})
