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
    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = undefined
    }
    const message = resolveErrorMessage(errorJson, errorText)
    consola.error("HTTP error:", errorJson ?? errorText)
    return c.json(
      {
        error: {
          message,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: "error",
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
