// Non-streaming response-mapping tests: chat/completions object → Anthropic
// Messages (Gemini path).

import { expect, test, describe } from "bun:test"

import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"
import { chatResponseToAnthropicMessage } from "~/lib/anthropic-translate/chat-egress"

const MODEL_ID = "gemini-3.1-pro-preview"

function resp(
  message: Record<string, unknown>,
  over: Record<string, unknown> = {},
): ChatCompletionResponse {
  return {
    id: "chatcmpl_abc",
    object: "chat.completion",
    created: 0,
    model: MODEL_ID,
    choices: [
      { index: 0, message, logprobs: null, finish_reason: over.finish_reason ?? "stop" },
    ],
    ...over,
  } as unknown as ChatCompletionResponse
}

describe("chatResponseToAnthropicMessage", () => {
  test("text content → single text block, end_turn", () => {
    const msg = chatResponseToAnthropicMessage(
      resp(
        { role: "assistant", content: "hi there" },
        { usage: { prompt_tokens: 12, completion_tokens: 4 } },
      ),
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

  test("tool_calls → tool_use blocks, tool_use stop_reason", () => {
    const msg = chatResponseToAnthropicMessage(
      resp(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_9", type: "function", function: { name: "lookup", arguments: '{"id":7}' } },
          ],
        },
        { finish_reason: "tool_calls", usage: { prompt_tokens: 3, completion_tokens: 8 } },
      ),
      MODEL_ID,
    )
    expect(msg.content).toEqual([
      { type: "tool_use", id: "call_9", name: "lookup", input: { id: 7 } },
    ])
    expect(msg.stop_reason).toBe("tool_use")
  })

  test("text + two tool calls preserve order + distinct ids", () => {
    const msg = chatResponseToAnthropicMessage(
      resp(
        {
          role: "assistant",
          content: "sure",
          tool_calls: [
            { id: "a", type: "function", function: { name: "tool_a", arguments: '{"x":1}' } },
            { id: "b", type: "function", function: { name: "tool_b", arguments: '{"y":2}' } },
          ],
        },
        { finish_reason: "tool_calls" },
      ),
      MODEL_ID,
    )
    expect(msg.content.map((b: Record<string, unknown>) => b.type)).toEqual([
      "text",
      "tool_use",
      "tool_use",
    ])
    expect(msg.content[1]).toEqual({ type: "tool_use", id: "a", name: "tool_a", input: { x: 1 } })
    expect(msg.content[2]).toEqual({ type: "tool_use", id: "b", name: "tool_b", input: { y: 2 } })
    expect(msg.stop_reason).toBe("tool_use")
  })

  test("finish_reason length → max_tokens (wins over a partial tool call)", () => {
    const msg = chatResponseToAnthropicMessage(
      resp(
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "foo", arguments: "{}" } }],
        },
        { finish_reason: "length" },
      ),
      MODEL_ID,
    )
    expect(msg.stop_reason).toBe("max_tokens")
  })

  test("cached_tokens → cache_read_input_tokens", () => {
    const msg = chatResponseToAnthropicMessage(
      resp(
        { role: "assistant", content: "x" },
        { usage: { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 40 } } },
      ),
      MODEL_ID,
    )
    expect(msg.usage.cache_read_input_tokens).toBe(40)
    expect(msg.usage.input_tokens).toBe(60)
  })

  test("malformed tool arguments degrade to empty input", () => {
    const msg = chatResponseToAnthropicMessage(
      resp(
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{not json" } }],
        },
        { finish_reason: "tool_calls" },
      ),
      MODEL_ID,
    )
    expect(msg.content).toEqual([{ type: "tool_use", id: "c", name: "f", input: {} }])
  })

  test("missing tool id → generated toolu_ id (matchable), not empty string", () => {
    const msg = chatResponseToAnthropicMessage(
      resp(
        {
          role: "assistant",
          content: null,
          tool_calls: [{ type: "function", function: { name: "f", arguments: '{"a":1}' } }],
        },
        { finish_reason: "tool_calls" },
      ),
      MODEL_ID,
    )
    const block = msg.content[0]
    expect(block.type).toBe("tool_use")
    expect(String(block.id).startsWith("toolu_")).toBe(true)
    expect(String(block.id).length).toBeGreaterThan("toolu_".length)
    expect(block.input).toEqual({ a: 1 })
  })

  // Previously asserted `end_turn`, which pinned a real defect in place: an
  // upstream safety block was indistinguishable from a normal completion, so a
  // client had no way to know content had been withheld. `refusal` is
  // Anthropic's documented stop_reason for this case.
  test("content_filter finish_reason (no tools) → refusal, not end_turn", () => {
    const msg = chatResponseToAnthropicMessage(
      resp({ role: "assistant", content: "blocked" }, { finish_reason: "content_filter" }),
      MODEL_ID,
    )
    expect(msg.stop_reason).toBe("refusal")
  })

  test("a refusal arrives outside `content` and must still reach the client", () => {
    // The model declines: `content` is null and the text lives in `refusal`.
    // Reading only `content` produced an empty, apparently-successful message.
    const msg = chatResponseToAnthropicMessage(
      resp(
        { role: "assistant", content: null, refusal: "I can't help with that." },
        { finish_reason: "content_filter" },
      ),
      MODEL_ID,
    )
    expect(msg.content).toEqual([{ type: "text", text: "I can't help with that." }])
    expect(msg.stop_reason).toBe("refusal")
  })

  test("tool_use still wins over content_filter when a tool call is present", () => {
    const msg = chatResponseToAnthropicMessage(
      resp(
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", function: { name: "f", arguments: "{}" } }],
        },
        { finish_reason: "content_filter" },
      ),
      MODEL_ID,
    )
    expect(msg.stop_reason).toBe("tool_use")
  })
})
