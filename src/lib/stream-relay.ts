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
 * Detect the family of "controller has already closed" errors that Bun and
 * the WHATWG streams runtime throw when an enqueue/close call races with
 * the consumer cancelling its read. These are NOT upstream failures — they
 * mean the client has finished reading (or disconnected) and we should
 * exit pull() quietly without trying to write more bytes or log noise.
 *
 * Bun's wording: `TypeError: Invalid state: Controller is already closed`.
 * Other runtimes use `TypeError: The stream is closing` or
 * `TypeError: This ReadableStream is closed` or include "errored" / "cancelled".
 */
export function isControllerClosedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return (
    msg.includes("controller is already closed")
    || msg.includes("controller is already errored")
    || msg.includes("readablestream is closed")
    || msg.includes("readablestream is already closed")
    || msg.includes("stream is closing")
    || msg.includes("stream is already closed")
    || msg.includes("stream is closed")
  )
}

/**
 * Wrap an upstream SSE byte stream so that:
 *   - Backpressure is respected (pull-based; only reads when downstream demands).
 *   - Mid-stream errors (undici "terminated", AbortError, network resets) are
 *     caught, logged with structured context, and converted to a final
 *     Anthropic-shape `event: error` SSE event before the downstream is closed.
 *   - Upstream inactivity (no chunk for `inactivityTimeoutMs`) is treated as a
 *     soft failure that emits an error event rather than hanging forever.
 *   - Consumer cancellation (client disconnects mid-read or finishes early)
 *     is recognized and handled silently — NOT logged as an upstream error,
 *     NOT followed by a futile event:error write that can corrupt the
 *     terminal bytes the client has already buffered.
 *
 * Pre-byte upstream errors (failure on the very first read) are handled by
 * the same code path: an `event: error` SSE event is emitted on a 200
 * response, then the connection is closed. Even if the consumer's SDK
 * silently swallows `event: error`, the immediate close triggers the
 * client's socket-disconnect handler — the user always sees an error
 * string, never a hang.
 */
export function relayAnthropicStream(
  body: ReadableStream<Uint8Array>,
  opts: RelayOptions,
): ReadableStream<Uint8Array> {
  const inactivityMs = opts.inactivityTimeoutMs ?? UPSTREAM_INACTIVITY_TIMEOUT_MS
  const reader = body.getReader() as unknown as ByteReader
  let bytesRelayed = 0
  let upstreamFinished = false
  let consumerCancelled = false

  const safeClose = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    try {
      controller.close()
    } catch {
      // already closed / errored — fine
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (consumerCancelled || upstreamFinished) {
        safeClose(controller)
        return
      }

      try {
        const result = await readWithInactivityTimeout(reader, inactivityMs)
        if (consumerCancelled) {
          // Consumer cancelled while we were awaiting upstream — drop the
          // value (if any) and exit silently. The cancel() callback has
          // already propagated cancellation upstream.
          safeClose(controller)
          return
        }
        if (result.done) {
          // Zero-byte close is rare and usually indicates upstream
          // misbehavior (200 + SSE headers + immediate FIN). Surface it
          // in the error log so the operator can correlate; the consumer
          // sees a clean empty stream.
          if (bytesRelayed === 0) {
            consola.warn(
              `Upstream returned empty SSE stream at ${opts.routePath}`,
            )
          }
          upstreamFinished = true
          safeClose(controller)
          return
        }
        if (result.value) {
          bytesRelayed += result.value.byteLength
          try {
            controller.enqueue(result.value)
          } catch (enqueueError) {
            if (isControllerClosedError(enqueueError)) {
              // Consumer raced ahead of us: it closed the stream between
              // our last await and this enqueue. Treat as a normal end of
              // stream — upstream chunks past this point are dropped, but
              // that's expected behavior on consumer cancel.
              consumerCancelled = true
              return
            }
            throw enqueueError
          }
        }
      } catch (error) {
        upstreamFinished = true
        if (consumerCancelled) {
          // Consumer cancelled mid-stream — the cancel() callback already
          // ran (or our inner enqueue-catch flipped the flag). Close the
          // downstream so the consumer's read settles, and release the
          // upstream reader if not already done.
          //
          // We deliberately do NOT call isControllerClosedError(error) on
          // upstream/reader failures here — that helper matches substrings
          // like "stream is closed" which can legitimately appear in real
          // undici upstream errors (e.g., body stream closed by the
          // server), and treating them as consumer-cancel would silently
          // suppress an `event: error` frame the consumer needs.
          reader.cancel(error).catch(() => {
            // upstream may already be closed
          })
          safeClose(controller)
          return
        }
        const errName = error instanceof Error ? error.name : "Error"
        const errMessage = error instanceof Error ? error.message : String(error)
        consola.error(
          `Upstream stream interrupted at ${opts.routePath}: bytes=${bytesRelayed} errType=${errName} message=${JSON.stringify(errMessage)}`,
        )
        const event = buildAnthropicErrorEvent(errName, errMessage)
        try {
          controller.enqueue(ENCODER.encode(event))
        } catch (enqueueError) {
          if (!isControllerClosedError(enqueueError)) {
            consola.warn(
              `Could not deliver error event to consumer at ${opts.routePath}: ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)}`,
            )
          }
          // Consumer-closed: silent
        }
        // Release the upstream socket. We've decided this stream is over —
        // the consumer's `cancel()` callback will NOT fire because we're
        // closing from our side, so without this the upstream fetch body
        // and TCP connection stay alive until the upstream times out.
        reader.cancel(error).catch(() => {
          // upstream may already be closed
        })
        safeClose(controller)
      }
    },
    cancel(reason) {
      consumerCancelled = true
      upstreamFinished = true
      reader.cancel(reason).catch(() => {
        // upstream may already be closed
      })
    },
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
  // Attach a noop catcher so that, when reader.read() wins the race and
  // the timer happens to fire on the same tick anyway, the rejection is
  // already handled. Without this, Node 24's default
  // --unhandled-rejections=throw terminates the process under sustained
  // load (every chunk creates a fresh setTimeout/timeoutPromise pair).
  timeoutPromise.catch(() => {})
  try {
    return await Promise.race([reader.read(), timeoutPromise])
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

/**
 * Race an `AsyncIterableIterator.next()` call against an inactivity timeout.
 *
 * Follows the same pattern as `readWithInactivityTimeout` (including the
 * noop catcher to avoid Node 24 unhandled-rejection crashes) but works
 * with typed iterators that yield parsed objects rather than raw bytes.
 *
 * On timeout, throws an `InactivityTimeout` error (same classification as
 * the byte-reader variant — surfaced to the consumer as `timeout_error` via
 * `buildOpenAIErrorEvent`).
 *
 * @param iterator - An AsyncIterableIterator whose `.next()` we want to race.
 * @param timeoutMs - Milliseconds before the timeout fires.
 */
export async function readIteratorWithTimeout<T>(
  iterator: AsyncIterableIterator<T>,
  timeoutMs: number,
): Promise<IteratorResult<T>> {
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
  // Same noop-catcher pattern: prevents unhandled-rejection crashes when the
  // iterator wins the race on the same tick the timer fires.
  timeoutPromise.catch(() => {})
  try {
    return await Promise.race([iterator.next(), timeoutPromise])
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
  // Use only documented Anthropic error types
  // (https://platform.claude.com/docs/en/api/errors). `timeout_error` is
  // the documented type for client-side / inactivity aborts; it survives
  // the SDK's discriminated-union parsing without falling into a default
  // branch that some consumers don't handle.
  if (errName === "AbortError") return "timeout_error"
  if (errName === "InactivityTimeout") return "timeout_error"
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
