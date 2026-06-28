import type { McpGroup, NonPersonaMcpTool } from "../peer-mcp-personas"
import {
  FleetClient,
  decodeSessionId,
  encodeSessionId,
  type CapabilitiesResponse,
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
import { createTunnelTokenProvider, type TunnelTokenProvider } from "./tunnel-auth"

const FLEET_GROUP: McpGroup = "fleet"
const INSTANCE_PROBE_TIMEOUT_MS = 2_000
const INSTANCE_PROBE_CACHE_TTL_MS = 5_000
const CAPABILITIES_CACHE_TTL_MS = 60_000
const AWAIT_TURN_DEFAULT_TIMEOUT_MS = 30_000
const AWAIT_TURN_TIMEOUT_SLACK_MS = 5_000
const LIST_INSTANCES_FANOUT_CONCURRENCY = 16
const AWAIT_TURN_FANOUT_CONCURRENCY = 256
const INSTANCE_PROBE_RATE_LIMIT_MAX_RETRIES = 1
const INSTANCE_PROBE_RATE_LIMIT_BACKOFF_BASE_MS = 250
const INSTANCE_PROBE_RATE_LIMIT_BACKOFF_MAX_MS = 1_000
const FLEET_FANOUT_CONCURRENCY_ENV = "GH_ROUTER_FLEET_FANOUT_CONCURRENCY"

type DelayFn = (ms: number) => Promise<void>

type FleetInstanceProbeResult =
  | { id: string; label: string; reachable: true; sessionCount: number; lastSeen: number }
  | { id: string; label: string; reachable: false; error: FleetErrorCode; hint?: string }

type AwaitTurnInstanceResult =
  | { ok: true; instance: FleetResolvedInstance; response: WaitEventsResponse }
  | { ok: false; instance: FleetResolvedInstance; error: FleetErrorCode; hint?: string }

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

interface FleetRegistryLike {
  resolveInstance(arg?: string): Promise<FleetResolvedInstance>
  listInstances(): Promise<Array<FleetInstanceInfo>>
}

interface FleetClientLike {
  capabilities(signal?: AbortSignal): Promise<CapabilitiesResponse>
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
  /** Override the Dev Tunnel connect-token provider (tests inject a fake). */
  tunnelTokenProvider?: TunnelTokenProvider
  /** Tests shorten this so per-instance await_turn deadlines stay instant. */
  awaitTurnDeadlineSlackMs?: number
  /** Tests inject this so RATE_LIMITED probe backoff stays instant. */
  probeRetryDelay?: DelayFn
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
let defaultTunnelProvider: TunnelTokenProvider | undefined
const awaitTurnCursors = new Map<string, Map<string, string>>()
const instanceProbeCache = new Map<string, { result: FleetInstanceProbeResult; at: number }>()

export function createFleetTools(options: CreateFleetToolsOptions = {}): ReadonlyArray<NonPersonaMcpTool> {
  const registry = options.registry
  const clients = new Map<string, FleetClientLike>()
  const capabilitiesCache = new Map<string, { caps: Set<string> | null; at: number }>()
  const tunnelProvider = options.tunnelTokenProvider ?? (defaultTunnelProvider ??= createTunnelTokenProvider())
  const probeRetryDelay = options.probeRetryDelay ?? delay
  const awaitTurnDeadlineSlackMs = nonNegativeNumberOrDefault(
    options.awaitTurnDeadlineSlackMs,
    AWAIT_TURN_TIMEOUT_SLACK_MS,
  )

  function getRegistry(): FleetRegistryLike {
    if (registry) return registry
    defaultRegistry ??= new FleetRegistry()
    return defaultRegistry
  }

  function clientFor(instance: FleetResolvedInstance): FleetClientLike {
    const key = `${instance.id}\0${instance.url}\0${instance.token}\0${instance.tunnelId ?? ""}\0${instance.tunnelToken ?? ""}\0${instance.insecureTLS === true ? "1" : "0"}`
    const existing = clients.get(key)
    if (existing) return existing
    const created = options.createClient
      ? options.createClient(instance)
      : new FleetClient({
          url: instance.url,
          token: instance.token,
          fetchFn: options.fetchFn,
          insecureTLS: instance.insecureTLS,
          ...tunnelClientOptions(instance, tunnelProvider),
        })
    clients.set(key, created)
    return created
  }

  async function getInstanceCapabilities(
    instance: FleetResolvedInstance,
    signal?: AbortSignal,
  ): Promise<Set<string> | null> {
    const now = Date.now()
    const cached = capabilitiesCache.get(instance.id)
    if (cached && now - cached.at < CAPABILITIES_CACHE_TTL_MS) return cached.caps

    try {
      const response = await clientFor(instance).capabilities(signal)
      const caps = new Set(response.capabilities)
      capabilitiesCache.set(instance.id, { caps, at: Date.now() })
      return caps
    } catch {
      // Capabilities are an optimization over the server-side BAD_REQUEST path.
      // Legacy/unknown/broken probes must not block a create the server might accept.
      capabilitiesCache.set(instance.id, { caps: null, at: Date.now() })
      return null
    }
  }

  async function assertCapability(
    instance: FleetResolvedInstance,
    cap: string,
    featureName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const caps = await getInstanceCapabilities(instance, signal)
    if (caps !== null && !caps.has(cap)) {
      throw new FleetToolInputError(
        "UNSUPPORTED_CAPABILITY",
        `fleet instance ${instance.id} does not advertise the '${cap}' capability required for ${featureName}; omit it or upgrade the ai-or-die control plane`,
      )
    }
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

    for (let attempt = 0; attempt <= INSTANCE_PROBE_RATE_LIMIT_MAX_RETRIES; attempt++) {
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
        const code = fleetProbeErrorCode(err)
        if (code === "RATE_LIMITED" && attempt < INSTANCE_PROBE_RATE_LIMIT_MAX_RETRIES) {
          timeout.cleanup()
          await probeRetryDelay(probeRateLimitBackoffMs(attempt))
          continue
        }
        const result = failedProbeResult(info, code)
        instanceProbeCache.set(cacheKey, { result, at: Date.now() })
        return result
      } finally {
        timeout.cleanup()
      }
    }

    const result = failedProbeResult(info, "UNREACHABLE")
    instanceProbeCache.set(cacheKey, { result, at: Date.now() })
    return result
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
        const probed = await mapWithConcurrency(
          instances,
          fleetFanoutConcurrency(LIST_INSTANCES_FANOUT_CONCURRENCY),
          (instance) => probeInstance(instance),
        )
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
      "Send a message to a fleet session. isError reflects DELIVERY ONLY: it is true only when the message could not be delivered to the session (transport/precondition failure). A delivered message whose confirmation did not arrive within awaitMs is NOT an error — it returns delivered:true with confirmationPending/confirmationTimedOut, because a long turn legitimately outruns awaitMs. Recommended pattern: send with awaitMs:0 for a fast delivery ack that never blocks on confirmation, then call await_turn (filtered to this sessionId) to observe the session's actual turn completion. The idempotencyKey makes a retried send safe (a retry never re-types the message).",
      objectSchema({
        sessionId: stringProp("Global session id in the form instanceId:localSessionId."),
        instance: stringProp("Optional instance id/label; when supplied it must agree with sessionId."),
        message: stringProp("Message text to deliver to the session."),
        idempotencyKey: stringProp("Caller-generated idempotency key. Reuse the same key on retry; the upstream dedupes so a retry never re-types."),
        awaitMs: numberProp("Optional best-effort confirmation wait (ms) — NOT a deadline. Prefer awaitMs:0 plus await_turn; a turn that outruns awaitMs returns confirmationPending, not an error."),
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
        // F9: isError keys on delivery alone. Delivery fails only when the upstream
        // says so (delivered:false) or the structured delivery sub-status is a hard
        // failure. Confirmation/turn states are surfaced as NON-error fields.
        const deliveryFailed =
          response.delivered === false
          || response.delivery?.status === "failed"
          || response.delivery?.status === "error"
        const delivered = !deliveryFailed
        const confirmed = delivered && response.confirmed === true
        const awaited = awaitMs !== undefined && awaitMs > 0
        // confirmationTimedOut: delivered + unconfirmed after an await window (ours or
        // the upstream's). It is a successful delivery with completion still pending —
        // the caller resolves it via await_turn, never by re-sending.
        const confirmationTimedOut =
          delivered && !confirmed && (awaited || response.confirmationTimedOut === true)
        const isError = !delivered
        return jsonResult({
          resolvedInstance: publicInstance(instance),
          sessionId: globalId,
          ...response,
          delivered,
          confirmed,
          ...(confirmationTimedOut ? { confirmationPending: true, confirmationTimedOut: true } : {}),
          ...(isError
            ? { message: "message was not delivered to the session by the upstream instance" }
            : confirmationTimedOut
              ? {
                  message:
                    "delivered; turn completion not confirmed in the await window. Use await_turn filtered to this sessionId to observe completion (the idempotencyKey makes a retried send safe).",
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
        readyTimeoutMs: numberProp("F17: bounded ms to wait for the agent to become driveable before returning. The response carries ready/bound/blocker."),
        permissionMode: stringProp("F10 (claude only): permission mode the launched agent starts in — one of plan | acceptEdits | default | bypassPermissions. Rejected with BAD_REQUEST if unknown or if agentArgs also sets it."),
        agentArgs: arrayProp("F10 (claude only): extra launcher args appended after the github-router prefix. Must NOT include --permission-mode or --dangerously-skip-permissions (use permissionMode) — rejected with BAD_REQUEST."),
      }, ["instance", "agent", "idempotencyKey"]),
      async (args, signal) => {
        const instance = await resolve(requiredString(args, "instance"))
        const agent = requiredString(args, "agent")
        const idempotencyKey = requiredString(args, "idempotencyKey")
        const permissionMode = optionalString(args, "permissionMode")
        const agentArgs = optionalStringArray(args, "agentArgs")
        if (permissionMode !== undefined) {
          await assertCapability(instance, "permission_mode", "permissionMode", signal)
        }
        if (agentArgs !== undefined) {
          await assertCapability(instance, "agent_args", "agentArgs", signal)
        }
        // End-to-end idempotency also requires the ai-or-die control plane to dedupe by this key.
        const response = await clientFor(instance).createSession(
          definedObject({
            agent,
            name: optionalString(args, "name"),
            workingDir: optionalString(args, "workingDir"),
            start: optionalBoolean(args, "start"),
            readyTimeoutMs: optionalNumber(args, "readyTimeoutMs"),
            permissionMode,
            agentArgs,
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
      "Long-poll session events across fleet instances. The server owns per-target opaque cursors, so callers do not pass cursor tokens. Distinct concurrent watchers over the same instance set should pass a distinct watcherId so they do not share a cursor.",
      objectSchema({
        instances: arrayProp("Instance ids or labels to poll. Omit with sessionIds to target those session instances; omit both to poll every registered instance."),
        sessionIds: arrayProp("Global session ids to filter to."),
        timeoutMs: numberProp("Long-poll timeout per instance in milliseconds."),
        kinds: arrayProp("Optional event kinds to filter to."),
        watcherId: stringProp("Optional stable id for this watcher. Use a distinct value for concurrent watchers over the same target set to keep cursors isolated."),
      }, []),
      async (args, signal) => {
        const target = await resolveAwaitTarget(args, getRegistry())
        const watcherId = optionalString(args, "watcherId")
        const clientKey = awaitTurnCursorKey(watcherId)
        const cursorByInstance = takeAwaitTurnCursorMap(clientKey)
        const timeoutMs = optionalNumber(args, "timeoutMs")
        const kinds = optionalStringArray(args, "kinds")
        // F23: this is intentionally one waitEvents call per instance. The
        // sessionIds filter multiplexes all requested sessions on that instance;
        // do not fan out per session or 100-instance watches become N*M polls.
        const results = await mapWithConcurrency(
          target.instances,
          fleetFanoutConcurrency(AWAIT_TURN_FANOUT_CONCURRENCY),
          async (instance): Promise<AwaitTurnInstanceResult> => {
            const deadline = createAwaitTurnDeadline(timeoutMs, awaitTurnDeadlineSlackMs)
            const combined = combineAbortSignals([signal, deadline.signal])
            try {
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
                combined.signal,
              )
              cursorByInstance.set(instance.id, response.cursor)
              return { ok: true, instance, response }
            } catch (err) {
              const error = fleetProbeErrorCode(err)
              const hint = fleetProbeHint(error)
              return { ok: false, instance, error, ...(hint ? { hint } : {}) }
            } finally {
              combined.cleanup()
              deadline.cleanup()
            }
          },
        )
        const responses = results.filter(isAwaitTurnSuccess)
        const errors = results.filter(isAwaitTurnFailure).map(({ instance, error, hint }) => ({
          instance: publicInstance(instance),
          error,
          ...(hint ? { hint } : {}),
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
            cursor: response.cursor,
          })),
          more: responses.some(({ response }) => response.more),
          ...(errors.length > 0 ? { errors } : {}),
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

function createAwaitTurnDeadline(timeoutMs: number | undefined, slackMs: number): { signal: AbortSignal; cleanup: () => void } {
  const waitMs = Math.max(0, timeoutMs ?? AWAIT_TURN_DEFAULT_TIMEOUT_MS)
  const deadlineMs = waitMs + slackMs
  const controller = new AbortController()
  const timer = setTimeout(() => {
    const err = new Error("await_turn per-instance deadline exceeded")
    err.name = "TimeoutError"
    controller.abort(err)
  }, deadlineMs)
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) }
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): { signal: AbortSignal | undefined; cleanup: () => void } {
  const noop = () => {}
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (present.length === 0) return { signal: undefined, cleanup: noop }
  if (present.length === 1) return { signal: present[0], cleanup: noop }
  const any = (AbortSignal as typeof AbortSignal & { any?: (signals: Array<AbortSignal>) => AbortSignal }).any
  if (typeof any === "function") return { signal: any(present), cleanup: noop }

  // Fallback for runtimes without AbortSignal.any: forward the first abort. The
  // listeners are removed by cleanup() so they can't accumulate on a long-lived
  // parent signal across many fan-out turns (the incoming request signal is
  // shared by every instance in a turn).
  const controller = new AbortController()
  const listeners: Array<{ signal: AbortSignal; handler: () => void }> = []
  const cleanup = () => {
    for (const { signal, handler } of listeners) signal.removeEventListener("abort", handler)
    listeners.length = 0
  }
  for (const signal of present) {
    if (signal.aborted) {
      if (!controller.signal.aborted) controller.abort(signal.reason)
      cleanup()
      return { signal: controller.signal, cleanup: noop }
    }
    const handler = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason)
    }
    signal.addEventListener("abort", handler, { once: true })
    listeners.push({ signal, handler })
  }
  return { signal: controller.signal, cleanup }
}

function fleetProbeErrorCode(err: unknown): FleetErrorCode {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === "string" && isFleetErrorCode(code)) return code
  }
  if (isAbortLike(err)) return "TIMEOUT"
  return "UNREACHABLE"
}

// F4: a short, actionable hint the model can read off a failed probe so the
// connectivity class (relay-up-no-host vs slow vs unreachable) is legible.
function fleetProbeHint(code: FleetErrorCode): string | undefined {
  switch (code) {
    case "NO_HOST":
      return "tunnel relay up, no ai-or-die host connected (start the host on that machine)"
    case "RELAY_ERROR":
      return "tunnel relay returned an error; the host may be down, restarting, or under load"
    case "TIMEOUT":
      return "no response before the probe deadline; the host may be slow or the tunnel may have no host"
    case "UNREACHABLE":
      return "could not connect (DNS or connection failure); check the instance url"
    default:
      return undefined
  }
}

function isFleetErrorCode(code: string): code is FleetErrorCode {
  switch (code) {
    case "UNREACHABLE":
    case "AUTH_FAILED":
    case "SESSION_NOT_FOUND":
    case "PRECONDITION_FAILED":
    case "TIMEOUT":
    case "UPSTREAM_ERROR":
    case "NO_HOST":
    case "RELAY_ERROR":
    case "BAD_REQUEST":
    case "RATE_LIMITED":
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

// Event `at` is epoch-ms NUMBER on the wire (ai-or-die `Date.now()`). Coerce
// defensively (a future producer could emit an ISO string) so cross-instance
// await_turn merge sorts by real time, not by per-instance seq (which is
// meaningless across instances).
function eventAtMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

function compareStampedEvents(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const atA = eventAtMs(a.at)
  const atB = eventAtMs(b.at)
  if (atA !== atB) return atA - atB
  const seqA = typeof a.seq === "number" ? a.seq : 0
  const seqB = typeof b.seq === "number" ? b.seq : 0
  return seqA - seqB
}

const MAX_WATCHER_ID_LEN = 200
const MAX_AWAIT_TURN_CURSOR_KEYS = 1024

// Per-watcher cursor isolation keys on watcherId ALONE — NOT the instance set.
// The inner cursorByInstance Map already isolates by instance.id, so adding or
// removing an instance from a watch must not drop the others' cursors. watcherId
// is client-controlled, so it is length-capped here and the key count is
// LRU-bounded in takeAwaitTurnCursorMap so a flood of unique ids can't grow the
// module-level Map without bound.
function awaitTurnCursorKey(watcherId: string | undefined): string {
  const id = watcherId ?? "default"
  return id.length > MAX_WATCHER_ID_LEN ? id.slice(0, MAX_WATCHER_ID_LEN) : id
}

// LRU access to the per-watcher cursor map: re-insert on hit so the most recently
// used keys stay, and a hard cap evicts the least recently used.
function takeAwaitTurnCursorMap(clientKey: string): Map<string, string> {
  const existing = awaitTurnCursors.get(clientKey)
  if (existing) {
    awaitTurnCursors.delete(clientKey)
    awaitTurnCursors.set(clientKey, existing)
    return existing
  }
  const created = new Map<string, string>()
  awaitTurnCursors.set(clientKey, created)
  while (awaitTurnCursors.size > MAX_AWAIT_TURN_CURSOR_KEYS) {
    const oldest = awaitTurnCursors.keys().next().value
    if (oldest === undefined) break
    awaitTurnCursors.delete(oldest)
  }
  return created
}

function isAwaitTurnSuccess(
  result: AwaitTurnInstanceResult,
): result is Extract<AwaitTurnInstanceResult, { ok: true }> {
  return result.ok
}

function isAwaitTurnFailure(
  result: AwaitTurnInstanceResult,
): result is Extract<AwaitTurnInstanceResult, { ok: false }> {
  return !result.ok
}

function failedProbeResult(info: FleetInstanceInfo, code: FleetErrorCode): FleetInstanceProbeResult {
  const hint = fleetProbeHint(code)
  return {
    id: info.id,
    label: info.label,
    reachable: false,
    error: code,
    ...(hint ? { hint } : {}),
  }
}

async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<R>> {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1
  const concurrency = Math.max(1, Math.min(items.length || 1, safeLimit))
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await fn(items[index]!, index)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return results
}

function fleetFanoutConcurrency(defaultLimit: number): number {
  const raw = process.env[FLEET_FANOUT_CONCURRENCY_ENV]
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  return defaultLimit
}

function probeRateLimitBackoffMs(attempt: number): number {
  return Math.min(
    INSTANCE_PROBE_RATE_LIMIT_BACKOFF_BASE_MS * (2 ** attempt),
    INSTANCE_PROBE_RATE_LIMIT_BACKOFF_MAX_MS,
  )
}

function nonNegativeNumberOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function isAbortLike(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === "AbortError" || err.name === "TimeoutError"
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

/**
 * Build the FleetClient tunnel-auth options for a resolved instance.
 * Resolution order: a `tunnelId` enables auto-mint + auto-refresh (and the
 * evict-on-failure hook); else a static `tunnelToken` is sent directly (no
 * retry, since it cannot be re-minted); else no tunnel auth.
 */
function tunnelClientOptions(
  instance: FleetResolvedInstance,
  provider: TunnelTokenProvider,
): { getTunnelToken?: () => Promise<string | undefined>; onTunnelAuthInvalidate?: () => void } {
  if (instance.tunnelId) {
    const cfg = { tunnelId: instance.tunnelId }
    return {
      getTunnelToken: () => provider.getToken(cfg),
      onTunnelAuthInvalidate: () => provider.invalidate(cfg),
    }
  }
  if (instance.tunnelToken) {
    const token = instance.tunnelToken
    return { getTunnelToken: async () => token }
  }
  return {}
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
