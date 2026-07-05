// Request-mapping unit tests for the Anthropic → chat/completions shim (Gemini
// path). Pure functions — no fetch/state mocking needed.

import { expect, test, describe } from "bun:test"

import { parseAnthropicRequest } from "~/lib/anthropic-translate/anthropic-request"
import { parsedToChatPayload } from "~/lib/anthropic-translate/chat-request"
import type { Model } from "~/services/copilot/get-models"

const MODEL_ID = "gemini-3.1-pro-preview"

function geminiModel(reasoningEfforts?: Array<string>): Model {
  return {
    id: MODEL_ID,
    name: "Gemini 3.1 Pro",
    object: "model",
    vendor: "google",
    version: "1",
    preview: true,
    model_picker_enabled: true,
    capabilities: {
      family: "gemini",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      supports: {
        tool_calls: true,
        ...(reasoningEfforts && { reasoning_effort: reasoningEfforts }),
      },
    },
    supported_endpoints: ["/chat/completions"],
  }
}

function build(body: Record<string, unknown>, model?: Model) {
  const parsed = parseAnthropicRequest(body, MODEL_ID, model)
  const payload = parsedToChatPayload(parsed)
  return { parsed, payload }
}

describe("anthropic-translate chat request mapping (Gemini)", () => {
  test("plain user text → user message; max_tokens; stream carried", () => {
    const { payload } = build({
      model: MODEL_ID,
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    })
    expect(payload.model).toBe(MODEL_ID)
    expect(payload.messages).toEqual([{ role: "user", content: "hello" }])
    expect(payload.max_tokens).toBe(100)
    expect(payload.stream).toBe(true)
  })

  test("system string → leading {role:'system'} message", () => {
    const { payload } = build({
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(payload.messages[0]).toEqual({ role: "system", content: "be terse" })
    expect(payload.messages[1]).toEqual({ role: "user", content: "hi" })
  })

  test("system text-block array → joined into one system message", () => {
    const { payload } = build({
      system: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ],
      messages: [],
    })
    expect(payload.messages).toEqual([{ role: "system", content: "line1line2" }])
  })

  test("image block (base64) → image_url data URI content part", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "QUJD" },
            },
          ],
        },
      ],
    })
    expect(payload.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
        ],
      },
    ])
  })

  test("image block (url) → image_url passthrough", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "url", url: "https://ex.com/a.png" } }],
        },
      ],
    })
    expect(payload.messages).toEqual([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://ex.com/a.png" } }],
      },
    ])
  })

  test("assistant text + tool_use → content + tool_calls", () => {
    const { payload } = build({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool_use", id: "toolu_1", name: "search", input: { q: "x" } },
          ],
        },
      ],
    })
    expect(payload.messages).toEqual([
      {
        role: "assistant",
        content: "calling",
        tool_calls: [
          { id: "toolu_1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } },
        ],
      },
    ])
  })

  test("assistant tool-only turn → content:null + tool_calls (OpenAI convention)", () => {
    const { payload } = build({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_2", name: "run", input: {} }],
        },
      ],
    })
    expect(payload.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "toolu_2", type: "function", function: { name: "run", arguments: "{}" } },
        ],
      },
    ])
  })

  test("tool_result (string) → {role:'tool'} message", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "42" }],
        },
      ],
    })
    expect(payload.messages).toEqual([
      { role: "tool", tool_call_id: "toolu_1", content: "42" },
    ])
  })

  test("tool_result with image → {role:'tool'} + follow-up user image_url message", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_9",
              content: [
                { type: "text", text: "screenshot:" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
              ],
            },
          ],
        },
      ],
    })
    expect(payload.messages).toEqual([
      { role: "tool", tool_call_id: "toolu_9", content: "screenshot:" },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }],
      },
    ])
  })

  test("tools[] → chat function tools; tool_choice NESTED variants", () => {
    const tools = [
      {
        name: "get_weather",
        description: "weather",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]
    const auto = build({ messages: [], tools, tool_choice: { type: "auto" } }).payload
    expect(auto.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ])
    expect(auto.tool_choice).toBe("auto")

    expect(build({ messages: [], tools, tool_choice: { type: "any" } }).payload.tool_choice).toBe("required")
    expect(build({ messages: [], tools, tool_choice: { type: "none" } }).payload.tool_choice).toBe("none")
    // Forced tool: the CHAT nested form {type:"function", function:{name}} —
    // distinct from the Responses flat form {type:"function", name}.
    expect(
      build({ messages: [], tools, tool_choice: { type: "tool", name: "get_weather" } }).payload.tool_choice,
    ).toEqual({ type: "function", function: { name: "get_weather" } })
    // tool_choice omitted but tools present → default auto
    expect(build({ messages: [], tools }).payload.tool_choice).toBe("auto")
  })

  test("no tools → no tools/tool_choice fields on the payload", () => {
    const { payload } = build({ messages: [{ role: "user", content: "hi" }] })
    expect(payload.tools).toBeUndefined()
    expect(payload.tool_choice).toBeUndefined()
  })

  test("reasoning: Gemini has NO xhigh → a high-budget thinking clamps xhigh → high", () => {
    const model = geminiModel(["low", "medium", "high"])
    const effort = build(
      { messages: [], thinking: { type: "enabled", budget_tokens: 30000 } },
      model,
    ).payload.reasoning_effort
    expect(effort).toBe("high")
  })

  test("reasoning: lower budgets bucket + pass through unchanged when supported", () => {
    const model = geminiModel(["minimal", "low", "medium", "high"])
    const mk = (budget: number) =>
      build({ messages: [], thinking: { type: "enabled", budget_tokens: budget } }, model)
        .payload.reasoning_effort
    expect(mk(1000)).toBe("low")
    expect(mk(5000)).toBe("medium")
    expect(mk(10000)).toBe("high")
    // xhigh bucket clamps down to the highest supported (high)
    expect(mk(30000)).toBe("high")
  })

  test("no thinking → no reasoning_effort field", () => {
    const { payload } = build({ messages: [{ role: "user", content: "hi" }] }, geminiModel(["low", "medium", "high"]))
    expect(payload.reasoning_effort).toBeUndefined()
  })

  test("no structured_outputs: response_format is never emitted", () => {
    const { payload } = build({
      messages: [{ role: "user", content: "hi" }],
      output_config: { schema: { type: "object" } },
    })
    expect((payload as unknown as Record<string, unknown>).response_format).toBeUndefined()
  })

  test("I6: stop_sequences → chat `stop` (forwarded; Copilot accepts it)", () => {
    const { parsed, payload } = build({
      messages: [{ role: "user", content: "hi" }],
      stop_sequences: ["END"],
    })
    expect(parsed.stopSequences).toEqual(["END"])
    expect(payload.stop).toEqual(["END"])
  })

  test("I6: absent stop_sequences → no `stop` field emitted", () => {
    const { payload } = build({ messages: [{ role: "user", content: "hi" }] })
    expect("stop" in payload).toBe(false)
  })

  test("I8b: tool_choice.disable_parallel_tool_use:true → parallel_tool_calls:false", () => {
    const tools = [
      { name: "get_weather", input_schema: { type: "object", properties: {} } },
    ]
    const { parsed, payload } = build({
      messages: [],
      tools,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    })
    expect(parsed.parallelToolCalls).toBe(false)
    expect(payload.parallel_tool_calls).toBe(false)
    expect(payload.tool_choice).toBe("auto")
  })

  test("I8b: absent / false disable_parallel_tool_use → no parallel_tool_calls field", () => {
    const tools = [
      { name: "get_weather", input_schema: { type: "object", properties: {} } },
    ]
    const a = build({ messages: [], tools, tool_choice: { type: "auto" } })
    expect("parallel_tool_calls" in a.payload).toBe(false)
    const b = build({
      messages: [],
      tools,
      tool_choice: { type: "auto", disable_parallel_tool_use: false },
    })
    expect("parallel_tool_calls" in b.payload).toBe(false)
  })
})
