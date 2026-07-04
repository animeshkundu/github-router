import { randomUUID } from "node:crypto"

import { applyInsecureTls } from "../insecure-tls"

export type ArtifactErrorCode =
  | "UNREACHABLE"
  | "AUTH_FAILED"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "UPSTREAM_ERROR"
  | "INVALID_RESPONSE"
  | "INVALID_REQUEST"

export class ArtifactError extends Error {
  code: ArtifactErrorCode
  retryable: boolean
  status?: number
  detail?: unknown

  constructor(args: {
    code: ArtifactErrorCode
    message: string
    retryable: boolean
    status?: number
    detail?: unknown
  }) {
    super(args.message)
    this.name = "ArtifactError"
    this.code = args.code
    this.retryable = args.retryable
    this.status = args.status
    this.detail = args.detail
  }
}

export interface ArtifactClientOptions {
  baseUrl: string
  token: string
  sessionId: string
  fetchFn?: typeof fetch
  /**
   * Disable TLS certificate verification for this client's requests (ai-or-die
   * serves the artifact API over a SELF-SIGNED cert on loopback). Applied
   * per-request via the runtime-correct mechanism (Bun `tls` / Node undici
   * `dispatcher`); the global TLS posture is untouched. Off unless explicitly true.
   */
  insecureTLS?: boolean
  /**
   * Base backoff (ms) between transient retries. The per-attempt delay is
   * `retryBaseMs * 2^(attempt-1)` with jitter. Tests pass 0 for instant retries.
   */
  retryBaseMs?: number
}

export interface ArtifactOpenResponse {
  sessionId: string
  key: string
  viewUrl: string
}

export interface ArtifactUpdateResponse {
  ok: boolean
  viewUrl?: string
  [key: string]: unknown
}

export interface ArtifactSimpleResponse {
  ok: boolean
  [key: string]: unknown
}

export interface ArtifactEndResponse {
  ok: boolean
  status?: string
  [key: string]: unknown
}

export interface ArtifactPollResponse {
  status: string
  prompts?: unknown
  layout_warnings?: unknown
  dom_snapshot?: unknown
  next_step?: string
  [key: string]: unknown
}

/**
 * Typed drain events (contract v2.2 §2). The union is deliberately open-ended:
 * an unknown `kind` is preserved (never rejected) so a future event type flows
 * through to the model, which ignores what it does not understand (the
 * forward-compat rule). Server assigns a per-session, gap-free monotonic `id`.
 */
export interface ArtifactCommentEvent {
  kind: "comment"
  id: string
  prompt: string
  text: string
  selector: string
  sourceLine?: number
  target?: unknown
}
export interface ArtifactActionEvent {
  kind: "action"
  id: string
  action: string
  value?: string
  elementId: string
  selector?: string
  sourceLine?: number
}
export interface ArtifactEndedEvent {
  kind: "ended"
  id: string
}
export type ArtifactEvent =
  | ArtifactCommentEvent
  | ArtifactActionEvent
  | ArtifactEndedEvent
  | { kind: string; id: string; [key: string]: unknown }

export type ReviewStatus = "open" | "ended" | "missing" | (string & {})

export interface ArtifactAwaitResponse {
  events: ArtifactEvent[]
  status: ReviewStatus
  cursor?: string
  [key: string]: unknown
}

export interface ArtifactAgentReplyResponse {
  [key: string]: unknown
}

// Long-hold budget for /await. The server long-polls up to ~25s; we abort a
// little above that so a healthy long-hold is never severed, only a real stall.
const AWAIT_DEFAULT_TIMEOUT_MS = 25_000
const AWAIT_ABORT_MARGIN_MS = 5_000
const DEFAULT_RETRY_BASE_MS = 250
// Retryable ops (open/update/end/await) get this many additional attempts on a
// transient UNREACHABLE/TIMEOUT. Single-shot ops (reply/refresh/dismiss) get 0.
const TRANSIENT_RETRIES = 2
// Which error codes withRetry re-attempts. Default covers a network stall and a
// connection failure. `awaitEvents` narrows to UNREACHABLE only (a long-hold
// TIMEOUT is a normal empty-drain, not a fault to re-hold).
const DEFAULT_RETRYABLE_CODES: ReadonlySet<ArtifactErrorCode> = new Set(["UNREACHABLE", "TIMEOUT"])
const AWAIT_RETRYABLE_CODES: ReadonlySet<ArtifactErrorCode> = new Set(["UNREACHABLE"])

export class ArtifactClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly sessionId: string
  private readonly fetchFn: typeof fetch
  private readonly insecureTLS: boolean
  private readonly retryBaseMs: number

  constructor(options: ArtifactClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "")
    this.token = options.token
    this.sessionId = options.sessionId
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.insecureTLS = options.insecureTLS ?? false
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS
  }

  /**
   * Open (or replace) the review for this session. `mode` is advisory metadata
   * forwarded to the server (forward-compat: ignored if unknown); the actual
   * interactivity comes from the served HTML's `data-aod-*` markup. Retried on a
   * transient failure with a STABLE idempotency key so a retry-after-success does
   * not double-open.
   */
  open(
    file: string,
    opts: { mode?: string; idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<ArtifactOpenResponse> {
    const idempotencyKey = opts.idempotencyKey ?? randomUUID()
    const body: Record<string, unknown> = { file }
    if (opts.mode) body.mode = opts.mode
    return this.withRetry(
      () =>
        this.requestOnce<ArtifactOpenResponse>({
          method: "POST",
          pathname: this.path("/open"),
          body,
          signal: opts.signal,
          idempotencyKey,
        }),
      TRANSIENT_RETRIES,
      opts.signal,
    )
  }

  /**
   * Replace the current review's content. Exactly one of `file` | `html` (the
   * caller-facing tool enforces that). `html` is written by the SERVER to the
   * review's existing sandboxed file, so `html` with no existing review is an
   * INVALID_REQUEST from the server. Retried with a stable idempotency key.
   */
  update(opts: {
    file?: string
    html?: string
    idempotencyKey?: string
    signal?: AbortSignal
  }): Promise<ArtifactUpdateResponse> {
    const idempotencyKey = opts.idempotencyKey ?? randomUUID()
    const body: Record<string, unknown> = {}
    if (opts.file !== undefined) body.file = opts.file
    if (opts.html !== undefined) body.html = opts.html
    return this.withRetry(
      () =>
        this.requestOnce<ArtifactUpdateResponse>({
          method: "POST",
          pathname: this.path("/update"),
          body,
          signal: opts.signal,
          idempotencyKey,
          allowEmptyJson: true,
        }),
      TRANSIENT_RETRIES,
      opts.signal,
    )
  }

  /** Force a reload from disk (no content change). Single-shot (idempotent, cheap). */
  refresh(signal?: AbortSignal): Promise<ArtifactSimpleResponse> {
    return this.requestOnce<ArtifactSimpleResponse>({
      method: "POST",
      pathname: this.path("/refresh"),
      signal,
      allowEmptyJson: true,
    })
  }

  /** Hide the panel UI while keeping the review alive. Single-shot; server idempotent. */
  dismiss(signal?: AbortSignal): Promise<ArtifactSimpleResponse> {
    return this.requestOnce<ArtifactSimpleResponse>({
      method: "POST",
      pathname: this.path("/dismiss"),
      signal,
      allowEmptyJson: true,
    })
  }

  /**
   * Typed drain (contract v2.2 §1/§2). Long-holds up to the server cap, returns
   * events with `id > cursor` plus the new high-water `cursor`. Idempotent by
   * (cursor, event.id): re-calling with the same cursor replays the same window
   * from the server's bounded buffer, so a lost cursor (compaction) is
   * recoverable. Retried on a transient network failure (the cursor makes retry
   * safe — no double-consumption).
   */
  awaitEvents(
    opts: { cursor?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ArtifactAwaitResponse> {
    const serverTimeoutMs =
      typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : AWAIT_DEFAULT_TIMEOUT_MS
    // Abort a little ABOVE the server's own long-hold cap so a healthy hold is
    // never severed — only a genuine stall trips the client timeout.
    const clientTimeoutMs = serverTimeoutMs + AWAIT_ABORT_MARGIN_MS
    return this.withRetry(
      () =>
        this.requestOnce<ArtifactAwaitResponse>({
          method: "GET",
          pathname: this.path("/await"),
          query: {
            cursor: opts.cursor,
            timeoutMs: String(serverTimeoutMs),
          },
          signal: opts.signal,
          timeoutMsHint: clientTimeoutMs,
        }),
      TRANSIENT_RETRIES,
      opts.signal,
      // A long-hold TIMEOUT is the EXPECTED empty-drain outcome, not a fault, so
      // do not silently re-hold (which would multiply the wait); the caller
      // re-awaits with the cursor. Only a real connection failure is retried.
      AWAIT_RETRYABLE_CODES,
    )
  }

  /** Free-text agent->human reply. SINGLE-SHOT (not retried): a retry-after-success
   *  would render a duplicate chat bubble server-side. */
  agentReply(text: string, signal?: AbortSignal): Promise<ArtifactAgentReplyResponse> {
    return this.requestOnce<ArtifactAgentReplyResponse>({
      method: "POST",
      pathname: this.path("/agent-reply"),
      body: { text },
      signal,
      allowEmptyJson: true,
    })
  }

  /**
   * End the review. Retried with a stable idempotency key; a NOT_FOUND (the
   * review is already ended — whether by a prior call or by a retry landing after
   * the first attempt succeeded) is mapped to a successful `{ ok, status:"ended" }`
   * rather than surfaced as a 404 (contract v2.2 §1.1).
   */
  async end(signal?: AbortSignal): Promise<ArtifactEndResponse> {
    const idempotencyKey = randomUUID()
    try {
      return await this.withRetry(
        () =>
          this.requestOnce<ArtifactEndResponse>({
            method: "POST",
            pathname: this.path("/end"),
            signal,
            idempotencyKey,
            allowEmptyJson: true,
          }),
        TRANSIENT_RETRIES,
        signal,
      )
    } catch (err) {
      if (err instanceof ArtifactError && err.code === "NOT_FOUND") {
        return { ok: true, status: "ended" }
      }
      throw err
    }
  }

  /**
   * FROZEN legacy long-poll (contract v2.2 §1). Old payload shape,
   * comment-equivalent only. New agents use `awaitEvents`. Single request per
   * call (the caller-facing tool owns the bounded re-poll budget).
   */
  poll(timeoutMsHint?: number, signal?: AbortSignal): Promise<ArtifactPollResponse> {
    return this.requestOnce<ArtifactPollResponse>({
      method: "GET",
      pathname: this.path("/poll"),
      signal,
      timeoutMsHint,
    })
  }

  private path(suffix: string): string {
    return `/api/artifact/${encodeURIComponent(this.sessionId)}${suffix}`
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    retries: number,
    signal?: AbortSignal,
    retryableCodes: ReadonlySet<ArtifactErrorCode> = DEFAULT_RETRYABLE_CODES,
  ): Promise<T> {
    let attempt = 0
    for (;;) {
      try {
        return await fn()
      } catch (err) {
        attempt += 1
        const transient =
          err instanceof ArtifactError && err.retryable && retryableCodes.has(err.code)
        // Never retry once the caller cancelled, and never exceed the budget.
        if (!transient || attempt > retries || signal?.aborted) throw err
        const base = this.retryBaseMs
        const delay = base <= 0 ? 0 : Math.round(base * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5))
        await sleep(delay, signal)
      }
    }
  }

  private async requestOnce<T>(o: {
    method: "GET" | "POST"
    pathname: string
    body?: unknown
    signal?: AbortSignal
    timeoutMsHint?: number
    allowEmptyJson?: boolean
    idempotencyKey?: string
    query?: Record<string, string | undefined>
  }): Promise<T> {
    let url: URL
    try {
      url = new URL(o.pathname, `${this.baseUrl}/`)
    } catch (err) {
      throw new ArtifactError({
        code: "UNREACHABLE",
        message: "artifact API base URL is invalid",
        retryable: false,
        detail: err,
      })
    }
    if (o.query) {
      for (const [key, value] of Object.entries(o.query)) {
        if (value !== undefined) url.searchParams.set(key, value)
      }
    }
    const timeout = combineSignalAndTimeout(o.signal, o.timeoutMsHint)

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
      }
      if (o.body !== undefined) headers["Content-Type"] = "application/json"
      // A stable idempotency key survives across retries so the server can dedupe
      // a retry that lands after the first attempt already succeeded.
      if (o.idempotencyKey) headers["Idempotency-Key"] = o.idempotencyKey
      const init: RequestInit = {
        method: o.method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        redirect: "error",
        signal: timeout.signal,
      }
      if (this.insecureTLS) {
        // Self-signed direct-HTTPS ai-or-die on loopback: relax verification for
        // THIS request only (Bun `tls` / Node undici `dispatcher`). Bearer +
        // `redirect:"error"` still bound the token to the pinned loopback origin.
        applyInsecureTls(init as unknown as Record<string, unknown>)
      }
      const response = await this.fetchFn(url.toString(), init)

      if (!response.ok) {
        throw await mapHttpError(response)
      }

      // Read the body INSIDE the timeout scope (cleanup is in the finally below),
      // so a server that sends headers then hangs on the body is bounded by the
      // same deadline as the connect/headers phase — not left to block forever.
      let text: string
      try {
        text = await response.text()
      } catch (err) {
        if (isAbortLike(err)) throw mapNetworkError(err)
        throw new ArtifactError({
          code: "INVALID_RESPONSE",
          message: "artifact API response body could not be read",
          retryable: false,
          detail: err,
        })
      }
      if (!text && o.allowEmptyJson) return {} as T
      try {
        return JSON.parse(text) as T
      } catch (err) {
        throw new ArtifactError({
          code: "INVALID_RESPONSE",
          message: "artifact API returned a non-JSON response",
          retryable: false,
          detail: err,
        })
      }
    } catch (err) {
      // ArtifactErrors (HTTP status, parse) are already classified — pass through.
      // Anything else is a transport failure (connect/abort/body stall) → map it.
      if (err instanceof ArtifactError) throw err
      throw mapNetworkError(err)
    } finally {
      timeout.cleanup()
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException("retry backoff aborted", "AbortError"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function combineSignalAndTimeout(
  signal: AbortSignal | undefined,
  timeoutMsHint: number | undefined,
): { signal?: AbortSignal; cleanup: () => void } {
  const timeoutMs =
    typeof timeoutMsHint === "number" && Number.isFinite(timeoutMsHint) && timeoutMsHint > 0
      ? timeoutMsHint
      : undefined
  if (timeoutMs === undefined) return { signal, cleanup: () => {} }

  const controller = new AbortController()
  const abortFromCaller = (): void => {
    try {
      controller.abort(signal?.reason)
    } catch {
      controller.abort()
    }
  }
  if (signal?.aborted) abortFromCaller()
  signal?.addEventListener("abort", abortFromCaller, { once: true })
  const timer = setTimeout(() => {
    try {
      controller.abort(new DOMException("artifact API request timed out", "TimeoutError"))
    } catch {
      controller.abort()
    }
  }, timeoutMs)

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abortFromCaller)
    },
  }
}

async function mapHttpError(response: Response): Promise<ArtifactError> {
  const detail = await readErrorDetail(response)
  const upstreamMessage = detailToMessage(detail)
  const suffix = upstreamMessage ? `: ${upstreamMessage}` : ""
  if (response.status === 401 || response.status === 403) {
    return new ArtifactError({
      code: "AUTH_FAILED",
      message: `artifact API authentication failed (${response.status})${suffix}`,
      retryable: false,
      status: response.status,
      detail,
    })
  }
  if (response.status === 404) {
    return new ArtifactError({
      code: "NOT_FOUND",
      message: `artifact session or resource not found (404)${suffix}`,
      retryable: false,
      status: response.status,
      detail,
    })
  }
  if (response.status === 408 || response.status === 504) {
    return new ArtifactError({
      code: "TIMEOUT",
      message: `artifact API request timed out (${response.status})${suffix}`,
      retryable: true,
      status: response.status,
      detail,
    })
  }
  // A 400 tagged with an INVALID_REQUEST code (e.g. update html-without-file) is a
  // distinct, non-retryable client error — not the generic upstream bucket.
  if (response.status === 400 && detailToCode(detail)?.toUpperCase() === "INVALID_REQUEST") {
    return new ArtifactError({
      code: "INVALID_REQUEST",
      message: `artifact API rejected the request (400)${suffix}`,
      retryable: false,
      status: response.status,
      detail,
    })
  }
  return new ArtifactError({
    code: "UPSTREAM_ERROR",
    message: `artifact API returned HTTP ${response.status}${suffix}`,
    retryable: response.status === 429 || response.status >= 500,
    status: response.status,
    detail,
  })
}

function mapNetworkError(err: unknown): ArtifactError {
  if (isAbortLike(err)) {
    return new ArtifactError({
      code: "TIMEOUT",
      message: "artifact API request timed out or was aborted",
      retryable: true,
      detail: err,
    })
  }
  const message = err instanceof Error ? err.message : String(err)
  return new ArtifactError({
    code: "UNREACHABLE",
    message: `artifact API unreachable: ${message}`,
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

/** Extract a machine `code` from an upstream error body (`{error:{code}}` or
 *  `{code}`) so a tagged 400 can be classified (INVALID_REQUEST). */
function detailToCode(detail: unknown): string | undefined {
  if (typeof detail !== "object" || detail === null) return undefined
  const record = detail as Record<string, unknown>
  const error = record.error
  if (typeof error === "object" && error !== null) {
    const code = (error as Record<string, unknown>).code
    if (typeof code === "string") return code
  }
  if (typeof record.code === "string") return record.code
  return undefined
}

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")
}
