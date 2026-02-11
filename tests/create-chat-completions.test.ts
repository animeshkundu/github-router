import { test, expect, mock, beforeEach, afterEach } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
} from "../src/services/copilot/create-chat-completions"
import { HTTPError } from "../src/lib/error"

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Helper to mock fetch
const originalFetch = globalThis.fetch
const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => {
    return {
      ok: true,
      json: () => ({ id: "123", object: "chat.completion", choices: [] }),
      headers: opts.headers,
    }
  },
)

beforeEach(() => {
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  globalThis.fetch = fetchMock
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("sets X-Initiator to agent if tool/assistant present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to user if only user present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[1][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("user")
})

test("throws HTTPError when Copilot responds with error", async () => {
  const originalFetch = globalThis.fetch
  const errorFetch = mock(() => new Response("fail", { status: 500 }))
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = errorFetch

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
  }
  await expect(createChatCompletions(payload)).rejects.toBeInstanceOf(HTTPError)

  globalThis.fetch = originalFetch
})

test("returns stream events when stream is enabled", async () => {
  const originalFetch = globalThis.fetch
  const streamFetch = mock(
    () =>
      new Response(
        'data: {"id":"chunk_1","choices":[{"delta":{"content":"hi"}}]}\n\n',
        {
          headers: { "content-type": "text/event-stream" },
        },
      ),
  )
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = streamFetch

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
    stream: true,
  }
  const stream = (await createChatCompletions(payload)) as AsyncIterable<{
    data: string
  }>
  const chunks: Array<ChatCompletionChunk> = []
  for await (const event of stream) {
    chunks.push(JSON.parse(event.data))
  }
  expect(chunks[0]?.id).toBe("chunk_1")

  globalThis.fetch = originalFetch
})
