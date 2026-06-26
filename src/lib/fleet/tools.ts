import type { McpGroup, NonPersonaMcpTool } from "../peer-mcp-personas"
import {
  FleetClient,
  decodeSessionId,
  encodeSessionId,
  type CreateSessionInput,
  type CreateSessionResponse,
  type FleetErrorCode,
  type FleetEvent,
  type FleetSessionSummary,
  type ReadSessionResponse,
  type RespondResponse,
  type SendKeysResponse,
  type SendMessageResponse,
  type StatusResponse,
  type StopSessionInput,
  type StopSessionResponse,
  type WaitEventsResponse,
} from "./client"
import {
  FleetRegistry,
  FleetRegistryError,
  type FleetInstanceInfo,
  type FleetResolvedInstance,
} from "./registry"

const FLEET_GROUP: McpGroup = "fleet"
const INSTANCE_PROBE_TIMEOUT_MS = 2_000
const INSTANCE_PROBE_CACHE_TTL_MS = 5_000

type FleetInstanceProbeResult =
  | { id: string; label: string; reachable: true; sessionCount: number; lastSeen: number }
  | { id: string; label: string; reachable: false; error: FleetErrorCode }

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

interface FleetRegistryLike {
  resolveInstance(arg?: string): Promise<FleetResolvedInstance>
  listInstances(): Promise<Array<FleetInstanceInfo>>
}

interface FleetClientLike {
  listSessions(signal?: AbortSignal): Promise<{ sessions: Array<FleetSessionSummary> }>
  readSession(sessionId: string, lines?: number, signal?: AbortSignal): Promise<ReadSessionResponse>
  status(sessionId: string, signal?: AbortSignal): Promise<StatusResponse>
  createSession(input: CreateSessionInput, signal?: AbortSignal): Promise<CreateSessionResponse>
  stopSession(sessionId: string, input?: StopSessionInput, signal?: AbortSignal): Promise<StopSessionResponse>
  sendMessage(
    sessionId: string,
    input: { message: string; idempotencyKey: string; awaitMs?: number },
    signal?: AbortSignal,
  ): Promise<SendMessageResponse>
  sendKeys(
    sessionId: string,
    input: { keys: string; idempotencyKey: string; raw?: boolean },
    signal?: AbortSignal,
  ): Promise<SendKeysResponse>
  respond(
    sessionId: string,
    input: { choice?: string; optionValue?: string; keys?: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<RespondResponse>
  waitEvents(input: {
    cursor?: string
    timeoutMs?: number
    sessionIds?: ReadonlyArray<string>
    kinds?: ReadonlyArray<string>
  }, signal?: AbortSignal): Promise<WaitEventsResponse>
  readFile(pathValue: string, signal?: AbortSignal): Promise<Record<string, unknown>>
  listDir(pathValue: string, signal?: AbortSignal): Promise<Record<string, unknown>>
  search(queryValue: string, pathValue?: string, signal?: AbortSignal): Promise<Record<string, unknown>>
  gitShow(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
}

export interface CreateFleetToolsOptions {
  registry?: FleetRegistryLike
  fetchFn?: typeof fetch
  createClient?: (instance: FleetResolvedInstance) => FleetClientLike
}

class FleetToolInputError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "FleetToolInputError"
    this.code = code
  }
}

let defaultRegistry: FleetRegistry | undefined
const awaitTurnCursors = new Map<string, Map<string, string>>()
const instanceProbeCache = new Map<string, { result: FleetInstanceProbeResult; at: number }>()

export function createFleetTools(options: CreateFleetToolsOptions = {}): ReadonlyArray<NonPersonaMcpTool> {
  const registry = options.registry
  const clients = new Map<string, FleetClientLike>()

  function getRegistry(): FleetRegistryLike {
    if (registry) return registry
    defaultRegistry ??= new FleetRegistry()
    return defaultRegistry
  }

  function clientFor(instance: FleetResolvedInstance): FleetClientLike {
    const key = `${instance.id}\0${instance.url}\0${instance.token}`
    const existing = clients.get(key)
    if (existing) return existing
    const created = options.createClient
      ? options.createClient(instance)
      : new FleetClient({ url: instance.url, token: instance.token, fetchFn: options.fetchFn })
    clients.set(key, created)
    return created
  }

  async function resolve(arg?: string): Promise<FleetResolvedInstance> {
    return getRegistry().resolveInstance(arg)
  }

  async function resolveSession(
    args: Record<string, unknown>,
  ): Promise<{ instance: FleetResolvedInstance; localId: string; globalId: string }> {
    const globalId = requiredString(args, "sessionId")
    const decoded = decodeSessionId(globalId)
    const instance = await resolve(decoded.instanceId)
    const explicitInstance = optionalString(args, "instance")
    if (explicitInstance !== undefined) {
      const explicit = await resolve(explicitInstance)
      if (explicit.id !== decoded.instanceId) {
        throw new FleetToolInputError(
          "INSTANCE_MISMATCH",
          `sessionId is for instance ${JSON.stringify(decoded.instanceId)} but arguments.instance resolved to ${JSON.stringify(explicit.id)}`,
        )
      }
    }
    return { instance, localId: decoded.localId, globalId }
  }

  async function probeInstance(info: FleetInstanceInfo): Promise<FleetInstanceProbeResult> {
    const cacheKey = `${info.id}\0${info.url}`
    const now = Date.now()
    const cached = instanceProbeCache.get(cacheKey)
    if (cached && now - cached.at < INSTANCE_PROBE_CACHE_TTL_MS) return cached.result

    const timeout = createProbeTimeout()
    try {
      const instance = await resolve(info.id)
      const response = await clientFor(instance).listSessions(timeout.signal)
      const lastSeen = Date.now()
      const result: FleetInstanceProbeResult = {
        id: info.id,
        label: info.label,
        reachable: true,
        sessionCount: response.sessions.length,
        lastSeen,
      }
      instanceProbeCache.set(cacheKey, { result, at: lastSeen })
      return result
    } catch (err) {
      const result: FleetInstanceProbeResult = {
        id: info.id,
        label: info.label,
        reachable: false,
        error: fleetProbeErrorCode(err),
      }
      instanceProbeCache.set(cacheKey, { result, at: Date.now() })
      return result
    } finally {
      timeout.cleanup()
    }
  }

  function tool(
    toolNameHttp: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpToolResult>,
  ): NonPersonaMcpTool {
    return {
      toolNameHttp,
      group: FLEET_GROUP,
      description,
      inputSchema,
      capability: "fleet",
      async handler(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
        try {
          return await handler(args, signal)
        } catch (err) {
          return errorResult(err)
        }
      },
    }
  }

  return Object.freeze([
    tool(
      "list_instances",
      "List registered remote ai-or-die instances in the fleet registry. Tokens are never returned.",
      objectSchema({}, []),
      async () => {
        const instances = await getRegistry().listInstances()
        const probed = await Promise.all(instances.map((instance) => probeInstance(instance)))
        return ok({ instances: probed })
      },
    ),
    tool(
      "list_sessions",
      "List sessions on one fleet instance, returning globally-addressable session ids.",
      objectSchema({ instance: stringProp("Instance id or label. Defaults to the registry default, or the sole instance.") }, []),
      async (args, signal) => {
        const instance = await resolve(optionalString(args, "instance"))
        const response = await clientFor(instance).listSessions(signal)
        return ok({
          resolvedInstance: publicInstance(instance),
          sessions: response.sessions.map((session) => globalizeSession(instance.id, session)),
        })
      },
    ),
    tool(
      "read_session",
      "Read recent text output from an addressed fleet session.",
      objectSchema({
        sessionId: stringProp("Global session id in the form instanceId:localSessionId."),
        instance: stringProp("Optional instance id/label; when supplied it must agree with sessionId."),
        lines: numberProp("Number of recent lines to read."),
        format: stringProp("Reserved for future formatting; results are JSON text today."),
      }, ["sessionId"]),
      async (args, signal) => {
        const { instance, localId, globalId } = await resolveSession(args)
        const lines = optionalNumber(args, "lines")
        const response = await clientFor(instance).readSession(localId, lines, signal)
        return ok({ resolvedInstance: publicInstance(instance), ...response, sessionId: globalId })
      },
    ),
    tool(
      "session_status",
      "Fetch lifecycle and interaction status for an addressed fleet session.",
      objectSchema({
        sessionId: stringProp("Global session id in the form instanceId:localSessionId."),
        instance: stringProp("Optional instance id/label; when supplied it must agree with sessionId."),
      }, ["sessionId"]),
      async (args, signal) => {
        const { instance, localId, globalId } = await resolveSession(args)
        const response = await clientFor(instance).status(localId, signal)
        return ok({ resolvedInstance: publicInstance(instance), ...response, sessionId: globalId })
      },
    ),
    tool(
      "send_message",
      "Send a message to a fleet session. Returns isError if delivery failed or an awaited confirmation did not arrive.",
      objectSchema({
        sessionId: stringProp("Global session id in the form instanceId:localSessionId."),
        instance: stringProp("Optional instance id/label; when supplied it must agree with sessionId."),
        message: stringProp("Message text to deliver to the session."),
        idempotencyKey: stringProp("Caller-generated idempotency key."),
        awaitMs: numberProp("Optional confirmation wait time in milliseconds."),
      }, ["sessionId", "message", "idempotencyKey"]),
      async (args, signal) => {
        const { instance, localId, globalId } = await resolveSession(args)
        const awaitMs = optionalNumber(args, "awaitMs")
        const response = await clientFor(instance).sendMessage(
          localId,
          {
            message: requiredString(args, "message"),
            idempotencyKey: requiredString(args, "idempotencyKey"),
            ...(awaitMs === undefined ? {} : { awaitMs }),
          },
          signal,
        )
        const delivered = response.delivered !== false
        const confirmed = response.confirmed !== false
        const unconfirmedAfterAwait = awaitMs !== undefined && awaitMs > 0 && !confirmed
        const isError = !delivered || unconfirmedAfterAwait
        return jsonResult({
          resolvedInstance: publicInstance(instance),
          sessionId: globalId,
          ...response,
          ...(isError
            ? {
                message: !delivered
                  ? "message was not delivered by the upstream instance"
                  : `message delivery was not confirmed within awaitMs=${awaitMs}`,
              }
            : {}),
        }, isError)
      },
    ),
    tool(
      "send_keys",
      "Send key input to a fleet session.",
      objectSchema({
        sessionId: stringProp("Global session id in the form instanceId:localSessionId."),
        instance: stringProp("Optional instance id/label; when supplied it must agree with sessionId."),
        keys: stringProp("Key sequence to send."),
        idempotencyKey: stringProp("Caller-generated idempotency key."),
        raw: booleanProp("Pass keys through as raw input when the instance supports it."),
      }, ["sessionId", "keys", "idempotencyKey"]),
      async (args, signal) => {
        const { instance, localId, globalId } = await resolveSession(args)
        const raw = optionalBoolean(args, "raw")
        const response = await clientFor(instance).sendKeys(
          localId,
          {
            keys: requiredString(args, "keys"),
            idempotencyKey: requiredString(args, "idempotencyKey"),
            ...(raw === undefined ? {} : { raw }),
          },
          signal,
        )
        return ok({ resolvedInstance: publicInstance(instance), sessionId: globalId, ...response })
      },
    ),
    tool(
      "respond",
      "Answer an awaited prompt in a fleet session by choice, option value, or explicit key override.",
      objectSchema({
        sessionId: stringProp("Global session id in the form instanceId:localSessionId."),
        instance: stringProp("Optional instance id/label; when supplied it must agree with sessionId."),
        choice: stringProp("Named or numbered choice to select."),
        optionValue: stringProp("Exact option value to select."),
        keys: stringProp("Explicit key override to send instead of a mapped choice."),
        idempotencyKey: stringProp("Caller-generated idempotency key."),
      }, ["sessionId", "idempotencyKey"]),
      async (args, signal) => {
        const { instance, localId, globalId } = await resolveSession(args)
        const input = definedObject({
          choice: optionalString(args, "choice"),
          optionValue: optionalString(args, "optionValue"),
          keys: optionalString(args, "keys"),
          idempotencyKey: requiredString(args, "idempotencyKey"),
        }) as { choice?: string; optionValue?: string; keys?: string; idempotencyKey: string }
        const response = await clientFor(instance).respond(localId, input, signal)
        return ok({ resolvedInstance: publicInstance(instance), sessionId: globalId, ...response })
      },
    ),
    tool(
      "create_session",
      "Create a new session on a specific fleet instance. The instance argument is required; no default is used.",
      objectSchema({
        instance: stringProp("Required instance id or label. Create never uses the registry default."),
        agent: stringProp("Agent/runtime to create on the instance."),
        name: stringProp("Optional display name for the session."),
        workingDir: stringProp("Optional working directory on the remote instance."),
        idempotencyKey: stringProp("Caller-generated idempotency key."),
        start: booleanProp("Whether the remote instance should start the session immediately."),
      }, ["instance", "agent", "idempotencyKey"]),
      async (args, signal) => {
        const instance = await resolve(requiredString(args, "instance"))
        const idempotencyKey = requiredString(args, "idempotencyKey")
        // End-to-end idempotency also requires the ai-or-die control plane to dedupe by this key.
        const response = await clientFor(instance).createSession(
          definedObject({
            agent: requiredString(args, "agent"),
            name: optionalString(args, "name"),
            workingDir: optionalString(args, "workingDir"),
            start: optionalBoolean(args, "start"),
            idempotencyKey,
          }),
          signal,
        )
        const localSessionId = typeof response.sessionId === "string" ? response.sessionId : ""
        return ok({
          resolvedInstance: publicInstance(instance),
          ...response,
          sessionId: localSessionId ? encodeSessionId(instance.id, localSessionId) : response.sessionId,
        })
      },
    ),
    tool(
      "stop_session",
      "Stop a fleet session.",
      objectSchema({
        sessionId: stringProp("Global session id in the form instanceId:localSessionId."),
        instance: stringProp("Optional instance id/label; when supplied it must agree with sessionId."),
        idempotencyKey: stringProp("Caller-generated idempotency key."),
        mode: stringProp("Optional stop mode understood by the remote instance."),
      }, ["sessionId", "idempotencyKey"]),
      async (args, signal) => {
        const { instance, localId, globalId } = await resolveSession(args)
        const idempotencyKey = requiredString(args, "idempotencyKey")
        // End-to-end idempotency also requires the ai-or-die control plane to dedupe by this key.
        const response = await clientFor(instance).stopSession(
          localId,
          definedObject({ mode: optionalString(args, "mode"), idempotencyKey }),
          signal,
        )
        return ok({ resolvedInstance: publicInstance(instance), sessionId: globalId, ...response })
      },
    ),
    tool(
      "await_turn",
      "Long-poll session events across fleet instances. The server owns per-target cursors, so callers do not pass cursor tokens.",
      objectSchema({
        instances: arrayProp("Instance ids or labels to poll. Omit with sessionIds to target those session instances; omit both to poll every registered instance."),
        sessionIds: arrayProp("Global session ids to filter to."),
        timeoutMs: numberProp("Long-poll timeout per instance in milliseconds."),
        kinds: arrayProp("Optional event kinds to filter to."),
      }, []),
      async (args, signal) => {
        const target = await resolveAwaitTarget(args, getRegistry())
        const clientKey = target.instances.map((instance) => instance.id).sort().join(",")
        const cursorByInstance = awaitTurnCursors.get(clientKey) ?? new Map<string, string>()
        awaitTurnCursors.set(clientKey, cursorByInstance)
        const timeoutMs = optionalNumber(args, "timeoutMs")
        const kinds = optionalStringArray(args, "kinds")
        const responses = await Promise.all(target.instances.map(async (instance) => {
          const response = await clientFor(instance).waitEvents(
            definedObject({
              cursor: cursorByInstance.get(instance.id),
              timeoutMs,
              sessionIds: target.localSessionIdsByInstance.get(instance.id),
              kinds,
            }) as {
              cursor?: string
              timeoutMs?: number
              sessionIds?: ReadonlyArray<string>
              kinds?: ReadonlyArray<string>
            },
            signal,
          )
          cursorByInstance.set(instance.id, response.cursor)
          return { instance, response }
        }))
        const events = responses.flatMap(({ instance, response }) =>
          response.events.map((event) => stampEvent(instance, event)),
        ).sort(compareStampedEvents)
        const gaps = responses.flatMap(({ instance, response }) =>
          response.gaps.map((gap) => ({ instance: publicInstance(instance), ...gap })),
        )
        return ok({
          resolvedInstances: target.instances.map(publicInstance),
          events,
          gaps,
          cursors: responses.map(({ instance, response }) => ({
            instance: publicInstance(instance),
            ...parseCursor(response.cursor),
          })),
          more: responses.some(({ response }) => response.more),
        })
      },
    ),
    tool(
      "read_file",
      "Read a file from one fleet instance via its existing /api/files/content endpoint.",
      objectSchema({
        instance: stringProp("Instance id or label. Defaults to the registry default, or the sole instance."),
        path: stringProp("Remote file path to read."),
      }, ["path"]),
      async (args, signal) => {
        const instance = await resolve(optionalString(args, "instance"))
        const response = await clientFor(instance).readFile(requiredString(args, "path"), signal)
        return ok({ resolvedInstance: publicInstance(instance), ...response })
      },
    ),
    tool(
      "list_dir",
      "List a directory on one fleet instance via its existing /api/files endpoint.",
      objectSchema({
        instance: stringProp("Instance id or label. Defaults to the registry default, or the sole instance."),
        path: stringProp("Remote directory path to list."),
      }, ["path"]),
      async (args, signal) => {
        const instance = await resolve(optionalString(args, "instance"))
        const response = await clientFor(instance).listDir(requiredString(args, "path"), signal)
        return ok({ resolvedInstance: publicInstance(instance), ...response })
      },
    ),
    tool(
      "search",
      "Search files on one fleet instance via its existing /api/search endpoint.",
      objectSchema({
        instance: stringProp("Instance id or label. Defaults to the registry default, or the sole instance."),
        query: stringProp("Search query."),
        path: stringProp("Optional path scope."),
      }, ["query"]),
      async (args, signal) => {
        const instance = await resolve(optionalString(args, "instance"))
        const response = await clientFor(instance).search(
          requiredString(args, "query"),
          optionalString(args, "path"),
          signal,
        )
        return ok({ resolvedInstance: publicInstance(instance), ...response })
      },
    ),
    tool(
      "git_show",
      "Read a file/revision through one fleet instance's existing /api/files/git-show endpoint.",
      objectSchema({
        instance: stringProp("Instance id or label. Defaults to the registry default, or the sole instance."),
        path: stringProp("Remote repository path or file path for git-show."),
        ref: stringProp("Optional git ref/revision."),
        rev: stringProp("Optional git revision alias."),
        commit: stringProp("Optional commit id."),
      }, ["path"]),
      async (args, signal) => {
        const instance = await resolve(optionalString(args, "instance"))
        const response = await clientFor(instance).gitShow({ ...args, instance: undefined }, signal)
        return ok({ resolvedInstance: publicInstance(instance), ...response })
      },
    ),
  ])
}

export const FLEET_TOOLS: ReadonlyArray<NonPersonaMcpTool> = createFleetTools()

function createProbeTimeout(): { signal: AbortSignal; cleanup: () => void } {
  const timeout = (AbortSignal as typeof AbortSignal & { timeout?: (ms: number) => AbortSignal }).timeout
  if (typeof timeout === "function") {
    return { signal: timeout(INSTANCE_PROBE_TIMEOUT_MS), cleanup: () => {} }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INSTANCE_PROBE_TIMEOUT_MS)
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) }
}

function fleetProbeErrorCode(err: unknown): FleetErrorCode {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === "string" && isFleetErrorCode(code)) return code
  }
  return "UNREACHABLE"
}

function isFleetErrorCode(code: string): code is FleetErrorCode {
  switch (code) {
    case "UNREACHABLE":
    case "AUTH_FAILED":
    case "SESSION_NOT_FOUND":
    case "PRECONDITION_FAILED":
    case "TIMEOUT":
    case "UPSTREAM_ERROR":
      return true
    default:
      return false
  }
}

async function resolveAwaitTarget(
  args: Record<string, unknown>,
  registry: FleetRegistryLike,
): Promise<{
  instances: Array<FleetResolvedInstance>
  localSessionIdsByInstance: Map<string, Array<string>>
}> {
  const instanceArgs = optionalStringArray(args, "instances")
  const sessionIdArgs = optionalStringArray(args, "sessionIds")
  const localSessionIdsByInstance = new Map<string, Array<string>>()
  for (const sessionId of sessionIdArgs ?? []) {
    const decoded = decodeSessionId(sessionId)
    const existing = localSessionIdsByInstance.get(decoded.instanceId) ?? []
    existing.push(decoded.localId)
    localSessionIdsByInstance.set(decoded.instanceId, existing)
  }

  let instances: Array<FleetResolvedInstance>
  if (instanceArgs !== undefined && instanceArgs.length > 0) {
    instances = uniqueInstances(await Promise.all(instanceArgs.map((arg) => registry.resolveInstance(arg))))
    const ids = new Set(instances.map((instance) => instance.id))
    for (const instanceId of localSessionIdsByInstance.keys()) {
      if (!ids.has(instanceId)) {
        throw new FleetToolInputError(
          "INSTANCE_MISMATCH",
          `sessionIds include instance ${JSON.stringify(instanceId)} which is not in arguments.instances`,
        )
      }
    }
  } else if (localSessionIdsByInstance.size > 0) {
    instances = uniqueInstances(
      await Promise.all([...localSessionIdsByInstance.keys()].map((instanceId) => registry.resolveInstance(instanceId))),
    )
  } else {
    const infos = await registry.listInstances()
    if (infos.length === 0) {
      throw new FleetRegistryError("INSTANCE_REQUIRED", "await_turn requires at least one registered fleet instance")
    }
    instances = uniqueInstances(await Promise.all(infos.map((info) => registry.resolveInstance(info.id))))
  }

  return { instances, localSessionIdsByInstance }
}

function globalizeSession(instanceId: string, session: FleetSessionSummary): FleetSessionSummary {
  return { ...session, sessionId: encodeSessionId(instanceId, session.sessionId) }
}

function stampEvent(instance: FleetResolvedInstance, event: FleetEvent): Record<string, unknown> {
  return {
    ...event,
    instance: publicInstance(instance),
    ...(typeof event.sessionId === "string" ? { sessionId: encodeSessionId(instance.id, event.sessionId) } : {}),
  }
}

function compareStampedEvents(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const atA = typeof a.at === "string" ? a.at : ""
  const atB = typeof b.at === "string" ? b.at : ""
  if (atA !== atB) return atA < atB ? -1 : 1
  const seqA = typeof a.seq === "number" ? a.seq : 0
  const seqB = typeof b.seq === "number" ? b.seq : 0
  return seqA - seqB
}

function parseCursor(cursor: string): { cursor: string; epoch?: string; seq?: number } {
  const idx = cursor.indexOf(":")
  if (idx < 0) return { cursor }
  const seq = Number(cursor.slice(idx + 1))
  return {
    cursor,
    epoch: cursor.slice(0, idx),
    ...(Number.isFinite(seq) ? { seq } : {}),
  }
}

function uniqueInstances(instances: Array<FleetResolvedInstance>): Array<FleetResolvedInstance> {
  const seen = new Set<string>()
  const result: Array<FleetResolvedInstance> = []
  for (const instance of instances) {
    if (seen.has(instance.id)) continue
    seen.add(instance.id)
    result.push(instance)
  }
  return result
}

function publicInstance(instance: FleetResolvedInstance): { id: string; label: string } {
  return { id: instance.id, label: instance.label }
}

function ok(value: unknown): McpToolResult {
  return jsonResult(value, false)
}

function jsonResult(value: unknown, isError: boolean): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  }
}

function errorResult(err: unknown): McpToolResult {
  const code = errorCode(err)
  const message = err instanceof Error ? err.message : String(err)
  return jsonResult({ error: { code, message } }, true)
}

function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === "string") return code
  }
  return "FLEET_ERROR"
}

function definedObject(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || value.trim() === "") {
    throw new FleetToolInputError("INVALID_ARGUMENT", `arguments.${key} is required and must be a non-empty string`)
  }
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    throw new FleetToolInputError("INVALID_ARGUMENT", `arguments.${key} must be a string`)
  }
  const trimmed = value.trim()
  return trimmed === "" ? undefined : value
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FleetToolInputError("INVALID_ARGUMENT", `arguments.${key} must be a finite number`)
  }
  return value
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== "boolean") {
    throw new FleetToolInputError("INVALID_ARGUMENT", `arguments.${key} must be a boolean`)
  }
  return value
}

function optionalStringArray(args: Record<string, unknown>, key: string): Array<string> | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new FleetToolInputError("INVALID_ARGUMENT", `arguments.${key} must be an array of non-empty strings`)
  }
  return value as Array<string>
}

function objectSchema(properties: Record<string, unknown>, required: Array<string>): Record<string, unknown> {
  return {
    type: "object",
    required,
    additionalProperties: false,
    properties,
  }
}

function stringProp(description: string): Record<string, unknown> {
  return { type: "string", description }
}

function numberProp(description: string): Record<string, unknown> {
  return { type: "number", description }
}

function booleanProp(description: string): Record<string, unknown> {
  return { type: "boolean", description }
}

function arrayProp(description: string): Record<string, unknown> {
  return { type: "array", items: { type: "string" }, description }
}
