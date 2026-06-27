import { describe, expect, mock, test } from "bun:test"

import {
  FleetClient,
  FleetError,
  decodeSessionId,
  encodeSessionId,
} from "../../src/lib/fleet/client"

async function expectFleetError(promise: Promise<unknown>, code: FleetError["code"]): Promise<void> {
  try {
    await promise
    throw new Error("expected FleetError")
  } catch (err) {
    expect(err).toBeInstanceOf(FleetError)
    expect((err as FleetError).code).toBe(code)
  }
}

describe("fleet client session id helpers", () => {
  test("encodeSessionId/decodeSessionId round-trip and split on the first colon", () => {
    const encoded = encodeSessionId("iad", "sess:with:colon")

    expect(encoded).toBe("iad:sess:with:colon")
    expect(decodeSessionId(encoded)).toEqual({ instanceId: "iad", localId: "sess:with:colon" })
  })
})

describe("FleetClient request bodies", () => {
  test("createSession sends idempotencyKey in the request body", async () => {
    const calls: Array<{ url: string; body?: unknown }> = []
    const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: url.toString(),
        body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
      })
      return Response.json({ sessionId: "created", lifecycle: "created" })
    }) as unknown as typeof fetch
    const client = new FleetClient({ url: "https://alpha.example", token: "secret", fetchFn })

    await client.createSession({ agent: "codex", name: "Created", idempotencyKey: "idem-create" })

    expect(calls[0]).toEqual({
      url: "https://alpha.example/api/control/sessions/create",
      body: { agent: "codex", name: "Created", idempotencyKey: "idem-create" },
    })
  })

  test("stopSession sends idempotencyKey in the request body", async () => {
    const calls: Array<{ url: string; body?: unknown }> = []
    const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: url.toString(),
        body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
      })
      return Response.json({ stopped: true, lifecycle: "stopped" })
    }) as unknown as typeof fetch
    const client = new FleetClient({ url: "https://alpha.example", token: "secret", fetchFn })

    await client.stopSession("local", { mode: "graceful", idempotencyKey: "idem-stop" })

    expect(calls[0]).toEqual({
      url: "https://alpha.example/api/control/sessions/local/stop",
      body: { mode: "graceful", idempotencyKey: "idem-stop" },
    })
  })
})

describe("FleetClient error mapping", () => {
  test("maps 401 to AUTH_FAILED", async () => {
    const fetchFn = mock(async () =>
      new Response(JSON.stringify({ error: { code: "bad_token", message: "bad token" } }), { status: 401 }),
    ) as unknown as typeof fetch
    const client = new FleetClient({ url: "https://alpha.example", token: "secret", fetchFn })

    await expectFleetError(client.listSessions(), "AUTH_FAILED")
  })

  test("maps 404 to SESSION_NOT_FOUND", async () => {
    const fetchFn = mock(async () =>
      new Response(JSON.stringify({ error: { code: "missing", message: "missing" } }), { status: 404 }),
    ) as unknown as typeof fetch
    const client = new FleetClient({ url: "https://alpha.example", token: "secret", fetchFn })

    await expectFleetError(client.status("nope"), "SESSION_NOT_FOUND")
  })

  test("maps network throws to UNREACHABLE", async () => {
    const fetchFn = mock(async () => {
      throw new Error("socket hang up")
    }) as unknown as typeof fetch
    const client = new FleetClient({ url: "https://alpha.example", token: "secret", fetchFn })

    await expectFleetError(client.listSessions(), "UNREACHABLE")
  })
})

describe("FleetClient F4 connectivity classification", () => {
  const DEVTUNNEL_URL = "https://abc-3000.uks1.devtunnels.ms"

  function clientWith(url: string, fetchFn: typeof fetch): FleetClient {
    return new FleetClient({ url, token: "secret", fetchFn })
  }

  test("Dev Tunnel fast 502 with a no-host body signal → NO_HOST", async () => {
    const fetchFn = mock(async () =>
      new Response("no host is currently connected to this tunnel", { status: 502 }),
    ) as unknown as typeof fetch

    await expectFleetError(clientWith(DEVTUNNEL_URL, fetchFn).listSessions(), "NO_HOST")
  })

  test("Dev Tunnel no-host body in a JSON error envelope → NO_HOST", async () => {
    const fetchFn = mock(async () =>
      new Response(
        JSON.stringify({ error: { message: "The tunnel host is not connected." } }),
        { status: 503 },
      ),
    ) as unknown as typeof fetch

    await expectFleetError(clientWith(DEVTUNNEL_URL, fetchFn).listSessions(), "NO_HOST")
  })

  test("Dev Tunnel 502 WITHOUT a no-host signal → RELAY_ERROR (no over-assertion)", async () => {
    const fetchFn = mock(async () =>
      new Response("502 Bad Gateway", { status: 502 }),
    ) as unknown as typeof fetch

    await expectFleetError(clientWith(DEVTUNNEL_URL, fetchFn).listSessions(), "RELAY_ERROR")
  })

  test("Dev Tunnel generic 500 → UPSTREAM_ERROR (not RELAY_ERROR/NO_HOST)", async () => {
    const fetchFn = mock(async () =>
      new Response("kaboom", { status: 500 }),
    ) as unknown as typeof fetch

    await expectFleetError(clientWith(DEVTUNNEL_URL, fetchFn).listSessions(), "UPSTREAM_ERROR")
  })

  test("non-Dev-Tunnel 502 is UPSTREAM_ERROR even with a no-host body (NO_HOST not over-asserted)", async () => {
    const fetchFn = mock(async () =>
      new Response("no host is currently connected", { status: 502 }),
    ) as unknown as typeof fetch

    await expectFleetError(clientWith("https://alpha.example", fetchFn).listSessions(), "UPSTREAM_ERROR")
  })

  test("connection refused → UNREACHABLE, never NO_HOST (even on a Dev Tunnel url)", async () => {
    const fetchFn = mock(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED")
    }) as unknown as typeof fetch

    await expectFleetError(clientWith(DEVTUNNEL_URL, fetchFn).listSessions(), "UNREACHABLE")
  })

  test("DNS failure → UNREACHABLE, never NO_HOST", async () => {
    const fetchFn = mock(async () => {
      throw new TypeError("getaddrinfo ENOTFOUND abc-3000.uks1.devtunnels.ms")
    }) as unknown as typeof fetch

    await expectFleetError(clientWith(DEVTUNNEL_URL, fetchFn).listSessions(), "UNREACHABLE")
  })

  test("abort/timeout → TIMEOUT, kept distinct from NO_HOST", async () => {
    const fetchFn = mock(async () => {
      const err = new Error("aborted")
      err.name = "AbortError"
      throw err
    }) as unknown as typeof fetch

    await expectFleetError(clientWith(DEVTUNNEL_URL, fetchFn).listSessions(), "TIMEOUT")
  })

  test("Dev Tunnel 504 gateway timeout → TIMEOUT, not NO_HOST", async () => {
    const fetchFn = mock(async () =>
      new Response("gateway timeout", { status: 504 }),
    ) as unknown as typeof fetch

    await expectFleetError(clientWith(DEVTUNNEL_URL, fetchFn).listSessions(), "TIMEOUT")
  })
})
