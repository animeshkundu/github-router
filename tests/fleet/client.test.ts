import { describe, expect, mock, test } from "bun:test"

import {
  FleetClient,
  FleetError,
  applyInsecureTls,
  decodeSessionId,
  encodeSessionId,
} from "../../src/lib/fleet/client"
import { TunnelAuthError } from "../../src/lib/fleet/tunnel-auth"

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

  test("capabilities reads the frozen F19 response", async () => {
    const calls: Array<{ url: string; method: string }> = []
    const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url.toString(), method: init?.method ?? "GET" })
      return Response.json({ capabilities: ["permission_mode", "agent_args"], controlVersion: "f19" })
    }) as unknown as typeof fetch
    const client = new FleetClient({ url: "https://alpha.example", token: "secret", fetchFn })

    const response = await client.capabilities()

    expect(response).toEqual({ capabilities: ["permission_mode", "agent_args"], controlVersion: "f19" })
    expect(calls[0]).toEqual({
      url: "https://alpha.example/api/control/capabilities",
      method: "GET",
    })
  })

  test("capabilities rejects on 404", async () => {
    const fetchFn = mock(async () =>
      new Response(JSON.stringify({ error: { code: "missing", message: "missing" } }), { status: 404 }),
    ) as unknown as typeof fetch
    const client = new FleetClient({ url: "https://alpha.example", token: "secret", fetchFn })

    await expectFleetError(client.capabilities(), "SESSION_NOT_FOUND")
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

  test("400 → BAD_REQUEST (F10 invalid permissionMode/agentArgs)", async () => {
    const fetchFn = mock(async () =>
      new Response(JSON.stringify({ error: { message: "unknown permissionMode" } }), { status: 400 }),
    ) as unknown as typeof fetch

    await expectFleetError(clientWith(DEVTUNNEL_URL, fetchFn).listSessions(), "BAD_REQUEST")
  })

  test("429 → RATE_LIMITED (F21 fan-out backoff path)", async () => {
    const fetchFn = mock(async () =>
      new Response("slow down", { status: 429 }),
    ) as unknown as typeof fetch

    await expectFleetError(clientWith(DEVTUNNEL_URL, fetchFn).listSessions(), "RATE_LIMITED")
  })
})

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers
  if (h instanceof Headers) return h.get(name) ?? undefined
  const rec = h as Record<string, string> | undefined
  if (!rec) return undefined
  for (const key of Object.keys(rec)) {
    if (key.toLowerCase() === name.toLowerCase()) return rec[key]
  }
  return undefined
}

describe("FleetClient dev tunnel auth headers", () => {
  test("attaches X-Tunnel-Authorization + skip header on a devtunnels host", async () => {
    let lastInit: RequestInit | undefined
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      lastInit = init
      return Response.json({ sessions: [] })
    }) as unknown as typeof fetch
    const client = new FleetClient({
      url: "https://abc.usw2.devtunnels.ms",
      token: "bearer-1",
      fetchFn,
      getTunnelToken: async () => "connect-tok",
    })

    await client.listSessions()

    expect(headerOf(lastInit, "authorization")).toBe("Bearer bearer-1")
    expect(headerOf(lastInit, "x-tunnel-authorization")).toBe("tunnel connect-tok")
    expect(headerOf(lastInit, "x-tunnel-skip-anti-phishing-page")).toBe("true")
  })

  test("sends the skip header but no tunnel header when no provider is configured", async () => {
    let lastInit: RequestInit | undefined
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      lastInit = init
      return Response.json({ sessions: [] })
    }) as unknown as typeof fetch
    const client = new FleetClient({ url: "https://abc.usw2.devtunnels.ms", token: "bearer-1", fetchFn })

    await client.listSessions()

    expect(headerOf(lastInit, "x-tunnel-skip-anti-phishing-page")).toBe("true")
    expect(headerOf(lastInit, "x-tunnel-authorization")).toBeUndefined()
  })

  test("does NOT attach the tunnel header on a non-devtunnels host (origin scoping)", async () => {
    let lastInit: RequestInit | undefined
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      lastInit = init
      return Response.json({ sessions: [] })
    }) as unknown as typeof fetch
    const client = new FleetClient({
      url: "https://alpha.example",
      token: "bearer-1",
      fetchFn,
      getTunnelToken: async () => "connect-tok",
    })

    await client.listSessions()

    expect(headerOf(lastInit, "x-tunnel-authorization")).toBeUndefined()
  })

  test("does NOT attach the tunnel header over cleartext http even on a devtunnels host", async () => {
    let lastInit: RequestInit | undefined
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      lastInit = init
      return Response.json({ sessions: [] })
    }) as unknown as typeof fetch
    const client = new FleetClient({
      url: "http://abc.usw2.devtunnels.ms",
      token: "bearer-1",
      fetchFn,
      getTunnelToken: async () => "connect-tok",
    })

    await client.listSessions()

    expect(headerOf(lastInit, "x-tunnel-authorization")).toBeUndefined()
  })

  test("maps a tunnel-auth provider failure to AUTH_FAILED without calling fetch", async () => {
    const fetchFn = mock(async () => Response.json({ sessions: [] })) as unknown as typeof fetch
    const client = new FleetClient({
      url: "https://abc.usw2.devtunnels.ms",
      token: "bearer-1",
      fetchFn,
      getTunnelToken: async () => {
        throw new TunnelAuthError("NOT_LOGGED_IN", "run `devtunnel user login`")
      },
    })

    await expectFleetError(client.listSessions(), "AUTH_FAILED")
    expect(fetchFn).toHaveBeenCalledTimes(0)
  })

  test("evicts + re-mints once and retries when the first attempt fails", async () => {
    let calls = 0
    let invalidated = 0
    const fetchFn = mock(async () => {
      calls += 1
      if (calls === 1) throw new Error("unexpected redirect")
      return Response.json({ sessions: [] })
    }) as unknown as typeof fetch
    const client = new FleetClient({
      url: "https://abc.usw2.devtunnels.ms",
      token: "bearer-1",
      fetchFn,
      getTunnelToken: async () => "connect-tok",
      onTunnelAuthInvalidate: () => { invalidated += 1 },
    })

    await client.listSessions()

    expect(calls).toBe(2)
    expect(invalidated).toBe(1)
  })
})

describe("FleetClient insecureTLS", () => {
  test("attaches tls:{rejectUnauthorized:false} to the fetch init when insecureTLS is set", async () => {
    let captured: RequestInit | undefined
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init
      return Response.json({ sessions: [] })
    }) as unknown as typeof fetch
    const client = new FleetClient({ url: "https://localhost:7777", token: "none", fetchFn, insecureTLS: true })

    await client.listSessions()

    expect((captured as { tls?: unknown }).tls).toEqual({ rejectUnauthorized: false })
  })

  test("omits the tls field by default so verification stays on", async () => {
    let captured: RequestInit | undefined
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init
      return Response.json({ sessions: [] })
    }) as unknown as typeof fetch
    const client = new FleetClient({ url: "https://localhost:7777", token: "none", fetchFn })

    await client.listSessions()

    expect("tls" in (captured as object)).toBe(false)
    expect("dispatcher" in (captured as object)).toBe(false)
  })
})

describe("applyInsecureTls runtime branches", () => {
  test("Bun branch attaches `tls`, never a dispatcher", () => {
    const init: Record<string, unknown> = {}
    applyInsecureTls(init, true)
    expect(init.tls).toEqual({ rejectUnauthorized: false })
    expect("dispatcher" in init).toBe(false)
  })

  test("Node branch attaches an undici `dispatcher`, never `tls` (the path that shipped broken)", () => {
    const init: Record<string, unknown> = {}
    applyInsecureTls(init, false)
    expect(init.dispatcher).toBeDefined()
    expect("tls" in init).toBe(false)
  })
})
