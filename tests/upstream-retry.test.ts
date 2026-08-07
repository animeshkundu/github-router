/**
 * Tests for `src/lib/upstream-retry.ts` — the shared transient-failure
 * retry. Verifies it retries ONLY transient conditions, fails fast on
 * deterministic 4xx and user cancel, and bounds attempts.
 */

import { test, expect, describe } from "bun:test"

import {
  fetchWithTransientRetry,
  TransportExhaustionError,
  withTransientRetry,
} from "../src/lib/upstream-retry"

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

  test("transient transport exhaustion throws bounded diagnostic metadata", async () => {
    let calls = 0
    const cause = Object.assign(new Error("socket reset"), {
      code: "ECONNRESET",
    })
    let thrown: unknown
    try {
      await fetchWithTransientRetry(async () => {
        calls++
        throw new TypeError("fetch failed", { cause })
      }, {
        ...FAST,
        attempts: 3,
        label: "/v1/messages",
      })
    } catch (error) {
      thrown = error
    }

    expect(calls).toBe(3)
    expect(thrown).toBeInstanceOf(TransportExhaustionError)
    const transport = thrown as TransportExhaustionError
    expect(transport.endpoint).toBe("/v1/messages")
    expect(transport.label).toBe("/v1/messages")
    expect(transport.attempts).toBe(3)
    expect(transport.classification).toBe("transient")
    expect(transport.lastError).toEqual({
      name: "TypeError",
      message: "fetch failed",
      code: undefined,
      causeCode: "ECONNRESET",
    })
    expect(transport.cause).toBeInstanceOf(TypeError)
  })

  test("deterministic connectivity errors are wrapped once without retry", async () => {
    let calls = 0
    let thrown: unknown
    try {
      await fetchWithTransientRetry(async () => {
        calls++
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.invalid"), {
            code: "ENOTFOUND",
          }),
        })
      }, { ...FAST, attempts: 3, endpoint: "https://api.invalid" })
    } catch (error) {
      thrown = error
    }

    expect(calls).toBe(1)
    expect(thrown).toBeInstanceOf(TransportExhaustionError)
    const transport = thrown as TransportExhaustionError
    expect(transport.classification).toBe("deterministic")
    expect(transport.attempts).toBe(1)
    expect(transport.lastError.causeCode).toBe("ENOTFOUND")
  })

  test("connection refusal and TLS certificate failures are deterministic", async () => {
    for (const code of ["ECONNREFUSED", "CERT_HAS_EXPIRED"]) {
      let calls = 0
      let thrown: unknown
      try {
        await fetchWithTransientRetry(async () => {
          calls++
          throw Object.assign(new Error(`connect failed: ${code}`), { code })
        }, { ...FAST, attempts: 3 })
      } catch (error) {
        thrown = error
      }

      expect(calls).toBe(1)
      expect(thrown).toBeInstanceOf(TransportExhaustionError)
      expect((thrown as TransportExhaustionError).classification).toBe(
        "deterministic",
      )
    }
  })

  test("EAI_AGAIN remains a retryable DNS lookup failure", async () => {
    let calls = 0
    const result = await fetchWithTransientRetry(async () => {
      calls++
      if (calls === 1) {
        throw Object.assign(new Error("temporary DNS failure"), {
          code: "EAI_AGAIN",
        })
      }
      return resp(200)
    }, { ...FAST, attempts: 2 })

    expect(result.status).toBe(200)
    expect(calls).toBe(2)
  })

  test("rethrows a non-transient error without retry", async () => {
    let calls = 0
    const applicationError = new Error("malformed body: invalid JSON")
    let thrown: unknown
    try {
      await fetchWithTransientRetry(async () => {
        calls++
        throw applicationError
      }, { ...FAST, attempts: 3 })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBe(applicationError)
    expect(thrown).not.toBeInstanceOf(TransportExhaustionError)
    expect(calls).toBe(1)
  })

  test("withTransientRetry adds metadata only when thrown transport retries exhaust", async () => {
    let calls = 0
    let thrown: unknown
    try {
      await withTransientRetry(async () => {
        calls++
        throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
      }, { ...FAST, attempts: 2, label: "advisor" })
    } catch (error) {
      thrown = error
    }

    expect(calls).toBe(2)
    expect(thrown).toBeInstanceOf(TransportExhaustionError)
    const transport = thrown as TransportExhaustionError
    expect(transport.label).toBe("advisor")
    expect(transport.attempts).toBe(2)
    expect(transport.classification).toBe("transient")
    expect(transport.lastError.code).toBe("EPIPE")
  })

  test("withTransientRetry preserves HTTP-style errors after status exhaustion", async () => {
    const httpError = Object.assign(new Error("upstream HTTP 503"), {
      response: resp(503),
    })
    let calls = 0
    let thrown: unknown
    try {
      await withTransientRetry(async () => {
        calls++
        throw httpError
      }, { ...FAST, attempts: 3 })
    } catch (error) {
      thrown = error
    }

    expect(calls).toBe(3)
    expect(thrown).toBe(httpError)
    expect(thrown).not.toBeInstanceOf(TransportExhaustionError)
  })

  test("withTransientRetry preserves deterministic application errors", async () => {
    const applicationError = new Error("schema validation failed")
    await expect(
      withTransientRetry(async () => {
        throw applicationError
      }, { ...FAST, attempts: 3 }),
    ).rejects.toBe(applicationError)
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

  test("a user cancel during fetch preserves the original abort error", async () => {
    const ac = new AbortController()
    const abortError = new DOMException("cancelled by caller", "AbortError")
    let thrown: unknown
    try {
      await fetchWithTransientRetry(async () => {
        ac.abort()
        throw abortError
      }, { ...FAST, attempts: 3, signal: ac.signal })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBe(abortError)
    expect(thrown).not.toBeInstanceOf(TransportExhaustionError)
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
