import { describe, expect, mock, test } from "bun:test"

import { FleetError, encodeSessionId } from "../../src/lib/fleet/client"
import { createFleetTools, type CreateFleetToolsOptions } from "../../src/lib/fleet/tools"
import { FleetRegistry } from "../../src/lib/fleet/registry"

type FleetToolClient = ReturnType<NonNullable<CreateFleetToolsOptions["createClient"]>>

function unusedClientCall(): Promise<never> {
  return Promise.reject(new Error("unexpected fleet client call"))
}

function fleetClientStub(overrides: Partial<FleetToolClient>): FleetToolClient {
  return {
    listSessions: unusedClientCall,
    readSession: unusedClientCall,
    status: unusedClientCall,
    createSession: unusedClientCall,
    stopSession: unusedClientCall,
    sendMessage: unusedClientCall,
    sendKeys: unusedClientCall,
    respond: unusedClientCall,
    waitEvents: unusedClientCall,
    readFile: unusedClientCall,
    listDir: unusedClientCall,
    search: unusedClientCall,
    gitShow: unusedClientCall,
    ...overrides,
  }
}

function toolMap() {
  const registry = new FleetRegistry({
    config: {
      instances: [
        { id: "alpha", label: "Alpha", url: "https://alpha.example", token: "tok-alpha" },
        { id: "beta", label: "Beta", url: "https://beta.example", token: "tok-beta" },
      ],
    },
  })
  const calls: Array<{ url: string; method: string; body?: unknown; auth?: string }> = []
  const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlString = url.toString()
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined
    calls.push({
      url: urlString,
      method: init?.method ?? "GET",
      body,
      auth: init?.headers instanceof Headers
        ? init.headers.get("authorization") ?? undefined
        : (init?.headers as Record<string, string> | undefined)?.Authorization,
    })
    const parsed = new URL(urlString)
    if (parsed.hostname === "alpha.example" && parsed.pathname === "/api/control/sessions") {
      return Response.json({
        sessions: [
          {
            sessionId: "local-a",
            name: "Alpha Session",
            agent: "codex",
            lifecycle: "running",
            interactionState: "idle",
            canAcceptInput: true,
            lastActivity: "2026-01-01T00:00:00Z",
          },
        ],
      })
    }
    if (parsed.hostname === "beta.example" && parsed.pathname === "/api/control/sessions/local-b/read") {
      return Response.json({
        sessionId: "local-b",
        text: "hello from beta",
        truncated: false,
        source: "pty",
        status: { lifecycle: "running", canAcceptInput: true },
      })
    }
    if (parsed.hostname === "beta.example" && parsed.pathname === "/api/control/sessions/local-b/message") {
      return Response.json({
        messageId: "msg-1",
        delivered: true,
        confirmed: false,
        confidence: "low",
        interactionState: "busy",
        sessionStateSeq: 4,
        duplicated: false,
      })
    }
    if (parsed.hostname === "alpha.example" && parsed.pathname === "/api/control/sessions/create") {
      return Response.json({
        sessionId: "created-a",
        lifecycle: "created",
        name: "Created Session",
      })
    }
    if (parsed.hostname === "beta.example" && parsed.pathname === "/api/control/sessions/local-b/stop") {
      return Response.json({
        stopped: true,
        lifecycle: "stopped",
      })
    }
    if (parsed.hostname === "beta.example" && parsed.pathname === "/api/control/sessions/local-b/respond") {
      return Response.json({
        delivered: true,
        awaitingKind: "select",
        mappedKeys: "2",
        duplicated: false,
      })
    }
    return Response.json({ error: { message: `unhandled ${parsed.hostname}${parsed.pathname}` } }, { status: 500 })
  }) as unknown as typeof fetch
  const tools = new Map(createFleetTools({ registry, fetchFn }).map((tool) => [tool.toolNameHttp, tool]))
  return { tools, calls }
}

async function callTool(
  tools: Map<string, ReturnType<typeof createFleetTools>[number]>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: { content: Array<{ type: "text"; text: string }>; isError?: boolean }; json: unknown }> {
  const tool = tools.get(name)
  expect(tool).toBeDefined()
  const result = await tool!.handler(args)
  return { result, json: JSON.parse(result.content[0]!.text) as unknown }
}

describe("fleet MCP tools", () => {
  test("list_sessions echoes resolvedInstance and globalizes session ids", async () => {
    const { tools, calls } = toolMap()

    const { result, json } = await callTool(tools, "list_sessions", { instance: "alpha" })

    expect(result.isError).toBeUndefined()
    expect(json).toEqual({
      resolvedInstance: { id: "alpha", label: "Alpha" },
      sessions: [
        {
          sessionId: "alpha:local-a",
          name: "Alpha Session",
          agent: "codex",
          lifecycle: "running",
          interactionState: "idle",
          canAcceptInput: true,
          lastActivity: "2026-01-01T00:00:00Z",
        },
      ],
    })
    expect(calls[0]?.url).toBe("https://alpha.example/api/control/sessions")
    expect(calls[0]?.auth).toBe("Bearer tok-alpha")
  })

  test("read_session decodes a global session id and routes to the right instance", async () => {
    const { tools, calls } = toolMap()

    const { result, json } = await callTool(tools, "read_session", {
      sessionId: encodeSessionId("beta", "local-b"),
      lines: 80,
    })

    expect(result.isError).toBeUndefined()
    expect(json).toEqual({
      resolvedInstance: { id: "beta", label: "Beta" },
      sessionId: "beta:local-b",
      text: "hello from beta",
      truncated: false,
      source: "pty",
      status: { lifecycle: "running", canAcceptInput: true },
    })
    expect(calls[0]?.url).toBe("https://beta.example/api/control/sessions/local-b/read?lines=80")
    expect(calls[0]?.auth).toBe("Bearer tok-beta")
  })

  test("send_message returns isError when awaited confirmation is false", async () => {
    const { tools, calls } = toolMap()

    const { result, json } = await callTool(tools, "send_message", {
      sessionId: "beta:local-b",
      message: "continue",
      idempotencyKey: "idem-1",
      awaitMs: 250,
    })

    expect(result.isError).toBe(true)
    expect(json).toMatchObject({
      resolvedInstance: { id: "beta", label: "Beta" },
      sessionId: "beta:local-b",
      delivered: true,
      confirmed: false,
      message: "message delivery was not confirmed within awaitMs=250",
    })
    expect(calls[0]?.body).toEqual({ message: "continue", idempotencyKey: "idem-1", awaitMs: 250 })
  })

  test("respond passes a keys override through", async () => {
    const { tools, calls } = toolMap()

    const { result, json } = await callTool(tools, "respond", {
      sessionId: "beta:local-b",
      keys: "2",
      idempotencyKey: "idem-2",
    })

    expect(result.isError).toBeUndefined()
    expect(json).toMatchObject({
      resolvedInstance: { id: "beta", label: "Beta" },
      sessionId: "beta:local-b",
      delivered: true,
      mappedKeys: "2",
    })
    expect(calls[0]?.body).toEqual({ keys: "2", idempotencyKey: "idem-2" })
  })

  test("list_instances probes reachability without exposing tokens", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "probe-up", label: "Probe Up", url: "https://probe-up.example", token: "tok-probe-up" },
          { id: "probe-down", label: "Probe Down", url: "https://probe-down.example", token: "tok-probe-down" },
        ],
      },
    })
    const upListSessions = mock(async (_signal?: AbortSignal) => ({
      sessions: [{ sessionId: "one" }, { sessionId: "two" }],
    }))
    const downListSessions = mock(async (_signal?: AbortSignal) => {
      throw new FleetError({
        code: "AUTH_FAILED",
        message: "bad token",
        retryable: false,
      })
    })
    const createClient = mock((instance) => fleetClientStub({
      listSessions: instance.id === "probe-up" ? upListSessions : downListSessions,
    })) satisfies NonNullable<CreateFleetToolsOptions["createClient"]>
    const tools = new Map(createFleetTools({ registry, createClient }).map((tool) => [tool.toolNameHttp, tool]))

    const { result, json } = await callTool(tools, "list_instances", {})
    const instances = (json as { instances: Array<Record<string, unknown>> }).instances

    expect(result.isError).toBeUndefined()
    expect(instances[0]).toMatchObject({
      id: "probe-up",
      label: "Probe Up",
      reachable: true,
      sessionCount: 2,
    })
    expect(typeof instances[0]?.lastSeen).toBe("number")
    expect(instances[1]).toEqual({
      id: "probe-down",
      label: "Probe Down",
      reachable: false,
      error: "AUTH_FAILED",
    })
    expect(result.content[0]?.text).not.toContain("tok-probe")
    expect(upListSessions).toHaveBeenCalledTimes(1)
    expect(downListSessions).toHaveBeenCalledTimes(1)
  })

  test("create_session forwards idempotencyKey", async () => {
    const { tools, calls } = toolMap()

    const { result, json } = await callTool(tools, "create_session", {
      instance: "alpha",
      agent: "codex",
      name: "Created Session",
      workingDir: "/work",
      start: true,
      idempotencyKey: "idem-create",
    })

    expect(result.isError).toBeUndefined()
    expect(json).toMatchObject({
      resolvedInstance: { id: "alpha", label: "Alpha" },
      sessionId: "alpha:created-a",
      lifecycle: "created",
      name: "Created Session",
    })
    expect(calls[0]?.url).toBe("https://alpha.example/api/control/sessions/create")
    expect(calls[0]?.body).toEqual({
      agent: "codex",
      name: "Created Session",
      workingDir: "/work",
      start: true,
      idempotencyKey: "idem-create",
    })
  })

  test("stop_session forwards idempotencyKey", async () => {
    const { tools, calls } = toolMap()

    const { result, json } = await callTool(tools, "stop_session", {
      sessionId: "beta:local-b",
      mode: "graceful",
      idempotencyKey: "idem-stop",
    })

    expect(result.isError).toBeUndefined()
    expect(json).toMatchObject({
      resolvedInstance: { id: "beta", label: "Beta" },
      sessionId: "beta:local-b",
      stopped: true,
      lifecycle: "stopped",
    })
    expect(calls[0]?.url).toBe("https://beta.example/api/control/sessions/local-b/stop")
    expect(calls[0]?.body).toEqual({ mode: "graceful", idempotencyKey: "idem-stop" })
  })
})
