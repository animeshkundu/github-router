import { describe, expect, test } from "bun:test"

import { ArtifactClient, ArtifactError } from "../../src/lib/artifact/client"

/**
 * Unit tests for the low-level ArtifactClient: HTTP-status → error-code mapping,
 * network-error mapping, empty/non-JSON body handling, and the timeout/abort
 * signal merge. These lock CURRENT behavior (client.ts), independent of the MCP
 * tool wrapper.
 */

interface ClientArgs {
  fetchFn: typeof fetch
  insecureTLS?: boolean
}

function makeClient(args: ClientArgs): ArtifactClient {
  return new ArtifactClient({
    baseUrl: "https://ai.example/",
    token: "tok-artifact",
    sessionId: "sess-1",
    fetchFn: args.fetchFn,
    insecureTLS: args.insecureTLS,
    // Instant retries so transient-retry paths don't add wall-clock to the suite.
    retryBaseMs: 0,
  })
}

/** Run a promise expected to reject and return the caught ArtifactError. */
async function catchArtifactError(run: () => Promise<unknown>): Promise<ArtifactError> {
  try {
    await run()
  } catch (err) {
    expect(err).toBeInstanceOf(ArtifactError)
    return err as ArtifactError
  }
  throw new Error("expected the client call to reject, but it resolved")
}

/**
 * A fetch that returns a FRESH Response per call. Retryable statuses (408/504)
 * are retried by the client, and a Response body can only be read once, so the
 * factory must mint a new body each attempt.
 */
function fetchReturning(make: () => Response): typeof fetch {
  return (async () => make()) as unknown as typeof fetch
}

function fetchThrowing(err: unknown): typeof fetch {
  return (async () => {
    throw err
  }) as unknown as typeof fetch
}

describe("ArtifactClient mapHttpError", () => {
  const cases: Array<{
    status: number
    code: ArtifactError["code"]
    retryable: boolean
    label: string
  }> = [
    { status: 401, code: "AUTH_FAILED", retryable: false, label: "401 → AUTH_FAILED (not retryable)" },
    { status: 403, code: "AUTH_FAILED", retryable: false, label: "403 → AUTH_FAILED (not retryable)" },
    { status: 404, code: "NOT_FOUND", retryable: false, label: "404 → NOT_FOUND (not retryable)" },
    { status: 408, code: "TIMEOUT", retryable: true, label: "408 → TIMEOUT (retryable)" },
    { status: 504, code: "TIMEOUT", retryable: true, label: "504 → TIMEOUT (retryable)" },
    { status: 429, code: "UPSTREAM_ERROR", retryable: true, label: "429 → UPSTREAM_ERROR (retryable)" },
    { status: 500, code: "UPSTREAM_ERROR", retryable: true, label: "500 → UPSTREAM_ERROR (retryable)" },
    { status: 503, code: "UPSTREAM_ERROR", retryable: true, label: "503 → UPSTREAM_ERROR (retryable)" },
    { status: 400, code: "UPSTREAM_ERROR", retryable: false, label: "400 → UPSTREAM_ERROR (not retryable)" },
  ]

  for (const c of cases) {
    test(c.label, async () => {
      const client = makeClient({
        fetchFn: fetchReturning(() => Response.json({ error: "upstream detail" }, { status: c.status })),
      })
      const err = await catchArtifactError(() => client.open("src/App.tsx"))
      expect(err.code).toBe(c.code)
      expect(err.retryable).toBe(c.retryable)
      expect(err.status).toBe(c.status)
      // Upstream detail message is appended to the error message.
      expect(err.message).toContain("upstream detail")
    })
  }

  test("extracts a nested {error:{message}} upstream detail", async () => {
    const client = makeClient({
      fetchFn: fetchReturning(() => Response.json({ error: { message: "session gone", code: "X" } }, { status: 404 })),
    })
    const err = await catchArtifactError(() => client.poll())
    expect(err.code).toBe("NOT_FOUND")
    expect(err.message).toContain("session gone")
  })
})

describe("ArtifactClient mapNetworkError", () => {
  test("an AbortError from fetch → TIMEOUT (retryable)", async () => {
    const client = makeClient({ fetchFn: fetchThrowing(new DOMException("aborted", "AbortError")) })
    const err = await catchArtifactError(() => client.open("f"))
    expect(err.code).toBe("TIMEOUT")
    expect(err.retryable).toBe(true)
  })

  test("a TimeoutError from fetch → TIMEOUT (retryable)", async () => {
    const client = makeClient({ fetchFn: fetchThrowing(new DOMException("timed out", "TimeoutError")) })
    const err = await catchArtifactError(() => client.open("f"))
    expect(err.code).toBe("TIMEOUT")
    expect(err.retryable).toBe(true)
  })

  test("any other fetch failure → UNREACHABLE (retryable), message carries the cause", async () => {
    const client = makeClient({ fetchFn: fetchThrowing(new TypeError("fetch failed")) })
    const err = await catchArtifactError(() => client.open("f"))
    expect(err.code).toBe("UNREACHABLE")
    expect(err.retryable).toBe(true)
    expect(err.message).toContain("fetch failed")
  })
})

describe("ArtifactClient body handling", () => {
  test("reply tolerates an empty body (allowEmptyJson) → {}", async () => {
    const client = makeClient({ fetchFn: fetchReturning(() => new Response(null, { status: 204 })) })
    expect(await client.agentReply("done")).toEqual({})
  })

  test("end tolerates an empty body (allowEmptyJson) → {}", async () => {
    const client = makeClient({ fetchFn: fetchReturning(() => new Response(null, { status: 204 })) })
    const result: unknown = await client.end()
    expect(result).toEqual({})
  })

  test("open with an empty body (no allowEmptyJson) → INVALID_RESPONSE", async () => {
    const client = makeClient({ fetchFn: fetchReturning(() => new Response("", { status: 200 })) })
    const err = await catchArtifactError(() => client.open("f"))
    expect(err.code).toBe("INVALID_RESPONSE")
    expect(err.retryable).toBe(false)
  })

  test("a non-JSON 200 body → INVALID_RESPONSE", async () => {
    const client = makeClient({ fetchFn: fetchReturning(() => new Response("not json at all", { status: 200 })) })
    const err = await catchArtifactError(() => client.poll())
    expect(err.code).toBe("INVALID_RESPONSE")
    expect(err.retryable).toBe(false)
  })

  test("a valid JSON body is parsed and returned", async () => {
    const client = makeClient({
      fetchFn: fetchReturning(() => Response.json({ sessionId: "sess-1", key: "k", viewUrl: "https://ai.example/v" })),
    })
    expect(await client.open("f")).toEqual({ sessionId: "sess-1", key: "k", viewUrl: "https://ai.example/v" })
  })
})

describe("ArtifactClient request shaping", () => {
  test("sends Bearer auth, redirect:error, JSON content-type only with a body", async () => {
    const seen: Array<{ url: string; method: string; auth?: string; redirect?: string; contentType?: string; body?: unknown }> = []
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      seen.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        auth: headers?.Authorization,
        redirect: init?.redirect,
        contentType: headers?.["Content-Type"],
        body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
      })
      return Response.json({ ok: true })
    }) as unknown as typeof fetch

    const client = makeClient({ fetchFn })
    await client.open("src/App.tsx") // POST with body
    await client.poll() // GET without body

    expect(seen[0]).toEqual({
      url: "https://ai.example/api/artifact/sess-1/open",
      method: "POST",
      auth: "Bearer tok-artifact",
      redirect: "error",
      contentType: "application/json",
      body: { file: "src/App.tsx" },
    })
    expect(seen[1]).toEqual({
      url: "https://ai.example/api/artifact/sess-1/poll",
      method: "GET",
      auth: "Bearer tok-artifact",
      redirect: "error",
      contentType: undefined,
      body: undefined,
    })
  })

  test("session id is URL-encoded in the path", async () => {
    let capturedUrl = ""
    const fetchFn = (async (url: string | URL | Request) => {
      capturedUrl = url.toString()
      return Response.json({ ok: true })
    }) as unknown as typeof fetch
    const client = new ArtifactClient({
      baseUrl: "https://ai.example",
      token: "t",
      sessionId: "inst:local id",
      fetchFn,
    })
    await client.end()
    expect(capturedUrl).toBe("https://ai.example/api/artifact/inst%3Alocal%20id/end")
  })
})

describe("ArtifactClient timeout / abort signal merge", () => {
  /**
   * A fetch that never resolves on its own; it rejects with the init.signal's
   * abort reason when the merged controller aborts, exactly as a real fetch does.
   */
  const abortAwareFetch: typeof fetch = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const sig = init?.signal
      const fail = (): void => reject(sig?.reason ?? new DOMException("aborted", "AbortError"))
      if (sig?.aborted) {
        fail()
        return
      }
      sig?.addEventListener("abort", fail, { once: true })
    })) as unknown as typeof fetch

  test("the poll timeout hint fires → TIMEOUT", async () => {
    const client = makeClient({ fetchFn: abortAwareFetch })
    // Tiny hint so the internal timer aborts quickly.
    const err = await catchArtifactError(() => client.poll(20))
    expect(err.code).toBe("TIMEOUT")
    expect(err.retryable).toBe(true)
  })

  test("an already-aborted caller signal aborts the request → TIMEOUT", async () => {
    const client = makeClient({ fetchFn: abortAwareFetch })
    const controller = new AbortController()
    controller.abort(new DOMException("caller cancelled", "AbortError"))
    // A timeout hint is present so the merge path (combineSignalAndTimeout) runs.
    const err = await catchArtifactError(() => client.poll(10_000, controller.signal))
    expect(err.code).toBe("TIMEOUT")
  })

  test("a caller signal aborted mid-flight aborts the request → TIMEOUT", async () => {
    const client = makeClient({ fetchFn: abortAwareFetch })
    const controller = new AbortController()
    const pending = catchArtifactError(() => client.poll(10_000, controller.signal))
    // Abort after the request is in flight.
    setTimeout(() => controller.abort(new DOMException("cancelled", "AbortError")), 10)
    const err = await pending
    expect(err.code).toBe("TIMEOUT")
  })
})

describe("ArtifactClient retry + idempotency (v2.2 §1.1)", () => {
  function captureFetch(
    plan: (call: number, key: string | undefined) => Response | Error,
  ): { fetchFn: typeof fetch; keys: Array<string | undefined>; calls: () => number } {
    const keys: Array<string | undefined> = []
    let n = 0
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      n += 1
      const key = (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"]
      keys.push(key)
      const out = plan(n, key)
      if (out instanceof Error) throw out
      return out
    }) as unknown as typeof fetch
    return { fetchFn, keys, calls: () => n }
  }

  test("open retries a transient failure and reuses ONE stable idempotency key", async () => {
    const cap = captureFetch((call) =>
      call === 1
        ? new TypeError("network down") // -> UNREACHABLE (retryable)
        : Response.json({ sessionId: "s", key: "k", viewUrl: "https://ai.example/v" }),
    )
    const client = makeClient({ fetchFn: cap.fetchFn })
    const res = await client.open("f")
    expect(res).toEqual({ sessionId: "s", key: "k", viewUrl: "https://ai.example/v" })
    expect(cap.keys.length).toBe(2)
    expect(cap.keys[0]).toBeDefined()
    // A retry that lands after a first-attempt success must dedupe -> same key.
    expect(cap.keys[0]).toBe(cap.keys[1])
  })

  test("open gives up after the retry budget (1 + 2 retries) on a persistent failure", async () => {
    const cap = captureFetch(() => new TypeError("still down"))
    const client = makeClient({ fetchFn: cap.fetchFn })
    const err = await catchArtifactError(() => client.open("f"))
    expect(err.code).toBe("UNREACHABLE")
    expect(cap.calls()).toBe(3)
  })

  test("caller-supplied idempotencyKey is used verbatim on update", async () => {
    const cap = captureFetch(() => Response.json({ ok: true, viewUrl: "v" }))
    const client = makeClient({ fetchFn: cap.fetchFn })
    await client.update({ file: "f", idempotencyKey: "caller-key-123" })
    expect(cap.keys[0]).toBe("caller-key-123")
  })

  test("reply is single-shot: a transient failure is NOT retried", async () => {
    const cap = captureFetch(() => new TypeError("down"))
    const client = makeClient({ fetchFn: cap.fetchFn })
    const err = await catchArtifactError(() => client.agentReply("x"))
    expect(err.code).toBe("UNREACHABLE")
    expect(cap.calls()).toBe(1)
  })

  test("refresh and dismiss are single-shot (no retry)", async () => {
    const capR = captureFetch(() => new TypeError("down"))
    await catchArtifactError(() => makeClient({ fetchFn: capR.fetchFn }).refresh())
    expect(capR.calls()).toBe(1)
    const capD = captureFetch(() => new TypeError("down"))
    await catchArtifactError(() => makeClient({ fetchFn: capD.fetchFn }).dismiss())
    expect(capD.calls()).toBe(1)
  })

  test("does not retry once the caller signal is aborted", async () => {
    const controller = new AbortController()
    const cap = captureFetch(() => {
      // Abort the caller between attempts so the retry loop must stop.
      controller.abort(new DOMException("cancelled", "AbortError"))
      return new TypeError("down")
    })
    const client = makeClient({ fetchFn: cap.fetchFn })
    await catchArtifactError(() => client.open("f", { signal: controller.signal }))
    expect(cap.calls()).toBe(1)
  })
})

describe("ArtifactClient INVALID_REQUEST + end idempotence", () => {
  test("400 tagged INVALID_REQUEST -> INVALID_REQUEST (non-retryable)", async () => {
    const client = makeClient({
      fetchFn: fetchReturning(() =>
        Response.json({ error: { code: "INVALID_REQUEST", message: "html requires an existing review" } }, { status: 400 })),
    })
    const err = await catchArtifactError(() => client.update({ html: "<p>x</p>" }))
    expect(err.code).toBe("INVALID_REQUEST")
    expect(err.retryable).toBe(false)
    expect(err.status).toBe(400)
    expect(err.message).toContain("html requires an existing review")
  })

  test("a plain 400 (no code) stays UPSTREAM_ERROR", async () => {
    const client = makeClient({ fetchFn: fetchReturning(() => Response.json({ error: "bad" }, { status: 400 })) })
    const err = await catchArtifactError(() => client.update({ file: "f" }))
    expect(err.code).toBe("UPSTREAM_ERROR")
  })

  test("end maps a 404 (already ended) to ok:true status:ended", async () => {
    const client = makeClient({ fetchFn: fetchReturning(() => Response.json({ error: "not found" }, { status: 404 })) })
    expect(await client.end()).toEqual({ ok: true, status: "ended" })
  })

  test("end passes a successful server payload through", async () => {
    const client = makeClient({ fetchFn: fetchReturning(() => Response.json({ ok: true, status: "ended" })) })
    expect(await client.end()).toEqual({ ok: true, status: "ended" })
  })
})

describe("ArtifactClient awaitEvents (typed drain + cursor)", () => {
  test("sends timeoutMs (omits cursor on first call), returns typed events + cursor", async () => {
    const urls: string[] = []
    const fetchFn = (async (url: string | URL | Request) => {
      urls.push(url.toString())
      return Response.json({
        events: [{ kind: "action", id: "7", action: "approve", elementId: "step-1" }],
        status: "open",
        cursor: "7",
      })
    }) as unknown as typeof fetch
    const client = makeClient({ fetchFn })
    const r1 = await client.awaitEvents({})
    expect(r1.cursor).toBe("7")
    expect(r1.status).toBe("open")
    expect(r1.events[0]).toMatchObject({ kind: "action", id: "7", elementId: "step-1" })
    await client.awaitEvents({ cursor: r1.cursor, timeoutMs: 5000 })
    expect(urls[0]).toContain("/await?")
    expect(urls[0]).toContain("timeoutMs=25000")
    expect(urls[0]).not.toContain("cursor=")
    expect(urls[1]).toContain("cursor=7")
    expect(urls[1]).toContain("timeoutMs=5000")
  })

  test("re-calling with the same cursor replays the same window (idempotent by cursor)", async () => {
    const fetchFn = (async (url: string | URL | Request) => {
      const c = new URL(url.toString()).searchParams.get("cursor")
      const events = c === "3" ? [{ kind: "comment", id: "4", prompt: "x", text: "", selector: "" }] : []
      return Response.json({ events, status: "open", cursor: events.length ? "4" : c })
    }) as unknown as typeof fetch
    const client = makeClient({ fetchFn })
    const a = await client.awaitEvents({ cursor: "3" })
    const b = await client.awaitEvents({ cursor: "3" })
    expect(a).toEqual(b)
    expect(a.events[0]).toMatchObject({ id: "4" })
  })

  test("retries a transient network failure (cursor makes retry safe)", async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      if (calls === 1) throw new TypeError("down")
      return Response.json({ events: [], status: "open", cursor: "0" })
    }) as unknown as typeof fetch
    const client = makeClient({ fetchFn })
    const r = await client.awaitEvents({})
    expect(calls).toBe(2)
    expect(r.status).toBe("open")
  })
})

describe("ArtifactClient awaitEvents does not re-hold on a TIMEOUT", () => {
  test("a long-hold TIMEOUT is surfaced without retry (caller re-awaits with cursor)", async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      // A client-side long-hold timeout maps to TIMEOUT; await must NOT re-hold.
      throw new DOMException("long-hold expired", "TimeoutError")
    }) as unknown as typeof fetch
    const client = makeClient({ fetchFn })
    const err = await catchArtifactError(() => client.awaitEvents({ cursor: "3" }))
    expect(err.code).toBe("TIMEOUT")
    expect(calls).toBe(1)
  })

  test("but a UNREACHABLE (connection failure) IS retried for await", async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      if (calls === 1) throw new TypeError("connection refused")
      return Response.json({ events: [], status: "open", cursor: "3" })
    }) as unknown as typeof fetch
    const client = makeClient({ fetchFn })
    const r = await client.awaitEvents({ cursor: "3" })
    expect(calls).toBe(2)
    expect(r.status).toBe("open")
  })
})
