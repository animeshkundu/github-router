import { describe, expect, mock, test } from "bun:test"

import { FleetError, encodeSessionId, type SendMessageResponse } from "../../src/lib/fleet/client"
import { createFleetTools, type CreateFleetToolsOptions } from "../../src/lib/fleet/tools"
import { FleetRegistry, type FleetInstanceConfig } from "../../src/lib/fleet/registry"
import { TunnelAuthError, type TunnelTokenProvider } from "../../src/lib/fleet/tunnel-auth"

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
        lifecycle: "running",
        name: "Created Session",
        ready: true,
        bound: true,
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

  test("send_message: delivered but confirmation timed out is NOT an error (F9)", async () => {
    const { tools, calls } = toolMap()

    const { result, json } = await callTool(tools, "send_message", {
      sessionId: "beta:local-b",
      message: "continue",
      idempotencyKey: "idem-1",
      awaitMs: 250,
    })

    // Delivered + unconfirmed after the await window is a SUCCESS with a pending
    // confirmation, not an error.
    expect(result.isError).toBeUndefined()
    expect(json).toMatchObject({
      resolvedInstance: { id: "beta", label: "Beta" },
      sessionId: "beta:local-b",
      delivered: true,
      confirmed: false,
      confirmationPending: true,
      confirmationTimedOut: true,
    })
    expect((json as { message?: string }).message).toContain("await_turn")
    expect(calls[0]?.body).toEqual({ message: "continue", idempotencyKey: "idem-1", awaitMs: 250 })
  })

  test("send_message: delivery failure is the ONLY isError case (F9)", async () => {
    const registry = new FleetRegistry({
      config: { instances: [{ id: "beta", label: "Beta", url: "https://beta.example", token: "tok-beta" }] },
    })
    const createClient = mock(() => fleetClientStub({
      sendMessage: mock(async () => ({
        messageId: "msg-fail",
        delivered: false,
        confirmed: false,
        delivery: { status: "failed" },
      })),
    })) satisfies NonNullable<CreateFleetToolsOptions["createClient"]>
    const tools = new Map(createFleetTools({ registry, createClient }).map((tool) => [tool.toolNameHttp, tool]))

    const { result, json } = await callTool(tools, "send_message", {
      sessionId: "beta:local-b",
      message: "continue",
      idempotencyKey: "idem-fail",
      awaitMs: 0,
    })

    expect(result.isError).toBe(true)
    expect(json).toMatchObject({ delivered: false, confirmed: false })
    expect((json as { confirmationPending?: boolean }).confirmationPending).toBeUndefined()
    expect((json as { message?: string }).message).toContain("not delivered")
  })

  test("send_message: structured delivery.status=failed sets isError even when delivered!==false (F9)", async () => {
    const registry = new FleetRegistry({
      config: { instances: [{ id: "beta", label: "Beta", url: "https://beta.example", token: "tok-beta" }] },
    })
    const createClient = mock(() => fleetClientStub({
      sendMessage: mock(async () => ({
        messageId: "msg-fail2",
        // delivered boolean omitted; the structured sub-status is the failure signal.
        confirmed: false,
        delivery: { status: "error" },
      } as unknown as SendMessageResponse)),
    })) satisfies NonNullable<CreateFleetToolsOptions["createClient"]>
    const tools = new Map(createFleetTools({ registry, createClient }).map((tool) => [tool.toolNameHttp, tool]))

    const { result, json } = await callTool(tools, "send_message", {
      sessionId: "beta:local-b",
      message: "continue",
      idempotencyKey: "idem-fail2",
    })

    expect(result.isError).toBe(true)
    expect(json).toMatchObject({ delivered: false })
  })

  test("send_message: delivered and confirmed is a clean success (F9)", async () => {
    const registry = new FleetRegistry({
      config: { instances: [{ id: "beta", label: "Beta", url: "https://beta.example", token: "tok-beta" }] },
    })
    const createClient = mock(() => fleetClientStub({
      sendMessage: mock(async () => ({
        messageId: "msg-ok",
        delivered: true,
        confirmed: true,
        confirmation: "turn_completed",
        turn: { status: "completed" },
      })),
    })) satisfies NonNullable<CreateFleetToolsOptions["createClient"]>
    const tools = new Map(createFleetTools({ registry, createClient }).map((tool) => [tool.toolNameHttp, tool]))

    const { result, json } = await callTool(tools, "send_message", {
      sessionId: "beta:local-b",
      message: "continue",
      idempotencyKey: "idem-ok",
      awaitMs: 500,
    })

    expect(result.isError).toBeUndefined()
    expect(json).toMatchObject({ delivered: true, confirmed: true, confirmation: "turn_completed" })
    expect((json as { confirmationPending?: boolean }).confirmationPending).toBeUndefined()
    expect((json as { confirmationTimedOut?: boolean }).confirmationTimedOut).toBeUndefined()
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

  test("list_instances surfaces F4 NO_HOST with an actionable hint", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "no-host", label: "No Host", url: "https://nh-3000.uks1.devtunnels.ms", token: "tok-nh" },
          { id: "slow", label: "Slow", url: "https://slow.example", token: "tok-slow" },
          { id: "gone", label: "Gone", url: "https://gone.example", token: "tok-gone" },
        ],
      },
    })
    const createClient = mock((instance) => fleetClientStub({
      listSessions: mock(async (_signal?: AbortSignal) => {
        if (instance.id === "no-host") {
          throw new FleetError({ code: "NO_HOST", message: "no host connected", retryable: true })
        }
        if (instance.id === "slow") {
          throw new FleetError({ code: "TIMEOUT", message: "timed out", retryable: true })
        }
        throw new FleetError({ code: "UNREACHABLE", message: "dns failure", retryable: true })
      }),
    })) satisfies NonNullable<CreateFleetToolsOptions["createClient"]>
    const tools = new Map(createFleetTools({ registry, createClient }).map((tool) => [tool.toolNameHttp, tool]))

    const { result, json } = await callTool(tools, "list_instances", {})
    const instances = (json as { instances: Array<Record<string, unknown>> }).instances

    expect(result.isError).toBeUndefined()
    expect(instances[0]).toMatchObject({ id: "no-host", reachable: false, error: "NO_HOST" })
    expect(typeof instances[0]?.hint).toBe("string")
    expect(instances[0]?.hint).toContain("no ai-or-die host connected")
    expect(instances[1]).toMatchObject({ id: "slow", reachable: false, error: "TIMEOUT" })
    expect(instances[2]).toMatchObject({ id: "gone", reachable: false, error: "UNREACHABLE" })
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
      lifecycle: "running",
      name: "Created Session",
      ready: true,
      bound: true,
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

  test("create_session forwards readyTimeoutMs and surfaces ready/bound (F17)", async () => {
    const { tools, calls } = toolMap()

    const { result, json } = await callTool(tools, "create_session", {
      instance: "alpha",
      agent: "claude",
      start: true,
      readyTimeoutMs: 8000,
      idempotencyKey: "idem-ready",
    })

    expect(result.isError).toBeUndefined()
    expect(json).toMatchObject({ ready: true, bound: true })
    expect(calls[0]?.body).toEqual({
      agent: "claude",
      start: true,
      readyTimeoutMs: 8000,
      idempotencyKey: "idem-ready",
    })
  })

  test("create_session forwards permissionMode + agentArgs (F10)", async () => {
    const { tools, calls } = toolMap()

    const { result } = await callTool(tools, "create_session", {
      instance: "alpha",
      agent: "claude",
      start: true,
      permissionMode: "plan",
      agentArgs: ["--model", "opus"],
      idempotencyKey: "idem-f10",
    })

    expect(result.isError).toBeUndefined()
    expect(calls[0]?.body).toEqual({
      agent: "claude",
      start: true,
      permissionMode: "plan",
      agentArgs: ["--model", "opus"],
      idempotencyKey: "idem-f10",
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

function tunnelHeaderOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers
  if (h instanceof Headers) return h.get(name) ?? undefined
  const rec = h as Record<string, string> | undefined
  if (!rec) return undefined
  for (const key of Object.keys(rec)) {
    if (key.toLowerCase() === name.toLowerCase()) return rec[key]
  }
  return undefined
}

function tunnelToolMap(instance: FleetInstanceConfig, provider?: TunnelTokenProvider) {
  const registry = new FleetRegistry({ config: { instances: [instance] } })
  const calls: Array<{ url: string; tunnelAuth?: string; skip?: string; auth?: string }> = []
  const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: url.toString(),
      tunnelAuth: tunnelHeaderOf(init, "x-tunnel-authorization"),
      skip: tunnelHeaderOf(init, "x-tunnel-skip-anti-phishing-page"),
      auth: tunnelHeaderOf(init, "authorization"),
    })
    return Response.json({ sessions: [] })
  }) as unknown as typeof fetch
  const tools = new Map(
    createFleetTools({ registry, fetchFn, tunnelTokenProvider: provider }).map((tool) => [tool.toolNameHttp, tool]),
  )
  return { tools, calls }
}

describe("fleet MCP tools dev tunnel auth", () => {
  test("auto-mint: forwards the provider connect token as X-Tunnel-Authorization", async () => {
    const provider: TunnelTokenProvider = { getToken: async () => "connect-xyz", invalidate: () => {} }
    const { tools, calls } = tunnelToolMap(
      { id: "t", label: "T", url: "https://t.usw2.devtunnels.ms", token: "btok", tunnelId: "aiordie-h.usw2" },
      provider,
    )

    const { result } = await callTool(tools, "list_sessions", { instance: "t" })

    expect(result.isError).toBeUndefined()
    expect(calls[0]?.auth).toBe("Bearer btok")
    expect(calls[0]?.tunnelAuth).toBe("tunnel connect-xyz")
    expect(calls[0]?.skip).toBe("true")
    expect(result.content[0]?.text).not.toContain("connect-xyz")
  })

  test("static token path: sends the configured tunnelToken without the provider", async () => {
    const provider: TunnelTokenProvider = {
      getToken: async () => { throw new Error("provider must not be used for a static token") },
      invalidate: () => {},
    }
    const { tools, calls } = tunnelToolMap(
      { id: "t", label: "T", url: "https://t.usw2.devtunnels.ms", token: "btok", tunnelToken: "static-tok" },
      provider,
    )

    const { result } = await callTool(tools, "list_sessions", { instance: "t" })

    expect(result.isError).toBeUndefined()
    expect(calls[0]?.tunnelAuth).toBe("tunnel static-tok")
  })

  test("precedence: tunnelId (provider) wins over a static tunnelToken", async () => {
    const provider: TunnelTokenProvider = { getToken: async () => "from-provider", invalidate: () => {} }
    const { tools, calls } = tunnelToolMap(
      {
        id: "t",
        label: "T",
        url: "https://t.usw2.devtunnels.ms",
        token: "btok",
        tunnelId: "aiordie-h.usw2",
        tunnelToken: "static-tok",
      },
      provider,
    )

    await callTool(tools, "list_sessions", { instance: "t" })

    expect(calls[0]?.tunnelAuth).toBe("tunnel from-provider")
  })

  test("a tunnel-auth failure surfaces an actionable isError result and never calls fetch or leaks", async () => {
    const provider: TunnelTokenProvider = {
      getToken: async () => { throw new TunnelAuthError("NOT_INSTALLED", "install the devtunnel CLI and run `devtunnel user login`") },
      invalidate: () => {},
    }
    const { tools, calls } = tunnelToolMap(
      { id: "t", label: "T", url: "https://t.usw2.devtunnels.ms", token: "btok", tunnelId: "aiordie-h.usw2" },
      provider,
    )

    const { result, json } = await callTool(tools, "list_sessions", { instance: "t" })

    expect(result.isError).toBe(true)
    expect(json).toMatchObject({ error: { code: "AUTH_FAILED" } })
    expect((json as { error: { message: string } }).error.message).toContain("devtunnel")
    expect(calls.length).toBe(0)
  })
})
