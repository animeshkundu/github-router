import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import {
  sanitizeTransportText,
  TransportExhaustionError,
} from "~/lib/upstream-retry"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export async function forwardError(c: Context, error: unknown) {
  consola.error(`Error occurred at ${c.req.path}:`, error)

  if (error instanceof TransportExhaustionError) {
    const target = sanitizeTransportText(
      error.endpoint ?? error.label ?? c.req.path,
    )
    const diagnostic = formatTransportDiagnostic(error)
    if (error.classification === "transient") {
      // 502 / api_error, NOT 503 / overloaded_error.
      //
      // We already exhausted our own retries against a transport that failed,
      // so "I am busy, retry later" is both inaccurate and expensive:
      // `overloaded_error` is the type Claude Code retries hardest against,
      // and each client retry costs another full round of upstream attempts.
      // On a session near the 1M-token context limit that re-uploads a
      // multi-megabyte body every time, which is what turned a fast failure
      // into multi-minute stalls when this mapping shipped.
      //
      // Trade-off, deliberate: the client now surfaces the error instead of
      // papering over a genuinely recoverable blip. That is the behaviour
      // operators had before the mapping was introduced.
      return c.json(
        {
          type: "error",
          error: {
            type: "api_error",
            message: `Upstream transport was interrupted at ${target} after ${error.attempts} attempts. ${diagnostic}`,
          },
        },
        502,
      )
    }
    return c.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message: `Could not connect to upstream at ${target}. Check DNS, proxy, firewall, and TLS configuration. ${diagnostic}`,
        },
      },
      502,
    )
  }

  if (error instanceof HTTPError) {
    const errorText = await error.response.text().catch(() => "")
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = undefined
    }

    // Map an upstream context-overflow rejection onto Claude Code's gateway
    // capability-rejection contract, so the client runs its own recovery
    // (reactive compaction + retry) instead of stranding the session.
    //
    // This is the whole reason a long session used to brick: Copilot rejects
    // with "Your input exceeds the context window of this model" on a 400, and
    // the client's classifier only consults its "context window" test on a
    // 413 — so that 400 matched no class, produced no canonical error, and no
    // compaction was ever triggered. `/compact` then re-sent the same
    // oversized request and failed identically.
    const overflowClass = classifyOverflow(
      error.response.status,
      errorJson,
      errorText,
    )
    if (overflowClass) {
      const upstream = resolveErrorMessage(errorJson, errorText)
      consola.error(
        `HTTP error (mapped to ${overflowClass}):`,
        errorJson ?? errorText,
      )
      return c.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: buildCapabilityRejectedMessage(overflowClass, upstream),
          },
        },
        400,
      )
    }

    // Remap upstream 401 to 503 — maintain the no-401 invariant on the
    // Anthropic-shape boundary. Claude Code's reactive refresh path
    // (function `SZ1` → `D3(0,true,...)` in v2.1.140 binary) fires on
    // any 401 from upstream and attempts to refresh the OAuth token.
    // Spawned-via-proxy sessions use a synthetic credential
    // (`ensureClaudeConfigMirror`'s SYNTHETIC_CREDENTIAL); refreshing
    // it would fail and degrade the session. Mapping 401 → 503 lets
    // the upstream message still reach the user while side-stepping
    // the refresh path. 503 maps to Anthropic's "overloaded_error"
    // type — semantically reasonable for "proxy got an upstream
    // failure, retry later".
    const responseStatus =
      error.response.status === 401 ? 503 : error.response.status

    // Forward upstream Anthropic-format errors as-is (with remapped status)
    if (isAnthropicError(errorJson)) {
      consola.error("HTTP error:", errorJson)
      return c.json(errorJson, responseStatus as ContentfulStatusCode)
    }

    const message = resolveErrorMessage(errorJson, errorText)
    consola.error("HTTP error:", errorJson ?? errorText)
    return c.json(
      {
        type: "error",
        error: {
          type: resolveErrorType(responseStatus),
          message,
        },
      },
      responseStatus as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      type: "error",
      error: {
        type: "api_error",
        message: error instanceof Error ? error.message : String(error),
      },
    },
    500,
  )
}

function formatTransportDiagnostic(error: TransportExhaustionError): string {
  const code = error.lastError.causeCode ?? error.lastError.code
  const codeText = code ? ` (${sanitizeTransportText(code)})` : ""
  return `${sanitizeTransportText(error.lastError.name)}: ${sanitizeTransportText(error.lastError.message)}${codeText}`
}

// Extracts error message from { message } or { error: { message } } payloads.
function resolveErrorMessage(errorJson: unknown, fallback: string): string {
  if (typeof errorJson !== "object" || errorJson === null) return fallback

  const errorRecord = errorJson as Record<string, unknown>
  if (errorRecord.message !== undefined) return String(errorRecord.message)

  if (typeof errorRecord.error === "object" && errorRecord.error !== null) {
    const nestedRecord = errorRecord.error as Record<string, unknown>
    if (nestedRecord.message !== undefined) return String(nestedRecord.message)
  }

  return fallback
}

/**
 * Check if a parsed JSON body is already in Anthropic error format:
 * { type: "error", error: { type: "...", message: "..." } }
 */
function isAnthropicError(json: unknown): boolean {
  if (typeof json !== "object" || json === null) return false
  const record = json as Record<string, unknown>
  if (record.type !== "error") return false
  if (typeof record.error !== "object" || record.error === null) return false
  const inner = record.error as Record<string, unknown>
  return typeof inner.type === "string" && typeof inner.message === "string"
}

const CONTEXT_OVERFLOW_SUBSTRINGS = [
  "prompt is too long",
  "context_length_exceeded",
  "context length exceeded",
  "input is too long",
  "maximum context length",
  "too many tokens",
  // Copilot's exact wording. Load-bearing: Claude Code's own classifier only
  // consults its "context window" test on a 413, so this phrasing on a 400
  // classifies as NOTHING there and the session strands instead of compacting.
  "exceeds the context window",
]

/** Upstream wording for the `max_tokens_context_overflow` class: the prompt
 *  itself fits, but prompt + requested `max_tokens` does not. A different
 *  client recovery (lower `max_tokens`) than dropping history, so it must not
 *  be collapsed into `prompt_too_long`. */
const MAX_TOKENS_OVERFLOW_SUBSTRING =
  "input length and `max_tokens` exceed context limit"

/**
 * Prefix of Claude Code's gateway capability-rejection contract.
 *
 * A gateway that replaces an upstream 400/413 body hides the wording the
 * client recovers from, so the client accepts a stable token in its place:
 * `capability_rejected: <class>`. Verified in the installed 2.1.247 bundle —
 * `IZ(e) = JBn(e.message) || wd(e.message, "prompt_too_long")`, i.e. the
 * ORIGINAL WORDING or the TOKEN, either one. We emit both: the token is the
 * documented contract, the wording is the older independently-matched path,
 * and neither costs anything. `wd` boundary-checks the character after the
 * class, so whatever follows the token must not match `[A-Za-z0-9_:.-]`.
 */
const CAPABILITY_REJECTED_PREFIX = "capability_rejected: "

/**
 * Build the `error.message` for a classified overflow.
 *
 * A space after the class satisfies the client's right-boundary check; the
 * human-readable tail preserves the upstream detail for a user reading the
 * transcript, and independently satisfies the wording matcher.
 */
export function buildCapabilityRejectedMessage(
  overflowClass: "prompt_too_long" | "max_tokens_context_overflow",
  upstream: string,
): string {
  const wording =
    overflowClass === "prompt_too_long"
      ? "prompt is too long"
      : MAX_TOKENS_OVERFLOW_SUBSTRING
  return `${CAPABILITY_REJECTED_PREFIX}${overflowClass} (${wording}: ${upstream})`
}

/**
 * Which overflow class an upstream rejection belongs to, or undefined when it
 * is not an overflow at all.
 *
 * The `max_tokens` variant is tested FIRST and independently of
 * `isContextOverflow`: it names a different client recovery (lower
 * `max_tokens`, keep the history) than dropping history, so collapsing it into
 * `prompt_too_long` would trigger the wrong one.
 */
export function classifyOverflow(
  status: number,
  errorJson: unknown,
  errorText: string,
): "prompt_too_long" | "max_tokens_context_overflow" | undefined {
  if (status !== 400 && status !== 413) return undefined
  if (overflowHaystack(errorJson, errorText).includes(MAX_TOKENS_OVERFLOW_SUBSTRING)) {
    return "max_tokens_context_overflow"
  }
  return isContextOverflow(status, errorJson, errorText)
    ? "prompt_too_long"
    : undefined
}

function overflowHaystack(errorJson: unknown, errorText: string): string {
  return (
    errorText +
    " " +
    (typeof errorJson === "object" && errorJson !== null
      ? JSON.stringify(errorJson)
      : "")
  ).toLowerCase()
}

/**
 * Detect upstream context-overflow errors so we can remap them to a 400
 * "prompt is too long" shape that triggers Claude Code self-compaction.
 *
 * Always remaps 413 (treated as a hard payload-size signal regardless of
 * body wording). Remaps 400 only when the error text contains one of the
 * known overflow substrings — a regular 400 (e.g. "model not found") must
 * NOT remap.
 */
export function isContextOverflow(
  status: number,
  errorJson: unknown,
  errorText: string,
): boolean {
  if (status === 413) return true
  if (status !== 400) return false

  const haystack = overflowHaystack(errorJson, errorText)

  return CONTEXT_OVERFLOW_SUBSTRINGS.some((s) => haystack.includes(s))
}

/**
 * Map HTTP status to Anthropic error type.
 *
 * Note: a 401 from upstream is remapped to 503 in `forwardError` BEFORE
 * this function is called (no-401 invariant — see comment there). The
 * 401 → "authentication_error" mapping below is preserved for
 * defensive coverage in case any code path calls `resolveErrorType`
 * directly with an unsanitized status.
 */
function resolveErrorType(status: number): string {
  if (status === 400) return "invalid_request_error"
  if (status === 401) return "authentication_error"
  if (status === 403) return "permission_error"
  if (status === 404) return "not_found_error"
  if (status === 429) return "rate_limit_error"
  if (status === 503) return "overloaded_error"
  if (status === 529) return "overloaded_error"
  return "api_error"
}
