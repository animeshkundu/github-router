import type { McpGroup, NonPersonaMcpTool } from "../peer-mcp-personas"
import { randomUUID } from "node:crypto"
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
  FleetRegistryError,
  type FleetInstanceInfo,
  type FleetResolvedInstance,
} from "./registry"
import { MergedFleetRegistry } from "./discovery"
import { createTunnelTokenProvider, type TunnelTokenProvider } from "./tunnel-auth"
import {
  classifyTurnEvents,
  driveTask,
  isHardNotReady,
  isNamedKeyOp,
  mapNamedKeyOp,
  waitForMessageReady,
  type DriverClient,
} from "./driver"

const FLEET_GROUP: McpGroup = "fleet"
const INSTANCE_PROBE_TIMEOUT_MS = 2_000
const INSTANCE_PROBE_CACHE_TTL_MS = 5_000
const CAPABILITIES_CACHE_TTL_MS = 60_000
const AWAIT_TURN_DEFAULT_TIMEOUT_MS = 30_000
const AWAIT_TURN_TIMEOUT_SLACK_MS = 5_000
const DRIVE_TASK_DEFAULT_TIMEOUT_MS = 120_000
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

let defaultRegistry: MergedFleetRegistry | undefined
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
    defaultRegistry ??= new MergedFleetRegistry()
    return defaultRegistry
  }

  function clientFor(instance: FleetResolvedInstance): FleetClientLike {
    // Mesh clients are NOT cached: the egress proxy's Proxy-Authorization is a
    // credential that can ROTATE (sidecar restart) and must never enter the cache
    // key, and a cached client would pin a stale authHeader captured at construction.
    // Rebuilding a FleetClient is cheap (URL parse only), so build one per call with
    // the CURRENT meshProxy. (A mesh instance carries no tunnel provider.)
    if (instance.auth.type === "mesh") {
      return options.createClient
        ? options.createClient(instance)
        : new FleetClient({
            url: instance.url,
            auth: instance.auth,
            fetchFn: options.fetchFn,
            meshProxy: instance.meshProxy,
          })
    }
    const key = `${instance.id}\0${instance.url}\0${instance.auth.type}\0${instance.token}\0${instance.tunnelId ?? ""}\0${instance.tunnelToken ?? ""}\0${instance.insecureTLS === true ? "1" : "0"}`
    const existing = clients.get(key)
    if (existing) return existing
    const created = options.createClient
      ? options.createClient(instance)
      : new FleetClient({
          url: instance.url,
          auth: instance.auth,
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
      "Lists registered remote ai-or-die fleet instances and probes whether each instance is currently reachable. It takes no input; the registry decides which instances exist, and credentials or tunnel tokens are not returned. It returns instances with id, label, reachable status, sessionCount and lastSeen for reachable hosts, or error and hint for unreachable hosts. It is useful as the discovery entry point before list_sessions, create_session, or other fleet tools that need an instance id. It is not for local repository search or for reading sessions; use local tools for this machine and list_sessions after choosing an instance.",
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
      "Lists sessions on one remote ai-or-die fleet instance and returns session ids that can be used by the other fleet session tools. The optional instance input is an id or label; when it is omitted, the registry default or sole instance is used. It returns resolvedInstance and sessions, with each sessionId globalized as instanceId:localSessionId. It is useful after list_instances to choose a remote session to inspect, message, drive, or stop. It is not a fleet-wide listing and does not read transcript output; call it per instance, and use read_session for a session's text tail.",
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
      "Reads recent text output from an addressed remote ai-or-die fleet session. The required sessionId must be a global id in instanceId:localSessionId form; the optional instance input is only a cross-check and must resolve to the same instance. It returns resolvedInstance, sessionId, text, truncated, source, and the session status snapshot. It is useful for inspecting the transcript tail after send_message, await_turn, or drive_task. It is not for lifecycle-only checks or live waiting; use session_status for point-in-time state and await_turn to wait for new events.",
      objectSchema({
        sessionId: stringProp("Global session id in the form instanceId:localSessionId."),
        instance: stringProp("Optional instance id/label; when supplied it must agree with sessionId."),
        lines: numberProp("Number of recent lines to read."),
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
      "Fetches the lifecycle and interaction status for an addressed remote ai-or-die fleet session. The required sessionId must be a global id in instanceId:localSessionId form; the optional instance input is only a cross-check and must resolve to the same instance. It returns resolvedInstance, sessionId, and a status object that can include lifecycle, interactionState, canAcceptInput, blockReason, and awaiting details. It is useful before deciding whether a session can accept a message or is awaiting a prompt. It is not a transcript reader or event watcher; use read_session for output text and await_turn for turn-completion events.",
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
      "Sends a free-text message to an existing remote ai-or-die fleet session. The required sessionId must be global, message is the text to deliver, requireIdle defaults to true, waitForIdleMs can wait briefly for readiness, awaitMs waits only for best-effort delivery confirmation, and idempotencyKey is usually auto-generated unless retrying the same send. It returns resolvedInstance, sessionId, delivered, confirmed, submitted when the remote proves the composer accepted the message, and confirmationPending/confirmationTimedOut when delivery succeeded but the turn outran the await window; delivered:false or notReady is reported as an error result. It is useful for sending the next free-text instruction to an idle session, especially with awaitMs:0 followed by await_turn for the actual turn boundary. It is not for answering an awaited choice prompt or sending control keys; use respond for prompts and send_keys for submit, interrupt, or literal key sequences.",
      objectSchema({
        sessionId: stringProp("Global session id in the form instanceId:localSessionId."),
        instance: stringProp("Optional instance id/label; when supplied it must agree with sessionId."),
        message: stringProp("Message text to deliver to the session."),
        idempotencyKey: stringProp("Optional caller idempotency key; AUTO-GENERATED when omitted, so you normally never pass it. Supply your OWN stable key only when you will retry the SAME send and need the upstream to dedupe it."),
        awaitMs: numberProp("Optional best-effort confirmation wait (ms) — NOT a deadline. Prefer awaitMs:0 plus await_turn; a turn that outruns awaitMs returns confirmationPending, not an error."),
        requireIdle: booleanProp("Default true: check status and refuse a busy/awaiting-prompt/dead session with a structured notReady result. Set false to force an unconditional send (unsafe: may type into a busy composer)."),
        waitForIdleMs: numberProp("When requireIdle, wait up to this many ms for the session to become idle before deciding (default 0 = decide immediately)."),
      }, ["sessionId", "message"]),
      async (args, signal) => {
        const { instance, localId, globalId } = await resolveSession(args)
        const awaitMs = optionalNumber(args, "awaitMs")
        const requireIdle = optionalBoolean(args, "requireIdle") ?? true
        const client = clientFor(instance)

        // C1: never blind-type into a busy composer. Refuse ONLY on positive evidence
        // (busy / a non-message pending prompt / a dead session); a status probe that
        // fails, or an ambiguous "unknown" state, fails OPEN so a transient status
        // hiccup can't wedge a legitimate send (the send carries its own submission
        // signal). Opt out entirely with requireIdle:false.
        if (requireIdle) {
          const readyResult = await waitForMessageReady(client, localId, {
            waitMs: optionalNumber(args, "waitForIdleMs") ?? 0,
            signal,
          })
          if (!readyResult.ready && isHardNotReady(readyResult.readiness.reason)) {
            const advise =
              readyResult.readiness.reason === "awaiting_other"
                ? " The session is awaiting a prompt — use `respond`, not a free-text message."
                : readyResult.readiness.reason === "terminal"
                  ? " The session has exited."
                  : " Wait for it to go idle (await_turn) or set requireIdle:false to force."
            return jsonResult({
              resolvedInstance: publicInstance(instance),
              sessionId: globalId,
              delivered: false,
              submitted: false,
              notReady: true,
              reason: readyResult.readiness.reason,
              interactionState: readyResult.readiness.interactionState,
              awaitingKind: readyResult.readiness.awaitingKind,
              message: `not sent: session is not ready for a message (${readyResult.readiness.reason}).${advise}`,
            }, true)
          }
        }

        const response = await client.sendMessage(
          localId,
          {
            message: requiredString(args, "message"),
            idempotencyKey: optionalString(args, "idempotencyKey") ?? randomUUID(),
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
        // C1: a reliable submitted-vs-unconfirmed signal from ai-or-die's submission
        // sub-status ("submitted" proves the bytes reached the composer).
        const submitted = delivered && response.submission?.status === "submitted"
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
          submitted,
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
      "Sends key input to an existing remote ai-or-die fleet session. The required sessionId must be global; provide exactly one of op or keys, where op is a named operation (`submit` for Enter or `interrupt` for Ctrl-C) and keys is a literal key sequence; raw only applies to literal keys. It returns resolvedInstance, sessionId, delivered, duplicated when an idempotency retry was deduped, and the mapped key name when op was used. It is useful for control-key actions such as submitting a typed prompt or interrupting a busy turn without stopping the session. It is not the normal free-text path and not the prompt-answer path; use send_message for free text and respond for awaited prompts.",
      objectSchema({
        sessionId: stringProp("Global session id in the form instanceId:localSessionId."),
        instance: stringProp("Optional instance id/label; when supplied it must agree with sessionId."),
        op: stringProp("Higher-level named op: 'submit' (Enter) or 'interrupt' (Ctrl-C). Mapped to the ai-or-die named key with raw off. Do NOT also pass keys."),
        keys: stringProp("Literal key sequence to send. Provide instead of op."),
        idempotencyKey: stringProp("Optional caller idempotency key; auto-generated when omitted."),
        raw: booleanProp("Pass keys through as raw literal bytes when the instance supports it. Ignored when op is set."),
      }, ["sessionId"]),
      async (args, signal) => {
        const { instance, localId, globalId } = await resolveSession(args)
        const op = optionalString(args, "op")
        const literalKeys = optionalString(args, "keys")
        if (op !== undefined && literalKeys !== undefined) {
          throw new FleetToolInputError("INVALID_ARGUMENT", "provide either arguments.op or arguments.keys, not both")
        }
        if (op === undefined && literalKeys === undefined) {
          throw new FleetToolInputError("INVALID_ARGUMENT", "one of arguments.op or arguments.keys is required")
        }
        let keys: string
        let raw: boolean | undefined
        if (op !== undefined) {
          if (!isNamedKeyOp(op)) {
            throw new FleetToolInputError("INVALID_ARGUMENT", `arguments.op must be 'submit' or 'interrupt' (got ${JSON.stringify(op)})`)
          }
          // A NAMED key rides with raw:false so ai-or-die resolves it (never a literal byte).
          keys = mapNamedKeyOp(op)
          raw = false
        } else {
          keys = literalKeys!
          raw = optionalBoolean(args, "raw")
        }
        const response = await clientFor(instance).sendKeys(
          localId,
          {
            keys,
            idempotencyKey: optionalString(args, "idempotencyKey") ?? randomUUID(),
            ...(raw === undefined ? {} : { raw }),
          },
          signal,
        )
        return ok({
          resolvedInstance: publicInstance(instance),
          sessionId: globalId,
          ...(op === undefined ? {} : { op, mappedKeys: keys }),
          delivered: response.delivered,
          ...(response.duplicated === undefined ? {} : { duplicated: response.duplicated }),
        })
      },
    ),
    tool(
      "respond",
      "Answers an awaited prompt in an existing remote ai-or-die fleet session by selecting a choice, selecting an exact option value, or sending explicit keys. The required sessionId must be global; choose the answer mode that matches the prompt, and idempotencyKey is usually auto-generated unless retrying the same response. It returns resolvedInstance, sessionId, delivered, duplicated when an idempotency retry was deduped, and any awaitingKind or mappedKeys supplied by the remote; delivered:false is reported as an error result. It is useful only when session_status or await_turn shows the session is waiting for a prompt or choice. It is not for ordinary free-text instructions or control keys; use send_message for free text and send_keys for submit or interrupt.",
      objectSchema({
        sessionId: stringProp("Global session id in the form instanceId:localSessionId."),
        instance: stringProp("Optional instance id/label; when supplied it must agree with sessionId."),
        choice: stringProp("Named or numbered choice to select."),
        optionValue: stringProp("Exact option value to select."),
        keys: stringProp("Explicit key override to send instead of a mapped choice."),
        idempotencyKey: stringProp("Optional caller idempotency key; auto-generated when omitted."),
      }, ["sessionId"]),
      async (args, signal) => {
        const { instance, localId, globalId } = await resolveSession(args)
        const input = definedObject({
          choice: optionalString(args, "choice"),
          optionValue: optionalString(args, "optionValue"),
          keys: optionalString(args, "keys"),
          idempotencyKey: optionalString(args, "idempotencyKey") ?? randomUUID(),
        }) as { choice?: string; optionValue?: string; keys?: string; idempotencyKey: string }
        const response = await clientFor(instance).respond(localId, input, signal)
        const delivered = response.delivered !== false
        return jsonResult({
          resolvedInstance: publicInstance(instance),
          sessionId: globalId,
          ...response,
          delivered,
          ...(delivered ? {} : { message: "response was not delivered to the session by the upstream instance" }),
        }, !delivered)
      },
    ),
    tool(
      "create_session",
      "Creates a new session on a specific remote ai-or-die fleet instance. The instance input is required and never defaults; agent is required and must be one of claude, codex, copilot, gemini, or terminal; start:true is required for the session to actually run and be driveable. It returns resolvedInstance plus the remote create response, with sessionId converted to the global instanceId:localSessionId form when creation succeeds. It is useful when the user wants a new remote session to run on a named fleet host before using drive_task, send_message, or await_turn. It is not for selecting or inspecting an existing session; use list_instances and list_sessions first when the target is unknown.",
      objectSchema({
        instance: stringProp("Required instance id or label. Create never uses the registry default."),
        agent: { ...stringProp("Required agent/runtime to create on the instance. Valid values: claude, codex, copilot, gemini, terminal."), enum: ["claude", "codex", "copilot", "gemini", "terminal"] },
        name: stringProp("Optional display name for the session."),
        workingDir: stringProp("Optional working directory on the remote instance."),
        idempotencyKey: stringProp("Optional caller idempotency key; auto-generated when omitted."),
        start: booleanProp("Set true to start the remote session immediately; without start:true the created session is not running or driveable."),
        readyTimeoutMs: numberProp("Bounded milliseconds to wait for the agent to become driveable before returning. The response carries ready, bound, and blocker."),
        permissionMode: stringProp("Claude-only permission mode for the launched agent: plan, acceptEdits, default, or bypassPermissions. Rejected with BAD_REQUEST if unknown or if agentArgs also sets it."),
        agentArgs: arrayProp("Claude-only extra launcher args appended after the github-router prefix. Do not include --permission-mode or --dangerously-skip-permissions; use permissionMode instead."),
        disableStopGate: booleanProp("Claude-only option to disable the structural Stop-gate on the launched session by injecting --no-stop-gate into agentArgs, so a driven session's turn-end does not hang on a blocking Stop hook. Requires a remote github-router that understands the flag."),
      }, ["instance", "agent"]),
      async (args, signal) => {
        const instance = await resolve(requiredString(args, "instance"))
        const agent = requiredString(args, "agent")
        const idempotencyKey = optionalString(args, "idempotencyKey") ?? randomUUID()
        const permissionMode = optionalString(args, "permissionMode")
        const disableStopGate = optionalBoolean(args, "disableStopGate") === true
        const requestedAgentArgs = optionalStringArray(args, "agentArgs")
        // C3: injecting --no-stop-gate rides the same launcher-args channel, so it
        // needs the agent_args capability just like an explicit agentArgs.
        const agentArgs = disableStopGate
          ? [...(requestedAgentArgs ?? []), "--no-stop-gate"]
          : requestedAgentArgs
        if (permissionMode !== undefined) {
          await assertCapability(instance, "permission_mode", "permissionMode", signal)
        }
        if (agentArgs !== undefined) {
          await assertCapability(instance, "agent_args", disableStopGate ? "disableStopGate" : "agentArgs", signal)
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
      "Terminates an existing remote ai-or-die fleet session. The required sessionId must be global; instance is only a cross-check, mode is an optional remote-understood stop mode, and idempotencyKey is usually auto-generated unless retrying the same stop. It returns resolvedInstance, sessionId, stopped, and lifecycle. It is useful when the remote session should be ended and its in-flight turn should be killed. It is destructive and irreversible, with no resume companion; to merely unstick or interrupt a busy session without terminating it, use send_keys with op `interrupt`.",
      objectSchema({
        sessionId: stringProp("Global session id in the form instanceId:localSessionId."),
        instance: stringProp("Optional instance id/label; when supplied it must agree with sessionId."),
        idempotencyKey: stringProp("Optional caller idempotency key; auto-generated when omitted."),
        mode: stringProp("Optional stop mode understood by the remote instance."),
      }, ["sessionId"]),
      async (args, signal) => {
        const { instance, localId, globalId } = await resolveSession(args)
        const idempotencyKey = optionalString(args, "idempotencyKey") ?? randomUUID()
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
      "Long-polls session events across remote ai-or-die fleet instances. The caller selects targets with instances, sessionIds, or neither for every registered instance; timeoutMs bounds each per-instance long poll, kinds filters event kinds, and watcherId isolates cursor state for concurrent watchers. It returns resolvedInstances, time-sorted stamped events, gaps, cursors, more, optional per-session settled classifications, and optional per-instance errors. It is useful after send_message with awaitMs:0 to observe the real turn boundary; a settled status such as turn_ended or waiting_input is the reliable completion signal, while idle flickers are not completion. It is not a transcript reader or a one-shot task driver; use read_session for text output and drive_task when sending one prompt and waiting for its report should be a single composite operation.",
      objectSchema({
        instances: arrayProp("Instance ids or labels to poll. Omit with sessionIds to target those session instances; omit both to poll every registered instance."),
        sessionIds: arrayProp("Global session ids to filter to."),
        timeoutMs: numberProp(`Long-poll timeout per instance in milliseconds (default ${AWAIT_TURN_DEFAULT_TIMEOUT_MS}).`),
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
        // C2: an additive per-session settle classification so a caller keys on the
        // RELIABLE signal — `turn_ended` = completed, `waiting_input` = awaiting input;
        // a bare `became_idle` is surfaced as idle_flicker/reliable:false and is NEVER
        // reported as completion. Purely additive to the raw `events` above.
        const settled = classifyTurnEvents(events)
        return ok({
          resolvedInstances: target.instances.map(publicInstance),
          events,
          gaps,
          ...(settled.length > 0 ? { settled } : {}),
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
      "drive_task",
      "Drives one prompt on an existing remote ai-or-die fleet session to completion and returns a parsed operator report. The required sessionId must be global, prompt is the single instruction to send, timeoutMs controls when a hung turn is interrupted for recovery, and expectReport defaults to true so a nonce-guarded OPERATOR REPORT trailer is appended and parsed. It returns resolvedInstance, sessionId, state, summary, ask, artifact, raw, settled, submitted, reportFound, and recovery fields such as interrupted or recovered; state must be read together with settled and interrupted because a timeout recovery can leave work needing verification. It is useful as the composite path that performs the safe send_message plus await_turn plus read_session sequence for one already-created session. It is not a session creator, a multi-turn conversation loop, or a simple transcript read; use create_session first when needed, send_message and await_turn when controlling each step manually, and read_session when only the transcript tail is needed.",
      objectSchema({
        sessionId: stringProp("Global session id in the form instanceId:localSessionId."),
        instance: stringProp("Optional instance id/label; when supplied it must agree with sessionId."),
        prompt: stringProp("The task/prompt to drive on the session."),
        timeoutMs: numberProp(`Ms to wait for the turn to end before auto-recovering via interrupt (default ${DRIVE_TASK_DEFAULT_TIMEOUT_MS}). Set generously — exceeding it triggers a Ctrl-C recovery.`),
        expectReport: booleanProp("Default true: append the OPERATOR REPORT trailer instruction so the driven session ends its turn with a parseable {state,summary,ask,artifact}. Set false to send the prompt verbatim."),
      }, ["sessionId", "prompt"]),
      async (args, signal) => {
        const { instance, localId, globalId } = await resolveSession(args)
        const result = await driveTask({
          client: clientFor(instance) as DriverClient,
          localId,
          prompt: requiredString(args, "prompt"),
          timeoutMs: optionalNumber(args, "timeoutMs") ?? DRIVE_TASK_DEFAULT_TIMEOUT_MS,
          expectReport: optionalBoolean(args, "expectReport") ?? true,
          idempotencyKey: randomUUID(),
          interruptKey: randomUUID(),
          reportId: randomUUID(),
          signal,
        })
        return jsonResult(
          { resolvedInstance: publicInstance(instance), sessionId: globalId, ...result },
          result.error !== undefined,
        )
      },
    ),
    tool(
      "read_file",
      "Reads a file from one remote ai-or-die fleet instance's filesystem. The required path is passed to the remote host as an unsanitized read request; this router does not confine it to a local workspace, and path policy is delegated to the remote instance. It returns resolvedInstance plus the remote file-content response. It is useful for reading a known file on a remote fleet host after choosing an instance. It is not for local files, directory browsing, text search, git revisions, or session transcripts; use local Read for this machine, list_dir to browse remote directories, search to find remote files, git_show for revision content, and read_session for terminal output.",
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
      "Lists a directory on one remote ai-or-die fleet instance. The required path is the remote directory path, and instance can select a registered host or default to the registry default or sole instance. It returns resolvedInstance plus the remote directory-listing response. It is useful for browsing a remote workspace before choosing a file to read or search. It is not for local directories, file contents, git revisions, or session transcripts; use local filesystem tools for this machine, read_file for remote file contents, git_show for revision content, and read_session for terminal output.",
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
      "Searches files on one remote ai-or-die fleet instance's workspace, where a fleet instance is a registered remote host exposed through the fleet MCP server. The required query is sent to that remote instance, and path can narrow the remote search scope; this does not search the local repository or the web. It returns resolvedInstance plus the remote search response. It is useful when the target content lives on a remote fleet host. It is not for this checkout, semantic code discovery, or internet research; use mcp__search__code for the local workspace and mcp__search__web for web search.",
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
      "Shows git content on one remote ai-or-die fleet instance, such as a file at a specific revision or a commit object. The required path identifies the remote repository path or file path, and the optional ref is a git commit-ish such as HEAD, a branch, a tag, or a commit SHA. It returns resolvedInstance plus the remote git-show response. It is useful when the caller needs repository content as it existed at a revision on the remote host. It is not for current working-tree reads, directory listings, local git commands, or web search; use read_file for current remote file content and local tools for this checkout.",
      objectSchema({
        instance: stringProp("Instance id or label. Defaults to the registry default, or the sole instance."),
        path: stringProp("Remote repository path or file path for git-show."),
        ref: stringProp("Optional git ref, revision, or commit-ish, such as HEAD, a branch, a tag, or a commit SHA."),
      }, ["path"]),
      async (args, signal) => {
        const instance = await resolve(optionalString(args, "instance"))
        const response = await clientFor(instance).gitShow(definedObject({
          path: requiredString(args, "path"),
          ref: optionalString(args, "ref"),
        }), signal)
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
    case "MESH_UNCONFIGURED":
      return "mesh egress unconfigured or stale; (re)start the local ai-or-die --mesh sidecar so it publishes a fresh mesh/egress.json"
    case "TAILNET_UNREACHABLE":
      return "reached the local egress proxy but the request did not land on the tailnet peer; likely the tag:aiordie ACL, or the peer's sidecar is down"
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
    case "TAILNET_UNREACHABLE":
    case "MESH_UNCONFIGURED":
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
