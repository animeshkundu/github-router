import { test, expect, mock, afterEach } from "bun:test"

import { server } from "../../src/server"
import { state } from "../../src/lib/state"

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
    limits: { max_output_tokens: 256 },
    object: "model",
    supports: {},
    tokenizer: "o200k_base",
    type: "chat",
  },
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function resetState() {
  state.accountType = "individual"
  state.copilotToken = "token"
  state.githubToken = "gh"
  state.vsCodeVersion = "1.0.0"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.showToken = false
  state.models = { object: "list", data: [baseModel] }
}

test("chat completions injects web search context and strips tools", async () => {
  resetState()
  let lastChatBody: string | undefined

  const fetchMock = mock((url: string, opts?: { body?: string }) => {
    if (url.endsWith("/github/chat/threads")) {
      return new Response(JSON.stringify({ thread_id: "thread-1" }))
    }
    if (url.includes("/github/chat/threads/") && url.endsWith("/messages")) {
      return new Response(
        JSON.stringify({
          message: { content: "search result", references: [] },
        }),
      )
    }
    if (url.endsWith("/chat/completions")) {
      lastChatBody = opts?.body
      return new Response(
        JSON.stringify({ id: "chat", object: "chat.completion", choices: [] }),
      )
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: { name: "web_search", parameters: { type: "object" } },
        },
      ],
      tool_choice: { type: "function", function: { name: "web_search" } },
    }),
  })

  expect(response.status).toBe(200)
  const forwarded = JSON.parse(lastChatBody ?? "{}") as {
    messages: Array<{ role: string; content: string }>
    tools?: Array<unknown>
    tool_choice?: unknown
    max_tokens?: number
  }
  expect(forwarded.tools).toBeUndefined()
  expect(forwarded.tool_choice).toBeUndefined()
  expect(forwarded.max_tokens).toBe(256)
  expect(forwarded.messages[0]?.content).toContain("[Web Search Results]")
})

test("chat completions stream returns SSE output", async () => {
  resetState()
  const fetchMock = mock((url: string) => {
    if (url.endsWith("/chat/completions")) {
      return new Response(
        'data: {"id":"chunk","choices":[{"delta":{"content":"hi"}}]}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  })
  const body = await response.text()
  expect(body).toContain("data:")
})

test("responses injects web search and default max_output_tokens", async () => {
  resetState()
  let lastBody: string | undefined

  const fetchMock = mock((url: string, opts?: { body?: string }) => {
    if (url.endsWith("/github/chat/threads")) {
      return new Response(JSON.stringify({ thread_id: "thread-2" }))
    }
    if (url.includes("/github/chat/threads/") && url.endsWith("/messages")) {
      return new Response(
        JSON.stringify({
          message: { content: "search result", references: [] },
        }),
      )
    }
    if (url.endsWith("/responses")) {
      lastBody = opts?.body
      return new Response(
        JSON.stringify({ id: "resp", object: "response", output: [] }),
      )
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4",
      input: "hello",
      tools: [{ type: "web_search" }],
      tool_choice: { type: "function", function: { name: "web_search" } },
    }),
  })

  expect(response.status).toBe(200)
  const forwarded = JSON.parse(lastBody ?? "{}") as {
    tools?: Array<unknown>
    tool_choice?: unknown
    max_output_tokens?: number
    instructions?: string
  }
  expect(forwarded.tools).toBeUndefined()
  expect(forwarded.tool_choice).toBeUndefined()
  expect(forwarded.max_output_tokens).toBe(256)
  expect(forwarded.instructions).toContain("[Web Search Results]")
})

test("responses stream skips DONE chunks", async () => {
  resetState()
  const fetchMock = mock((url: string) => {
    if (url.endsWith("/responses")) {
      return new Response('data: {"id":"resp"}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      })
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4",
      input: "hello",
      stream: true,
    }),
  })
  const body = await response.text()
  expect(body).toContain("resp")
  expect(body).not.toContain("[DONE]")
})

test("messages passthrough forwards body to copilot /v1/messages", async () => {
  resetState()
  let lastBody: string | undefined
  let lastUrl: string | undefined

  const fetchMock = mock((url: string, opts?: { body?: string }) => {
    if (url.includes("/v1/messages")) {
      lastUrl = url
      lastBody = opts?.body
      return new Response(
        JSON.stringify({
          id: "msg_123",
          type: "message",
          role: "assistant",
          model: "gpt-4",
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
      )
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  const requestBody = JSON.stringify({
    model: "gpt-4",
    max_tokens: 10,
    messages: [{ role: "user", content: "hello" }],
  })

  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody,
  })

  expect(response.status).toBe(200)
  expect(lastUrl).toContain("/v1/messages")
  // Body is forwarded as-is
  expect(lastBody).toBe(requestBody)
  const json = (await response.json()) as { type: string; id: string }
  expect(json.type).toBe("message")
  expect(json.id).toBe("msg_123")
})

test("messages stream passthrough pipes SSE events directly", async () => {
  resetState()
  const ssePayload = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"gpt-4","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("")

  const fetchMock = mock((url: string) => {
    if (url.includes("/v1/messages")) {
      return new Response(ssePayload, {
        headers: { "content-type": "text/event-stream" },
      })
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4",
      max_tokens: 10,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  })
  const body = await response.text()
  // SSE events are forwarded as-is from upstream
  expect(body).toContain("message_start")
  expect(body).toContain("content_block_delta")
  expect(body).toContain("message_stop")
})

test("count_tokens passthrough forwards to copilot and returns result", async () => {
  resetState()

  const fetchMock = mock((url: string) => {
    if (url.includes("/v1/messages/count_tokens")) {
      return new Response(JSON.stringify({ input_tokens: 42 }))
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  const response = await server.request("/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4.5",
      max_tokens: 10,
      messages: [{ role: "user", content: "hello" }],
    }),
  })
  expect(response.status).toBe(200)
  const json = (await response.json()) as { input_tokens: number }
  expect(json.input_tokens).toBe(42)
})

test("count_tokens forwards upstream errors", async () => {
  resetState()

  const fetchMock = mock((url: string) => {
    if (url.includes("/v1/messages/count_tokens")) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "not_found_error", message: "model not found" },
        }),
        { status: 404 },
      )
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  const response = await server.request("/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "missing",
      max_tokens: 10,
      messages: [{ role: "user", content: "hello" }],
    }),
  })
  expect(response.status).toBe(404)
})

test("routes for models, search, embeddings, usage, and token", async () => {
  resetState()
  state.showToken = true
  state.copilotToken = "copilot"

  const fetchMock = mock((url: string) => {
    if (url.endsWith("/embeddings")) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [],
          model: "gpt-4",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      )
    }
    if (url.endsWith("/copilot_internal/user")) {
      return new Response(
        JSON.stringify({
          access_type_sku: "sku",
          analytics_tracking_id: "id",
          assigned_date: "date",
          can_signup_for_limited: false,
          chat_enabled: true,
          copilot_plan: "plan",
          organization_login_list: [],
          organization_list: [],
          quota_reset_date: "date",
          quota_snapshots: {
            chat: {
              entitlement: 1,
              overage_count: 0,
              overage_permitted: false,
              percent_remaining: 1,
              quota_id: "id",
              quota_remaining: 1,
              remaining: 1,
              unlimited: false,
            },
            completions: {
              entitlement: 1,
              overage_count: 0,
              overage_permitted: false,
              percent_remaining: 1,
              quota_id: "id",
              quota_remaining: 1,
              remaining: 1,
              unlimited: false,
            },
            premium_interactions: {
              entitlement: 1,
              overage_count: 0,
              overage_permitted: false,
              percent_remaining: 1,
              quota_id: "id",
              quota_remaining: 1,
              remaining: 1,
              unlimited: false,
            },
          },
        }),
      )
    }
    if (url.endsWith("/github/chat/threads")) {
      return new Response(JSON.stringify({ thread_id: "thread-4" }))
    }
    if (url.includes("/github/chat/threads/") && url.endsWith("/messages")) {
      return new Response(
        JSON.stringify({ message: { content: "search", references: [] } }),
      )
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  const modelsResponse = await server.request("/v1/models")
  const modelsJson = (await modelsResponse.json()) as { data: Array<unknown> }
  expect(modelsJson.data).toHaveLength(1)

  const embeddingsResponse = await server.request("/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4", input: "hello" }),
  })
  expect(embeddingsResponse.status).toBe(200)

  const usageResponse = await server.request("/usage")
  expect(usageResponse.status).toBe(200)

  const tokenResponse = await server.request("/token")
  const tokenJson = (await tokenResponse.json()) as { token: string }
  expect(tokenJson.token).toBe("copilot")

  const searchResponse = await server.request("/v1/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "hello" }),
  })
  expect(searchResponse.status).toBe(200)
})

test("usage route forwards upstream errors", async () => {
  resetState()

  const fetchMock = mock((url: string) => {
    if (url.endsWith("/copilot_internal/user")) {
      return new Response(JSON.stringify({ message: "no usage" }), {
        status: 500,
      })
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  const usageResponse = await server.request("/usage")
  expect(usageResponse.status).toBe(500)
})

test("search endpoint rejects missing query", async () => {
  resetState()
  const response = await server.request("/v1/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  })
  expect(response.status).toBe(400)
})

test("token endpoint rejects when disabled", async () => {
  resetState()
  state.showToken = false
  const response = await server.request("/token")
  expect(response.status).toBe(403)
})

test("messages passthrough forwards upstream error status and body", async () => {
  resetState()

  const fetchMock = mock((url: string) => {
    if (url.includes("/v1/messages")) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "model not supported",
          },
        }),
        { status: 400 },
      )
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "invalid",
      max_tokens: 10,
      messages: [{ role: "user", content: "hello" }],
    }),
  })
  expect(response.status).toBe(400)
})

test("all routes forward errors when copilot token is missing", async () => {
  resetState()
  state.copilotToken = undefined

  const chatResponse = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    }),
  })
  expect(chatResponse.status).toBe(500)

  const messagesResponse = await server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4.5",
      max_tokens: 10,
      messages: [{ role: "user", content: "hello" }],
    }),
  })
  expect(messagesResponse.status).toBe(500)

  const countTokensResponse = await server.request(
    "/v1/messages/count_tokens",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.5",
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }],
      }),
    },
  )
  expect(countTokensResponse.status).toBe(500)

  const responsesResponse = await server.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4",
      input: "hello",
    }),
  })
  expect(responsesResponse.status).toBe(500)
})
