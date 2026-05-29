import { test, expect, mock, beforeEach, afterEach } from "bun:test"

import type { ResponsesPayload } from "../src/services/copilot/create-responses"

import { state } from "../src/lib/state"
import { createResponses } from "../src/services/copilot/create-responses"
import { HTTPError } from "../src/lib/error"

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const originalFetch = globalThis.fetch

const DEFAULT_RESPONSE_BODY = JSON.stringify({
  id: "resp_123",
  object: "response",
  status: "completed",
  output: [],
})

// Returns a real Response so readResponseBodyCapped can call response.headers.get()
// and response.body.getReader(). The previous plain-object mock broke after we
// introduced the response-cap utility which requires a proper Response interface.
// Request-header inspection still works: tests read fetchMock.mock.calls[N][1].headers
// which are the RequestInit.headers passed TO the upstream (unchanged).
const fetchMock = mock(
  (_url: string, _opts: { headers: Record<string, string>; body?: string }) => {
    return new Response(DEFAULT_RESPONSE_BODY, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(DEFAULT_RESPONSE_BODY.length),
      },
    })
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
    model: "gpt-5.2-codex",
    input: "Hello",
  }
  await createResponses(payload)
  expect(fetchMock).toHaveBeenCalled()
  const url = fetchMock.mock.calls[0][0]
  expect(url).toBe("https://api.githubcopilot.com/responses")
})

test("sets X-Initiator to user when input is a string", async () => {
  const payload: ResponsesPayload = {
    model: "gpt-5.2-codex",
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
    model: "gpt-5.2-codex",
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
    model: "gpt-5.2-codex",
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
    model: "gpt-5.2-codex",
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
    model: "gpt-5.2-codex",
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

test("forwards all tool types unchanged (apply_patch, custom, shell, tool_search, mcp)", async () => {
  // Copilot's /responses now schema-supports 14 tool types; per-model
  // support varies. The router lets Copilot return its own per-model 400
  // rather than pre-filtering. See plan §4.
  const payload: ResponsesPayload = {
    model: "gpt-5.5",
    input: "Hello",
    tools: [
      { type: "function", name: "get_weather", parameters: { type: "object" } },
      { type: "apply_patch" },
      { type: "custom", name: "x", format: { type: "text" } },
      { type: "shell" },
      { type: "tool_search" },
      { type: "mcp" },
      { type: "web_search_preview" },
    ],
    tool_choice: { type: "tool", name: "apply_patch" },
  }
  await createResponses(payload)
  const lastCall = fetchMock.mock.calls.at(-1)
  const body = JSON.parse(
    (lastCall?.[1] as unknown as { body: string }).body,
  ) as { tools?: Array<{ type: string; name?: string }>; tool_choice?: unknown }
  expect(body.tools).toHaveLength(7)
  expect(body.tools?.map((t) => t.type)).toEqual([
    "function",
    "apply_patch",
    "custom",
    "shell",
    "tool_search",
    "mcp",
    "web_search_preview",
  ])
  expect(body.tool_choice).toEqual({ type: "tool", name: "apply_patch" })
})

test("forwards single non-function tool (regression for old strip behavior)", async () => {
  const payload: ResponsesPayload = {
    model: "gpt-5.5",
    input: "Hello",
    tools: [{ type: "apply_patch" }],
  }
  await createResponses(payload)
  const lastCall = fetchMock.mock.calls.at(-1)
  const body = JSON.parse(
    (lastCall?.[1] as unknown as { body: string }).body,
  ) as { tools?: Array<{ type: string }> }
  expect(body.tools).toEqual([{ type: "apply_patch" }])
})

test("returns parsed JSON for non-streaming response", async () => {
  const payload: ResponsesPayload = {
    model: "gpt-5.2-codex",
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
    createResponses({ model: "gpt-5.2-codex", input: "Hello" }),
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
    model: "gpt-5.2-codex",
    input: "Hello",
    stream: true,
  })) as AsyncIterable<{ data: string }>
  const events = []
  for await (const event of stream) {
    events.push(event)
  }
  expect(events[0]?.data).toContain("resp_chunk")
})
