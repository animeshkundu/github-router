/**
 * Tests for `src/lib/upstream-retry.ts` — the shared transient-failure
 * retry. Verifies it retries ONLY transient conditions, fails fast on
 * deterministic 4xx and user cancel, and bounds attempts.
 */

import { test, expect, describe } from "bun:test"

import { fetchWithTransientRetry } from "../src/lib/upstream-retry"

function resp(status: number, headers?: Record<string, string>): Response {
  return new Response(status === 204 ? null : `body-${status}`, { status, headers })
}

const FAST = { baseDelayMs: 1, maxDelayMs: 4 }

describe("fetchWithTransientRetry", () => {
  test("returns immediately on success — no retry", async () => {
    let calls = 0
    const r = await fetchWithTransientRetry(async () => {
      calls++
      return resp(200)
    }, FAST)
    expect(r.status).toBe(200)
    expect(calls).toBe(1)
  })

  test("retries a transient 502 then returns the 200", async () => {
    let calls = 0
    const r = await fetchWithTransientRetry(async () => {
      calls++
      return calls < 3 ? resp(502) : resp(200)
    }, { ...FAST, attempts: 3 })
    expect(r.status).toBe(200)
    expect(calls).toBe(3)
  })

  test("does NOT retry a deterministic 400 — fails fast", async () => {
    let calls = 0
    const r = await fetchWithTransientRetry(async () => {
      calls++
      return resp(400)
    }, { ...FAST, attempts: 3 })
    expect(r.status).toBe(400)
    expect(calls).toBe(1)
  })

  test("does NOT retry a 401 (token-refresh path owns it)", async () => {
    let calls = 0
    const r = await fetchWithTransientRetry(async () => {
      calls++
      return resp(401)
    }, { ...FAST, attempts: 3 })
    expect(r.status).toBe(401)
    expect(calls).toBe(1)
  })

  test("retries 429 (rate limit)", async () => {
    let calls = 0
    const r = await fetchWithTransientRetry(async () => {
      calls++
      return calls < 2 ? resp(429) : resp(200)
    }, { ...FAST, attempts: 3 })
    expect(r.status).toBe(200)
    expect(calls).toBe(2)
  })

  test("exhausts attempts on a persistent 503 and returns the last response", async () => {
    let calls = 0
    const r = await fetchWithTransientRetry(async () => {
      calls++
      return resp(503)
    }, { ...FAST, attempts: 3 })
    expect(r.status).toBe(503)
    expect(calls).toBe(3) // first + 2 retries
  })

  test("retries a transient network error (terminated) then succeeds", async () => {
    let calls = 0
    const r = await fetchWithTransientRetry(async () => {
      calls++
      if (calls < 2) throw new TypeError("terminated")
      return resp(200)
    }, { ...FAST, attempts: 3 })
    expect(r.status).toBe(200)
    expect(calls).toBe(2)
  })

  test("rethrows a non-transient error without retry", async () => {
    let calls = 0
    await expect(
      fetchWithTransientRetry(async () => {
        calls++
        throw new Error("malformed body: invalid JSON")
      }, { ...FAST, attempts: 3 }),
    ).rejects.toThrow(/malformed/)
    expect(calls).toBe(1)
  })

  test("a user cancel (aborted signal) fails fast — never retried", async () => {
    const ac = new AbortController()
    ac.abort()
    let calls = 0
    await expect(
      fetchWithTransientRetry(async () => {
        calls++
        return resp(502)
      }, { ...FAST, attempts: 3, signal: ac.signal }),
    ).rejects.toThrow()
    expect(calls).toBe(0) // aborted before the first attempt
  })

  test("a thrown abort while the caller signal is NOT aborted is treated as a retryable timeout", async () => {
    let calls = 0
    const r = await fetchWithTransientRetry(async () => {
      calls++
      if (calls < 2) {
        const e = new DOMException("timed out", "AbortError")
        throw e
      }
      return resp(200)
    }, { ...FAST, attempts: 3 })
    expect(r.status).toBe(200)
    expect(calls).toBe(2)
  })

  test("attempts:1 means no retry", async () => {
    let calls = 0
    const r = await fetchWithTransientRetry(async () => {
      calls++
      return resp(502)
    }, { ...FAST, attempts: 1 })
    expect(r.status).toBe(502)
    expect(calls).toBe(1)
  })
})
