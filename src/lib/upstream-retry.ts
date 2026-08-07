/**
 * Shared transient-failure retry for upstream calls (`src/lib/upstream-retry.ts`).
 *
 * Retries ONLY on transient conditions — never on success, never on a
 * deterministic 4xx (400/401/403/404…), so a malformed request or auth
 * failure fails fast instead of being hammered. 401 is intentionally NOT
 * retried here: it stays with the existing token-refresh path so the
 * 401→503 forwardError invariant is preserved.
 *
 * Retryable:
 *   - HTTP 429 + 5xx (500/502/503/504) — the "upstream is sick" class.
 *   - network errors (ECONNRESET / "fetch failed" / "terminated" / EPIPE …).
 *   - upstream TIMEOUT aborts: an AbortError thrown while the CALLER'S
 *     `signal` is NOT aborted (a user cancel aborts the caller's signal
 *     and is rethrown immediately, never retried).
 *
 * Exponential backoff + FULL jitter, capped, honoring `Retry-After`. The
 * inter-attempt sleep is abortable so a user cancel during backoff
 * returns promptly. Bounded `attempts` keep a single call from holding an
 * inflight slot indefinitely (robust AND fast).
 *
 * Streaming note: the user-facing passthrough and the worker loop must
 * only retry in the PRE-FIRST-BYTE window — a retry after bytes have
 * streamed would duplicate output. Callers there pass a `doFetch` that
 * has not yet handed its body to the consumer.
 */

import consola from "consola"

export interface TransientRetryOpts {
  /** Total attempts including the first (default 3 → up to 2 retries). */
  attempts?: number
  /** Retryable HTTP statuses (default 429, 500, 502, 503, 504). */
  retryStatuses?: ReadonlyArray<number>
  /** Backoff base (default 250ms) and cap (default 4000ms). */
  baseDelayMs?: number
  maxDelayMs?: number
  /** Caller's abort signal — a user cancel fails fast (never retried). */
  signal?: AbortSignal
  /** Short label for debug logging (e.g. "codex_critic", "advisor"). */
  label?: string
  /** Upstream endpoint when it differs from the human-readable label. */
  endpoint?: string
}

const DEFAULT_RETRY_STATUSES: ReadonlyArray<number> = [429, 500, 502, 503, 504]
const TRANSPORT_MESSAGE_MAX = 512
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
])
const DETERMINISTIC_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
  "ERR_SSL_WRONG_VERSION_NUMBER",
])
const CREDENTIAL_RE =
  /\b(eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+){0,2}|gh[opsu]_[A-Za-z0-9_]{20,}|Bearer\s+\S{20,})\b/gi
const SECRET_ASSIGNMENT_RE =
  /\b(authorization|api[_-]?key|access[_-]?token|token|password)\s*[:=]\s*([^\s,;]+)/gi
const REQUEST_BODY_RE =
  /\b(request\s+body|body)\s*[:=]\s*.*$/gi

export type TransportErrorClassification =
  | "transient"
  | "deterministic"
  | "non_transport"
  | "cancelled"

export interface TransportErrorDetails {
  classification: TransportErrorClassification
  name: string
  message: string
  code?: string
  causeCode?: string
}

export interface TransportExhaustionMetadata {
  endpoint?: string
  label?: string
  attempts: number
  classification: "transient" | "deterministic"
  lastError: Omit<TransportErrorDetails, "classification">
}

export class TransportExhaustionError extends Error {
  readonly endpoint?: string
  readonly label?: string
  readonly attempts: number
  readonly classification: "transient" | "deterministic"
  readonly lastError: Omit<TransportErrorDetails, "classification">

  constructor(metadata: TransportExhaustionMetadata, cause: unknown) {
    const target = metadata.endpoint ?? metadata.label ?? "upstream"
    const lastError = {
      name: sanitizeTransportText(metadata.lastError.name),
      message: sanitizeTransportText(metadata.lastError.message),
      code: metadata.lastError.code
        ? sanitizeTransportText(metadata.lastError.code)
        : undefined,
      causeCode: metadata.lastError.causeCode
        ? sanitizeTransportText(metadata.lastError.causeCode)
        : undefined,
    }
    const code = lastError.causeCode ?? lastError.code
    const suffix = code ? ` (${code})` : ""
    super(
      `Upstream transport ${metadata.classification === "transient" ? "failed" : "is unreachable"} at ${sanitizeTransportText(target)} after ${metadata.attempts} attempt${metadata.attempts === 1 ? "" : "s"}: ${lastError.name}: ${lastError.message}${suffix}`,
      { cause },
    )
    this.name = "TransportExhaustionError"
    this.endpoint = metadata.endpoint
      ? sanitizeTransportText(metadata.endpoint)
      : undefined
    this.label = metadata.label ? sanitizeTransportText(metadata.label) : undefined
    this.attempts = metadata.attempts
    this.classification = metadata.classification
    this.lastError = lastError
  }
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (
    (typeof value !== "object" && typeof value !== "function")
    || value === null
  ) {
    return undefined
  }
  try {
    const property = (value as Record<string, unknown>)[key]
    return typeof property === "string" ? property : undefined
  } catch {
    return undefined
  }
}

function readCause(value: unknown): unknown {
  if (
    (typeof value !== "object" && typeof value !== "function")
    || value === null
  ) {
    return undefined
  }
  try {
    return (value as { cause?: unknown }).cause
  } catch {
    return undefined
  }
}

function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return "[unserializable error]"
  }
}

export function sanitizeTransportText(value: string): string {
  const sanitized = value
    .replace(/\r\n|\r|\n/g, " ")
    .replace(CREDENTIAL_RE, "[REDACTED]")
    .replace(SECRET_ASSIGNMENT_RE, "$1=[REDACTED]")
    .replace(REQUEST_BODY_RE, "$1=[REDACTED]")
  return sanitized.length > TRANSPORT_MESSAGE_MAX
    ? `${sanitized.slice(0, TRANSPORT_MESSAGE_MAX)}…`
    : sanitized
}

/**
 * Classify errors thrown before the first response byte. Deterministic
 * connectivity/configuration signals win over generic runtime wording such as
 * TypeError("fetch failed"), because the nested cause is more specific.
 */
export function classifyTransportError(
  error: unknown,
  opts: { callerCancelled?: boolean } = {},
): TransportErrorDetails {
  const name = readStringProperty(error, "name") ?? "Error"
  const rawMessage =
    readStringProperty(error, "message")
    ?? (typeof error === "string" ? error : safeString(error))
  const message = sanitizeTransportText(rawMessage)
  const code = readStringProperty(error, "code")

  const causes: unknown[] = []
  const seen = new Set<unknown>()
  let current = readCause(error)
  for (let depth = 0; current !== undefined && depth < 4; depth++) {
    if (
      (typeof current === "object" || typeof current === "function")
      && current !== null
    ) {
      if (seen.has(current)) break
      seen.add(current)
    }
    causes.push(current)
    current = readCause(current)
  }
  const causeCode = causes
    .map((cause) => readStringProperty(cause, "code"))
    .find((value): value is string => value !== undefined)
  const codes = [code, ...causes.map((cause) => readStringProperty(cause, "code"))]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.toUpperCase())
  const messages = [
    rawMessage,
    ...causes.map((cause) => readStringProperty(cause, "message") ?? ""),
  ]
    .join(" ")
    .toLowerCase()

  if (opts.callerCancelled) {
    return { classification: "cancelled", name, message, code, causeCode }
  }
  if (
    codes.some((value) => DETERMINISTIC_CODES.has(value))
    || messages.includes("self signed certificate")
    || messages.includes("certificate has expired")
    || messages.includes("unable to verify the first certificate")
    || messages.includes("unable to get local issuer certificate")
    || messages.includes("hostname/ip does not match certificate")
    || messages.includes("tls handshake")
    || messages.includes("ssl routines")
    || messages.includes("econnrefused")
    || messages.includes("enotfound")
  ) {
    return { classification: "deterministic", name, message, code, causeCode }
  }
  if (
    name === "AbortError"
    || name === "TimeoutError"
    || name === "InactivityTimeout"
    || codes.some((value) => TRANSIENT_CODES.has(value))
    || messages.includes("terminated")
    || messages.includes("fetch failed")
    || messages.includes("network error")
    || messages.includes("socket hang up")
    || messages.includes("socket closed")
    || messages.includes("econnreset")
    || messages.includes("etimedout")
    || messages.includes("epipe")
    || messages.includes("eai_again")
  ) {
    return { classification: "transient", name, message, code, causeCode }
  }
  return { classification: "non_transport", name, message, code, causeCode }
}

function transportExhaustion(
  error: unknown,
  attempts: number,
  opts: TransientRetryOpts,
  details: TransportErrorDetails,
): TransportExhaustionError {
  if (
    details.classification !== "transient"
    && details.classification !== "deterministic"
  ) {
    throw new TypeError("transportExhaustion requires a transport error")
  }
  return new TransportExhaustionError(
    {
      endpoint: opts.endpoint ?? opts.label,
      label: opts.label,
      attempts,
      classification: details.classification,
      lastError: {
        name: details.name,
        message: details.message,
        code: details.code,
        causeCode: details.causeCode,
      },
    },
    error,
  )
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined
  const secs = Number(headerValue)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const dateMs = Date.parse(headerValue)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now())
  return undefined
}

/** Sleep that resolves early (does not reject) when `signal` aborts — the
 *  retry loop re-checks `signal.aborted` at the top and throws there. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    if (signal) {
      if (signal.aborted) {
        done()
        return
      }
      signal.addEventListener("abort", done, { once: true })
    }
  })
}

/**
 * Run `doFetch` with bounded transient-failure retries. `doFetch` is a
 * thunk so each attempt issues a FRESH request (bodies can't be replayed
 * from a consumed stream). Returns the final `Response` — which may still
 * carry a retryable status if all attempts are exhausted (the caller
 * handles that as it would a single-shot failure).
 */
export async function fetchWithTransientRetry(
  doFetch: (attempt: number) => Promise<Response>,
  opts: TransientRetryOpts = {},
): Promise<Response> {
  const attempts = Math.max(1, opts.attempts ?? 3)
  const retryStatuses = opts.retryStatuses ?? DEFAULT_RETRY_STATUSES
  const baseDelayMs = opts.baseDelayMs ?? 250
  const maxDelayMs = opts.maxDelayMs ?? 4000
  const { signal, label } = opts

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) {
      throw new DOMException("This operation was aborted", "AbortError")
    }

    let res: Response | undefined
    let caught: unknown
    try {
      res = await doFetch(attempt)
    } catch (err) {
      caught = err
    }

    // Success or a non-retryable status → done.
    if (res && !retryStatuses.includes(res.status)) return res

    // A thrown error: a user cancel fails fast; otherwise only retry the
    // transient network/timeout class.
    if (caught !== undefined) {
      if (signal?.aborted) throw caught
      const details = classifyTransportError(caught)
      if (details.classification === "deterministic") {
        throw transportExhaustion(caught, attempt, opts, details)
      }
      if (details.classification !== "transient") throw caught
    }

    // Out of attempts → return the last error response (or rethrow).
    if (attempt >= attempts) {
      if (res) return res
      const details = classifyTransportError(caught)
      throw transportExhaustion(caught, attempt, opts, details)
    }

    // Free the connection before retrying a retryable-status response.
    const retryAfterMs = res
      ? parseRetryAfter(res.headers.get("retry-after"))
      : undefined
    if (res?.body) {
      try {
        await res.body.cancel()
      } catch {
        /* already torn down */
      }
    }

    // Full jitter (random within the exponential cap), Retry-After wins.
    const expCap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
    const delay = Math.min(
      maxDelayMs,
      retryAfterMs ?? Math.round(Math.random() * expCap),
    )
    if (label) {
      const why = res
        ? `HTTP ${res.status}`
        : (caught as { name?: string } | undefined)?.name ?? "error"
      consola.debug(
        `[upstream-retry] ${label}: attempt ${attempt}/${attempts} failed (${why}); retrying in ${delay}ms`,
      )
    }
    await abortableSleep(delay, signal)
  }
}

/** Extract an HTTP status from a thrown error (HTTPError carries
 *  `.response.status`; others may carry `.status`/`.statusCode`; last
 *  resort parses `"HTTP <code>"` from the message). */
function errorStatus(err: unknown): number | undefined {
  const e = err as
    | {
        status?: unknown
        statusCode?: unknown
        response?: { status?: unknown }
        message?: string
      }
    | undefined
  for (const v of [e?.status, e?.statusCode, e?.response?.status]) {
    if (typeof v === "number") return v
  }
  const m = /\bHTTP (\d{3})\b/.exec(e?.message ?? "")
  return m ? Number(m[1]) : undefined
}

/**
 * Generic transient-retry for a non-`Response`-returning call (e.g. the
 * Copilot service clients, which throw `HTTPError` on non-OK and throw on
 * network errors). Retries `fn()` when it throws a transient error — an
 * `HTTPError`-like with a retryable status (429/5xx) OR a transient
 * network/timeout error — using the same backoff + abort semantics as
 * `fetchWithTransientRetry`. Never retries a deterministic 4xx (incl.
 * 401), a non-transient throw, or a user cancel.
 */
export async function withTransientRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: TransientRetryOpts = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3)
  const retryStatuses = opts.retryStatuses ?? DEFAULT_RETRY_STATUSES
  const baseDelayMs = opts.baseDelayMs ?? 250
  const maxDelayMs = opts.maxDelayMs ?? 4000
  const { signal, label } = opts

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) {
      throw new DOMException("This operation was aborted", "AbortError")
    }
    try {
      return await fn(attempt)
    } catch (err) {
      if (signal?.aborted) throw err
      const status = errorStatus(err)
      const details = classifyTransportError(err)
      if (status !== undefined) {
        if (!retryStatuses.includes(status) || attempt >= attempts) throw err
      } else {
        if (details.classification === "deterministic") {
          throw transportExhaustion(err, attempt, opts, details)
        }
        if (details.classification !== "transient") throw err
        if (attempt >= attempts) {
          throw transportExhaustion(err, attempt, opts, details)
        }
      }

      const retryAfterMs = parseRetryAfter(
        (err as { response?: { headers?: { get?: (k: string) => string | null } } })
          ?.response?.headers?.get?.("retry-after") ?? null,
      )
      const expCap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      const delay = Math.min(
        maxDelayMs,
        retryAfterMs ?? Math.round(Math.random() * expCap),
      )
      if (label) {
        consola.debug(
          `[upstream-retry] ${label}: attempt ${attempt}/${attempts} threw (${
            status !== undefined ? `HTTP ${status}` : (err as { name?: string })?.name ?? "error"
          }); retrying in ${delay}ms`,
        )
      }
      await abortableSleep(delay, signal)
    }
  }
}
