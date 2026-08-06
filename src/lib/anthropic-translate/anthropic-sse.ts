/**
 * Anthropic Messages SSE egress: frame builders + a Bun-safe ReadableStream
 * adapter that serializes a generator of Anthropic stream events to wire bytes.
 *
 * The synthesizer (see `responses-egress.ts`) is source-specific and yields
 * plain event objects; these builders + adapter own the Anthropic wire shape
 * and the stream lifecycle so the synthesizer stays a pure state machine.
 *
 * Stream-lifecycle contract (repo mandate for any synthesized SSE surface):
 * the adapter is pull-based (backpressure-respecting), guards every
 * `controller.enqueue`/`close` against the consumer-cancel race
 * (`isControllerClosedError`), and on a mid-stream upstream error emits a
 * terminal Anthropic `event: error` frame before closing — mirroring
 * `relayAnthropicStream`. Verified against Bun's
 * `TypeError: Invalid state: Controller is already closed`.
 */

import { randomUUID } from "node:crypto"

import consola from "consola"

import { buildAnthropicErrorEvent, isControllerClosedError } from "~/lib/stream-relay"

export interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** A synthesized Anthropic SSE event (serialized verbatim to the wire). */
export type AnthropicStreamEvent = Record<string, unknown> & { type: string }

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }

export function makeMessageId(): string {
  return `msg_${randomUUID().replace(/-/g, "")}`
}

export function makeMessageStart(
  id: string,
  model: string,
  usage: AnthropicUsage = {},
): AnthropicStreamEvent {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      },
    },
  }
}

export function makeContentBlockStart(
  index: number,
  block: AnthropicContentBlock,
): AnthropicStreamEvent {
  return { type: "content_block_start", index, content_block: block }
}

export function makeTextDelta(index: number, text: string): AnthropicStreamEvent {
  return { type: "content_block_delta", index, delta: { type: "text_delta", text } }
}

export function makeInputJsonDelta(
  index: number,
  partialJson: string,
): AnthropicStreamEvent {
  return {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  }
}

export function makeThinkingDelta(
  index: number,
  thinking: string,
): AnthropicStreamEvent {
  return {
    type: "content_block_delta",
    index,
    delta: { type: "thinking_delta", thinking },
  }
}

export function makeSignatureDelta(
  index: number,
  signature: string,
): AnthropicStreamEvent {
  return {
    type: "content_block_delta",
    index,
    delta: { type: "signature_delta", signature },
  }
}

export function makeContentBlockStop(index: number): AnthropicStreamEvent {
  return { type: "content_block_stop", index }
}

export function makeMessageDelta(
  stopReason: string,
  stopSequence: string | null,
  usage: AnthropicUsage,
): AnthropicStreamEvent {
  return {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: stopSequence },
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    },
  }
}

export function makeMessageStop(): AnthropicStreamEvent {
  return { type: "message_stop" }
}

/** Serialize one event to the Anthropic SSE wire form (`event:` + `data:`). */
export function serializeAnthropicEvent(ev: AnthropicStreamEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

/**
 * Wrap a generator of Anthropic stream events into a byte `ReadableStream`.
 * Pull-based; guards the consumer-cancel race on both `enqueue` and `close`;
 * converts a mid-stream generator throw into a terminal `event: error` frame.
 * On consumer cancel it invokes `onCancel` (abort the upstream fetch) and
 * `return()`s the generator so its `finally` tears down the upstream reader.
 *
 * `inactivityTimeoutMs` bounds how long a single `events.next()` may stall.
 * Without it a Copilot upstream that holds the socket open but stops emitting
 * hangs the caller FOREVER: `UPSTREAM_FETCH_TIMEOUT_MS` defaults to 0 (see
 * `~/lib/port`), so inactivity detection is the only stall defense, and every
 * sibling streaming path already has it (`readIteratorWithTimeout`). The clock
 * is per-read, NOT an absolute budget — a long-reasoning model legitimately
 * streams for many minutes, and only a gap between events is a stall.
 *
 * Three properties this must preserve, each pinned by a test in
 * `tests/anthropic-translate-inactivity.test.ts`:
 *
 *   - NO LEAK: on timeout we take the SAME teardown path as consumer cancel
 *     (`onCancel` aborts the upstream fetch, `events.return()` drives the
 *     generator's `finally`). Timing out without that leaves the fetch alive
 *     for the life of the process.
 *   - NO CRASH: the abandoned `events.next()` promise keeps running. If the
 *     upstream later errors, that rejection has no handler and would kill the
 *     process under Node's `--unhandled-rejections=throw`, so it is swallowed
 *     explicitly. (Same reasoning as the noop `.catch` in `stream-relay.ts`.)
 *   - NO TRUNCATION: a stream that keeps producing inside the deadline is
 *     never cut short, however long it runs in total.
 */
export function anthropicSseStreamFromEvents(
  events: AsyncGenerator<AnthropicStreamEvent>,
  opts: {
    routePath: string
    onCancel?: () => void
    inactivityTimeoutMs?: number
  },
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let consumerCancelled = false
  let finished = false

  /** Sentinel identity — never a legitimate iterator result. */
  const STALLED = Symbol("stalled")

  /**
   * `events.next()` bounded by an inactivity deadline. Resolves to `STALLED`
   * rather than throwing so the caller can distinguish a stall (terminate with
   * a stall-specific message) from a genuine upstream error.
   */
  const nextWithTimeout = async (
    timeoutMs: number,
  ): Promise<IteratorResult<AnthropicStreamEvent> | typeof STALLED> => {
    const pending = events.next()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        pending,
        new Promise<typeof STALLED>((resolve) => {
          timer = setTimeout(() => resolve(STALLED), timeoutMs)
          // Never hold the event loop open on account of the deadline.
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      // If the timeout won, `pending` is still in flight. A later rejection
      // would be unhandled and terminate the process — attach a sink now.
      // Harmless when `pending` already settled.
      void pending.catch(() => undefined)
    }
  }

  const safeClose = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    try {
      controller.close()
    } catch {
      // already closed / errored — fine
    }
  }

  /**
   * Tear down the upstream, exactly once, on a PREMATURE end of stream.
   *
   * Called from the three places a stream can end early — the stall branch,
   * the error branch, and consumer `cancel()` — because all three leave the
   * upstream fetch running and the generator suspended. Both halves matter:
   * `onCancel` aborts the fetch, and `return()` drives the generator's
   * `finally`; `return()` alone cannot release a generator parked on a
   * never-settling await, since it queues behind that await.
   *
   * Two things this is deliberately NOT:
   *
   *   - **Not a `finally` around `pull`.** `pull` re-enters per chunk, so a
   *     `finally` there would fire on every successful chunk.
   *   - **Not called on normal completion** (`res.done`). Aborting an
   *     AbortController whose fetch has already completed DESTROYS the socket
   *     instead of returning it to the keep-alive pool, so every successful
   *     turn would pay a fresh TLS handshake. Premature-only is the whole
   *     correctness condition, and `tornDown` only makes it idempotent — it
   *     does not make an unconditional call safe.
   */
  let tornDown = false
  const teardownUpstream = (): void => {
    if (tornDown) return
    tornDown = true
    opts.onCancel?.()
    // `.catch` is load-bearing: `onCancel` just aborted the upstream fetch, so
    // the generator's pending read rejects and its `finally` can rethrow. An
    // unhandled rejection would kill the process under Node's
    // `--unhandled-rejections=throw`.
    void events.return?.(undefined as never)?.catch?.(() => undefined)
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (consumerCancelled || finished) {
        safeClose(controller)
        return
      }

      let res: IteratorResult<AnthropicStreamEvent>
      try {
        const timeoutMs = opts.inactivityTimeoutMs
        const settled =
          timeoutMs !== undefined && timeoutMs > 0
            ? await nextWithTimeout(timeoutMs)
            : await events.next()

        if (settled === STALLED) {
          finished = true
          if (consumerCancelled) {
            safeClose(controller)
            return
          }
          const message = `Upstream stalled: no stream activity for ${timeoutMs}ms`
          consola.error(
            `Anthropic-translate stream inactivity timeout at ${opts.routePath}: ${message}`,
          )
          // Same teardown as consumer cancel: abort the upstream fetch and
          // drive the generator's finally. Skipping this leaks the fetch.
          teardownUpstream()
          try {
            controller.enqueue(
              enc.encode(buildAnthropicErrorEvent("timeout_error", message)),
            )
          } catch (enqueueError) {
            if (!isControllerClosedError(enqueueError)) {
              consola.warn(
                `Could not deliver error event to consumer at ${opts.routePath}: ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)}`,
              )
            }
          }
          safeClose(controller)
          return
        }
        res = settled
      } catch (err) {
        finished = true
        if (consumerCancelled) {
          safeClose(controller)
          return
        }
        const name = err instanceof Error ? err.name : "Error"
        const message = err instanceof Error ? err.message : String(err)
        consola.error(
          `Anthropic-translate stream interrupted at ${opts.routePath}: ${name}: ${JSON.stringify(message)}`,
        )
        // Same teardown as the stall branch above. This branch used to do
        // NEITHER half, so a translation/serialization throw — anything other
        // than the upstream socket already being dead — left the Copilot fetch
        // running. `UPSTREAM_FETCH_TIMEOUT_MS` defaults to 0 (disabled by
        // design), so nothing else would ever have reclaimed it.
        teardownUpstream()
        try {
          controller.enqueue(enc.encode(buildAnthropicErrorEvent(name, message)))
        } catch (enqueueError) {
          if (!isControllerClosedError(enqueueError)) {
            consola.warn(
              `Could not deliver error event to consumer at ${opts.routePath}: ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)}`,
            )
          }
        }
        safeClose(controller)
        return
      }

      // Consumer may have cancelled while we awaited the generator.
      if (consumerCancelled) {
        safeClose(controller)
        return
      }
      if (res.done) {
        finished = true
        safeClose(controller)
        return
      }

      try {
        controller.enqueue(enc.encode(serializeAnthropicEvent(res.value)))
      } catch (err) {
        if (isControllerClosedError(err)) {
          // Consumer raced ahead and closed the stream — stop quietly.
          consumerCancelled = true
          return
        }
        throw err
      }
    },
    cancel() {
      consumerCancelled = true
      finished = true
      // Consumer cancel is a premature end like the stall and error branches,
      // so it takes the same teardown. Routing all three through one closure
      // means a future branch cannot silently omit half of it — which is
      // exactly how the error branch came to leak.
      teardownUpstream()
    },
  })
}
