import { describe, expect, mock, test } from "bun:test"

import { FleetClient, FleetError } from "~/lib/fleet/client"

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
    const client = new FleetClient({ url: "https://aiordie-bar.tail.ts.net", auth: { type: "mesh" }, fetchFn })

    await client.listSessions()

    expect("Authorization" in calls[0]!.headers).toBe(false)
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
    const client = new FleetClient({ url: "https://aiordie-bar.tail.ts.net", auth: { type: "mesh" }, fetchFn })

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
