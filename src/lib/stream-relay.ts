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

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
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
