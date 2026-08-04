// Streaming synthesizer tests: chat/completions SSE → Anthropic SSE event
// sequence (Gemini path). Mirrors the Phase 1 /responses stream coverage:
// text streaming, MULTIPLE tool calls keep FULL args at DISTINCT block indices
// (the C1 lesson carried to chat), finish_reason → stop_reason, usage, and the
// truncation guard. Plus one happy-path pass through the byte-stream adapter.

import { expect, test, describe } from "bun:test"

import {
  anthropicSseStreamFromEvents,
  type AnthropicStreamEvent,
} from "~/lib/anthropic-translate/anthropic-sse"
import { synthAnthropicFromChat } from "~/lib/anthropic-translate/chat-egress"

const MODEL_ID = "gemini-3.1-pro-preview"

async function* upstreamFrom(events: Array<object>): AsyncGenerator<{ data?: string }> {
  for (const e of events) yield { data: JSON.stringify(e) }
}

// Real chat/completions streams terminate with a `[DONE]` sentinel; that is the
// authoritative clean-end marker. `collect` appends it so happy-path fixtures
// model a clean end. Truncation tests use `upstreamFrom` directly (no `[DONE]`).
async function* upstreamWithDone(events: Array<object>): AsyncGenerator<{ data?: string }> {
  for (const e of events) yield { data: JSON.stringify(e) }
  yield { data: "[DONE]" }
}

async function collect(events: Array<object>): Promise<Array<AnthropicStreamEvent>> {
  const out: Array<AnthropicStreamEvent> = []
  for await (const ev of synthAnthropicFromChat(upstreamWithDone(events), {
    modelId: MODEL_ID,
    messageId: "msg_test",
  })) {
    out.push(ev)
  }
  return out
}

const types = (evs: Array<AnthropicStreamEvent>) => evs.map((e) => e.type)

describe("refusal streaming", () => {
  test("a streamed refusal reaches the client as text with stop_reason refusal", async () => {
    // `delta.refusal` is a sibling of `delta.content`, so a synthesizer that
    // reads only `content` streams literally nothing and then terminates with a
    // clean `end_turn` — the user sees an empty successful response and never
    // learns the model declined.
    const evs = await collect([
      { choices: [{ delta: { refusal: "I can't help " } }] },
      { choices: [{ delta: { refusal: "with that." } }] },
      { choices: [{ delta: {}, finish_reason: "content_filter" }] },
    ])
    const text = evs
      .filter((e) => e.type === "content_block_delta")
      .map((e) => (e as unknown as { delta?: { text?: string } }).delta?.text ?? "")
      .join("")
    expect(text).toBe("I can't help with that.")

    const delta = evs.find((e) => e.type === "message_delta") as unknown as {
      delta?: { stop_reason?: string }
    }
    expect(delta?.delta?.stop_reason).toBe("refusal")
  })
})

function toolStarts(evs: Array<AnthropicStreamEvent>): Array<{ index: number; id: string; name: string }> {
  return evs
    .filter(
      (e) =>
        e.type === "content_block_start"
        && (e.content_block as Record<string, unknown> | undefined)?.type === "tool_use",
    )
    .map((e) => {
      const block = e.content_block as Record<string, unknown>
      return { index: e.index as number, id: block.id as string, name: block.name as string }
    })
}

function argsForIndex(evs: Array<AnthropicStreamEvent>, index: number): string {
  return evs
    .filter(
      (e) =>
        e.type === "content_block_delta"
        && e.index === index
        && (e.delta as Record<string, unknown>).type === "input_json_delta",
    )
    .map((e) => (e.delta as Record<string, unknown>).partial_json as string)
    .join("")
}

describe("synthAnthropicFromChat — sequence", () => {
  test("text-only turn: message_start → block start/delta*/stop → message_delta → message_stop", async () => {
    const evs = await collect([
      { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
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
    expect(start.model).toBe(MODEL_ID)
    expect(start.content).toEqual([])
    expect(start.stop_reason).toBeNull()

    // The empty prelude content did NOT open a stray text block.
    expect(evs[1].content_block).toEqual({ type: "text", text: "" })
    expect(evs[1].index).toBe(0)
    expect(evs[2].delta).toEqual({ type: "text_delta", text: "Hel" })
    expect(evs[3].delta).toEqual({ type: "text_delta", text: "lo" })

    const delta = evs[5]
    expect((delta.delta as Record<string, unknown>).stop_reason).toBe("end_turn")
    expect((delta.delta as Record<string, unknown>).stop_sequence).toBeNull()
    expect((delta.usage as Record<string, unknown>).input_tokens).toBe(5)
    expect((delta.usage as Record<string, unknown>).output_tokens).toBe(2)
  })

  test("two tool calls: DISTINCT block indices, FULL args assembled from incremental deltas, keyed by array index", async () => {
    const evs = await collect([
      { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
      // tool 0: id/name arrive first, then args stream incrementally
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "toolA", arguments: "" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"x"' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }, finish_reason: null }] },
      // tool 1
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "toolB", arguments: "" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"y":2}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 6 } },
    ])

    expect(types(evs)).toEqual([
      "message_start",
      "content_block_start", // tool 0
      "content_block_delta", // full args for tool 0 (one input_json_delta)
      "content_block_stop",
      "content_block_start", // tool 1
      "content_block_delta", // full args for tool 1
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])

    expect(toolStarts(evs)).toEqual([
      { index: 0, id: "call_a", name: "toolA" },
      { index: 1, id: "call_b", name: "toolB" },
    ])
    // Args assembled correctly and NOT lost/truncated (the C1 lesson).
    expect(argsForIndex(evs, 0)).toBe('{"x":1}')
    expect(argsForIndex(evs, 1)).toBe('{"y":2}')
    expect(argsForIndex(evs, 0)).not.toBe("{}")

    const delta = evs.find((e) => e.type === "message_delta")!
    expect((delta.delta as Record<string, unknown>).stop_reason).toBe("tool_use")
  })

  test("text → tool: the text block is closed before the tool block opens (fresh index)", async () => {
    const evs = await collect([
      { choices: [{ index: 0, delta: { content: "a" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "t", arguments: "{}" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ])
    expect(types(evs)).toEqual([
      "message_start",
      "content_block_start", // text @ 0
      "content_block_delta",
      "content_block_stop", // text @ 0 closed on tool
      "content_block_start", // tool @ 1
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(evs[1].index).toBe(0)
    expect(toolStarts(evs)).toEqual([{ index: 1, id: "c", name: "t" }])
    expect(argsForIndex(evs, 1)).toBe("{}")
  })

  test("missing/empty tool id → generated toolu_ id, never empty; args still delivered", async () => {
    const evs = await collect([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "", type: "function", function: { name: "toolNoId", arguments: '{"n":1}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ])
    const starts = toolStarts(evs)
    expect(starts.length).toBe(1)
    expect(starts[0].name).toBe("toolNoId")
    expect(starts[0].id.startsWith("toolu_")).toBe(true)
    expect(starts[0].id.length).toBeGreaterThan("toolu_".length)
    expect(argsForIndex(evs, 0)).toBe('{"n":1}')
  })

  test("finish_reason length → max_tokens", async () => {
    const evs = await collect([
      { choices: [{ index: 0, delta: { content: "cut" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
    ])
    const delta = evs.find((e) => e.type === "message_delta")!
    expect((delta.delta as Record<string, unknown>).stop_reason).toBe("max_tokens")
  })

  test("usage max-accumulate: a later zeroed usage frame does not clobber", async () => {
    const evs = await collect([
      { choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } } },
      { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } },
    ])
    const delta = evs.find((e) => e.type === "message_delta")!
    expect((delta.usage as Record<string, unknown>).input_tokens).toBe(20)
    expect((delta.usage as Record<string, unknown>).output_tokens).toBe(7)
    expect((delta.usage as Record<string, unknown>).cache_read_input_tokens).toBe(4)
  })

  test("truncated stream (no terminal finish_reason) throws", async () => {
    const run = async () => {
      for await (const _ev of synthAnthropicFromChat(
        upstreamFrom([
          { choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] },
          // no finish_reason, no [DONE] — the upstream was cut
        ]),
        { modelId: MODEL_ID },
      )) {
        void _ev
      }
    }
    await expect(run()).rejects.toThrow(/truncat/i)
  })

  // Finding 1: `[DONE]` — not a chunk-level finish_reason — is the authoritative
  // clean-end marker. A `[DONE]` with no finish_reason must NOT falsely error.
  test("[DONE] but NO finish_reason on any chunk → clean end_turn, not an error", async () => {
    const evs = await collect([
      { choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: " there" }, finish_reason: null }] },
      // no chunk ever carries finish_reason; the stream ends with [DONE]
    ])
    expect(types(evs).at(-1)).toBe("message_stop")
    const delta = evs.find((e) => e.type === "message_delta")!
    expect((delta.delta as Record<string, unknown>).stop_reason).toBe("end_turn")
    // The generator resolved (collect completed) → it did NOT throw an error.
  })

  test("[DONE] but NO finish_reason WITH a streamed tool → stop_reason tool_use", async () => {
    const evs = await collect([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "toolA", arguments: '{"x":1}' } }] }, finish_reason: null }] },
      // no finish_reason; the stream ends with [DONE]
    ])
    const delta = evs.find((e) => e.type === "message_delta")!
    expect((delta.delta as Record<string, unknown>).stop_reason).toBe("tool_use")
    expect(toolStarts(evs)).toEqual([{ index: 0, id: "call_a", name: "toolA" }])
    expect(argsForIndex(evs, 0)).toBe('{"x":1}')
  })

  test("finish_reason present but NO [DONE] → treated as truncated (throws)", async () => {
    // [DONE] is the signal; a finish_reason without it is not a clean end.
    const run = async () => {
      for await (const _ev of synthAnthropicFromChat(
        upstreamFrom([
          { choices: [{ index: 0, delta: { content: "done-ish" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          // finish_reason arrived, but the [DONE] sentinel never did
        ]),
        { modelId: MODEL_ID },
      )) {
        void _ev
      }
    }
    await expect(run()).rejects.toThrow(/truncat/i)
  })

  test("truncation surfaces as a terminal event: error through the byte adapter", async () => {
    const gen = synthAnthropicFromChat(
      upstreamFrom([
        { choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] },
        // no [DONE] — cut mid-flight
      ]),
      { modelId: MODEL_ID },
    )
    const stream = anthropicSseStreamFromEvents(gen, { routePath: "/v1/messages" })
    const text = await new Response(stream).text()
    expect(text).toContain("event: error")
  })

  // Finding 3: streaming sanitizes tool args exactly like the non-streaming
  // path — truncated/malformed accumulated JSON degrades to `{}`.
  test("malformed/truncated streamed tool args degrade to {} (parseable, matches non-streaming)", async () => {
    const evs = await collect([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_x", type: "function", function: { name: "getWeather", arguments: '{"city":"SF' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
    ])
    const partial = argsForIndex(evs, 0)
    expect(partial).toBe("{}")
    expect(() => JSON.parse(partial)).not.toThrow()
    expect(JSON.parse(partial)).toEqual({})
  })

  test("well-formed streamed tool args round-trip unchanged (parse→stringify of valid JSON)", async () => {
    const evs = await collect([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_y", type: "function", function: { name: "t", arguments: '{"a":1,"b":"two"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ])
    const partial = argsForIndex(evs, 0)
    expect(partial).toBe('{"a":1,"b":"two"}')
    expect(JSON.parse(partial)).toEqual({ a: 1, b: "two" })
  })

  // Finding 4: out-of-order provider indices still flush as numeric blocks 0,1…
  test("out-of-order provider indices (1 before 0) flush in numeric order with correct args", async () => {
    const evs = await collect([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_one", type: "function", function: { name: "toolOne", arguments: '{"one":1}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_zero", type: "function", function: { name: "toolZero", arguments: '{"zero":0}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ])
    // Anthropic blocks emit in numeric provider-index order: 0 (call_zero) then 1 (call_one).
    expect(toolStarts(evs)).toEqual([
      { index: 0, id: "call_zero", name: "toolZero" },
      { index: 1, id: "call_one", name: "toolOne" },
    ])
    expect(argsForIndex(evs, 0)).toBe('{"zero":0}')
    expect(argsForIndex(evs, 1)).toBe('{"one":1}')
  })
})

describe("anthropicSseStreamFromEvents — byte serialization (chat happy path)", () => {
  test("serializes chat-derived events to Anthropic SSE wire frames", async () => {
    const gen = synthAnthropicFromChat(
      upstreamWithDone([
        { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
      { modelId: MODEL_ID, messageId: "msg_x" },
    )
    const stream = anthropicSseStreamFromEvents(gen, { routePath: "/v1/messages" })
    const text = await new Response(stream).text()

    expect(text).toContain("event: message_start\ndata: ")
    expect(text).toContain('"type":"message_start"')
    expect(text).toContain("event: content_block_start\n")
    expect(text).toContain('"type":"text_delta","text":"hi"')
    expect(text).toContain("event: message_delta\n")
    expect(text).toContain('"stop_reason":"end_turn"')
    expect(text.trimEnd().endsWith('event: message_stop\ndata: {"type":"message_stop"}')).toBe(true)
  })

  test("real [DONE] sentinel terminates the stream after a finish_reason", async () => {
    async function* withDone(): AsyncGenerator<{ data?: string }> {
      yield { data: JSON.stringify({ choices: [{ index: 0, delta: { content: "z" }, finish_reason: null }] }) }
      yield { data: JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) }
      yield { data: "[DONE]" }
    }
    const out: Array<AnthropicStreamEvent> = []
    for await (const ev of synthAnthropicFromChat(withDone(), { modelId: MODEL_ID })) out.push(ev)
    expect(types(out).at(-1)).toBe("message_stop")
    expect((out.find((e) => e.type === "message_delta")!.delta as Record<string, unknown>).stop_reason).toBe("end_turn")
  })
})
