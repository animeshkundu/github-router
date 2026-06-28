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
    capabilities: unusedClientCall,
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

function createSessionCapabilityToolMap(capabilityResponse: {
  status: number
  capabilities?: Array<string>
}) {
  const registry = new FleetRegistry({
    config: { instances: [{ id: "alpha", label: "Alpha", url: "https://alpha.example", token: "tok-alpha" }] },
  })
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlString = url.toString()
    const parsed = new URL(urlString)
    calls.push({
      url: urlString,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
    })
    if (parsed.pathname === "/api/control/capabilities") {
      if (capabilityResponse.status === 200) {
        return Response.json({ capabilities: capabilityResponse.capabilities ?? [], controlVersion: "f19-test" })
      }
      return Response.json(
        { error: { message: `capabilities returned ${capabilityResponse.status}` } },
        { status: capabilityResponse.status },
      )
    }
    if (parsed.pathname === "/api/control/sessions/create") {
      return Response.json({ sessionId: "created-a", lifecycle: "running" })
    }
    return Response.json({ error: { message: `unhandled ${parsed.pathname}` } }, { status: 500 })
  }) as unknown as typeof fetch
  const tools = new Map(createFleetTools({ registry, fetchFn }).map((tool) => [tool.toolNameHttp, tool]))
  return { tools, calls }
}

function callsToPath(
  calls: Array<{ url: string; method: string; body?: unknown }>,
  pathname: string,
): Array<{ url: string; method: string; body?: unknown }> {
  return calls.filter((call) => new URL(call.url).pathname === pathname)
}

async function withFleetFanoutConcurrency<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.GH_ROUTER_FLEET_FANOUT_CONCURRENCY
  process.env.GH_ROUTER_FLEET_FANOUT_CONCURRENCY = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.GH_ROUTER_FLEET_FANOUT_CONCURRENCY
    else process.env.GH_ROUTER_FLEET_FANOUT_CONCURRENCY = previous
  }
}

function abortLikeError(): Error {
  const err = new Error("aborted")
  err.name = "AbortError"
  return err
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

  test("await_turn keeps healthy results when one instance fails and does not advance the failed cursor", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "partial-ok-f20", label: "Partial OK", url: "https://partial-ok-f20.example", token: "tok-ok" },
          { id: "partial-fail-f20", label: "Partial Fail", url: "https://partial-fail-f20.example", token: "tok-fail" },
        ],
      },
    })
    const healthyInputs: Array<{ cursor?: string }> = []
    const failedInputs: Array<{ cursor?: string }> = []
    let healthyCall = 0
    let failedCall = 0
    const createClient = mock((instance) => fleetClientStub({
      waitEvents: mock(async (input: Parameters<FleetToolClient["waitEvents"]>[0]) => {
        if (instance.id === "partial-ok-f20") {
          healthyInputs.push({ cursor: input.cursor })
          healthyCall += 1
          return {
            events: healthyCall === 1
              ? [{ seq: 1, sessionId: "session-ok", kind: "turn_ended", at: 1_000 }]
              : [],
            gaps: [],
            cursor: `healthy-cursor-${healthyCall}`,
            more: healthyCall === 1,
          }
        }
        failedInputs.push({ cursor: input.cursor })
        failedCall += 1
        if (failedCall === 1) {
          throw new FleetError({ code: "UNREACHABLE", message: "host down", retryable: true })
        }
        return { events: [], gaps: [], cursor: `failed-cursor-${failedCall}`, more: false }
      }),
    })) satisfies NonNullable<CreateFleetToolsOptions["createClient"]>
    const tools = new Map(createFleetTools({ registry, createClient }).map((tool) => [tool.toolNameHttp, tool]))

    const { result, json } = await callTool(tools, "await_turn", {
      instances: ["partial-ok-f20", "partial-fail-f20"],
      watcherId: "partial-f20",
      timeoutMs: 25,
    })
    const first = json as {
      events: Array<Record<string, unknown>>
      cursors: Array<Record<string, unknown>>
      errors?: Array<Record<string, unknown>>
      more?: boolean
    }

    expect(result.isError).toBeUndefined()
    expect(first.events).toEqual([
      expect.objectContaining({
        seq: 1,
        sessionId: "partial-ok-f20:session-ok",
        kind: "turn_ended",
        instance: { id: "partial-ok-f20", label: "Partial OK" },
      }),
    ])
    expect(first.errors).toEqual([
      expect.objectContaining({
        instance: { id: "partial-fail-f20", label: "Partial Fail" },
        error: "UNREACHABLE",
      }),
    ])
    expect(first.cursors).toEqual([
      { instance: { id: "partial-ok-f20", label: "Partial OK" }, cursor: "healthy-cursor-1" },
    ])
    expect(first.more).toBe(true)

    await callTool(tools, "await_turn", {
      instances: ["partial-ok-f20", "partial-fail-f20"],
      watcherId: "partial-f20",
      timeoutMs: 25,
    })

    expect(healthyInputs.map((input) => input.cursor)).toEqual([undefined, "healthy-cursor-1"])
    expect(failedInputs.map((input) => input.cursor)).toEqual([undefined, undefined])
  })

  test("await_turn cuts a hung instance at the per-instance deadline", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "deadline-f20", label: "Deadline", url: "https://deadline-f20.example", token: "tok-deadline" },
        ],
      },
    })
    let observedAbort = false
    const fetchFn = mock((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) {
        reject(new Error("expected an abort signal"))
        return
      }
      const rejectAbort = () => {
        observedAbort = true
        reject(signal.reason instanceof Error ? signal.reason : abortLikeError())
      }
      if (signal.aborted) {
        rejectAbort()
        return
      }
      signal.addEventListener("abort", rejectAbort, { once: true })
    })) as unknown as typeof fetch
    const tools = new Map(
      createFleetTools({ registry, fetchFn, awaitTurnDeadlineSlackMs: 0 }).map((tool) => [tool.toolNameHttp, tool]),
    )

    const { result, json } = await callTool(tools, "await_turn", {
      instances: ["deadline-f20"],
      watcherId: "deadline-f20",
      timeoutMs: 1,
    })
    const body = json as { events: Array<unknown>; errors?: Array<Record<string, unknown>> }

    expect(result.isError).toBeUndefined()
    expect(observedAbort).toBe(true)
    expect(body.events).toEqual([])
    expect(body.errors).toEqual([
      expect.objectContaining({
        instance: { id: "deadline-f20", label: "Deadline" },
        error: "TIMEOUT",
      }),
    ])
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  test("await_turn watcherId keeps concurrent watchers on the same set isolated", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "watcher-f22", label: "Watcher", url: "https://watcher-f22.example", token: "tok-watch" },
        ],
      },
    })
    const inputs: Array<{ cursor?: string }> = []
    let callCount = 0
    const createClient = mock(() => fleetClientStub({
      waitEvents: mock(async (input: Parameters<FleetToolClient["waitEvents"]>[0]) => {
        inputs.push({ cursor: input.cursor })
        callCount += 1
        return { events: [], gaps: [], cursor: `cursor-${callCount}`, more: false }
      }),
    })) satisfies NonNullable<CreateFleetToolsOptions["createClient"]>
    const tools = new Map(createFleetTools({ registry, createClient }).map((tool) => [tool.toolNameHttp, tool]))

    await callTool(tools, "await_turn", { instances: ["watcher-f22"], watcherId: "watcher-a", timeoutMs: 25 })
    await callTool(tools, "await_turn", { instances: ["watcher-f22"], watcherId: "watcher-b", timeoutMs: 25 })
    await callTool(tools, "await_turn", { instances: ["watcher-f22"], watcherId: "watcher-a", timeoutMs: 25 })

    expect(inputs.map((input) => input.cursor)).toEqual([undefined, undefined, "cursor-1"])
  })

  test("await_turn keeps a watcher's per-instance cursor when the instance set changes", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "set-a", label: "Set A", url: "https://set-a.example", token: "tok-a" },
          { id: "set-b", label: "Set B", url: "https://set-b.example", token: "tok-b" },
        ],
      },
    })
    const cursorInputsByInstance = new Map<string, Array<string | undefined>>()
    const createClient = mock((instance) => fleetClientStub({
      waitEvents: mock(async (input: Parameters<FleetToolClient["waitEvents"]>[0]) => {
        const seen = cursorInputsByInstance.get(instance.id) ?? []
        seen.push(input.cursor)
        cursorInputsByInstance.set(instance.id, seen)
        return { events: [], gaps: [], cursor: `${instance.id}-cursor`, more: false }
      }),
    })) satisfies NonNullable<CreateFleetToolsOptions["createClient"]>
    const tools = new Map(createFleetTools({ registry, createClient }).map((tool) => [tool.toolNameHttp, tool]))

    // Same watcher polls BOTH instances, then only set-a (set-b dropped). The
    // cursor key is watcherId-only, NOT the instance set, so set-a's cursor from
    // the first call must still be passed on the second despite the set change.
    await callTool(tools, "await_turn", { instances: ["set-a", "set-b"], watcherId: "w1", timeoutMs: 25 })
    await callTool(tools, "await_turn", { instances: ["set-a"], watcherId: "w1", timeoutMs: 25 })

    expect(cursorInputsByInstance.get("set-a")).toEqual([undefined, "set-a-cursor"])
  })

  test("list_instances caps probe fan-out concurrency", async () => {
    await withFleetFanoutConcurrency("3", async () => {
      const instances = Array.from({ length: 12 }, (_, index) => ({
        id: `cap-f21-${index}`,
        label: `Cap ${index}`,
        url: `https://cap-f21-${index}.example`,
        token: `tok-cap-${index}`,
      }))
      const registry = new FleetRegistry({ config: { instances } })
      let inFlight = 0
      let maxInFlight = 0
      const fetchFn = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return Response.json({ sessions: [] })
        } finally {
          inFlight -= 1
        }
      }) as unknown as typeof fetch
      const tools = new Map(createFleetTools({ registry, fetchFn }).map((tool) => [tool.toolNameHttp, tool]))

      const { result, json } = await callTool(tools, "list_instances", {})
      const body = json as { instances: Array<Record<string, unknown>> }

      expect(result.isError).toBeUndefined()
      expect(fetchFn).toHaveBeenCalledTimes(instances.length)
      expect(maxInFlight).toBeLessThanOrEqual(3)
      expect(body.instances.every((instance) => instance.reachable === true)).toBe(true)
    })
  })

  test("list_instances retries one RATE_LIMITED probe after injected backoff", async () => {
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "rate-limited-f21", label: "Rate Limited", url: "https://rate-limited-f21.example", token: "tok-rate" },
        ],
      },
    })
    let attempts = 0
    const delays: Array<number> = []
    const fetchFn = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
      attempts += 1
      if (attempts === 1) {
        return Response.json({ error: { message: "slow down" } }, { status: 429 })
      }
      return Response.json({ sessions: [{ sessionId: "after-retry" }] })
    }) as unknown as typeof fetch
    const tools = new Map(
      createFleetTools({
        registry,
        fetchFn,
        probeRetryDelay: async (ms) => { delays.push(ms) },
      }).map((tool) => [tool.toolNameHttp, tool]),
    )

    const { result, json } = await callTool(tools, "list_instances", {})
    const body = json as { instances: Array<Record<string, unknown>> }

    expect(result.isError).toBeUndefined()
    expect(attempts).toBe(2)
    expect(delays).toEqual([250])
    expect(body.instances[0]).toMatchObject({
      id: "rate-limited-f21",
      label: "Rate Limited",
      reachable: true,
      sessionCount: 1,
    })
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

    const createCalls = callsToPath(calls, "/api/control/sessions/create")
    expect(result.isError).toBeUndefined()
    expect(callsToPath(calls, "/api/control/capabilities")).toHaveLength(1)
    expect(createCalls[0]?.body).toEqual({
      agent: "claude",
      start: true,
      permissionMode: "plan",
      agentArgs: ["--model", "opus"],
      idempotencyKey: "idem-f10",
    })
  })

  test("create_session allows permissionMode when the instance advertises permission_mode", async () => {
    const { tools, calls } = createSessionCapabilityToolMap({
      status: 200,
      capabilities: ["readiness_barrier", "permission_mode"],
    })

    const { result } = await callTool(tools, "create_session", {
      instance: "alpha",
      agent: "claude",
      permissionMode: "plan",
      idempotencyKey: "idem-cap-allow",
    })

    const createCalls = callsToPath(calls, "/api/control/sessions/create")
    expect(result.isError).toBeUndefined()
    expect(callsToPath(calls, "/api/control/capabilities")).toHaveLength(1)
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.body).toMatchObject({
      agent: "claude",
      permissionMode: "plan",
      idempotencyKey: "idem-cap-allow",
    })
  })

  test("create_session rejects permissionMode when capabilities omit permission_mode", async () => {
    const { tools, calls } = createSessionCapabilityToolMap({
      status: 200,
      capabilities: ["readiness_barrier", "turn_binding"],
    })

    const { result, json } = await callTool(tools, "create_session", {
      instance: "alpha",
      agent: "claude",
      permissionMode: "plan",
      idempotencyKey: "idem-cap-deny",
    })

    expect(result.isError).toBe(true)
    expect(json).toMatchObject({ error: { code: "UNSUPPORTED_CAPABILITY" } })
    expect((json as { error: { message: string } }).error.message).toContain("permission_mode")
    expect(callsToPath(calls, "/api/control/capabilities")).toHaveLength(1)
    expect(callsToPath(calls, "/api/control/sessions/create")).toHaveLength(0)
  })

  test("create_session fail-opens permissionMode when capabilities is 404 on a legacy server", async () => {
    const { tools, calls } = createSessionCapabilityToolMap({ status: 404 })

    const { result } = await callTool(tools, "create_session", {
      instance: "alpha",
      agent: "claude",
      permissionMode: "plan",
      idempotencyKey: "idem-cap-404",
    })

    expect(result.isError).toBeUndefined()
    expect(callsToPath(calls, "/api/control/capabilities")).toHaveLength(1)
    expect(callsToPath(calls, "/api/control/sessions/create")).toHaveLength(1)
  })

  test("create_session fail-opens permissionMode when capabilities returns 500", async () => {
    const { tools, calls } = createSessionCapabilityToolMap({ status: 500 })

    const { result } = await callTool(tools, "create_session", {
      instance: "alpha",
      agent: "claude",
      permissionMode: "plan",
      idempotencyKey: "idem-cap-500",
    })

    expect(result.isError).toBeUndefined()
    expect(callsToPath(calls, "/api/control/capabilities")).toHaveLength(1)
    expect(callsToPath(calls, "/api/control/sessions/create")).toHaveLength(1)
  })

  test("create_session caches capabilities per instance", async () => {
    const { tools, calls } = createSessionCapabilityToolMap({
      status: 200,
      capabilities: ["permission_mode"],
    })

    await callTool(tools, "create_session", {
      instance: "alpha",
      agent: "claude",
      permissionMode: "plan",
      idempotencyKey: "idem-cap-cache-1",
    })
    await callTool(tools, "create_session", {
      instance: "alpha",
      agent: "claude",
      permissionMode: "plan",
      idempotencyKey: "idem-cap-cache-2",
    })

    expect(callsToPath(calls, "/api/control/capabilities")).toHaveLength(1)
    expect(callsToPath(calls, "/api/control/sessions/create")).toHaveLength(2)
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

describe("createFleetTools insecureTLS wiring", () => {
  test("threads insecureTLS into the FleetClient fetch; cache key keeps same-url instances distinct", async () => {
    const inits: Array<RequestInit | undefined> = []
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      inits.push(init)
      return Response.json({ sessions: [] })
    }) as unknown as typeof fetch

    // Two instances, identical url, differing ONLY by insecureTLS. Exercises the
    // real clientFor -> new FleetClient path (no createClient override). If the
    // flag were dropped from the cache key, both would share one client and BOTH
    // (or neither) inits would carry tls.
    const registry = new FleetRegistry({
      config: {
        instances: [
          { id: "li", label: "li", url: "https://localhost:7777", token: "none", insecureTLS: true },
          { id: "ln", label: "ln", url: "https://localhost:7777", token: "none" },
        ],
      },
    })
    const tools = new Map(createFleetTools({ registry, fetchFn }).map((tool) => [tool.toolNameHttp, tool]))

    await tools.get("list_instances")!.handler({})

    expect(inits.length).toBe(2)
    const withTls = inits.filter((i) => (i as { tls?: unknown } | undefined)?.tls !== undefined)
    expect(withTls.length).toBe(1)
    expect((withTls[0] as { tls?: unknown }).tls).toEqual({ rejectUnauthorized: false })
  })
})
