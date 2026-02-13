import { describe, test, expect } from "bun:test"
import { z } from "zod"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import { normalizeCopilotModelName } from "~/routes/messages/utils"
import { state } from "~/lib/state"

import { translateToOpenAI } from "../src/routes/messages/non-stream-translation"

// Zod schema for a single message in the chat completion request.
const messageSchema = z.object({
  role: z.enum([
    "system",
    "user",
    "assistant",
    "tool",
    "function",
    "developer",
  ]),
  content: z.union([z.string(), z.object({}), z.array(z.any())]),
  name: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
})

// Zod schema for the entire chat completion request payload.
// This is derived from the openapi.documented.yml specification.
const chatCompletionRequestSchema = z.object({
  messages: z.array(messageSchema).min(1, "Messages array cannot be empty."),
  model: z.string(),
  frequency_penalty: z.number().min(-2).max(2).optional().nullable(),
  logit_bias: z.record(z.string(), z.number()).optional().nullable(),
  logprobs: z.boolean().optional().nullable(),
  top_logprobs: z.number().int().min(0).max(20).optional().nullable(),
  max_tokens: z.number().int().optional().nullable(),
  n: z.number().int().min(1).max(128).optional().nullable(),
  presence_penalty: z.number().min(-2).max(2).optional().nullable(),
  response_format: z
    .object({
      type: z.enum(["text", "json_object", "json_schema"]),
      json_schema: z.object({}).optional(),
    })
    .optional(),
  seed: z.number().int().optional().nullable(),
  stop: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .nullable(),
  stream: z.boolean().optional().nullable(),
  temperature: z.number().min(0).max(2).optional().nullable(),
  top_p: z.number().min(0).max(1).optional().nullable(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.union([z.string(), z.object({})]).optional(),
  user: z.string().optional(),
})

/**
 * Validates if a request payload conforms to the OpenAI Chat Completion v1 shape using Zod.
 * @param payload The request payload to validate.
 * @returns True if the payload is valid, false otherwise.
 */
function isValidChatCompletionRequest(payload: unknown): boolean {
  const result = chatCompletionRequestSchema.safeParse(payload)
  return result.success
}

describe("Anthropic to OpenAI translation logic", () => {
  test("should translate minimal Anthropic payload to valid OpenAI payload", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("should translate comprehensive Anthropic payload to valid OpenAI payload", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      system: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "What is the weather like in Boston?" },
        {
          role: "assistant",
          content: "The weather in Boston is sunny and 75°F.",
        },
      ],
      temperature: 0.7,
      max_tokens: 150,
      top_p: 1,
      stream: false,
      metadata: { user_id: "user-123" },
      tools: [
        {
          name: "getWeather",
          description: "Gets weather info",
          input_schema: { location: { type: "string" } },
        },
      ],
      tool_choice: { type: "auto" },
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("should handle missing fields gracefully", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("should handle invalid types in Anthropic payload", () => {
    const anthropicPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      temperature: "hot", // Should be a number
    }
    // @ts-expect-error intended to be invalid
    const openAIPayload = translateToOpenAI(anthropicPayload)
    // Should fail validation
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(false)
  })

  test("should handle thinking blocks in assistant messages", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "What is 2+2?" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Let me think about this simple math problem...",
            },
            { type: "text", text: "2+2 equals 4." },
          ],
        },
      ],
      max_tokens: 100,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)

    // Check that thinking content is combined with text content
    const assistantMessage = openAIPayload.messages.find(
      (m) => m.role === "assistant",
    )
    expect(assistantMessage?.content).toContain(
      "Let me think about this simple math problem...",
    )
    expect(assistantMessage?.content).toContain("2+2 equals 4.")
  })

  test("should handle thinking blocks with tool calls", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking:
                "I need to call the weather API to get current weather information.",
            },
            { type: "text", text: "I'll check the weather for you." },
            {
              type: "tool_use",
              id: "call_123",
              name: "get_weather",
              input: { location: "New York" },
            },
          ],
        },
      ],
      max_tokens: 100,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)

    // Check that thinking content is included in the message content
    const assistantMessage = openAIPayload.messages.find(
      (m) => m.role === "assistant",
    )
    expect(assistantMessage?.content).toContain(
      "I need to call the weather API",
    )
    expect(assistantMessage?.content).toContain(
      "I'll check the weather for you.",
    )
    expect(assistantMessage?.tool_calls).toHaveLength(1)
    expect(assistantMessage?.tool_calls?.[0].function.name).toBe("get_weather")
  })

  test("should default missing tool input to empty arguments", () => {
    const anthropicPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_456",
              name: "get_weather",
              input: undefined,
            },
          ],
        },
      ],
      max_tokens: 100,
    } as unknown as AnthropicMessagesPayload

    const openAIPayload = translateToOpenAI(anthropicPayload)
    const assistantMessage = openAIPayload.messages.find(
      (m) => m.role === "assistant",
    )
    expect(assistantMessage?.tool_calls?.[0].function.arguments).toBe("{}")
  })

  test("should skip tool_use blocks missing required identifiers", () => {
    const anthropicPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "",
              name: "",
              input: { location: "NYC" },
            },
            { type: "text", text: "Working on it." },
          ],
        },
      ],
      max_tokens: 100,
    } as unknown as AnthropicMessagesPayload

    const openAIPayload = translateToOpenAI(anthropicPayload)
    const assistantMessage = openAIPayload.messages.find(
      (m) => m.role === "assistant",
    )
    expect(assistantMessage?.tool_calls).toBeUndefined()
    expect(assistantMessage?.content).toContain("Working on it.")
  })
})

describe("OpenAI Chat Completion v1 Request Payload Validation with Zod", () => {
  test("should return true for a minimal valid request payload", () => {
    const validPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(validPayload)).toBe(true)
  })

  test("should return true for a comprehensive valid request payload", () => {
    const validPayload = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What is the weather like in Boston?" },
      ],
      temperature: 0.7,
      max_tokens: 150,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      stream: false,
      n: 1,
    }
    expect(isValidChatCompletionRequest(validPayload)).toBe(true)
  })

  test('should return false if the "model" field is missing', () => {
    const invalidPayload = {
      messages: [{ role: "user", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if the "messages" field is missing', () => {
    const invalidPayload = {
      model: "gpt-4o",
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if the "messages" array is empty', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if "model" is not a string', () => {
    const invalidPayload = {
      model: 12345,
      messages: [{ role: "user", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if "messages" is not an array', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: { role: "user", content: "Hello!" },
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if a message in the "messages" array is missing a "role"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if a message in the "messages" array is missing "content"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "user" }],
    }
    // Note: Zod considers 'undefined' as missing, so this will fail as expected.
    const result = chatCompletionRequestSchema.safeParse(invalidPayload)
    expect(result.success).toBe(false)
  })

  test('should return false if a message has an invalid "role"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "customer", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test("should return false if an optional field has an incorrect type", () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      temperature: "hot", // Should be a number
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test("should return false for a completely empty object", () => {
    const invalidPayload = {}
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test("should return false for null or non-object payloads", () => {
    expect(isValidChatCompletionRequest(null)).toBe(false)
    expect(isValidChatCompletionRequest(undefined)).toBe(false)
    expect(isValidChatCompletionRequest("a string")).toBe(false)
    expect(isValidChatCompletionRequest(123)).toBe(false)
  })
})

// Mock Copilot model list matching the real server response
const mockCopilotModels = [
  "claude-opus-4.6-1m",
  "claude-opus-4.6-fast",
  "claude-opus-4.6",
  "claude-sonnet-4",
  "claude-sonnet-4.5",
  "claude-opus-4.5",
  "claude-opus-41",
  "claude-haiku-4.5",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt5.2-codex",
]

function setupMockModels() {
  state.models = {
    object: "list",
    data: mockCopilotModels.map((id) => ({
      id,
      name: id,
      object: "model",
      version: "1.0",
      vendor: "test",
      preview: false,
      model_picker_enabled: true,
      capabilities: {
        family: "test",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "test",
        type: "chat",
      },
    })),
  }
}

function clearMockModels() {
  state.models = undefined
}

describe("Model name normalization (normalizeCopilotModelName)", () => {
  test("exact match: claude-opus-4.6-1m passes through unchanged", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-opus-4.6-1m")).toBe("claude-opus-4.6-1m")
    clearMockModels()
  })

  test("exact match: claude-haiku-4.5 passes through unchanged", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-haiku-4.5")).toBe("claude-haiku-4.5")
    clearMockModels()
  })

  test("exact match: claude-opus-4.6 passes through unchanged", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-opus-4.6")).toBe("claude-opus-4.6")
    clearMockModels()
  })

  test("dash→dot conversion: claude-opus-4-6 → claude-opus-4.6", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-opus-4-6")).toBe("claude-opus-4.6")
    clearMockModels()
  })

  test("dash→dot conversion: claude-haiku-4-5 → claude-haiku-4.5", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-haiku-4-5")).toBe("claude-haiku-4.5")
    clearMockModels()
  })

  test("dash→dot conversion: claude-sonnet-4-5 → claude-sonnet-4.5", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-sonnet-4-5")).toBe("claude-sonnet-4.5")
    clearMockModels()
  })

  test("date suffix stripping: claude-sonnet-4-20250514 → claude-sonnet-4", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-sonnet-4-20250514")).toBe("claude-sonnet-4")
    clearMockModels()
  })

  test("dash→dot + date: claude-sonnet-4-5-20250929 → claude-sonnet-4.5", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4.5")
    clearMockModels()
  })

  test("variant suffix stripping: claude-opus-4.6-fast is exact match", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-opus-4.6-fast")).toBe("claude-opus-4.6-fast")
    clearMockModels()
  })

  test("prefix match fallback for unrecognized suffixes", () => {
    setupMockModels()
    // claude-opus-4.6-unknown should prefix-match claude-opus-4.6-fast or claude-opus-4.6-1m (longest prefix)
    const result = normalizeCopilotModelName("claude-opus-4.6-unknown")
    expect(mockCopilotModels).toContain(result)
    clearMockModels()
  })

  test("non-Claude passthrough: gpt-4o passes through unchanged", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("gpt-4o")).toBe("gpt-4o")
    clearMockModels()
  })

  test("non-Claude passthrough: gpt5.2-codex passes through unchanged", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("gpt5.2-codex")).toBe("gpt5.2-codex")
    clearMockModels()
  })

  test("non-Claude unknown model passes through unchanged", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("llama-3-70b")).toBe("llama-3-70b")
    clearMockModels()
  })

  test("unknown Claude model falls back to claude-opus-4.6", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-unknown-99")).toBe("claude-opus-4.6")
    clearMockModels()
  })

  test("no models loaded: Claude model falls back to claude-opus-4.6", () => {
    clearMockModels()
    expect(normalizeCopilotModelName("claude-opus-4-6")).toBe("claude-opus-4.6")
  })

  test("no models loaded: non-Claude model passes through", () => {
    clearMockModels()
    expect(normalizeCopilotModelName("gpt-4o")).toBe("gpt-4o")
  })
})

// Tests covering every model name that Claude Code's /model menu sends
describe("Claude Code /model menu integration", () => {
  test("Default (Sonnet 4.5): claude-sonnet-4-5-20250929 → claude-sonnet-4.5", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4.5")
    clearMockModels()
  })

  test("Opus: claude-opus-4-6 → claude-opus-4.6", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-opus-4-6")).toBe("claude-opus-4.6")
    clearMockModels()
  })

  test("Opus (1M context): claude-opus-4-6-1m → claude-opus-4.6-1m", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-opus-4-6-1m")).toBe("claude-opus-4.6-1m")
    clearMockModels()
  })

  test("Sonnet (1M context): claude-sonnet-4-5-1m → claude-sonnet-4.5", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-sonnet-4-5-1m")).toBe("claude-sonnet-4.5")
    clearMockModels()
  })

  test("Haiku: claude-haiku-4-5-20251001 → claude-haiku-4.5", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-haiku-4-5-20251001")).toBe("claude-haiku-4.5")
    clearMockModels()
  })

  test("Sub-agent Opus 4.5: claude-opus-4-5 → claude-opus-4.5", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-opus-4-5")).toBe("claude-opus-4.5")
    clearMockModels()
  })

  test("Sub-agent Opus 4.5 dated: claude-opus-4-5-20250918 → claude-opus-4.5", () => {
    setupMockModels()
    expect(normalizeCopilotModelName("claude-opus-4-5-20250918")).toBe("claude-opus-4.5")
    clearMockModels()
  })
})
