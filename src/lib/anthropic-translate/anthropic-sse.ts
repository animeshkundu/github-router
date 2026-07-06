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
 */
export function anthropicSseStreamFromEvents(
  events: AsyncGenerator<AnthropicStreamEvent>,
  opts: { routePath: string; onCancel?: () => void },
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let consumerCancelled = false
  let finished = false

  const safeClose = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    try {
      controller.close()
    } catch {
      // already closed / errored — fine
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (consumerCancelled || finished) {
        safeClose(controller)
        return
      }

      let res: IteratorResult<AnthropicStreamEvent>
      try {
        res = await events.next()
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
      opts.onCancel?.()
      // Drive the generator's finally so it tears down the upstream reader.
      void events.return?.(undefined as never)
    },
  })
}
