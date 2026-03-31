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
