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
}

const DEFAULT_RETRY_STATUSES: ReadonlyArray<number> = [429, 500, 502, 503, 504]

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined
  const secs = Number(headerValue)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const dateMs = Date.parse(headerValue)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now())
  return undefined
}

/**
 * A thrown fetch error that is worth retrying — network resets, broken
 * pipes, DNS hiccups, and timeout aborts. NOTE: the caller must already
 * have ruled out a user cancel (caller signal aborted) before calling
 * this, since a timeout abort and a user-cancel abort look identical.
 */
function isTransientNetworkError(err: unknown): boolean {
  const e = err as
    | { name?: string; message?: string; code?: string; cause?: { code?: string } }
    | undefined
  if (!e) return false
  if (e.name === "AbortError" || e.name === "TimeoutError") return true
  const msg = (e.message ?? "").toLowerCase()
  if (
    msg.includes("terminated") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("socket") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("epipe") ||
    msg.includes("enotfound")
  ) {
    return true
  }
  const code = e.code ?? e.cause?.code
  return (
    code !== undefined &&
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "ENOTFOUND"].includes(code)
  )
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
      if (!isTransientNetworkError(caught)) throw caught
    }

    // Out of attempts → return the last error response (or rethrow).
    if (attempt >= attempts) {
      if (res) return res
      throw caught
    }

    // Free the connection before retrying a retryable-status response.
    const retryAfterMs = res ? parseRetryAfter(res.headers.get("retry-after")) : undefined
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
      const retryable =
        (status !== undefined && retryStatuses.includes(status)) ||
        isTransientNetworkError(err)
      if (!retryable || attempt >= attempts) throw err

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
