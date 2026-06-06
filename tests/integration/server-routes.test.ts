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

/**
 * Mock a single MCP request (initialize / notifications/initialized / tools/call /
 * DELETE teardown) given the request opts. `content` is the search text the
 * tools/call leg returns inside `inner.text.value`.
 */
function mcpResponse(
  opts: { body?: string; method?: string } | undefined,
  content: string,
): Response {
  if ((opts?.method ?? "GET") === "DELETE") {
    return new Response(null, { status: 204 })
  }
  let parsed: { method?: string; id?: number } = {}
  if (opts?.body) {
    try {
      parsed = JSON.parse(opts.body) as { method?: string; id?: number }
    } catch {
      // ignore
    }
  }
  if (parsed.method === "initialize") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2024-11-05", capabilities: {} },
      }),
      { status: 200, headers: { "mcp-session-id": "sid-test" } },
    )
  }
  if (parsed.method === "notifications/initialized") {
    return new Response(null, { status: 202 })
  }
  if (parsed.method === "tools/call") {
    const inner = JSON.stringify({
      type: "output_text",
      text: { value: content, annotations: [] },
    })
    const sse = `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: parsed.id,
      result: { content: [{ type: "text", text: inner }] },
    })}\n\n`
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }
  return new Response("unexpected MCP request", { status: 500 })
}

test("chat completions injects web search context and strips tools", async () => {
  resetState()
  let lastChatBody: string | undefined

  const fetchMock = mock(async (url: string, opts?: { body?: string; method?: string }) => {
    if (url.endsWith("/mcp")) {
      return mcpResponse(opts, "search result")
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

test("responses injects web search and strips tools", async () => {
  resetState()
  let lastBody: string | undefined

  const fetchMock = mock(async (url: string, opts?: { body?: string; method?: string }) => {
    if (url.endsWith("/mcp")) {
      return mcpResponse(opts, "search result")
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
  // max_output_tokens is no longer injected — Codex CLI relies on server defaults
  expect(forwarded.max_output_tokens).toBeUndefined()
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

  const fetchMock = mock(async (url: string, opts?: { body?: string; method?: string }) => {
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
    if (url.endsWith("/mcp")) {
      return mcpResponse(opts, "search")
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

test("telemetry stub returns 200 for malformed body without calling fetch", async () => {
  resetState()
  let fetchCalled = false
  const fetchMock = mock(() => {
    fetchCalled = true
    throw new Error("fetch must not be called for telemetry stub")
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  const response = await server.request("/api/event_logging/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid json",
  })

  expect(response.status).toBe(200)
  expect(fetchCalled).toBe(false)
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

test("messages stream pre-byte upstream error emits event:error on a 200 stream", async () => {
  resetState()

  // Upstream returns 200 SSE Content-Type but the body errors on the very
  // first read — the production failure mode where undici's TLSSocket close
  // fires before any chunk arrives.
  //
  // After dropping peekAndRelay (followup PR), pre-byte errors stay on the
  // 200 streaming path: the wrapper emits `event: error` and immediately
  // closes the stream. Anthropic SDKs that special-case `event: error`
  // surface our message; SDKs that don't fall back to socket-close handling
  // because the close immediately follows. Either path produces a clean
  // user-visible error — never a hang.
  const erroringBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError("terminated"))
    },
  })
  const fetchMock = mock((url: string) => {
    if (url.includes("/v1/messages")) {
      return new Response(erroringBody, {
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

  expect(response.status).toBe(200)
  // MUST consume the body via .text() to drive the wrapper's pull() loop —
  // otherwise pull is never invoked and we'd assert on an empty body.
  const body = await response.text()
  expect(body).toContain("event: error")
  expect(body).toContain('"type":"api_error"')
  expect(body).toContain("terminated")
})

test("messages stream mid-stream upstream error appends event:error to wire bytes", async () => {
  resetState()

  // Upstream yields two valid SSE events then errors. Wrapper must emit
  // both events plus a final `event: error` SSE frame.
  const ENC = new TextEncoder()
  const partialBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      controller.enqueue(
        ENC.encode(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"gpt-4","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
        ),
      )
      controller.enqueue(
        ENC.encode(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
        ),
      )
      // Now error mid-stream
      await new Promise((r) => setTimeout(r, 5))
      controller.error(new TypeError("terminated"))
    },
  })
  const fetchMock = mock((url: string) => {
    if (url.includes("/v1/messages")) {
      return new Response(partialBody, {
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
  expect(response.status).toBe(200)
  // Body must be consumed via .text() to drive the wrapper's pull() loop
  // — otherwise pull is never invoked and the test passes vacuously.
  const body = await response.text()
  expect(body).toContain("event: message_start")
  expect(body).toContain("event: content_block_delta")
  expect(body).toContain("event: error")
  expect(body).toContain('"type":"api_error"')
  expect(body).toContain("terminated")
})

// --- /mcp scoped + union routing (five-server split) ---
//
// The proxy mounts the MCP surface at `/mcp` (union — full tool surface)
// and `/mcp/<group>` (scoped — only that group's tools). The `claude`
// subcommand registers one mcpServers entry per group pointing at its
// scoped endpoint so the model namespaces tools as `mcp__<group>__<tool>`.
// These tests pin the routing contract through the full server: the
// scoped endpoint filters by group, the union exposes everything, and an
// unknown group is a routing-level 404 (-32601) before auth.

const MCP_NONCE = "0123456789abcdef".repeat(4)
const MCP_HOST = "127.0.0.1:8787"

async function mcpListNames(
  path: string,
): Promise<{ status: number; names?: Array<string>; error?: { code: number; message: string } }> {
  const res = await server.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MCP_NONCE}`,
      host: MCP_HOST,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })
  const json = (await res.json()) as {
    result?: { tools: Array<{ name: string }> }
    error?: { code: number; message: string }
  }
  return {
    status: res.status,
    names: json.result?.tools.map((t) => t.name),
    error: json.error,
  }
}

test("mcp scoped /mcp/search exposes only the search group's tools (code + web)", async () => {
  resetState()
  state.peerMcpNonce = MCP_NONCE
  // Pin worker / browser / stand_in gates off so the search group is the
  // deterministic {code, web} pair regardless of the host catalog.
  const savedDisableWorker = process.env.GH_ROUTER_DISABLE_WORKER_TOOLS
  process.env.GH_ROUTER_DISABLE_WORKER_TOOLS = "1"
  try {
    const { status, names } = await mcpListNames("/mcp/search")
    expect(status).toBe(200)
    expect([...(names ?? [])].sort()).toEqual(["code", "web"])
  } finally {
    state.peerMcpNonce = undefined
    if (savedDisableWorker === undefined) delete process.env.GH_ROUTER_DISABLE_WORKER_TOOLS
    else process.env.GH_ROUTER_DISABLE_WORKER_TOOLS = savedDisableWorker
  }
})

test("mcp scoped /mcp/peers exposes the persona critics, not the search tools", async () => {
  resetState()
  state.peerMcpNonce = MCP_NONCE
  try {
    const { status, names } = await mcpListNames("/mcp/peers")
    expect(status).toBe(200)
    // opus_critic is always registered; codex_critic + codex_reviewer too.
    // gemini_critic only appears when a gemini-3.x-pro model is in the
    // catalog (it isn't in this test's single-model state), so we don't
    // pin it. The search-group tools must NOT leak onto the peers scope.
    expect(names).toContain("codex_critic")
    expect(names).toContain("codex_reviewer")
    expect(names).toContain("opus_critic")
    expect(names).not.toContain("code")
    expect(names).not.toContain("web")
  } finally {
    state.peerMcpNonce = undefined
  }
})

test("mcp union /mcp exposes both peers and search tools together", async () => {
  resetState()
  state.peerMcpNonce = MCP_NONCE
  const savedDisableWorker = process.env.GH_ROUTER_DISABLE_WORKER_TOOLS
  process.env.GH_ROUTER_DISABLE_WORKER_TOOLS = "1"
  try {
    const { status, names } = await mcpListNames("/mcp")
    expect(status).toBe(200)
    // The union carries every enabled group's tools on one surface.
    expect(names).toContain("codex_critic")
    expect(names).toContain("code")
    expect(names).toContain("web")
  } finally {
    state.peerMcpNonce = undefined
    if (savedDisableWorker === undefined) delete process.env.GH_ROUTER_DISABLE_WORKER_TOOLS
    else process.env.GH_ROUTER_DISABLE_WORKER_TOOLS = savedDisableWorker
  }
})

test("mcp unknown group → 404 with JSON-RPC -32601 (validated AFTER auth)", async () => {
  resetState()
  // Group validation runs AFTER the nonce auth check (so an unauthenticated
  // probe can't enumerate valid vs. invalid groups). Supply a valid nonce so
  // we reach the post-auth scope check and observe the 404.
  state.peerMcpNonce = MCP_NONCE
  try {
    const res = await server.request("/mcp/bogus", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${MCP_NONCE}`,
        host: MCP_HOST,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(res.status).toBe(404)
    const json = (await res.json()) as {
      error?: { code: number; message: string }
    }
    expect(json.error?.code).toBe(-32601)
    expect(json.error?.message).toMatch(/unknown MCP group "bogus"/)
  } finally {
    state.peerMcpNonce = undefined
  }
})

test("mcp unknown group withOUT valid auth → auth failure, NOT a 404 oracle", async () => {
  resetState()
  // No nonce configured → checkAuth rejects. The response must be the SAME
  // auth failure a valid group would give (no pre-auth group enumeration).
  const res = await server.request("/mcp/bogus", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer wrong-nonce",
      host: MCP_HOST,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })
  // Whatever checkAuth returns for a bad nonce, it must NOT be the 404
  // unknown-group response (which would leak that "bogus" is invalid).
  expect(res.status).not.toBe(404)
})
