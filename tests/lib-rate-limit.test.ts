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

test(
  "queue-timed-out request does NOT mutate state.lastRequestTimestamp later",
  async () => {
    // Regression for codex_reviewer batch3 finding #1: when a request is
    // queue-timed-out and returns 429, the chained doCheck() must observe
    // the aborted flag and skip the timestamp-write that would have
    // penalised the next legitimate request.
    //
    // Setup: rateLimitSeconds = 6s causes doCheck to want to sleep ~6s,
    // exceeding the 5s queue-wait cap. We let doCheck complete (it
    // wakes up at ~6s), then assert the timestamp was NOT bumped by
    // the timed-out request.
    const baseTs = Date.now() - 100 // small offset so elapsed > 0
    const state = {
      accountType: "individual",
      manualApprove: false,
      rateLimitWait: true, // wait mode → sleeps instead of throwing immediately
      showToken: false,
      rateLimitSeconds: 6,
      lastRequestTimestamp: baseTs,
    } as State

    const req = checkRateLimit(state)

    // Queue-cap fires at 5s; doCheck is still sleeping until ~6s.
    await expect(req).rejects.toBeInstanceOf(HTTPError)

    // Wait long enough for doCheck to wake up from its sleep and
    // (correctly) skip the timestamp-write because the ticket is aborted.
    await new Promise((r) => setTimeout(r, 1500))

    // Critical: timestamp NOT moved forward by the timed-out request.
    // (The next REAL request must see the original timestamp, not one
    // bumped by an already-rejected request.)
    expect(state.lastRequestTimestamp).toBe(baseTs)
  },
  10_000,
)
