import { describe, expect, mock, test } from "bun:test"

import { FleetClient, FleetError } from "~/lib/fleet/client"
import type { FleetMeshProxy } from "~/lib/fleet/registry"

const MESH_PROXY: FleetMeshProxy = { url: "http://127.0.0.1:54321", authHeader: "Bearer egress-secret" }

// Force the Node (ProxyAgent) branch under the Bun test runtime by injecting a
// stub applicator that records the init instead of building a real undici agent.
function stubMeshEgress() {
  const applied: Array<{ url: string; authHeader: string }> = []
  const applyMeshEgress = (_init: Record<string, unknown>, meshProxy: FleetMeshProxy) => {
    applied.push({ url: meshProxy.url, authHeader: meshProxy.authHeader })
    return { close: async () => {} }
  }
  return { applied, applyMeshEgress }
}

function capturingFetch(response: () => Response) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k] = v
    }
    calls.push({ url: url.toString(), headers })
    return response()
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

describe("FleetClient mesh auth", () => {
  test("a mesh instance sends NO Authorization header (the peer sidecar injects it)", async () => {
    const { calls, fetchFn } = capturingFetch(() => Response.json({ sessions: [] }))
    const { applyMeshEgress } = stubMeshEgress()
    const client = new FleetClient({
      url: "https://aiordie-bar.tail.ts.net",
      auth: { type: "mesh" },
      meshProxy: MESH_PROXY,
      applyMeshEgress,
      fetchFn,
    })

    await client.listSessions()

    expect("Authorization" in calls[0]!.headers).toBe(false)
  })

  test("a mesh instance routes through the egress proxy with the Bearer authHeader", async () => {
    const { fetchFn } = capturingFetch(() => Response.json({ sessions: [] }))
    const { applied, applyMeshEgress } = stubMeshEgress()
    const client = new FleetClient({
      url: "https://aiordie-bar.tail.ts.net",
      auth: { type: "mesh" },
      meshProxy: MESH_PROXY,
      applyMeshEgress,
      fetchFn,
    })

    await client.listSessions()

    expect(applied).toEqual([{ url: "http://127.0.0.1:54321", authHeader: "Bearer egress-secret" }])
  })

  test("the per-request egress agent is torn down via destroy() (not close(), which deadlocks on an unread body)", async () => {
    const { fetchFn } = capturingFetch(() => Response.json({ sessions: [] }))
    let destroyed = 0
    let closed = 0
    const applyMeshEgress = () => ({
      destroy: async () => {
        destroyed++
      },
      close: async () => {
        closed++
      },
    })
    const client = new FleetClient({
      url: "https://aiordie-bar.tail.ts.net",
      auth: { type: "mesh" },
      meshProxy: MESH_PROXY,
      applyMeshEgress,
      fetchFn,
    })

    await client.listSessions()

    expect(destroyed).toBe(1)
    expect(closed).toBe(0)
  })

  test("a mesh instance with NO egress proxy fails closed BEFORE any fetch (MESH_UNCONFIGURED)", async () => {
    const { calls, fetchFn } = capturingFetch(() => Response.json({ sessions: [] }))
    const client = new FleetClient({ url: "https://aiordie-bar.tail.ts.net", auth: { type: "mesh" }, fetchFn })

    try {
      await client.listSessions()
      throw new Error("expected FleetError")
    } catch (err) {
      expect(err).toBeInstanceOf(FleetError)
      expect((err as FleetError).code).toBe("MESH_UNCONFIGURED")
    }
    // No direct `.ts.net` fetch was ever attempted.
    expect(calls).toHaveLength(0)
  })

  test("a bearer instance still sends Authorization: Bearer <token>", async () => {
    const { calls, fetchFn } = capturingFetch(() => Response.json({ sessions: [] }))
    const client = new FleetClient({ url: "https://alpha.example", auth: { type: "bearer", token: "sek" }, fetchFn })

    await client.listSessions()

    expect(calls[0]!.headers.Authorization).toBe("Bearer sek")
  })

  test("a token-only construction is treated as bearer (backward compat)", async () => {
    const { calls, fetchFn } = capturingFetch(() => Response.json({ sessions: [] }))
    const client = new FleetClient({ url: "https://alpha.example", token: "legacy", fetchFn })

    await client.listSessions()

    expect(calls[0]!.headers.Authorization).toBe("Bearer legacy")
  })

  test("a mesh peer network failure maps to TAILNET_UNREACHABLE with an ACL hint", async () => {
    const fetchFn = mock(async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    const { applyMeshEgress } = stubMeshEgress()
    const client = new FleetClient({
      url: "https://aiordie-bar.tail.ts.net",
      auth: { type: "mesh" },
      meshProxy: MESH_PROXY,
      applyMeshEgress,
      fetchFn,
    })

    try {
      await client.listSessions()
      throw new Error("expected FleetError")
    } catch (err) {
      expect(err).toBeInstanceOf(FleetError)
      expect((err as FleetError).code).toBe("TAILNET_UNREACHABLE")
      expect((err as FleetError).message).toContain("tag:aiordie")
    }
  })
})
