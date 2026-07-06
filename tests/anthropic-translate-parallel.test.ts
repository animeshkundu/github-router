// C1/C2/I4/I5 regression tests for the /responses → Anthropic streaming
// synthesizer. These target the interleaving/lifecycle bugs the sequence tests
// in `anthropic-translate-stream.test.ts` did not reproduce: parallel tools
// whose `output_item.added` all arrive BEFORE the first arg delta, thinking-block
// signatures, late `output_text.done`, and truncated streams.

import { expect, test, describe } from "bun:test"

import { type AnthropicStreamEvent } from "~/lib/anthropic-translate/anthropic-sse"
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

/** All tool_use content_block_start events, in wire order. */
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

/** input_json_delta partial_json string for a given block index (concatenated). */
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

describe("C1 — parallel tools: all `added` before the first arg delta", () => {
  test("both tools reach the client with FULL args and DISTINCT block indices", async () => {
    const evs = await collect([
      // Both parallel tools open BEFORE the args stream (real Copilot ordering — this
      // is the exact shape the single-`current`-pointer synthesizer dropped).
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc0", call_id: "call_0", name: "toolAlpha" } },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc1", call_id: "call_1", name: "toolBeta" } },
      // interleaved arg deltas carrying re-encrypted item_ids
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "reenc_a", delta: '{"x"' },
      { type: "response.function_call_arguments.delta", output_index: 1, item_id: "reenc_b", delta: '{"y"' },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "reenc_c", delta: ":1}" },
      { type: "response.function_call_arguments.delta", output_index: 1, item_id: "reenc_d", delta: ":2}" },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: "reenc_e", arguments: '{"x":1}' },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc0", call_id: "call_0", name: "toolAlpha", arguments: '{"x":1}' } },
      { type: "response.function_call_arguments.done", output_index: 1, item_id: "reenc_f", arguments: '{"y":2}' },
      { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc1", call_id: "call_1", name: "toolBeta", arguments: '{"y":2}' } },
      { type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 6 } } },
    ])

    // Each tool is emitted atomically: start → single input_json_delta → stop.
    expect(types(evs)).toEqual([
      "message_start",
      "content_block_start", // tool 0
      "content_block_delta", // full args for tool 0
      "content_block_stop", // tool 0
      "content_block_start", // tool 1
      "content_block_delta", // full args for tool 1
      "content_block_stop", // tool 1
      "message_delta",
      "message_stop",
    ])

    const starts = toolStarts(evs)
    expect(starts).toEqual([
      { index: 0, id: "call_0", name: "toolAlpha" },
      { index: 1, id: "call_1", name: "toolBeta" },
    ])

    // The C1 bug shipped tool 0 with input:{} and dropped its arg deltas. Assert
    // BOTH tools carry their FULL args (not empty, not truncated) at DISTINCT
    // indices.
    expect(argsForIndex(evs, 0)).toBe('{"x":1}')
    expect(argsForIndex(evs, 1)).toBe('{"y":2}')

    // Neither tool block is empty.
    expect(argsForIndex(evs, 0)).not.toBe("")
    expect(argsForIndex(evs, 0)).not.toBe("{}")

    const delta = evs.find((e) => e.type === "message_delta")!
    expect((delta.delta as Record<string, unknown>).stop_reason).toBe("tool_use")
  })

  test("out-of-order `output_item.done` still yields distinct, correctly-attributed blocks", async () => {
    const evs = await collect([
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc0", call_id: "call_0", name: "alpha" } },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc1", call_id: "call_1", name: "beta" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"a":0}' },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"b":1}' },
      // tool 1 finishes FIRST → it takes block index 0 (emit-order indexing).
      { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc1", call_id: "call_1", name: "beta", arguments: '{"b":1}' } },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc0", call_id: "call_0", name: "alpha", arguments: '{"a":0}' } },
      { type: "response.completed", response: { usage: {} } },
    ])

    const starts = toolStarts(evs)
    // Emitted in done-order: beta first (@0), alpha second (@1).
    expect(starts).toEqual([
      { index: 0, id: "call_1", name: "beta" },
      { index: 1, id: "call_0", name: "alpha" },
    ])
    expect(argsForIndex(evs, 0)).toBe('{"b":1}')
    expect(argsForIndex(evs, 1)).toBe('{"a":0}')
  })

  test("dangling tool (no output_item.done) is flushed at end-of-stream with its buffered args", async () => {
    const evs = await collect([
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc0", call_id: "call_0", name: "solo" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"k":9}' },
      { type: "response.function_call_arguments.done", output_index: 0, arguments: '{"k":9}' },
      // NO output_item.done for the tool — the terminal event arrives first.
      { type: "response.completed", response: { usage: {} } },
    ])
    const starts = toolStarts(evs)
    expect(starts).toEqual([{ index: 0, id: "call_0", name: "solo" }])
    expect(argsForIndex(evs, 0)).toBe('{"k":9}')
  })

  test("S12 (streaming): empty/missing tool id → generated toolu_ id, never empty", async () => {
    const evs = await collect([
      // call_id AND id both empty strings — `??` would have shipped id:""
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "", call_id: "", name: "toolNoId" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"n":1}' },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "", call_id: "", name: "toolNoId", arguments: '{"n":1}' } },
      { type: "response.completed", response: { usage: {} } },
    ])
    const starts = toolStarts(evs)
    expect(starts.length).toBe(1)
    expect(starts[0].name).toBe("toolNoId")
    expect(starts[0].id.startsWith("toolu_")).toBe(true)
    expect(starts[0].id.length).toBeGreaterThan("toolu_".length)
    // args still delivered correctly
    expect(argsForIndex(evs, 0)).toBe('{"n":1}')
  })

  test("S12 (streaming): a real call_id is preserved (no synthetic id)", async () => {
    const evs = await collect([
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_real", name: "t" } },
      { type: "response.function_call_arguments.done", output_index: 0, arguments: "{}" },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_real", name: "t", arguments: "{}" } },
      { type: "response.completed", response: { usage: {} } },
    ])
    expect(toolStarts(evs)[0].id).toBe("call_real")
  })
})

describe("interleaving: thinking → tool, text → tool → text", () => {
  test("thinking block closes (with signature) before the tool opens", async () => {
    const evs = await collect([
      { type: "response.reasoning_text.delta", output_index: 0, delta: "reason" },
      { type: "response.reasoning_text.done", output_index: 0 },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "r0", encrypted_content: "SIG" } },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc", call_id: "call_x", name: "toolT" } },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"a":1}' },
      { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc", call_id: "call_x", name: "toolT", arguments: '{"a":1}' } },
      { type: "response.completed", response: { usage: {} } },
    ])
    expect(types(evs)).toEqual([
      "message_start",
      "content_block_start", // thinking @ 0
      "content_block_delta", // thinking_delta
      "content_block_delta", // signature_delta
      "content_block_stop", // thinking @ 0 closed at reasoning output_item.done
      "content_block_start", // tool @ 1
      "content_block_delta", // args
      "content_block_stop", // tool @ 1
      "message_delta",
      "message_stop",
    ])
    // thinking @ 0, tool @ 1
    expect(evs[1].content_block).toEqual({ type: "thinking", thinking: "" })
    expect(evs[1].index).toBe(0)
    expect((evs[3].delta as Record<string, unknown>)).toEqual({ type: "signature_delta", signature: "SIG" })
    expect(evs[3].index).toBe(0)
    expect(toolStarts(evs)).toEqual([{ index: 1, id: "call_x", name: "toolT" }])
    expect(argsForIndex(evs, 1)).toBe('{"a":1}')
  })
})

describe("C2 — thinking-block signature preserved", () => {
  test("reasoning delta → done → output_item.done{encrypted_content} emits signature_delta", async () => {
    const evs = await collect([
      { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "thinking" },
      { type: "response.reasoning_summary_text.done", output_index: 0 },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "r0", encrypted_content: "sig-abc" } },
      { type: "response.completed", response: { usage: {} } },
    ])
    expect(types(evs)).toEqual([
      "message_start",
      "content_block_start", // thinking @ 0
      "content_block_delta", // thinking_delta
      "content_block_delta", // signature_delta
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    const sig = evs.find(
      (e) => e.type === "content_block_delta"
        && (e.delta as Record<string, unknown>).type === "signature_delta",
    )
    expect(sig).toBeDefined()
    expect((sig!.delta as Record<string, unknown>).signature).toBe("sig-abc")
    expect(sig!.index).toBe(0)
  })

  test("no signature_delta when the reasoning item carries no encrypted_content", async () => {
    const evs = await collect([
      { type: "response.reasoning_text.delta", output_index: 0, delta: "quiet" },
      { type: "response.reasoning_text.done", output_index: 0 },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "r0" } },
      { type: "response.completed", response: { usage: {} } },
    ])
    const sig = evs.find(
      (e) => e.type === "content_block_delta"
        && (e.delta as Record<string, unknown>).type === "signature_delta",
    )
    expect(sig).toBeUndefined()
    // block still opens + closes cleanly
    expect(types(evs)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
  })
})

describe("I5 — output_text.done never duplicates already-streamed text", () => {
  test("late output_text.done after a type switch does not re-emit the text", async () => {
    const evs = await collect([
      { type: "response.output_text.delta", output_index: 0, delta: "hello " },
      { type: "response.output_text.delta", output_index: 0, delta: "world" },
      // a tool interleaves → closes text @ 0
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc", call_id: "c", name: "t" } },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: "{}" },
      { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc", call_id: "c", name: "t", arguments: "{}" } },
      // the late done for the closed text block MUST NOT re-emit "hello world"
      { type: "response.output_text.done", output_index: 0, text: "hello world" },
      { type: "response.completed", response: { usage: {} } },
    ])
    // exactly the text once, no reopened text block after the tool
    const textDeltas = evs.filter(
      (e) => e.type === "content_block_delta"
        && (e.delta as Record<string, unknown>).type === "text_delta",
    )
    expect(textDeltas.map((e) => (e.delta as Record<string, unknown>).text).join("")).toBe("hello world")
    // no content_block_start after the tool's stop (the late done is a no-op)
    expect(types(evs)).toEqual([
      "message_start",
      "content_block_start", // text @ 0
      "content_block_delta", // "hello "
      "content_block_delta", // "world"
      "content_block_stop", // text @ 0 closed by tool
      "content_block_start", // tool @ 1
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
  })

  test("output_text.done emits only the un-emitted suffix when deltas were partial", async () => {
    const evs = await collect([
      { type: "response.output_text.delta", output_index: 0, delta: "par" },
      // .done carries the FULL text; only "tial" is new
      { type: "response.output_text.done", output_index: 0, text: "partial" },
      { type: "response.completed", response: { usage: {} } },
    ])
    const textDeltas = evs.filter(
      (e) => e.type === "content_block_delta"
        && (e.delta as Record<string, unknown>).type === "text_delta",
    )
    expect(textDeltas.map((e) => (e.delta as Record<string, unknown>).text)).toEqual(["par", "tial"])
    expect(textDeltas.map((e) => (e.delta as Record<string, unknown>).text).join("")).toBe("partial")
  })

  test("output_text.done with no prior deltas emits the full text once", async () => {
    const evs = await collect([
      { type: "response.output_text.done", output_index: 0, text: "whole" },
      { type: "response.completed", response: { usage: {} } },
    ])
    const textDeltas = evs.filter(
      (e) => e.type === "content_block_delta"
        && (e.delta as Record<string, unknown>).type === "text_delta",
    )
    expect(textDeltas.map((e) => (e.delta as Record<string, unknown>).text)).toEqual(["whole"])
  })
})

describe("I4 — truncated stream (no terminal event) is not a clean success", () => {
  test("a stream that ends without completed/incomplete/failed throws", async () => {
    const run = async (): Promise<Array<AnthropicStreamEvent>> => {
      const out: Array<AnthropicStreamEvent> = []
      for await (const ev of synthAnthropicFromResponses(
        upstreamFrom([
          { type: "response.output_text.delta", output_index: 0, delta: "partial" },
          { type: "response.output_text.done", output_index: 0, text: "partial" },
          // NO response.completed / incomplete / failed — the upstream was cut.
        ]),
        { modelId: MODEL_ID },
      )) {
        out.push(ev)
      }
      return out
    }
    await expect(run()).rejects.toThrow(/truncat/i)
  })

  test("a stream ending on [DONE] AFTER a terminal event is a clean success", async () => {
    const evs = await collect([
      { type: "response.output_text.delta", output_index: 0, delta: "ok" },
      { type: "response.output_text.done", output_index: 0, text: "ok" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ])
    expect(types(evs).at(-1)).toBe("message_stop")
  })
})
