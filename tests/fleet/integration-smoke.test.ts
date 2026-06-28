import { afterAll, describe, expect, test } from "bun:test"

import { createFleetTools } from "../../src/lib/fleet/tools"
import { FleetRegistry, type FleetInstanceConfig } from "../../src/lib/fleet/registry"

interface MockSession {
  sessionId: string
  name: string
  agent: string
  lifecycle: string
  interactionState: string
  canAcceptInput: boolean
  lastActivity: string
}

interface MockEvent {
  seq: number
  sessionId: string | null
  kind: "turn_ended"
  at: number
  detail?: unknown
}

interface MockControlPlaneOptions {
  token: string
  sessions?: Array<MockSession>
  capabilities?: Array<string>
  events?: Array<MockEvent>
  eventsStatus?: number
  createBadRequest?: (body: Record<string, unknown>) => boolean
}

interface RecordedRequest {
  method: string
  path: string
  auth: string | null
  body?: unknown
}

interface MockControlPlane {
  url: string
  token: string
  state: {
    createCalls: number
    requests: Array<RecordedRequest>
  }
}

type FleetTool = ReturnType<typeof createFleetTools>[number]
type ToolResult = Awaited<ReturnType<FleetTool["handler"]>>

const servers: Array<ReturnType<typeof Bun.serve>> = []

function defaultSession(sessionId = "local-1", name = "Local Session"): MockSession {
  return {
    sessionId,
    name,
    agent: "claude",
    lifecycle: "running",
    interactionState: "idle",
    canAcceptInput: true,
    lastActivity: "2026-01-01T00:00:00.000Z",
  }
}

function startMockControlPlane(options: MockControlPlaneOptions): MockControlPlane {
  const state: MockControlPlane["state"] = { createCalls: 0, requests: [] }
  const sessions = options.sessions ?? [defaultSession()]
  const capabilities = options.capabilities ?? ["permission_mode", "agent_args", "turn_binding", "events_cursor"]
  const events = options.events ?? [{ seq: 1, sessionId: "local-1", kind: "turn_ended", at: 100 }]

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const auth = req.headers.get("authorization")
      if (auth !== `Bearer ${options.token}`) {
        return Response.json(
          { error: { code: "AUTH_FAILED", message: "missing bearer token" } },
          { status: 401 },
        )
      }

      if (req.method === "GET") {
        state.requests.push({ method: req.method, path: url.pathname, auth })
      }

      if (req.method === "GET" && url.pathname === "/api/control/sessions") {
        return Response.json({ sessions })
      }

      if (req.method === "GET" && url.pathname === "/api/control/capabilities") {
        return Response.json({ capabilities, controlVersion: "1.0" })
      }

      if (req.method === "GET" && url.pathname === "/api/control/events") {
        if (options.eventsStatus !== undefined && options.eventsStatus !== 200) {
          return Response.json(
            { error: { code: "UPSTREAM_ERROR", message: "events failed" } },
            { status: options.eventsStatus },
          )
        }
        const filteredEvents = filterEvents(events, url)
        return Response.json({
          events: filteredEvents,
          gaps: [],
          cursor: `e1:${maxEventSeq(filteredEvents)}`,
          more: false,
        })
      }

      const statusMatch = /^\/api\/control\/sessions\/([^/]+)\/status$/.exec(url.pathname)
      if (req.method === "GET" && statusMatch) {
        const sessionId = decodeURIComponent(statusMatch[1]!)
        return Response.json({
          sessionId,
          status: {
            lifecycle: "running",
            interactionState: "idle",
            canAcceptInput: true,
            confidence: "high",
          },
        })
      }

      const body = req.method === "POST" ? await readJsonBody(req) : undefined
      if (req.method === "POST") {
        state.requests.push({ method: req.method, path: url.pathname, auth, body })
      }

      if (req.method === "POST" && url.pathname === "/api/control/sessions/create") {
        state.createCalls += 1
        const createBody = asRecord(body)
        if (options.createBadRequest?.(createBody)) {
          return Response.json(
            { error: { code: "INVALID_ARGUMENT", message: "bad permissionMode" } },
            { status: 400 },
          )
        }
        return Response.json({
          sessionId: "local-1",
          lifecycle: "running",
          name: stringField(createBody.name) ?? "Local Session",
          agent: stringField(createBody.agent) ?? "claude",
          ready: true,
          bound: true,
        })
      }

      const messageMatch = /^\/api\/control\/sessions\/([^/]+)\/message$/.exec(url.pathname)
      if (req.method === "POST" && messageMatch) {
        return Response.json({
          messageId: "m1",
          delivered: true,
          confirmed: true,
          confirmation: "turn_completed",
          delivery: { status: "delivered" },
          submission: { status: "submitted" },
          turn: { status: "completed" },
          interactionState: "idle",
          sessionStateSeq: 1,
          duplicated: false,
        })
      }

      const stopMatch = /^\/api\/control\/sessions\/([^/]+)\/stop$/.exec(url.pathname)
      if (req.method === "POST" && stopMatch) {
        return Response.json({ stopped: true, lifecycle: "stopped" })
      }

      return Response.json(
        { error: { code: "NOT_FOUND", message: `unhandled ${req.method} ${url.pathname}` } },
        { status: 404 },
      )
    },
  })
  servers.push(server)

  return { url: `http://127.0.0.1:${server.port}`, token: options.token, state }
}

function filterEvents(events: Array<MockEvent>, url: URL): Array<MockEvent> {
  const sessionIds = commaSet(url.searchParams.get("sessionIds"))
  const kinds = commaSet(url.searchParams.get("kinds"))
  return events.filter((event) => {
    const sessionMatches = sessionIds.size === 0 || (event.sessionId !== null && sessionIds.has(event.sessionId))
    const kindMatches = kinds.size === 0 || kinds.has(event.kind)
    return sessionMatches && kindMatches
  })
}

function commaSet(value: string | null): Set<string> {
  if (value === null || value === "") return new Set()
  return new Set(value.split(",").filter((item) => item !== ""))
}

function maxEventSeq(events: Array<MockEvent>): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0)
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function fleetToolMap(instances: Array<FleetInstanceConfig>): Map<string, FleetTool> {
  const registry = new FleetRegistry({ config: { instances } })
  return new Map(createFleetTools({ registry }).map((tool) => [tool.toolNameHttp, tool]))
}

function instanceConfig(id: string, label: string, controlPlane: MockControlPlane): FleetInstanceConfig {
  return { id, label, url: controlPlane.url, token: controlPlane.token }
}

async function callTool(
  tools: Map<string, FleetTool>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: ToolResult; json: unknown }> {
  const tool = tools.get(name)
  expect(tool).toBeDefined()
  const result = await tool!.handler(args)
  return { result, json: JSON.parse(result.content[0]!.text) as unknown }
}

afterAll(() => {
  for (const server of servers) server.stop(true)
})

describe("fleet client transport integration smoke", () => {
  test("list_instances probes real HTTP and never exposes tokens", async () => {
    const alpha = startMockControlPlane({
      token: "tok-a",
      sessions: [defaultSession("local-1", "A One"), defaultSession("local-2", "A Two")],
    })
    const beta = startMockControlPlane({
      token: "tok-b",
      sessions: [defaultSession("local-b", "B One")],
      capabilities: ["agent_args", "turn_binding", "events_cursor"],
    })
    const tools = fleetToolMap([
      instanceConfig("alpha", "Alpha", alpha),
      instanceConfig("beta", "Beta", beta),
    ])

    const { result, json } = await callTool(tools, "list_instances", {})
    const body = json as { instances: Array<Record<string, unknown>> }

    expect(result.isError).toBeUndefined()
    expect(body.instances[0]).toMatchObject({
      id: "alpha",
      label: "Alpha",
      reachable: true,
      sessionCount: 2,
    })
    expect(body.instances[1]).toMatchObject({
      id: "beta",
      label: "Beta",
      reachable: true,
      sessionCount: 1,
    })
    expect(typeof body.instances[0]?.lastSeen).toBe("number")
    expect(result.content[0]?.text).not.toContain("tok-a")
    expect(result.content[0]?.text).not.toContain("tok-b")
    expect(alpha.state.requests[0]?.auth).toBe("Bearer tok-a")
    expect(beta.state.requests[0]?.auth).toBe("Bearer tok-b")
  })

  test("create_session with permissionMode hits capabilities then returns ready and bound", async () => {
    const alpha = startMockControlPlane({ token: "tok-a" })
    const tools = fleetToolMap([instanceConfig("alpha", "Alpha", alpha)])

    const { result, json } = await callTool(tools, "create_session", {
      instance: "alpha",
      agent: "claude",
      name: "Started",
      start: true,
      permissionMode: "plan",
      idempotencyKey: "idem-create",
    })

    expect(result.isError).toBeUndefined()
    expect(json).toMatchObject({
      resolvedInstance: { id: "alpha", label: "Alpha" },
      sessionId: "alpha:local-1",
      lifecycle: "running",
      name: "Started",
      agent: "claude",
      ready: true,
      bound: true,
    })
    expect(alpha.state.requests.map((request) => request.path)).toEqual([
      "/api/control/capabilities",
      "/api/control/sessions/create",
    ])
  })

  test("send_message surfaces delivered and confirmed over real HTTP", async () => {
    const alpha = startMockControlPlane({ token: "tok-a" })
    const tools = fleetToolMap([instanceConfig("alpha", "Alpha", alpha)])

    const { result, json } = await callTool(tools, "send_message", {
      sessionId: "alpha:local-1",
      message: "continue",
      idempotencyKey: "idem-send",
      awaitMs: 0,
    })

    expect(result.isError).toBeUndefined()
    expect(json).toMatchObject({
      resolvedInstance: { id: "alpha", label: "Alpha" },
      sessionId: "alpha:local-1",
      messageId: "m1",
      delivered: true,
      confirmed: true,
      confirmation: "turn_completed",
    })
  })

  test("session_status returns the running lifecycle over real HTTP", async () => {
    const alpha = startMockControlPlane({ token: "tok-a" })
    const tools = fleetToolMap([instanceConfig("alpha", "Alpha", alpha)])

    const { result, json } = await callTool(tools, "session_status", {
      sessionId: "alpha:local-1",
    })

    expect(result.isError).toBeUndefined()
    expect(json).toMatchObject({
      resolvedInstance: { id: "alpha", label: "Alpha" },
      sessionId: "alpha:local-1",
      status: { lifecycle: "running", interactionState: "idle", canAcceptInput: true },
    })
  })

  test("await_turn returns alpha events stamped with the instance", async () => {
    const alpha = startMockControlPlane({
      token: "tok-a",
      events: [{ seq: 7, sessionId: "local-1", kind: "turn_ended", at: 123, detail: { ok: true } }],
    })
    const tools = fleetToolMap([instanceConfig("alpha", "Alpha", alpha)])

    const { result, json } = await callTool(tools, "await_turn", {
      instances: ["alpha"],
      watcherId: "alpha-smoke",
      timeoutMs: 25,
    })
    const body = json as { events: Array<Record<string, unknown>> }

    expect(result.isError).toBeUndefined()
    expect(body.events).toEqual([
      expect.objectContaining({
        seq: 7,
        sessionId: "alpha:local-1",
        kind: "turn_ended",
        at: 123,
        instance: { id: "alpha", label: "Alpha" },
      }),
    ])
    expect(typeof body.events[0]?.at).toBe("number")
  })

  test("await_turn merges two real HTTP instances by numeric at", async () => {
    const alpha = startMockControlPlane({
      token: "tok-a",
      events: [
        { seq: 2, sessionId: "local-a1", kind: "turn_ended", at: 100 },
        { seq: 3, sessionId: "local-a2", kind: "turn_ended", at: 300 },
      ],
    })
    const beta = startMockControlPlane({
      token: "tok-b",
      capabilities: ["agent_args", "turn_binding", "events_cursor"],
      events: [{ seq: 1, sessionId: "local-b1", kind: "turn_ended", at: 200 }],
    })
    const tools = fleetToolMap([
      instanceConfig("alpha", "Alpha", alpha),
      instanceConfig("beta", "Beta", beta),
    ])

    const { result, json } = await callTool(tools, "await_turn", {
      instances: ["alpha", "beta"],
      watcherId: "merge-smoke",
      timeoutMs: 25,
    })
    const body = json as { events: Array<Record<string, unknown>> }

    expect(result.isError).toBeUndefined()
    expect(body.events.map((event) => event.at)).toEqual([100, 200, 300])
    expect(body.events.map((event) => event.sessionId)).toEqual([
      "alpha:local-a1",
      "beta:local-b1",
      "alpha:local-a2",
    ])
  })

  test("await_turn keeps alpha events and reports an error when beta events returns 500", async () => {
    const alpha = startMockControlPlane({
      token: "tok-a",
      events: [{ seq: 1, sessionId: "local-1", kind: "turn_ended", at: 100 }],
    })
    const beta = startMockControlPlane({ token: "tok-b", eventsStatus: 500 })
    const tools = fleetToolMap([
      instanceConfig("alpha", "Alpha", alpha),
      instanceConfig("beta", "Beta", beta),
    ])

    const { result, json } = await callTool(tools, "await_turn", {
      instances: ["alpha", "beta"],
      watcherId: "partial-smoke",
      timeoutMs: 25,
    })
    const body = json as { events: Array<Record<string, unknown>>; errors?: Array<Record<string, unknown>> }

    expect(result.isError).toBeUndefined()
    expect(body.events).toEqual([
      expect.objectContaining({
        sessionId: "alpha:local-1",
        instance: { id: "alpha", label: "Alpha" },
      }),
    ])
    expect(body.errors).toEqual([
      expect.objectContaining({
        instance: { id: "beta", label: "Beta" },
        error: "UPSTREAM_ERROR",
      }),
    ])
  })

  test("create_session rejects permissionMode when capabilities exclude permission_mode", async () => {
    const beta = startMockControlPlane({
      token: "tok-b",
      capabilities: ["agent_args", "turn_binding", "events_cursor"],
    })
    const tools = fleetToolMap([instanceConfig("beta", "Beta", beta)])

    const { result, json } = await callTool(tools, "create_session", {
      instance: "beta",
      agent: "claude",
      permissionMode: "plan",
      idempotencyKey: "idem-cap-deny",
    })

    expect(result.isError).toBe(true)
    expect(json).toMatchObject({ error: { code: "UNSUPPORTED_CAPABILITY" } })
    expect((json as { error: { message: string } }).error.message).toContain("permission_mode")
    expect(beta.state.createCalls).toBe(0)
  })

  test("create_session surfaces upstream 400 and stop_session still stops", async () => {
    const alpha = startMockControlPlane({
      token: "tok-a",
      createBadRequest: (body) => body.permissionMode === "bogus",
    })
    const tools = fleetToolMap([instanceConfig("alpha", "Alpha", alpha)])

    const created = await callTool(tools, "create_session", {
      instance: "alpha",
      agent: "claude",
      permissionMode: "bogus",
      idempotencyKey: "idem-bad-create",
    })

    expect(created.result.isError).toBe(true)
    expect(created.json).toMatchObject({ error: { code: "BAD_REQUEST" } })
    expect((created.json as { error: { message: string } }).error.message).toContain("bad permissionMode")

    const stopped = await callTool(tools, "stop_session", {
      sessionId: "alpha:local-1",
      idempotencyKey: "idem-stop-after-bad-create",
    })

    expect(stopped.result.isError).toBeUndefined()
    expect(stopped.json).toMatchObject({
      resolvedInstance: { id: "alpha", label: "Alpha" },
      sessionId: "alpha:local-1",
      stopped: true,
      lifecycle: "stopped",
    })
  })
})
