import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export async function forwardError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    const errorText = await error.response.text().catch(() => "")
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = undefined
    }

    // Map upstream context-overflow errors (413, or 400 with a known
    // overflow substring) to Anthropic's "prompt is too long" 400 shape so
    // Claude Code triggers self-compaction instead of bubbling the error.
    // Note: a live probe of an oversized prompt against Copilot returned
    // 200 with stop_reason:"refusal" rather than 413/400 — this guard is
    // defensive for the documented Anthropic contract, not load-bearing.
    if (isContextOverflow(error.response.status, errorJson, errorText)) {
      const upstream = resolveErrorMessage(errorJson, errorText)
      consola.error("HTTP error (mapped to overflow):", errorJson ?? errorText)
      return c.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `prompt is too long: ${upstream}`,
          },
        },
        400,
      )
    }

    // Forward upstream Anthropic-format errors as-is
    if (isAnthropicError(errorJson)) {
      consola.error("HTTP error:", errorJson)
      return c.json(errorJson, error.response.status as ContentfulStatusCode)
    }

    const message = resolveErrorMessage(errorJson, errorText)
    consola.error("HTTP error:", errorJson ?? errorText)
    return c.json(
      {
        type: "error",
        error: {
          type: resolveErrorType(error.response.status),
          message,
        },
      },
      error.response.status as ContentfulStatusCode,
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
]

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

  const haystack = (
    errorText +
    " " +
    (typeof errorJson === "object" && errorJson !== null
      ? JSON.stringify(errorJson)
      : "")
  ).toLowerCase()

  return CONTEXT_OVERFLOW_SUBSTRINGS.some((s) => haystack.includes(s))
}

/**
 * Map HTTP status to Anthropic error type.
 */
function resolveErrorType(status: number): string {
  if (status === 400) return "invalid_request_error"
  if (status === 401) return "authentication_error"
  if (status === 403) return "permission_error"
  if (status === 404) return "not_found_error"
  if (status === 429) return "rate_limit_error"
  if (status === 529) return "overloaded_error"
  return "api_error"
}
