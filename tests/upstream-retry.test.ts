/**
 * Tests for `src/lib/upstream-retry.ts` — the shared transient-failure
 * retry. Verifies it retries ONLY transient conditions, fails fast on
 * deterministic 4xx and user cancel, and bounds attempts.
 */

import { test, expect, describe } from "bun:test"

import {
  classifyTransportError,
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

/**
 * Classification is a total order: buckets are checked narrowest-first and the
 * first match wins. These build the VERBATIM nested error shapes Node produces
 * — an outer `TypeError: fetch failed` wrapping an OpenSSL/undici cause — because
 * the bug this replaces only reproduced through the nested `cause` chain.
 */
describe("classifyTransportError — TLS and session faults", () => {
  /** The shape undici/Node actually throws: generic outer, specific cause. */
  function fetchFailed(causeMessage: string, causeCode?: string): TypeError {
    const cause = Object.assign(new Error(causeMessage), causeCode ? { code: causeCode } : {})
    return new TypeError("fetch failed", { cause })
  }

  // The regression this fixes. `bad_record_mac` is an integrity fault a fresh
  // connection routinely clears, but every OpenSSL error message contains the
  // substring "SSL routines", so a blanket match on it classified the alert as
  // deterministic and failed the request after ONE attempt.
  test("TLS alert 20 (received) is transient, not deterministic", () => {
    const details = classifyTransportError(
      fetchFailed(
        "80DEFEF401000000:error:0A0003FC:SSL routines:ssl3_read_bytes:ssl/tls alert bad record mac:../deps/openssl/openssl/ssl/record/rec_layer_s3.c:918:SSL alert number 20",
        "ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC",
      ),
    )
    expect(details.classification).toBe("transient")
  })

  // OpenSSL's local-detection wording (reason 281) for the same class of fault.
  test("TLS alert 20 (locally detected) is transient", () => {
    const details = classifyTransportError(
      fetchFailed(
        "error:0A000119:SSL routines:ssl3_get_record:decryption failed or bad record mac",
      ),
    )
    expect(details.classification).toBe("transient")
  })

  // Promoting these was considered and rejected: they are genuine
  // configuration/protocol faults, and retrying them buys 3x latency.
  test.each([
    ["wrong version number", "error:0A00010B:SSL routines:ssl3_get_record:wrong version number"],
    ["handshake failure", "error:0A000410:SSL routines:ssl3_read_bytes:sslv3 alert handshake failure"],
    ["certificate verify failed", "error:0A000086:SSL routines:tls_post_process_server_certificate:certificate verify failed"],
  ])("deterministic TLS fault stays deterministic: %s", (_label, message) => {
    expect(classifyTransportError(fetchFailed(message)).classification).toBe(
      "deterministic",
    )
  })

  // Previously in NEITHER code set, so it escaped as "non_transport" and was
  // rethrown raw — an unclassified error leaking out of a classifier.
  test("UND_ERR_CLOSED is transient", () => {
    const err = Object.assign(new Error("The client is closed"), {
      code: "UND_ERR_CLOSED",
    })
    expect(classifyTransportError(err).classification).toBe("transient")
  })

  // These reached "transient" only incidentally, via the outer "fetch failed"
  // text. Named explicitly so a wording change upstream cannot reclassify them.
  test.each(["ERR_HTTP2_INVALID_SESSION", "ERR_HTTP2_GOAWAY_SESSION"])(
    "%s is transient by code, not by incidental message match",
    (code) => {
      const cause = Object.assign(new Error("The session has been destroyed"), {
        code,
      })
      // Outer message deliberately does NOT contain "fetch failed".
      const err = new TypeError("upstream dispatch failed", { cause })
      expect(classifyTransportError(err).classification).toBe("transient")
    },
  )

  test("a caller cancel outranks every other bucket", () => {
    const details = classifyTransportError(
      fetchFailed("ssl3_read_bytes:ssl/tls alert bad record mac"),
      { callerCancelled: true },
    )
    expect(details.classification).toBe("cancelled")
  })

  // The invariant that makes the order safe to reason about: no error may
  // satisfy two buckets. If a phrase is ever added to both lists, the bucket
  // order silently decides — this test makes that a failure instead.
  test("no error matches two buckets — transient and deterministic stay disjoint", () => {
    const transientPhrases = ["bad record mac"]
    const deterministicPhrases = [
      "self signed certificate",
      "certificate has expired",
      "unable to verify the first certificate",
      "unable to get local issuer certificate",
      "hostname/ip does not match certificate",
      "certificate verify failed",
      "unknown ca",
      "wrong version number",
      "unsupported protocol",
      "no protocols available",
      "alert handshake failure",
      "alert protocol version",
      "alert insufficient security",
      "tls handshake",
    ]
    for (const t of transientPhrases) {
      for (const d of deterministicPhrases) {
        expect(t.includes(d)).toBe(false)
        expect(d.includes(t)).toBe(false)
      }
    }
    // And each phrase resolves to the bucket it is declared for.
    for (const t of transientPhrases) {
      expect(classifyTransportError(fetchFailed(t)).classification).toBe("transient")
    }
    for (const d of deterministicPhrases) {
      expect(classifyTransportError(fetchFailed(d)).classification).toBe(
        "deterministic",
      )
    }
  })
})
