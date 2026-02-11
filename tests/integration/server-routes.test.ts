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

test("messages translates anthropic payload and strips tool choice", async () => {
  resetState()
  let lastChatBody: string | undefined

  const fetchMock = mock((url: string, opts?: { body?: string }) => {
    if (url.endsWith("/github/chat/threads")) {
      return new Response(JSON.stringify({ thread_id: "thread-3" }))
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

  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4",
      max_tokens: 10,
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "web_search", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "web_search" },
    }),
  })

  expect(response.status).toBe(200)
  const forwarded = JSON.parse(lastChatBody ?? "{}") as {
    tool_choice?: unknown
    messages: Array<{ role: string; content: string }>
  }
  expect(forwarded.tool_choice).toBeUndefined()
  expect(forwarded.messages[0]?.content).toContain("[Web Search Results]")
})

test("messages stream returns anthropic SSE events", async () => {
  resetState()
  const fetchMock = mock((url: string) => {
    if (url.endsWith("/chat/completions")) {
      return new Response(
        [
          'data: {"id":"cmpl","model":"gpt-4","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null,"logprobs":null}]}\n\n',
          'data: {"id":"cmpl","model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop","logprobs":null}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
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
      model: "gpt-4",
      max_tokens: 10,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  })
  const body = await response.text()
  expect(body).toContain("message_start")
})

test("count_tokens returns token counts and handles missing model", async () => {
  resetState()
  let response = await server.request("/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4",
      max_tokens: 10,
      messages: [{ role: "user", content: "hello" }],
    }),
  })
  expect(response.status).toBe(200)
  const json = (await response.json()) as { input_tokens: number }
  expect(typeof json.input_tokens).toBe("number")

  state.models = { object: "list", data: [] }
  response = await server.request("/v1/messages/count_tokens", {
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

test("count_tokens applies tool adjustments for claude and grok", async () => {
  resetState()
  state.models = {
    object: "list",
    data: [
      { ...baseModel, id: "claude-3" },
      { ...baseModel, id: "grok-1" },
    ],
  }

  const regularResponse = await server.request("/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "claude-code-2024-02-01",
    },
    body: JSON.stringify({
      model: "claude-3",
      max_tokens: 10,
      tools: [{ name: "tool", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hello" }],
    }),
  })
  const regularJson = (await regularResponse.json()) as {
    input_tokens: number
  }

  const mcpResponse = await server.request("/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "claude-code-2024-02-01",
    },
    body: JSON.stringify({
      model: "claude-3",
      max_tokens: 10,
      tools: [{ name: "mcp__tool", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hello" }],
    }),
  })
  const mcpJson = (await mcpResponse.json()) as { input_tokens: number }
  expect(mcpJson.input_tokens).toBeLessThan(regularJson.input_tokens)

  const grokResponse = await server.request("/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-1",
      max_tokens: 10,
      tools: [{ name: "tool", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hello" }],
    }),
  })
  const grokJson = (await grokResponse.json()) as { input_tokens: number }
  expect(typeof grokJson.input_tokens).toBe("number")
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

test("chat and responses routes forward handler errors", async () => {
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
