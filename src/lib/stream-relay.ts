import consola from "consola"

import { UPSTREAM_INACTIVITY_TIMEOUT_MS } from "~/lib/port"

const ENCODER = new TextEncoder()

// Structural reader type so this helper accepts both DOM-style
// (`ReadableStreamDefaultReader<Uint8Array>`) and Node-style
// (`node:stream/web` reader) without type-incompatibility friction.
interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  cancel(reason?: unknown): Promise<void>
  releaseLock(): void
}

interface RelayOptions {
  routePath: string
  /**
   * Inactivity bound for individual upstream reads, in ms. Defaults to the
   * UPSTREAM_INACTIVITY_TIMEOUT_MS env-overridable constant in `~/lib/port`.
   * Tests can pass a small value (e.g. 50ms) to exercise the timeout path
   * without wall-clock waits.
   */
  inactivityTimeoutMs?: number
}

/**
 * Wrap an upstream SSE byte stream so that:
 *   - Backpressure is respected (pull-based; only reads when downstream demands).
 *   - Mid-stream errors (undici "terminated", AbortError, network resets) are
 *     caught, logged with structured context, and converted to a final
 *     Anthropic-shape `event: error` SSE event before the downstream is closed.
 *   - Upstream inactivity (no chunk for `inactivityTimeoutMs`) is treated as a
 *     soft failure that emits an error event rather than hanging forever.
 *
 * The caller MUST have already peeked the first chunk from the upstream
 * (see `peekAndRelay`) so that pre-byte failures can be surfaced as a clean
 * JSON 502 via `forwardError` instead of being squeezed into an SSE event
 * prefix that violates Anthropic's stream state machine.
 *
 * Pass the already-acquired `reader` (not the upstream `Response.body`) so
 * this helper doesn't try to re-acquire a lock the caller already holds.
 */
export function relayAnthropicStream(
  reader: ByteReader,
  firstChunk: Uint8Array,
  opts: RelayOptions,
): ReadableStream<Uint8Array> {
  const inactivityMs = opts.inactivityTimeoutMs ?? UPSTREAM_INACTIVITY_TIMEOUT_MS
  let bytesRelayed = 0
  let firstChunkSent = false
  let upstreamFinished = false

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!firstChunkSent) {
        firstChunkSent = true
        bytesRelayed += firstChunk.byteLength
        controller.enqueue(firstChunk)
        return
      }
      if (upstreamFinished) {
        controller.close()
        return
      }

      try {
        const result = await readWithInactivityTimeout(reader, inactivityMs)
        if (result.done) {
          upstreamFinished = true
          controller.close()
          return
        }
        if (result.value) {
          bytesRelayed += result.value.byteLength
          controller.enqueue(result.value)
        }
      } catch (error) {
        upstreamFinished = true
        const errName = error instanceof Error ? error.name : "Error"
        const errMessage = error instanceof Error ? error.message : String(error)
        consola.error(
          `Upstream stream interrupted at ${opts.routePath}: bytes=${bytesRelayed} errType=${errName} message=${JSON.stringify(errMessage)}`,
        )
        const event = buildAnthropicErrorEvent(errName, errMessage)
        try {
          controller.enqueue(ENCODER.encode(event))
        } catch {
          consola.warn(
            `Could not deliver error event to consumer at ${opts.routePath}: already cancelled`,
          )
        }
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
    },
    cancel(reason) {
      upstreamFinished = true
      reader.cancel(reason).catch(() => {
        // upstream may already be closed
      })
    },
  })
}

/**
 * Peek the first chunk of an upstream SSE response, then return a wrapped
 * ReadableStream that re-prepends that chunk and continues with the regular
 * relay. If the very first read fails, the error propagates — callers must
 * catch and route through `forwardError`, which converts the failure into a
 * proper JSON error response (status not yet committed). This is what
 * replaces the unsafe synthetic-`message_start` prefix approach.
 */
export async function peekAndRelay(
  body: ReadableStream<Uint8Array>,
  routePath: string,
  inactivityTimeoutMs?: number,
): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader() as unknown as ByteReader
  let firstChunk: Uint8Array
  try {
    const result = await readWithInactivityTimeout(
      reader,
      inactivityTimeoutMs ?? UPSTREAM_INACTIVITY_TIMEOUT_MS,
    )
    if (result.done || !result.value) {
      reader.releaseLock()
      throw new Error(`Upstream returned an empty SSE stream at ${routePath}`)
    }
    firstChunk = result.value
  } catch (error) {
    try {
      reader.releaseLock()
    } catch {
      // already released
    }
    throw error
  }
  return relayAnthropicStream(reader, firstChunk, {
    routePath,
    inactivityTimeoutMs,
  })
}

async function readWithInactivityTimeout(
  reader: ByteReader,
  timeoutMs: number,
): Promise<{ done: boolean; value?: Uint8Array }> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        Object.assign(new Error("upstream_inactive"), {
          name: "InactivityTimeout",
        }),
      )
    }, timeoutMs)
  })
  try {
    return await Promise.race([reader.read(), timeoutPromise])
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

/**
 * Build the SSE wire bytes for an Anthropic-format streaming error event.
 * Per Anthropic streaming spec, errors are sent as:
 *   event: error
 *   data: {"type":"error","error":{"type":"...","message":"..."}}
 */
export function buildAnthropicErrorEvent(
  errName: string,
  errMessage: string,
): string {
  const payload = {
    type: "error",
    error: {
      type: classifyStreamError(errName),
      message: `Upstream stream interrupted: ${errName}: ${errMessage}`,
    },
  }
  return `event: error\ndata: ${JSON.stringify(payload)}\n\n`
}

/**
 * Build the SSE wire bytes for an OpenAI-format streaming error event,
 * followed by the `data: [DONE]` terminator that OpenAI clients expect.
 */
export function buildOpenAIErrorEvent(
  errName: string,
  errMessage: string,
): string {
  const payload = {
    error: {
      type: classifyStreamError(errName),
      message: `Upstream stream interrupted: ${errName}: ${errMessage}`,
    },
  }
  return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`
}

function classifyStreamError(errName: string): string {
  if (errName === "AbortError") return "request_canceled"
  if (errName === "InactivityTimeout") return "request_canceled"
  return "api_error"
}

export function logStreamError(
  routePath: string,
  error: unknown,
): { errName: string; errMessage: string } {
  const errName = error instanceof Error ? error.name : "Error"
  const errMessage = error instanceof Error ? error.message : String(error)
  consola.error(
    `Upstream stream interrupted at ${routePath}: errType=${errName} message=${JSON.stringify(errMessage)}`,
  )
  return { errName, errMessage }
}
