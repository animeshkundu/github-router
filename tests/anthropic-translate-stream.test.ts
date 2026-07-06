// Streaming synthesizer tests: /responses SSE → Anthropic SSE event sequence.
// Drives the pure generator (collect yielded events) plus one happy-path pass
// through the byte-stream adapter.

import { expect, test, describe } from "bun:test"

import {
  anthropicSseStreamFromEvents,
  type AnthropicStreamEvent,
} from "~/lib/anthropic-translate/anthropic-sse"
import { synthAnthropicFromResponses } from "~/lib/anthropic-translate/responses-egress"

const MODEL_ID = "gpt-5.5"

async function* upstreamFrom(events: Array<object>): AsyncGenerator<{ data?: string }> {
  for (const e of events) yield { data: JSON.stringify(e) }
}

async function collect(events: Array<object>): Promise<Array<AnthropicStreamEvent>> {
  const out: Array<AnthropicStreamEvent> = []
  for await (const ev of synthAnthropicFromResponses(upstreamFrom(events), {
    modelId: MODEL_ID,
    messageId: "msg_test",
  })) {
    out.push(ev)
  }
  return out
}

const types = (evs: Array<AnthropicStreamEvent>) => evs.map((e) => e.type)

describe("synthAnthropicFromResponses — sequence", () => {
  test("text-only turn: message_start → block start/delta*/stop → message_delta → message_stop", async () => {
    const evs = await collect([
      { type: "response.created", response: { status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m0" } },
      { type: "response.output_text.delta", output_index: 0, item_id: "a", delta: "Hel" },
      { type: "response.output_text.delta", output_index: 0, item_id: "b", delta: "lo" },
      { type: "response.output_text.done", output_index: 0, text: "Hello" },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 2 } } },
    ])

    expect(types(evs)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])

    const start = evs[0].message as Record<string, unknown>
    expect(start.id).toBe("msg_test")
    expect(start.role).toBe("assistant")
    expect(start.type).toBe("message")
    expect(start.model).toBe(MODEL_ID)
    expect(start.content).toEqual([])
    expect(start.stop_reason).toBeNull()

    expect(evs[1].content_block).toEqual({ type: "text", text: "" })
    expect((evs[2].delta as Record<string, unknown>)).toEqual({ type: "text_delta", text: "Hel" })
    expect((evs[3].delta as Record<string, unknown>)).toEqual({ type: "text_delta", text: "lo" })
    expect(evs[1].index).toBe(0)
    expect(evs[4].index).toBe(0)

    const delta = evs[5]
    expect((delta.delta as Record<string, unknown>).stop_reason).toBe("end_turn")
    expect((delta.delta as Record<string, unknown>).stop_sequence).toBeNull()
    expect((delta.usage as Record<string, unknown>).output_tokens).toBe(2)
    expect((delta.usage as Record<string, unknown>).input_tokens).toBe(5)
  })

  test("two parallel tool calls: distinct block indices, authoritative args, keyed by output_index (not re-encrypted item_id)", async () => {
    const evs = await collect([
      // reasoning prologue with NO summary text → no thinking block
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "r0" } },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "r0" } },
      // tool 1 — streamed arg deltas carry DIFFERENT (re-encrypted) item_ids
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc1", call_id: "call_1", name: "toolA" } },
      { type: "response.function_call_arguments.delta", output_index: 1, item_id: "reenc_1", delta: '{"a"' },
      { type: "response.function_call_arguments.delta", output_index: 1, item_id: "reenc_2", delta: ":1}" },
      { type: "response.function_call_arguments.done", output_index: 1, item_id: "reenc_3", arguments: '{"a":1}' },
      { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc1", call_id: "call_1", name: "toolA", arguments: '{"a":1}' } },
      // tool 2
      { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc2", call_id: "call_2", name: "toolB" } },
      { type: "response.function_call_arguments.delta", output_index: 2, item_id: "reenc_4", delta: '{"b":2}' },
      { type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "fc2", call_id: "call_2", name: "toolB", arguments: '{"b":2}' } },
      { type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 6 } } },
    ])

    expect(types(evs)).toEqual([
      "message_start",
      "content_block_start", // tool 1 @ index 0
      "content_block_delta", // authoritative args (one input_json_delta)
      "content_block_stop", // tool 1
      "content_block_start", // tool 2 @ index 1
      "content_block_delta", // authoritative args
      "content_block_stop", // tool 2
      "message_delta",
      "message_stop",
    ])

    expect(evs[1].content_block).toEqual({ type: "tool_use", id: "call_1", name: "toolA", input: {} })
    expect(evs[1].index).toBe(0)
    expect((evs[2].delta as Record<string, unknown>)).toEqual({ type: "input_json_delta", partial_json: '{"a":1}' })

    expect(evs[4].content_block).toEqual({ type: "tool_use", id: "call_2", name: "toolB", input: {} })
    expect(evs[4].index).toBe(1)
    expect((evs[5].delta as Record<string, unknown>)).toEqual({ type: "input_json_delta", partial_json: '{"b":2}' })

    expect((evs[7].delta as Record<string, unknown>).stop_reason).toBe("tool_use")
  })

  test("tool args assemble from streamed deltas when no .done/output_item args are provided", async () => {
    const evs = await collect([
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "f", call_id: "c", name: "t" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"x"' },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: ":5}" },
      // output_item.done WITHOUT an authoritative arguments field → keep the
      // assembled deltas
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "f", call_id: "c", name: "t" } },
      { type: "response.completed", response: { usage: {} } },
    ])
    const deltas = evs.filter(
      (e) => e.type === "content_block_delta"
        && (e.delta as Record<string, unknown>).type === "input_json_delta",
    )
    expect(deltas.length).toBe(1)
    expect((deltas[0].delta as Record<string, unknown>).partial_json).toBe('{"x":5}')
  })

  test("no-delta tool args: authoritative .done args emitted once as input_json_delta", async () => {
    const evs = await collect([
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "f", call_id: "c", name: "t" } },
      { type: "response.function_call_arguments.done", output_index: 0, arguments: '{"z":9}' },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "f", call_id: "c", name: "t", arguments: '{"z":9}' } },
      { type: "response.completed", response: { usage: {} } },
    ])
    const deltas = evs.filter(
      (e) => e.type === "content_block_delta"
        && (e.delta as Record<string, unknown>).type === "input_json_delta",
    )
    expect(deltas.length).toBe(1)
    expect((deltas[0].delta as Record<string, unknown>).partial_json).toBe('{"z":9}')
  })

  test("multiple, sequential thinking blocks each get their own index", async () => {
    const evs = await collect([
      { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "first " },
      { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "thought" },
      { type: "response.reasoning_summary_text.done", output_index: 0 },
      { type: "response.output_text.delta", output_index: 1, delta: "answer" },
      { type: "response.output_text.done", output_index: 1, text: "answer" },
      { type: "response.reasoning_summary_text.delta", output_index: 2, delta: "second" },
      { type: "response.reasoning_summary_text.done", output_index: 2 },
      { type: "response.completed", response: { usage: {} } },
    ])

    expect(types(evs)).toEqual([
      "message_start",
      "content_block_start", // thinking @ 0
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start", // text @ 1
      "content_block_delta",
      "content_block_stop",
      "content_block_start", // thinking @ 2
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(evs[1].content_block).toEqual({ type: "thinking", thinking: "" })
    expect(evs[1].index).toBe(0)
    expect((evs[2].delta as Record<string, unknown>)).toEqual({ type: "thinking_delta", thinking: "first " })
    expect(evs[8].content_block).toEqual({ type: "thinking", thinking: "" })
    expect(evs[8].index).toBe(2)
  })

  test("interleave text → tool → text: prior block is closed before the next opens", async () => {
    const evs = await collect([
      { type: "response.output_text.delta", output_index: 0, delta: "a" },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "f", call_id: "c", name: "t" } },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: "{}" },
      { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "f", call_id: "c", name: "t", arguments: "{}" } },
      { type: "response.output_text.delta", output_index: 2, delta: "b" },
      { type: "response.output_text.done", output_index: 2, text: "b" },
      { type: "response.completed", response: { usage: {} } },
    ])
    expect(types(evs)).toEqual([
      "message_start",
      "content_block_start", // text @ 0
      "content_block_delta",
      "content_block_stop", // text 0 closed on tool open
      "content_block_start", // tool @ 1
      "content_block_delta",
      "content_block_stop", // tool 1 closed at output_item.done
      "content_block_start", // text @ 2 (fresh index — not a reopened block)
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    // indices: text=0, tool=1, text=2 (monotonic, never reused)
    expect(evs[1].index).toBe(0)
    expect(evs[4].index).toBe(1)
    expect(evs[7].index).toBe(2)
  })

  test("usage is not clobbered by a later zeroed usage event", async () => {
    const evs = await collect([
      { type: "response.output_text.delta", output_index: 0, delta: "x" },
      { type: "response.output_text.done", output_index: 0, text: "x" },
      { type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 7, input_tokens_details: { cached_tokens: 4 } } } },
      // a stray later terminal frame carrying zeros must not overwrite
      { type: "response.completed", response: { usage: { input_tokens: 0, output_tokens: 0 } } },
    ])
    const delta = evs.find((e) => e.type === "message_delta")!
    expect((delta.usage as Record<string, unknown>).input_tokens).toBe(20)
    expect((delta.usage as Record<string, unknown>).output_tokens).toBe(7)
    expect((delta.usage as Record<string, unknown>).cache_read_input_tokens).toBe(4)
  })

  test("response.failed makes the generator throw (surfaces as a terminal error)", async () => {
    const run = async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of synthAnthropicFromResponses(
        upstreamFrom([
          { type: "response.output_text.delta", output_index: 0, delta: "x" },
          { type: "response.failed", response: { error: { message: "boom" } } },
        ]),
        { modelId: MODEL_ID },
      )) {
        // drain
      }
    }
    await expect(run()).rejects.toThrow("boom")
  })
})

describe("anthropicSseStreamFromEvents — byte serialization (happy path)", () => {
  test("serializes events to Anthropic SSE wire frames", async () => {
    const gen = synthAnthropicFromResponses(
      upstreamFrom([
        { type: "response.output_text.delta", output_index: 0, delta: "hi" },
        { type: "response.output_text.done", output_index: 0, text: "hi" },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]),
      { modelId: MODEL_ID, messageId: "msg_x" },
    )
    const stream = anthropicSseStreamFromEvents(gen, { routePath: "/v1/messages" })
    const text = await new Response(stream).text()

    // Each frame: `event: <type>\ndata: <json>\n\n`
    expect(text).toContain("event: message_start\ndata: ")
    expect(text).toContain('"type":"message_start"')
    expect(text).toContain("event: content_block_start\n")
    expect(text).toContain('"type":"text_delta","text":"hi"')
    expect(text).toContain("event: message_delta\n")
    expect(text.trimEnd().endsWith("event: message_stop\ndata: {\"type\":\"message_stop\"}"))
      .toBe(true)
  })
})
