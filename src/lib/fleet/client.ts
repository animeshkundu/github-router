export type FleetErrorCode =
  | "UNREACHABLE"
  | "AUTH_FAILED"
  | "SESSION_NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "TIMEOUT"
  | "UPSTREAM_ERROR"
  // F4 connectivity diagnostics:
  // NO_HOST — a Dev Tunnel relay answered but reports no host is connected
  //   (asserted ONLY on a Dev-Tunnel-specific body/header signal, never on a
  //   generic connection-refused/DNS failure or a plain upstream 5xx).
  // RELAY_ERROR — a Dev Tunnel relay returned an error we can't pin to "no host"
  //   (a live host under load also returns 502/503), so this is the neutral
  //   "tunnel up, can't confirm" bucket, kept distinct from TIMEOUT/UPSTREAM_ERROR.
  | "NO_HOST"
  | "RELAY_ERROR"

export class FleetError extends Error {
  code: FleetErrorCode
  retryable: boolean
  status?: number
  detail?: unknown

  constructor(args: {
    code: FleetErrorCode
    message: string
    retryable: boolean
    status?: number
    detail?: unknown
  }) {
    super(args.message)
    this.name = "FleetError"
    this.code = args.code
    this.retryable = args.retryable
    this.status = args.status
    this.detail = args.detail
  }
}

export interface FleetClientOptions {
  url: string
  token: string
  fetchFn?: typeof fetch
}

export interface FleetSessionSummary {
  sessionId: string
  name?: string
  agent?: string
  lifecycle?: string
  interactionState?: string
  canAcceptInput?: boolean
  lastActivity?: string
}

export interface FleetSessionStatus {
  lifecycle?: string
  interactionState?: string
  canAcceptInput?: boolean
  confidence?: unknown
  blockReason?: string
  sessionStateSeq?: number
  lastTurnEndedAt?: string
  awaiting?: unknown
  [key: string]: unknown
}

export interface FleetEvent {
  seq: number
  sessionId?: string
  kind: string
  at: string
  detail?: unknown
  [key: string]: unknown
}

export interface FleetEventsGap {
  reason?: string
  [key: string]: unknown
}

export interface ListSessionsResponse {
  sessions: Array<FleetSessionSummary>
}

export interface StatusResponse {
  sessionId: string
  status: FleetSessionStatus
}

export interface ReadSessionResponse {
  sessionId: string
  text: string
  truncated: boolean
  source: string
  status: FleetSessionStatus
}

export interface CreateSessionInput {
  name?: string
  workingDir?: string
  agent?: string
  start?: boolean
  idempotencyKey?: string
  /** F17: bounded readiness wait (ms) before create returns; 0 = return immediately. */
  readyTimeoutMs?: number
}

export interface StopSessionInput {
  mode?: string
  idempotencyKey?: string
}

/** F17: a concrete reason a freshly-started session is not yet driveable. */
export interface FleetReadinessBlocker {
  kind: string
  message?: string
}

export interface CreateSessionResponse {
  sessionId: string
  lifecycle: string
  name?: string
  /** F17 readiness barrier: true once the agent is actually driveable. */
  ready?: boolean
  /** F17: true when a claude JSONL turn-binding is live (deterministic turn detection). */
  bound?: boolean
  /** F17: present when not ready — names the blocker (trust modal, binding_pending, …). */
  blocker?: FleetReadinessBlocker
  startError?: string
}

export interface StopSessionResponse {
  stopped: boolean
  lifecycle: string
}

/** F9/F18: structured per-stage status for a send_message. */
export interface FleetSubStatus {
  status: string
  awaiting?: unknown
}

export interface SendMessageResponse {
  messageId: string
  delivered: boolean
  confirmed: boolean
  /** F18: 'turn_completed' | 'submitted' | 'delivered' | 'unconfirmed' | 'no_turn_binding'. */
  confirmation?: string
  /** F9: true when the message submitted but its turn outran awaitMs (NOT a failure). */
  confirmationTimedOut?: boolean
  /** F18: delivery (bytes written), submission (message reached the composer), turn (ran to completion). */
  delivery?: FleetSubStatus
  submission?: FleetSubStatus
  turn?: FleetSubStatus
  confidence?: unknown
  interactionState?: string
  sessionStateSeq?: number
  duplicated?: boolean
}

export interface SendKeysResponse {
  keysId: string
  delivered: boolean
  duplicated?: boolean
}

export interface RespondResponse {
  delivered: boolean
  awaitingKind?: string
  mappedKeys?: string
  duplicated?: boolean
}

export interface WaitEventsInput {
  cursor?: string
  timeoutMs?: number
  sessionIds?: ReadonlyArray<string>
  kinds?: ReadonlyArray<string>
}

export interface WaitEventsResponse {
  events: Array<FleetEvent>
  gaps: Array<FleetEventsGap>
  cursor: string
  more: boolean
}

export interface ReadFileResponse {
  [key: string]: unknown
}

export interface ListDirResponse {
  [key: string]: unknown
}

export interface SearchResponse {
  [key: string]: unknown
}

export interface GitShowResponse {
  [key: string]: unknown
}

export function encodeSessionId(instanceId: string, localId: string): string {
  return `${instanceId}:${localId}`
}

export function decodeSessionId(globalId: string): { instanceId: string; localId: string } {
  const idx = globalId.indexOf(":")
  if (idx <= 0 || idx === globalId.length - 1) {
    throw new FleetError({
      code: "SESSION_NOT_FOUND",
      message: `invalid fleet sessionId ${JSON.stringify(globalId)}; expected "instanceId:localSessionId"`,
      retryable: false,
    })
  }
  return { instanceId: globalId.slice(0, idx), localId: globalId.slice(idx + 1) }
}

export class FleetClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchFn: typeof fetch

  constructor(options: FleetClientOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "")
    this.token = options.token
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
  }

  listSessions(signal?: AbortSignal): Promise<ListSessionsResponse> {
    return this.request("GET", "/api/control/sessions", undefined, undefined, signal)
  }

  status(sessionId: string, signal?: AbortSignal): Promise<StatusResponse> {
    return this.request("GET", `/api/control/sessions/${encodeURIComponent(sessionId)}/status`, undefined, undefined, signal)
  }

  readSession(sessionId: string, lines?: number, signal?: AbortSignal): Promise<ReadSessionResponse> {
    return this.request(
      "GET",
      `/api/control/sessions/${encodeURIComponent(sessionId)}/read`,
      lines === undefined ? undefined : { lines: String(lines) },
      undefined,
      signal,
    )
  }

  createSession(input: CreateSessionInput, signal?: AbortSignal): Promise<CreateSessionResponse> {
    return this.request("POST", "/api/control/sessions/create", undefined, input, signal)
  }

  stopSession(sessionId: string, mode?: string, signal?: AbortSignal): Promise<StopSessionResponse>
  stopSession(
    sessionId: string,
    mode: string | undefined,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<StopSessionResponse>
  stopSession(sessionId: string, input?: StopSessionInput, signal?: AbortSignal): Promise<StopSessionResponse>
  stopSession(
    sessionId: string,
    modeOrInput?: string | StopSessionInput,
    idempotencyKeyOrSignal?: string | AbortSignal,
    signal?: AbortSignal,
  ): Promise<StopSessionResponse> {
    const body: StopSessionInput = {}
    let requestSignal: AbortSignal | undefined
    if (typeof modeOrInput === "object" && modeOrInput !== null) {
      if (modeOrInput.mode !== undefined) body.mode = modeOrInput.mode
      if (modeOrInput.idempotencyKey !== undefined) body.idempotencyKey = modeOrInput.idempotencyKey
      requestSignal = typeof idempotencyKeyOrSignal === "string" ? signal : idempotencyKeyOrSignal
    } else {
      if (modeOrInput !== undefined) body.mode = modeOrInput
      if (typeof idempotencyKeyOrSignal === "string") {
        body.idempotencyKey = idempotencyKeyOrSignal
        requestSignal = signal
      } else {
        requestSignal = idempotencyKeyOrSignal
      }
    }
    return this.request("POST", `/api/control/sessions/${encodeURIComponent(sessionId)}/stop`, undefined, body, requestSignal)
  }

  sendMessage(
    sessionId: string,
    input: { message: string; idempotencyKey: string; awaitMs?: number },
    signal?: AbortSignal,
  ): Promise<SendMessageResponse> {
    return this.request("POST", `/api/control/sessions/${encodeURIComponent(sessionId)}/message`, undefined, input, signal)
  }

  sendKeys(
    sessionId: string,
    input: { keys: string; idempotencyKey: string; raw?: boolean },
    signal?: AbortSignal,
  ): Promise<SendKeysResponse> {
    return this.request("POST", `/api/control/sessions/${encodeURIComponent(sessionId)}/keys`, undefined, input, signal)
  }

  respond(
    sessionId: string,
    input: { choice?: string; optionValue?: string; keys?: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<RespondResponse> {
    return this.request("POST", `/api/control/sessions/${encodeURIComponent(sessionId)}/respond`, undefined, input, signal)
  }

  waitEvents(input: WaitEventsInput, signal?: AbortSignal): Promise<WaitEventsResponse> {
    const query: Record<string, string> = {}
    if (input.cursor !== undefined) query.cursor = input.cursor
    if (input.timeoutMs !== undefined) query.timeoutMs = String(input.timeoutMs)
    if (input.sessionIds !== undefined) query.sessionIds = input.sessionIds.join(",")
    if (input.kinds !== undefined) query.kinds = input.kinds.join(",")
    return this.request("GET", "/api/control/events", query, undefined, signal)
  }

  readFile(pathValue: string, signal?: AbortSignal): Promise<ReadFileResponse> {
    return this.request("GET", "/api/files/content", { path: pathValue }, undefined, signal)
  }

  listDir(pathValue: string, signal?: AbortSignal): Promise<ListDirResponse> {
    return this.request("GET", "/api/files", { path: pathValue }, undefined, signal)
  }

  search(queryValue: string, pathValue?: string, signal?: AbortSignal): Promise<SearchResponse> {
    const query: Record<string, string> = { q: queryValue }
    if (pathValue !== undefined) query.path = pathValue
    return this.request("GET", "/api/search", query, undefined, signal)
  }

  gitShow(input: Record<string, unknown>, signal?: AbortSignal): Promise<GitShowResponse> {
    const query: Record<string, string> = {}
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null) continue
      if (key === "instance") continue
      query[key] = String(value)
    }
    return this.request("GET", "/api/files/git-show", query, undefined, signal)
  }

  private async request<T>(
    method: "GET" | "POST",
    pathname: string,
    query?: Record<string, string>,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(pathname, `${this.baseUrl}/`)
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value)
    }

    let response: Response
    try {
      response = await this.fetchFn(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Never follow redirects: a 3xx to another origin must not re-send the
        // bearer token, and an http->https upgrade redirect should surface as a
        // loud error (the registry url should already be https) rather than a
        // silent cleartext first hop.
        redirect: "error",
        signal,
      })
    } catch (err) {
      throw mapNetworkError(err)
    }

    if (!response.ok) {
      throw await mapHttpError(response, url.toString())
    }

    return (await response.json()) as T
  }
}

async function mapHttpError(response: Response, requestUrl: string): Promise<FleetError> {
  const detail = await readErrorDetail(response)
  const upstreamMessage = detailToMessage(detail)
  const suffix = upstreamMessage ? `: ${upstreamMessage}` : ""
  const status = response.status

  // F4: a Dev Tunnel relay that reports "no host connected" — assert NO_HOST ONLY
  // when the host is a Dev Tunnel host AND a Dev-Tunnel-specific body signal
  // confirms it. Runs before the status table so a no-host 502/503/404 is not
  // mis-bucketed as a generic upstream error or a missing session.
  if (isDevTunnelHost(requestUrl) && detectDevTunnelNoHost(status, detail)) {
    return new FleetError({
      code: "NO_HOST",
      message: `dev tunnel relay reports no host connected (${status})${suffix}`,
      retryable: true,
      status,
      detail,
    })
  }

  if (status === 401 || status === 403) {
    return new FleetError({
      code: "AUTH_FAILED",
      message: `fleet instance authentication failed (${status})${suffix}`,
      retryable: false,
      status,
      detail,
    })
  }
  if (status === 404) {
    return new FleetError({
      code: "SESSION_NOT_FOUND",
      message: `fleet session or resource not found (404)${suffix}`,
      retryable: false,
      status,
      detail,
    })
  }
  if (status === 409 || status === 412) {
    return new FleetError({
      code: "PRECONDITION_FAILED",
      message: `fleet instance precondition failed (${status})${suffix}`,
      retryable: false,
      status,
      detail,
    })
  }
  if (status === 408 || status === 504) {
    return new FleetError({
      code: "TIMEOUT",
      message: `fleet instance request timed out (${status})${suffix}`,
      retryable: true,
      status,
      detail,
    })
  }
  // F4: a Dev Tunnel relay 502/503 with no no-host proof is the neutral RELAY_ERROR.
  // A live host under load also returns 502/503, so we must NOT over-claim NO_HOST;
  // scoped to Dev Tunnel hosts so a plain upstream 5xx from a direct host stays
  // UPSTREAM_ERROR.
  if ((status === 502 || status === 503) && isDevTunnelHost(requestUrl)) {
    return new FleetError({
      code: "RELAY_ERROR",
      message: `dev tunnel relay returned HTTP ${status} (host may be down, restarting, or under load)${suffix}`,
      retryable: true,
      status,
      detail,
    })
  }
  return new FleetError({
    code: "UPSTREAM_ERROR",
    message: `fleet instance returned HTTP ${status}${suffix}`,
    retryable: status === 429 || status >= 500,
    status,
    detail,
  })
}

const DEVTUNNEL_HOST_RE = /(?:^|\.)devtunnels\.ms$|(?:^|\.)tunnels\.api\.visualstudio\.com$/i

/** F4: only Dev Tunnel relay hosts may be classified NO_HOST / RELAY_ERROR. */
function isDevTunnelHost(requestUrl: string): boolean {
  try {
    return DEVTUNNEL_HOST_RE.test(new URL(requestUrl).hostname)
  } catch {
    return false
  }
}

// High-precision substrings the Dev Tunnel relay emits when no host is connected.
// The exact wording/status varies by cluster, so we match on the body signal
// rather than the status alone, and require one of these tokens before asserting
// NO_HOST (a bare 502 is RELAY_ERROR, not proof of no host).
const DEVTUNNEL_NO_HOST_SIGNALS = [
  "no host is currently connected",
  "tunnel is not currently hosted",
  "host is not accepting connections",
  "tunnel host is not connected",
  "no connection to the host",
  "tunnelporthostnotconnected",
] as const

function detectDevTunnelNoHost(status: number, detail: unknown): boolean {
  if (status !== 502 && status !== 503 && status !== 404) return false
  const haystack = detailToSearchString(detail).toLowerCase()
  if (haystack === "") return false
  return DEVTUNNEL_NO_HOST_SIGNALS.some((signal) => haystack.includes(signal))
}

function detailToSearchString(detail: unknown): string {
  if (detail === undefined || detail === null) return ""
  if (typeof detail === "string") return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

function mapNetworkError(err: unknown): FleetError {
  if (isAbortLike(err)) {
    return new FleetError({
      code: "TIMEOUT",
      message: "fleet instance request timed out or was aborted",
      retryable: true,
      detail: err,
    })
  }
  const message = err instanceof Error ? err.message : String(err)
  return new FleetError({
    code: "UNREACHABLE",
    message: `fleet instance unreachable: ${message}`,
    retryable: true,
    detail: err,
  })
}

async function readErrorDetail(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "")
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function detailToMessage(detail: unknown): string | undefined {
  if (typeof detail === "string") return detail
  if (typeof detail !== "object" || detail === null) return undefined
  const record = detail as Record<string, unknown>
  const error = record.error
  if (typeof error === "string") return error
  if (typeof error === "object" && error !== null) {
    const errorRecord = error as Record<string, unknown>
    if (typeof errorRecord.message === "string") return errorRecord.message
    if (typeof errorRecord.code === "string") return errorRecord.code
  }
  if (typeof record.message === "string") return record.message
  return undefined
}

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")
}
