import { describe, expect, test } from "bun:test"

import { FleetError, type WaitEventsResponse } from "../../src/lib/fleet/client"
import { createFleetTools, type CreateFleetToolsOptions } from "../../src/lib/fleet/tools"
import { FleetRegistry, type FleetInstanceConfig } from "../../src/lib/fleet/registry"

const INSTANCE_COUNT = 100
const WATCHER_COUNT = 50
const FAILURE_COUNT = 10
const AWAIT_TURN_FANOUT_CONCURRENCY = 256
const LOW_FANOUT_CONCURRENCY = 8
const FLEET_FANOUT_CONCURRENCY_ENV = "GH_ROUTER_FLEET_FANOUT_CONCURRENCY"

type FleetToolClient = ReturnType<NonNullable<CreateFleetToolsOptions["createClient"]>>
type FleetToolMap = Map<string, ReturnType<typeof createFleetTools>[number]>
type PublicInstance = { id: string; label: string }

type AwaitTurnBody = {
  resolvedInstances: Array<PublicInstance>
  events: Array<Record<string, unknown>>
  gaps: Array<Record<string, unknown>>
  cursors: Array<{ instance: PublicInstance; cursor: string }>
  more: boolean
  errors?: Array<{ instance: PublicInstance; error: string; hint?: string }>
}

type ListInstancesBody = {
  instances: Array<{ id: string; label: string; reachable: boolean; sessionCount?: number }>
}

type CreateSessionBody = {
  resolvedInstance: PublicInstance
  sessionId: string
  lifecycle: string
  ready?: boolean
  bound?: boolean
}

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

function scaleInstances(prefix: string, count: number): Array<FleetInstanceConfig> {
  return Array.from({ length: count }, (_, index) => {
    const suffix = index.toString().padStart(3, "0")
    return {
      id: `${prefix}-${suffix}`,
      label: `${prefix} ${suffix}`,
      url: `https://${prefix}-${suffix}.example`,
      token: `tok-${prefix}-${suffix}`,
    }
  })
}

function fleetTools(
  instances: Array<FleetInstanceConfig>,
  createClient: NonNullable<CreateFleetToolsOptions["createClient"]>,
): FleetToolMap {
  const registry = new FleetRegistry({ config: { instances } })
  return new Map(
    createFleetTools({ registry, createClient, awaitTurnDeadlineSlackMs: 0 })
      .map((tool) => [tool.toolNameHttp, tool]),
  )
}

async function callTool(
  tools: FleetToolMap,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: { content: Array<{ type: "text"; text: string }>; isError?: boolean }; json: unknown }> {
  const tool = tools.get(name)
  expect(tool).toBeDefined()
  const result = await tool!.handler(args)
  return { result, json: JSON.parse(result.content[0]!.text) as unknown }
}

function concurrencyProbe() {
  let calls = 0
  let inFlight = 0
  let maxInFlight = 0

  return {
    get calls() {
      return calls
    },
    get maxInFlight() {
      return maxInFlight
    },
    async run<T>(fn: () => T | Promise<T>): Promise<T> {
      calls += 1
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        await Promise.resolve()
        return await fn()
      } finally {
        inFlight -= 1
      }
    },
  }
}

async function withoutFleetFanoutConcurrency<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env[FLEET_FANOUT_CONCURRENCY_ENV]
  delete process.env[FLEET_FANOUT_CONCURRENCY_ENV]
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env[FLEET_FANOUT_CONCURRENCY_ENV]
    else process.env[FLEET_FANOUT_CONCURRENCY_ENV] = previous
  }
}

async function withFleetFanoutConcurrency<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[FLEET_FANOUT_CONCURRENCY_ENV]
  process.env[FLEET_FANOUT_CONCURRENCY_ENV] = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env[FLEET_FANOUT_CONCURRENCY_ENV]
    else process.env[FLEET_FANOUT_CONCURRENCY_ENV] = previous
  }
}

describe("fleet MCP tools scale", () => {
  test("bounds await_turn and list_instances fan-out at 100 instances", async () => {
    await withoutFleetFanoutConcurrency(async () => {
      const instances = scaleInstances("scale-await-default", INSTANCE_COUNT)
      const probe = concurrencyProbe()
      const tools = fleetTools(instances, (instance) => fleetClientStub({
        waitEvents: async (): Promise<WaitEventsResponse> => probe.run(() => ({
          events: [],
          gaps: [],
          cursor: `${instance.id}:c:1`,
          more: false,
        })),
      }))

      const { result, json } = await callTool(tools, "await_turn", {
        watcherId: "scale-await-default-watcher",
        timeoutMs: 0,
      })
      const body = json as AwaitTurnBody

      expect(result.isError).toBeUndefined()
      expect(probe.calls).toBe(INSTANCE_COUNT)
      expect(probe.maxInFlight).toBe(INSTANCE_COUNT)
      expect(probe.maxInFlight).toBeLessThanOrEqual(AWAIT_TURN_FANOUT_CONCURRENCY)
      expect(body.cursors).toHaveLength(INSTANCE_COUNT)
    })

    await withFleetFanoutConcurrency(String(LOW_FANOUT_CONCURRENCY), async () => {
      const instances = scaleInstances("scale-await-low-cap", INSTANCE_COUNT)
      const probe = concurrencyProbe()
      const tools = fleetTools(instances, (instance) => fleetClientStub({
        waitEvents: async (): Promise<WaitEventsResponse> => probe.run(() => ({
          events: [],
          gaps: [],
          cursor: `${instance.id}:c:1`,
          more: false,
        })),
      }))

      const { result } = await callTool(tools, "await_turn", {
        watcherId: "scale-await-low-cap-watcher",
        timeoutMs: 0,
      })

      expect(result.isError).toBeUndefined()
      expect(probe.calls).toBe(INSTANCE_COUNT)
      expect(probe.maxInFlight).toBe(LOW_FANOUT_CONCURRENCY)
      expect(probe.maxInFlight).toBeLessThanOrEqual(LOW_FANOUT_CONCURRENCY)
    })

    await withFleetFanoutConcurrency(String(LOW_FANOUT_CONCURRENCY), async () => {
      const instances = scaleInstances("scale-list-low-cap", INSTANCE_COUNT)
      const probe = concurrencyProbe()
      const tools = fleetTools(instances, () => fleetClientStub({
        listSessions: async () => probe.run(() => ({ sessions: [] })),
      }))

      const { result, json } = await callTool(tools, "list_instances", {})
      const body = json as ListInstancesBody

      expect(result.isError).toBeUndefined()
      expect(probe.calls).toBe(INSTANCE_COUNT)
      expect(probe.maxInFlight).toBe(LOW_FANOUT_CONCURRENCY)
      expect(probe.maxInFlight).toBeLessThanOrEqual(LOW_FANOUT_CONCURRENCY)
      expect(body.instances).toHaveLength(INSTANCE_COUNT)
      expect(body.instances.every((instance) => instance.reachable === true)).toBe(true)
    })
  })

  test("keeps 50 watcher cursor streams isolated on one instance", async () => {
    const [instance] = scaleInstances("scale-cursor-isolation", 1)
    const watcherIds = Array.from({ length: WATCHER_COUNT }, (_, index) => `scale-watcher-${index}`)
    const cursorInputsByWatcher = new Map<string, Array<string | undefined>>()
    const firstCursorByWatcher = new Map<string, string>()
    let currentWatcherId = ""
    let callCount = 0
    const tools = fleetTools([instance!], () => fleetClientStub({
      waitEvents: async (input): Promise<WaitEventsResponse> => {
        const watcherId = currentWatcherId
        const seen = cursorInputsByWatcher.get(watcherId) ?? []
        seen.push(input.cursor)
        cursorInputsByWatcher.set(watcherId, seen)
        callCount += 1
        return {
          events: [],
          gaps: [],
          cursor: `cursor-${callCount}`,
          more: false,
        }
      },
    }))

    for (const watcherId of watcherIds) {
      currentWatcherId = watcherId
      const { result, json } = await callTool(tools, "await_turn", {
        instances: [instance!.id],
        watcherId,
        timeoutMs: 0,
      })
      const body = json as AwaitTurnBody
      expect(result.isError).toBeUndefined()
      expect(body.cursors).toHaveLength(1)
      firstCursorByWatcher.set(watcherId, body.cursors[0]!.cursor)
    }

    for (const watcherId of watcherIds) {
      currentWatcherId = watcherId
      const { result } = await callTool(tools, "await_turn", {
        instances: [instance!.id],
        watcherId,
        timeoutMs: 0,
      })
      expect(result.isError).toBeUndefined()
    }

    expect(callCount).toBe(WATCHER_COUNT * 2)
    for (const watcherId of watcherIds) {
      expect(cursorInputsByWatcher.get(watcherId)).toEqual([undefined, firstCursorByWatcher.get(watcherId)])
    }
  })

  test("keeps 90 healthy events when 10 of 100 instances fail", async () => {
    const instances = scaleInstances("scale-partial-failure", INSTANCE_COUNT)
    const failingIds = new Set(instances
      .filter((_instance, index) => index < FAILURE_COUNT)
      .map((instance) => instance.id))
    let waitEventsCalls = 0
    const tools = fleetTools(instances, (instance) => fleetClientStub({
      waitEvents: async (): Promise<WaitEventsResponse> => {
        waitEventsCalls += 1
        if (failingIds.has(instance.id)) {
          throw new FleetError({ code: "UNREACHABLE", message: "host down", retryable: true })
        }
        const index = instances.findIndex((candidate) => candidate.id === instance.id)
        return {
          events: [{
            seq: index,
            sessionId: `session-${instance.id}`,
            kind: "turn_ended",
            at: 1_000 + index,
          }],
          gaps: [],
          cursor: `${instance.id}:cursor`,
          more: false,
        }
      },
    }))

    const { result, json } = await callTool(tools, "await_turn", {
      watcherId: "scale-partial-failure-watcher",
      timeoutMs: 0,
    })
    const body = json as AwaitTurnBody

    expect(result.isError).toBeUndefined()
    expect(waitEventsCalls).toBe(INSTANCE_COUNT)
    expect(body.events).toHaveLength(INSTANCE_COUNT - FAILURE_COUNT)
    expect(body.errors).toHaveLength(FAILURE_COUNT)
    expect(body.cursors).toHaveLength(INSTANCE_COUNT - FAILURE_COUNT)
    expect(body.errors?.map((error) => error.instance.id).sort()).toEqual([...failingIds].sort())
    expect(body.errors?.every((error) => error.error === "UNREACHABLE")).toBe(true)

    const eventInstanceIds = body.events.map((event) => (event.instance as PublicInstance).id).sort()
    const healthyIds = instances
      .map((instance) => instance.id)
      .filter((id) => !failingIds.has(id))
      .sort()
    expect(eventInstanceIds).toEqual(healthyIds)
    for (const event of body.events) {
      const stampedInstance = event.instance as PublicInstance
      expect(event.sessionId).toBe(`${stampedInstance.id}:session-${stampedInstance.id}`)
    }
  })

  test("creates sessions concurrently across 100 instances with per-instance ids", async () => {
    const instances = scaleInstances("scale-create-session", INSTANCE_COUNT)
    let createCalls = 0
    const tools = fleetTools(instances, (instance) => fleetClientStub({
      createSession: async (input) => {
        createCalls += 1
        expect(input.idempotencyKey).toBe(`idem-${instance.id}`)
        await Promise.resolve()
        return {
          sessionId: `local-${instance.id}`,
          lifecycle: "running",
          ready: true,
          bound: true,
        }
      },
    }))

    const results = await Promise.all(instances.map((instance) => callTool(tools, "create_session", {
      instance: instance.id,
      agent: "codex",
      idempotencyKey: `idem-${instance.id}`,
    })))

    expect(createCalls).toBe(INSTANCE_COUNT)
    for (const [index, { result, json }] of results.entries()) {
      const instance = instances[index]!
      const body = json as CreateSessionBody
      expect(result.isError).toBeUndefined()
      expect(body.resolvedInstance).toEqual({ id: instance.id, label: instance.label })
      expect(body.sessionId).toBe(`${instance.id}:local-${instance.id}`)
      expect(body.ready).toBe(true)
      expect(body.bound).toBe(true)
    }
  })
})
