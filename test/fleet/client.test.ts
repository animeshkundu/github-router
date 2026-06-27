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
