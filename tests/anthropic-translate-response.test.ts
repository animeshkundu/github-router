// Non-streaming response-mapping tests: Responses object → Anthropic Messages.

import { expect, test, describe } from "bun:test"

import type { ResponsesApiResponse } from "~/services/copilot/create-responses"
import { responsesResponseToAnthropicMessage } from "~/lib/anthropic-translate/responses-egress"

const MODEL_ID = "gpt-5.5"

function resp(over: Record<string, unknown>): ResponsesApiResponse {
  return {
    id: "resp_abc",
    object: "response",
    status: "completed",
    output: [],
    ...over,
  } as unknown as ResponsesApiResponse
}

describe("responsesResponseToAnthropicMessage", () => {
  test("text output → single text block, end_turn", () => {
    const msg = responsesResponseToAnthropicMessage(
      resp({
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi there" }] },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
      }),
      MODEL_ID,
    )
    expect(msg.type).toBe("message")
    expect(msg.role).toBe("assistant")
    expect(msg.model).toBe(MODEL_ID)
    expect(msg.content).toEqual([{ type: "text", text: "hi there" }])
    expect(msg.stop_reason).toBe("end_turn")
    expect(msg.stop_sequence).toBeNull()
    expect(String(msg.id).startsWith("msg_")).toBe(true)
    expect(msg.usage).toEqual({
      input_tokens: 12,
      output_tokens: 4,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  })

  test("function_call output → tool_use block, tool_use stop_reason", () => {
    const msg = responsesResponseToAnthropicMessage(
      resp({
        output: [
          { type: "function_call", call_id: "call_9", name: "lookup", arguments: '{"id":7}' },
        ],
        usage: { input_tokens: 3, output_tokens: 8 },
      }),
      MODEL_ID,
    )
    expect(msg.content).toEqual([
      { type: "tool_use", id: "call_9", name: "lookup", input: { id: 7 } },
    ])
    expect(msg.stop_reason).toBe("tool_use")
  })

  test("cached_tokens → cache_read_input_tokens", () => {
    const msg = responsesResponseToAnthropicMessage(
      resp({
        output: [{ type: "message", content: [{ type: "output_text", text: "x" }] }],
        usage: { input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 40 } },
      }),
      MODEL_ID,
    )
    expect(msg.usage.cache_read_input_tokens).toBe(40)
    expect(msg.usage.input_tokens).toBe(60)
  })

  test("cache writes are separated from uncached Anthropic input", () => {
    const msg = responsesResponseToAnthropicMessage(
      resp({
        usage: {
          input_tokens: 100,
          output_tokens: 2,
          input_tokens_details: {
            cached_tokens: 40,
            cache_write_tokens: 25,
          },
        },
      }),
      MODEL_ID,
    )
    expect(msg.usage.input_tokens).toBe(35)
    expect(msg.usage.cache_read_input_tokens).toBe(40)
    expect(msg.usage.cache_creation_input_tokens).toBe(25)
  })

  test("incomplete/max_output_tokens → max_tokens (wins over a partial tool call)", () => {
    const msg = responsesResponseToAnthropicMessage(
      resp({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          { type: "function_call", call_id: "c1", name: "foo", arguments: "{}" },
        ],
      }),
      MODEL_ID,
    )
    expect(msg.stop_reason).toBe("max_tokens")
  })

  test("reasoning output → thinking block with signature", () => {
    const msg = responsesResponseToAnthropicMessage(
      resp({
        output: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "thinking hard" }],
            encrypted_content: "sig-xyz",
          },
          { type: "message", content: [{ type: "output_text", text: "answer" }] },
        ],
      }),
      MODEL_ID,
    )
    expect(msg.content).toEqual([
      { type: "thinking", thinking: "thinking hard", signature: "sig-xyz" },
      { type: "text", text: "answer" },
    ])
  })

  test("mixed reasoning + text + two tool calls preserve order", () => {
    const msg = responsesResponseToAnthropicMessage(
      resp({
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "r" }] },
          { type: "message", content: [{ type: "output_text", text: "t" }] },
          { type: "function_call", call_id: "a", name: "tool_a", arguments: '{"x":1}' },
          { type: "function_call", call_id: "b", name: "tool_b", arguments: '{"y":2}' },
        ],
      }),
      MODEL_ID,
    )
    expect(msg.content.map((b: Record<string, unknown>) => b.type)).toEqual([
      "thinking",
      "text",
      "tool_use",
      "tool_use",
    ])
    expect(msg.content[2]).toEqual({ type: "tool_use", id: "a", name: "tool_a", input: { x: 1 } })
    expect(msg.content[3]).toEqual({ type: "tool_use", id: "b", name: "tool_b", input: { y: 2 } })
    expect(msg.stop_reason).toBe("tool_use")
  })

  test("malformed tool arguments degrade to empty input", () => {
    const msg = responsesResponseToAnthropicMessage(
      resp({
        output: [{ type: "function_call", call_id: "c", name: "f", arguments: "{not json" }],
      }),
      MODEL_ID,
    )
    expect(msg.content).toEqual([{ type: "tool_use", id: "c", name: "f", input: {} }])
  })

  test("S12: missing tool id → generated toolu_ id (matchable), not empty string", () => {
    const msg = responsesResponseToAnthropicMessage(
      resp({
        output: [{ type: "function_call", name: "f", arguments: '{"a":1}' }],
      }),
      MODEL_ID,
    )
    const block = msg.content[0]
    expect(block.type).toBe("tool_use")
    expect(typeof block.id).toBe("string")
    expect(String(block.id).length).toBeGreaterThan(0)
    expect(String(block.id).startsWith("toolu_")).toBe(true)
    expect(block.input).toEqual({ a: 1 })
  })

  test("S12: empty-string call_id/id also falls back to a generated toolu_ id", () => {
    const msg = responsesResponseToAnthropicMessage(
      resp({
        output: [{ type: "function_call", call_id: "", id: "", name: "f", arguments: "{}" }],
      }),
      MODEL_ID,
    )
    expect(String(msg.content[0].id).startsWith("toolu_")).toBe(true)
  })

  test("S12: a present call_id is preserved (no synthetic id)", () => {
    const msg = responsesResponseToAnthropicMessage(
      resp({
        output: [{ type: "function_call", call_id: "call_real", name: "f", arguments: "{}" }],
      }),
      MODEL_ID,
    )
    expect(msg.content[0].id).toBe("call_real")
  })
})
