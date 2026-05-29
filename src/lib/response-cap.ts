import consola from "consola"

import { parseJsonOrDiagnose } from "~/lib/diagnose-response"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>

/**
 * Hard byte cap for non-streaming upstream response bodies.
 *
 * Anthropic responses with large tool_use blocks can legitimately reach
 * several MB, but a multi-GB body is either a buggy upstream or a malicious
 * one. Buffering it would OOM the proxy and crash all in-flight requests.
 *
 * Applies to /v1/messages, /v1/chat/completions, and /v1/responses.
 */
export const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024 // 10 MiB

/**
 * Read a Response body with a hard byte cap, then parse as JSON.
 *
 * Falls back to the fast path (response.json()) when Content-Length is
 * present and within the cap, avoiding the streaming-reader overhead for
 * the vast majority of normal responses.
 *
 * When the cap is hit:
 *   - the reader is cancelled to release the upstream socket
 *   - a structured Anthropic-format error is returned to the caller
 *     (the caller wraps it in c.json(), not throws — the client gets a
 *     clean 413 error, not an unhandled-rejection crash)
 *
 * Returns `{ ok: true, value }` on success or `{ ok: false, errorResponse, status }`
 * on cap exceeded.
 */
export async function readResponseBodyCapped<T>(
  response: Response,
  routePath: string,
  capBytes: number = MAX_RESPONSE_BODY_BYTES,
): Promise<{ ok: true; value: T } | { ok: false; errorResponse: AnyRecord; status: number }> {
  // Fast path: trust a Content-Length header if it's within cap.
  const contentLengthHeader = response.headers.get("content-length")
  const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : NaN
  if (!isNaN(contentLength) && contentLength <= capBytes) {
    const value = await parseJsonOrDiagnose<T>(response, routePath)
    return { ok: true, value }
  }

  // Slow path: stream-read with byte counting.
  const reader = response.body?.getReader()
  if (!reader) {
    // Empty body — let parseJsonOrDiagnose handle the diagnostic.
    const value = await parseJsonOrDiagnose<T>(response, routePath)
    return { ok: true, value }
  }

  const chunks: Array<Uint8Array> = []
  let totalBytes = 0
  let capped = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      totalBytes += value.byteLength
      if (totalBytes > capBytes) {
        capped = true
        // Drain to release the socket — cancel signals the upstream to stop.
        try {
          await reader.cancel("size_cap")
        } catch {
          /* best-effort */
        }
        break
      }
      chunks.push(value)
    }
  } catch (err) {
    // Read error after cap cancel is expected; anything else is unusual.
    if (!capped) {
      consola.warn(`readResponseBodyCapped: read error at ${routePath}:`, err)
    }
  }

  if (capped) {
    consola.warn(
      `Non-streaming upstream response at ${routePath} exceeded ${capBytes} bytes (10 MiB cap); `
      + `dropping body to prevent OOM. Check upstream health.`,
    )
    return {
      ok: false,
      status: 502,
      errorResponse: {
        type: "error",
        error: {
          type: "api_error",
          message:
            `Upstream response body exceeded the 10 MiB size cap for non-streaming `
            + `${routePath}. The upstream may be misbehaving. Try enabling streaming `
            + `(stream: true) which handles large responses chunk-by-chunk.`,
        },
      },
    }
  }

  // All bytes read within cap — concatenate and parse.
  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(merged)
  try {
    return { ok: true, value: JSON.parse(text) as T }
  } catch (err) {
    const preview = text.slice(0, 200)
    const contentType = response.headers.get("content-type") ?? "(none)"
    consola.error(
      `Upstream JSON parse failed at ${routePath}: status=${response.status} `
      + `content-type="${contentType}" body[0..200]=${JSON.stringify(preview)}`,
    )
    throw err
  }
}
