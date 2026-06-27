import { TunnelAuthError } from "./tunnel-auth"

export type FleetErrorCode =
  | "UNREACHABLE"
  | "AUTH_FAILED"
  | "SESSION_NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "TIMEOUT"
  | "UPSTREAM_ERROR"

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
  /**
   * Optional async provider for a VS Code Dev Tunnel `connect` access token.
   * When present and it returns a non-empty value, the value is sent as
   * `X-Tunnel-Authorization: tunnel <token>` — but ONLY on a request whose host
   * is the pinned tunnel origin under `.devtunnels.ms` (origin scoping). It is
   * awaited per request so a re-minted token is always current.
   */
  getTunnelToken?: () => Promise<string | undefined>
  /**
   * Called once on a tunnel-auth failure so the provider can evict its cached
   * token before the single retry re-mints. Absent for the static-token path
   * (a static token cannot be re-minted, so no retry is attempted).
   */
  onTunnelAuthInvalidate?: () => void
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
}

export interface StopSessionInput {
  mode?: string
  idempotencyKey?: string
}

export interface CreateSessionResponse {
  sessionId: string
  lifecycle: string
  name?: string
}

export interface StopSessionResponse {
  stopped: boolean
  lifecycle: string
}

export interface SendMessageResponse {
  messageId: string
  delivered: boolean
  confirmed: boolean
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
  private readonly origin: string
  private readonly token: string
  private readonly fetchFn: typeof fetch
  private readonly getTunnelToken?: () => Promise<string | undefined>
  private readonly onTunnelAuthInvalidate?: () => void

  constructor(options: FleetClientOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "")
    // Pin the base origin once. Every composed request URL is asserted equal to
    // this before sending, so neither the bearer nor the tunnel token can be
    // emitted to an unexpected origin.
    this.origin = new URL(this.baseUrl).origin
    this.token = options.token
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.getTunnelToken = options.getTunnelToken
    this.onTunnelAuthInvalidate = options.onTunnelAuthInvalidate
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
    // Origin pinning: the composed URL must stay on the pinned base origin.
    // Pathnames are controlled and file paths ride in query params, so this
    // should always hold; the assertion is the credential boundary (NOT
    // `redirect:"error"`, which only declines to follow a 3xx).
    if (url.origin !== this.origin) {
      throw new FleetError({
        code: "UNREACHABLE",
        message: "fleet request URL origin did not match the registered instance origin",
        retryable: false,
      })
    }

    // Send the anti-phishing-skip header to any Dev Tunnel host (it helps an
    // anonymous tunnel and is ignored elsewhere). Attach the connect token ONLY
    // on a SECURE (https) Dev Tunnel origin — a credential must never ride a
    // cleartext hop — and only when a provider is configured.
    const devtunnelHost = isDevtunnelHost(url.hostname)
    const tunnelEligible = this.getTunnelToken !== undefined && devtunnelHost && url.protocol === "https:"

    // One forced re-mint + retry on a tunnel-auth failure (expired/rotated
    // connect token). attempt 0 = normal; attempt 1 = post-eviction retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      let tunnelToken: string | undefined
      if (tunnelEligible) {
        try {
          tunnelToken = await this.getTunnelToken!()
        } catch (err) {
          throw mapTunnelAuthError(err)
        }
      }
      const attachTunnel = tunnelToken !== undefined && tunnelToken !== ""
      const canRetry = attachTunnel && !!this.onTunnelAuthInvalidate && attempt === 0

      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
        ...(devtunnelHost ? { "X-Tunnel-Skip-Anti-Phishing-Page": "true" } : {}),
        ...(attachTunnel ? { "X-Tunnel-Authorization": `tunnel ${tunnelToken}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      }

      let response: Response
      try {
        response = await this.fetchFn(url.toString(), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          // Never follow redirects: a 3xx to another origin must not re-send the
          // bearer/tunnel token, and a private Dev Tunnel's 302->github-auth must
          // surface loudly rather than as a silent cleartext first hop.
          redirect: "error",
          signal,
        })
      } catch (err) {
        // A private Dev Tunnel rejecting a stale connect token 302s -> github
        // auth, which `redirect:"error"` turns into a network-style throw. Evict
        // and retry once — but ONLY for an idempotent GET, since a throw on a
        // mutating request could have already reached (and run on) the server.
        if (canRetry && method === "GET") {
          this.onTunnelAuthInvalidate!()
          continue
        }
        throw mapNetworkError(err, devtunnelHost)
      }

      if (!response.ok) {
        // A 401/403 RESPONSE means the request was rejected (not executed), so a
        // re-mint + retry is safe for any method.
        if ((response.status === 401 || response.status === 403) && canRetry) {
          this.onTunnelAuthInvalidate!()
          continue
        }
        throw await mapHttpError(response)
      }

      return (await response.json()) as T
    }

    // Both attempts failed without throwing (defensive; the loop normally
    // returns or throws inside).
    throw new FleetError({
      code: "AUTH_FAILED",
      message: "fleet instance tunnel authentication failed after re-mint; verify the tunnel and `devtunnel user login`",
      retryable: false,
    })
  }
}

/** Dev Tunnel access tokens are only ever scoped to the `*.devtunnels.ms` service. */
function isDevtunnelHost(hostname: string): boolean {
  return hostname === "devtunnels.ms" || hostname.endsWith(".devtunnels.ms")
}

function mapTunnelAuthError(err: unknown): FleetError {
  if (err instanceof TunnelAuthError) {
    return new FleetError({
      code: "AUTH_FAILED",
      message: err.message,
      retryable: err.code === "TIMEOUT",
      detail: { tunnelAuth: err.code },
    })
  }
  return mapNetworkError(err)
}

async function mapHttpError(response: Response): Promise<FleetError> {
  const detail = await readErrorDetail(response)
  const upstreamMessage = detailToMessage(detail)
  const suffix = upstreamMessage ? `: ${upstreamMessage}` : ""
  if (response.status === 401 || response.status === 403) {
    return new FleetError({
      code: "AUTH_FAILED",
      message: `fleet instance authentication failed (${response.status})${suffix}`,
      retryable: false,
      status: response.status,
      detail,
    })
  }
  if (response.status === 404) {
    return new FleetError({
      code: "SESSION_NOT_FOUND",
      message: `fleet session or resource not found (404)${suffix}`,
      retryable: false,
      status: response.status,
      detail,
    })
  }
  if (response.status === 409 || response.status === 412) {
    return new FleetError({
      code: "PRECONDITION_FAILED",
      message: `fleet instance precondition failed (${response.status})${suffix}`,
      retryable: false,
      status: response.status,
      detail,
    })
  }
  if (response.status === 408 || response.status === 504) {
    return new FleetError({
      code: "TIMEOUT",
      message: `fleet instance request timed out (${response.status})${suffix}`,
      retryable: true,
      status: response.status,
      detail,
    })
  }
  return new FleetError({
    code: "UPSTREAM_ERROR",
    message: `fleet instance returned HTTP ${response.status}${suffix}`,
    retryable: response.status === 429 || response.status >= 500,
    status: response.status,
    detail,
  })
}

function mapNetworkError(err: unknown, devtunnelHost = false): FleetError {
  if (isAbortLike(err)) {
    return new FleetError({
      code: "TIMEOUT",
      message: "fleet instance request timed out or was aborted",
      retryable: true,
      detail: err,
    })
  }
  const message = err instanceof Error ? err.message : String(err)
  const hint = devtunnelHost
    ? " — if this is a private VS Code Dev Tunnel, an unauthenticated request is redirected to GitHub auth (which we refuse to follow): set a `tunnelId` (auto-mint) / `tunnelToken` in the registry, or make the tunnel anonymous"
    : ""
  return new FleetError({
    code: "UNREACHABLE",
    message: `fleet instance unreachable: ${message}${hint}`,
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
