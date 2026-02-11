import { test, expect, mock, beforeEach, afterEach } from "bun:test"

import type { ResponsesPayload } from "../src/services/copilot/create-responses"

import { state } from "../src/lib/state"
import { createResponses } from "../src/services/copilot/create-responses"
import { HTTPError } from "../src/lib/error"

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Helper to mock fetch
const originalFetch = globalThis.fetch
const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string>; body?: string }) => {
    return {
      ok: true,
      json: () => ({
        id: "resp_123",
        object: "response",
        status: "completed",
        output: [],
      }),
      headers: opts.headers,
      body: opts.body,
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

test("sends POST to /responses endpoint", async () => {
  const payload: ResponsesPayload = {
    model: "gpt5.2-codex",
    input: "Hello",
  }
  await createResponses(payload)
  expect(fetchMock).toHaveBeenCalled()
  const url = fetchMock.mock.calls[0][0]
  expect(url).toBe("https://api.githubcopilot.com/responses")
})

test("sets X-Initiator to user when input is a string", async () => {
  const payload: ResponsesPayload = {
    model: "gpt5.2-codex",
    input: "Hello",
  }
  await createResponses(payload)
  const headers = (
    fetchMock.mock.calls[1][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("user")
})

test("sets X-Initiator to agent when input has assistant messages", async () => {
  const payload: ResponsesPayload = {
    model: "gpt5.2-codex",
    input: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    ],
  }
  await createResponses(payload)
  const headers = (
    fetchMock.mock.calls[2][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to agent when input has function_call_output", async () => {
  const payload: ResponsesPayload = {
    model: "gpt5.2-codex",
    input: [
      { role: "user", content: "hi" },
      { type: "function_call_output", call_id: "call_123", output: "result" },
    ],
  }
  await createResponses(payload)
  const headers = (
    fetchMock.mock.calls[3][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to agent when input has function_call", async () => {
  const payload: ResponsesPayload = {
    model: "gpt5.2-codex",
    input: [
      { role: "user", content: "hi" },
      {
        type: "function_call",
        call_id: "call_456",
        name: "get_weather",
        arguments: '{"location":"NYC"}',
      },
    ],
  }
  await createResponses(payload)
  const headers = (
    fetchMock.mock.calls[4][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to user when input has only user messages", async () => {
  const payload: ResponsesPayload = {
    model: "gpt5.2-codex",
    input: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
  }
  await createResponses(payload)
  const headers = (
    fetchMock.mock.calls[5][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("user")
})

test("strips unsupported tool types like web_search from payload", async () => {
  const payload: ResponsesPayload = {
    model: "gpt5.2-codex",
    input: "Hello",
    tools: [
      { type: "web_search" },
      {
        type: "function",
        name: "get_weather",
        parameters: { type: "object" },
      },
    ],
    tool_choice: { type: "tool", name: "web_search" },
  }
  await createResponses(payload)
  const lastCall = fetchMock.mock.calls.at(-1)
  const body = JSON.parse(
    (lastCall?.[1] as unknown as { body: string }).body,
  ) as { tools?: Array<{ type: string; name?: string }>; tool_choice?: unknown }
  expect(body.tools).toHaveLength(1)
  expect(body.tools?.[0].type).toBe("function")
  expect(body.tools?.[0].name).toBe("get_weather")
  expect(body.tool_choice).toBeUndefined()
})

test("removes tools field entirely when all tools are unsupported", async () => {
  const payload: ResponsesPayload = {
    model: "gpt5.2-codex",
    input: "Hello",
    tools: [{ type: "web_search" }, { type: "code_interpreter" }],
    tool_choice: { type: "tool", name: "web_search" },
  }
  await createResponses(payload)
  const lastCall2 = fetchMock.mock.calls.at(-1)
  const body = JSON.parse(
    (lastCall2?.[1] as unknown as { body: string }).body,
  ) as { tools?: Array<{ type: string }>; tool_choice?: unknown }
  expect(body.tools).toBeUndefined()
  expect(body.tool_choice).toBeUndefined()
})

test("clears function tool_choice when tool is stripped", async () => {
  const payload: ResponsesPayload = {
    model: "gpt5.2-codex",
    input: "Hello",
    tools: [{ type: "web_search" }],
    tool_choice: { type: "function", function: { name: "web_search" } },
  }
  await createResponses(payload)
  const lastCall = fetchMock.mock.calls.at(-1)
  const body = JSON.parse(
    (lastCall?.[1] as unknown as { body: string }).body,
  ) as { tools?: Array<{ type: string }>; tool_choice?: unknown }
  expect(body.tools).toBeUndefined()
  expect(body.tool_choice).toBeUndefined()
})

test("returns parsed JSON for non-streaming response", async () => {
  const payload: ResponsesPayload = {
    model: "gpt5.2-codex",
    input: "Hello",
    stream: false,
  }
  const response = await createResponses(payload)
  expect(response).toHaveProperty("id", "resp_123")
  expect(response).toHaveProperty("object", "response")
  expect(response).toHaveProperty("status", "completed")
})

test("throws HTTPError when response is not ok", async () => {
  const errorFetch = mock(() => new Response("fail", { status: 500 }))
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = errorFetch

  await expect(
    createResponses({ model: "gpt5.2-codex", input: "Hello" }),
  ).rejects.toBeInstanceOf(HTTPError)
})

test("returns stream events when stream is enabled", async () => {
  const streamFetch = mock(
    () =>
      new Response('data: {"id":"resp_chunk"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
  )
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = streamFetch

  const stream = (await createResponses({
    model: "gpt5.2-codex",
    input: "Hello",
    stream: true,
  })) as AsyncIterable<{ data: string }>
  const events = []
  for await (const event of stream) {
    events.push(event)
  }
  expect(events[0]?.data).toContain("resp_chunk")
})
