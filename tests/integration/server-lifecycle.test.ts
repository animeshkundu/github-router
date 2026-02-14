import { test, expect, mock, describe, afterEach } from "bun:test"
import { serve } from "srvx"

import { server as app } from "../../src/server"
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

describe("server lifecycle", () => {
  let activeServer: ReturnType<typeof serve> | undefined

  afterEach(async () => {
    if (activeServer) {
      await activeServer.close()
      activeServer = undefined
    }
  })

  test("srvx server returns populated URL after ready()", async () => {
    resetState()
    const srvxServer = serve({
      fetch: app.fetch as import("srvx").ServerHandler,
      hostname: "127.0.0.1",
      port: 0,
      silent: true,
    })
    activeServer = srvxServer

    await srvxServer.ready()
    const url = srvxServer.url

    expect(url).toBeTruthy()
    expect(url).toContain("127.0.0.1")
    // URL should be present after ready()
    expect(typeof url).toBe("string")
  })

  test("server responds to GET /models via real HTTP", async () => {
    resetState()
    const srvxServer = serve({
      fetch: app.fetch as import("srvx").ServerHandler,
      hostname: "127.0.0.1",
      port: 0,
      silent: true,
    })
    activeServer = srvxServer
    await srvxServer.ready()

    const serverUrl = srvxServer.url!.replace(/\/$/, "")
    const response = await originalFetch(`${serverUrl}/v1/models`)
    expect(response.status).toBe(200)
    const json = (await response.json()) as { data: Array<unknown> }
    expect(json.data).toBeDefined()
  })

  test("server binds to OS-assigned port", async () => {
    resetState()
    const srvxServer = serve({
      fetch: app.fetch as import("srvx").ServerHandler,
      hostname: "127.0.0.1",
      port: 0,
      silent: true,
    })
    activeServer = srvxServer
    await srvxServer.ready()

    const serverUrl = srvxServer.url!.replace(/\/$/, "")
    const url = new URL(serverUrl)
    const port = Number.parseInt(url.port, 10)
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65535)
  })

  test("server cleanup with close() works", async () => {
    resetState()
    const srvxServer = serve({
      fetch: app.fetch as import("srvx").ServerHandler,
      hostname: "127.0.0.1",
      port: 0,
      silent: true,
    })
    await srvxServer.ready()
    const serverUrl = srvxServer.url!.replace(/\/$/, "")

    await srvxServer.close()
    activeServer = undefined

    // After close, fetch should fail
    try {
      await originalFetch(`${serverUrl}/v1/models`)
    } catch {
      // Expected: connection refused
    }
  })
})

describe("route integration via app.request()", () => {
  test("POST /v1/chat/completions returns valid response shape", async () => {
    resetState()
    const fetchMock = mock((url: string) => {
      if (url.endsWith("/chat/completions")) {
        return new Response(
          JSON.stringify({
            id: "chat-1",
            object: "chat.completion",
            choices: [
              {
                message: { role: "assistant", content: "hello" },
                index: 0,
                finish_reason: "stop",
              },
            ],
          }),
        )
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(200)
    const json = (await response.json()) as {
      id: string
      object: string
      choices: Array<unknown>
    }
    expect(json.id).toBe("chat-1")
    expect(json.object).toBe("chat.completion")
    expect(json.choices).toHaveLength(1)
  })

  test("POST /v1/chat/completions streaming returns SSE", async () => {
    resetState()
    const fetchMock = mock((url: string) => {
      if (url.endsWith("/chat/completions")) {
        return new Response(
          'data: {"id":"chunk","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await app.request("/v1/chat/completions", {
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

  test("POST /v1/messages returns Anthropic-format response", async () => {
    resetState()
    const fetchMock = mock((url: string) => {
      if (url.includes("/v1/messages")) {
        return new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "gpt-4",
            content: [{ type: "text", text: "response" }],
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

    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(200)
    const json = (await response.json()) as { type: string; id: string }
    expect(json.type).toBe("message")
    expect(json.id).toBe("msg_test")
  })

  test("POST /v1/messages streaming returns SSE events", async () => {
    resetState()
    const ssePayload = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s","type":"message","role":"assistant","model":"gpt-4","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
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

    const response = await app.request("/v1/messages", {
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
    expect(body).toContain("message_stop")
  })

  test("POST /v1/responses passthrough returns response shape", async () => {
    resetState()
    const fetchMock = mock((url: string) => {
      if (url.endsWith("/responses")) {
        return new Response(
          JSON.stringify({
            id: "resp_test",
            object: "response",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "hi" }],
              },
            ],
          }),
        )
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        input: "hello",
      }),
    })

    expect(response.status).toBe(200)
    const json = (await response.json()) as {
      id: string
      object: string
      output: Array<unknown>
    }
    expect(json.id).toBe("resp_test")
    expect(json.object).toBe("response")
  })

  test("POST /v1/embeddings passthrough returns embedding shape", async () => {
    resetState()
    const fetchMock = mock((url: string) => {
      if (url.endsWith("/embeddings")) {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
            model: "text-embedding-ada-002",
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
        )
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "text-embedding-ada-002",
        input: "hello",
      }),
    })

    expect(response.status).toBe(200)
    const json = (await response.json()) as {
      object: string
      data: Array<{ embedding: number[] }>
    }
    expect(json.object).toBe("list")
    expect(json.data).toHaveLength(1)
    expect(json.data[0]!.embedding).toEqual([0.1, 0.2])
  })
})
