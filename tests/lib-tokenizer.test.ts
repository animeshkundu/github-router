import { test, expect } from "bun:test"

import {
  getTokenCount,
  getTokenizerFromModel,
  numTokensForTools,
} from "../src/lib/tokenizer"
import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

const baseModel = {
  id: "gpt-4",
  model_picker_enabled: true,
  name: "GPT-4",
  object: "model",
  preview: false,
  vendor: "openai",
  version: "1",
  capabilities: {
    family: "gpt",
    limits: {},
    object: "model",
    supports: {},
    tokenizer: "o200k_base",
    type: "chat",
  },
}

test("getTokenizerFromModel falls back when tokenizer missing", () => {
  const model = {
    ...baseModel,
    capabilities: { ...baseModel.capabilities, tokenizer: "" },
  }
  expect(getTokenizerFromModel(model)).toBe("o200k_base")
})

test("getTokenCount increases with tools and images", async () => {
  const payloadWithoutTools: ChatCompletionsPayload = {
    model: "gpt-4",
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ],
  }
  const payloadWithTools: ChatCompletionsPayload = {
    ...payloadWithoutTools,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Look" },
          { type: "image_url", image_url: { url: "https://example.com" } },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather.",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string", enum: ["NYC", "SF"] },
            },
            extra: "value",
          },
        },
      },
    ],
  }

  const withoutTools = await getTokenCount(payloadWithoutTools, baseModel)
  const withTools = await getTokenCount(payloadWithTools, baseModel)
  expect(withTools.input).toBeGreaterThan(withoutTools.input)
})

test("getTokenCount handles tool calls and unknown tokenizer", async () => {
  const model = {
    ...baseModel,
    id: "gpt-4o",
    capabilities: { ...baseModel.capabilities, tokenizer: "unknown" },
  }
  const payload: ChatCompletionsPayload = {
    model: "gpt-4o",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: "{\"id\":1}" },
          },
        ],
      },
    ],
  }

  const result = await getTokenCount(payload, model)
  expect(result.output).toBeGreaterThan(0)
})

test("numTokensForTools returns token count", () => {
  const tokens = numTokensForTools(
    [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Look up data.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "ID." },
            },
          },
        },
      },
    ],
    {
      encode: (text: string) => Array.from(text).map(() => 1),
    },
    {
      funcInit: 7,
      propInit: 3,
      propKey: 3,
      enumInit: -3,
      enumItem: 3,
      funcEnd: 12,
    },
  )
  expect(tokens).toBeGreaterThan(0)
})
