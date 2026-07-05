// Handler-level wiring guard for the Gemini chat path: a gemini request to
// /v1/messages is diverted to /chat/completions and translated back to the
// Anthropic shape (streaming + non-streaming), the ADVISOR gate also fails fast
// for the chat shim, and Claude still never hits /chat/completions.

import { afterEach, beforeEach, expect, test, describe } from "bun:test"

import { state } from "~/lib/state"
import { server } from "~/server"

const originalFetch = globalThis.fetch
let savedModels: typeof state.models

const claudeModel = {
  id: "claude-opus-4.7",
  name: "Claude Opus 4.7",
  object: "model",
  vendor: "anthropic",
  version: "1",
  preview: false,
  model_picker_enabled: true,
  capabilities: {
    family: "claude",
    object: "model",
    tokenizer: "claude",
    type: "chat",
    supports: {},
  },
  supported_endpoints: ["/v1/messages"],
}

const geminiModel = {
  id: "gemini-3.1-pro-preview",
  name: "Gemini 3.1 Pro",
  object: "model",
  vendor: "google",
  version: "1",
  preview: true,
  model_picker_enabled: true,
  capabilities: {
    family: "gemini",
    object: "model",
    tokenizer: "o200k_base",
    type: "chat",
    supports: { tool_calls: true, reasoning_effort: ["low", "medium", "high"] },
  },
  supported_endpoints: ["/chat/completions"],
}

function chatObjectResponse() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_1",
      object: "chat.completion",
      created: 0,
      model: "gemini-3.1-pro-preview",
      choices: [
        { index: 0, message: { role: "assistant", content: "shimmed" }, logprobs: null, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }),
    { headers: { "content-type": "application/json" } },
  )
}

beforeEach(() => {
  savedModels = state.models
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.models = { object: "list", data: [claudeModel, geminiModel] as never }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = savedModels
})

describe("/v1/messages gemini chat-shim routing", () => {
  test("non-streaming gemini request is diverted to /chat/completions and translated back to Anthropic", async () => {
    const urls: Array<string> = []
    let chatBody: Record<string, unknown> | undefined
    globalThis.fetch = ((url: string, opts?: { body?: string }) => {
      urls.push(url)
      if (url.includes("/chat/completions")) {
        chatBody = JSON.parse(opts?.body ?? "{}") as Record<string, unknown>
        return chatObjectResponse()
      }
      if (url.includes("/v1/messages")) throw new Error("gemini request must NOT hit native /v1/messages")
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.1-pro-preview",
        max_tokens: 256,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(urls.some((u) => u.includes("/chat/completions"))).toBe(true)
    expect(urls.some((u) => u.includes("/v1/messages"))).toBe(false)

    // Request was translated to chat/completions shape.
    expect(chatBody?.model).toBe("gemini-3.1-pro-preview")
    expect(chatBody?.max_tokens).toBe(256)
    expect(chatBody?.messages).toEqual([{ role: "user", content: "hi" }])

    // Response was translated back to an Anthropic Messages object.
    const body = (await res.json()) as {
      type: string
      content: Array<{ type: string; text: string }>
      stop_reason: string
    }
    expect(body.type).toBe("message")
    expect(body.content).toEqual([{ type: "text", text: "shimmed" }])
    expect(body.stop_reason).toBe("end_turn")
  })

  test("streaming gemini request produces Anthropic SSE from a chat/completions SSE stream", async () => {
    const chatEvents = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "he" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "llo" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } },
    ]
    const sseBody =
      chatEvents.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n"

    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(url)
      if (url.includes("/chat/completions")) {
        return new Response(sseBody, { headers: { "content-type": "text/event-stream" } })
      }
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        model: "gemini-3.1-pro-preview",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(urls.some((u) => u.includes("/chat/completions"))).toBe(true)

    const text = await res.text()
    expect(text).toContain("event: message_start\n")
    expect(text).toContain('"type":"text_delta","text":"he"')
    expect(text).toContain('"type":"text_delta","text":"llo"')
    expect(text).toContain("event: message_delta\n")
    expect(text).toContain('"stop_reason":"end_turn"')
    expect(text).toContain("event: message_stop\n")
  })

  test("gemini + ADVISOR beta → gracefully degrades to the /chat/completions shim (advisor tool stripped, NOT a 400)", async () => {
    // Advisor is a Claude-only feature (its server-side translate-loop only
    // exists on native /v1/messages). The chat shim now strips the injected
    // __anthropic_advisor tool and forwards instead of 400ing every request.
    const urls: Array<string> = []
    let chatBody: Record<string, unknown> | undefined
    globalThis.fetch = ((url: string, opts?: { body?: string }) => {
      urls.push(url)
      if (url.includes("/chat/completions")) {
        chatBody = JSON.parse(opts?.body ?? "{}") as Record<string, unknown>
        return chatObjectResponse()
      }
      if (url.includes("/v1/messages")) throw new Error("gemini request must NOT hit native /v1/messages")
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "advisor-tool-2026-03-01",
      },
      body: JSON.stringify({
        model: "gemini-3.1-pro-preview",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        // Injection is idempotent; include the advisor tool + a benign tool to
        // prove the advisor one is stripped while the other survives.
        tools: [
          {
            name: "__anthropic_advisor",
            description: "advisor",
            input_schema: { type: "object", properties: {}, required: [] },
          },
          {
            name: "get_weather",
            description: "get the weather",
            input_schema: { type: "object", properties: {}, required: [] },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(urls.some((u) => u.includes("/chat/completions"))).toBe(true)
    expect(urls.some((u) => u.includes("/v1/messages"))).toBe(false)

    const forwarded = JSON.stringify(chatBody)
    expect(forwarded).not.toContain("__anthropic_advisor")
    expect(forwarded).toContain("get_weather")
  })

  test("base64 document block degrades to a delimited text note before forwarding", async () => {
    const urls: Array<string> = []
    let chatBody: Record<string, unknown> | undefined
    globalThis.fetch = ((url: string, opts?: { body?: string }) => {
      urls.push(url)
      if (url.includes("/chat/completions")) {
        chatBody = JSON.parse(opts?.body ?? "{}") as Record<string, unknown>
        return chatObjectResponse()
      }
      if (url.includes("/v1/messages")) throw new Error("gemini request must NOT hit native /v1/messages")
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.1-pro-preview",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Read this first:" },
              {
                type: "document",
                title: "smoke.pdf",
                source: { type: "base64", media_type: "application/pdf", data: "JVBERi0x" },
              },
              { type: "text", text: "What does it say?" },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(urls.some((u) => u.includes("/chat/completions"))).toBe(true)
    expect(urls.some((u) => u.includes("/v1/messages"))).toBe(false)
    expect(chatBody?.messages).toEqual([
      {
        role: "user",
        content:
          'Read this first:\n[document "smoke.pdf" attached but not supported for this model]\nWhat does it say?',
      },
    ])

    const forwarded = JSON.stringify(chatBody)
    expect(forwarded).toContain("[document")
    expect(forwarded).toContain("smoke.pdf")
    expect(forwarded).toContain("attached but not supported for this model")
    expect(forwarded).not.toContain("JVBERi0x")
    expect(forwarded).not.toContain('"type":"file"')
    expect(forwarded).not.toContain("input_file")
    expect(forwarded).not.toContain("file_data")

    const body = (await res.json()) as {
      type: string
      content: Array<{ type: string; text: string }>
      stop_reason: string
    }
    expect(body.type).toBe("message")
    expect(body.content).toEqual([{ type: "text", text: "shimmed" }])
    expect(body.stop_reason).toBe("end_turn")
  })

  test("base64 image block forwards as an image_url content part", async () => {
    const urls: Array<string> = []
    let chatBody: Record<string, unknown> | undefined
    globalThis.fetch = ((url: string, opts?: { body?: string }) => {
      urls.push(url)
      if (url.includes("/chat/completions")) {
        chatBody = JSON.parse(opts?.body ?? "{}") as Record<string, unknown>
        return chatObjectResponse()
      }
      if (url.includes("/v1/messages")) throw new Error("gemini request must NOT hit native /v1/messages")
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.1-pro-preview",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(urls.some((u) => u.includes("/chat/completions"))).toBe(true)
    expect(urls.some((u) => u.includes("/v1/messages"))).toBe(false)
    expect(chatBody?.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
        ],
      },
    ])

    const body = (await res.json()) as {
      type: string
      content: Array<{ type: string; text: string }>
      stop_reason: string
    }
    expect(body.type).toBe("message")
    expect(body.content).toEqual([{ type: "text", text: "shimmed" }])
    expect(body.stop_reason).toBe("end_turn")
  })

  test("tool_result is_error true forwards as a tool error message", async () => {
    const urls: Array<string> = []
    let chatBody: Record<string, unknown> | undefined
    globalThis.fetch = ((url: string, opts?: { body?: string }) => {
      urls.push(url)
      if (url.includes("/chat/completions")) {
        chatBody = JSON.parse(opts?.body ?? "{}") as Record<string, unknown>
        return chatObjectResponse()
      }
      if (url.includes("/v1/messages")) throw new Error("gemini request must NOT hit native /v1/messages")
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.1-pro-preview",
        max_tokens: 64,
        messages: [
          { role: "user", content: "Divide 1 by 0" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_divide", name: "divide", input: { a: 1, b: 0 } },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_divide",
                is_error: true,
                content: "division by zero",
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(urls.some((u) => u.includes("/chat/completions"))).toBe(true)
    expect(urls.some((u) => u.includes("/v1/messages"))).toBe(false)
    expect(chatBody?.messages).toEqual([
      { role: "user", content: "Divide 1 by 0" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "toolu_divide",
            type: "function",
            function: { name: "divide", arguments: '{"a":1,"b":0}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "toolu_divide", content: "[tool error] division by zero" },
    ])

    const body = (await res.json()) as {
      type: string
      content: Array<{ type: string; text: string }>
      stop_reason: string
    }
    expect(body.type).toBe("message")
    expect(body.content).toEqual([{ type: "text", text: "shimmed" }])
    expect(body.stop_reason).toBe("end_turn")
  })

  test("non-streaming tool call response becomes a tool_use block", async () => {
    const urls: Array<string> = []
    let chatBody: Record<string, unknown> | undefined
    globalThis.fetch = ((url: string, opts?: { body?: string }) => {
      urls.push(url)
      if (url.includes("/chat/completions")) {
        chatBody = JSON.parse(opts?.body ?? "{}") as Record<string, unknown>
        return new Response(
          JSON.stringify({
            id: "chatcmpl_tool",
            object: "chat.completion",
            created: 0,
            model: "gemini-3.1-pro-preview",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_weather_1",
                      type: "function",
                      function: { name: "get_weather", arguments: '{"location":"Paris","unit":"c"}' },
                    },
                  ],
                },
                logprobs: null,
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 3 },
          }),
          { headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/v1/messages")) throw new Error("gemini request must NOT hit native /v1/messages")
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.1-pro-preview",
        max_tokens: 64,
        messages: [{ role: "user", content: "weather in Paris" }],
        tools: [
          {
            name: "get_weather",
            description: "get the weather",
            input_schema: {
              type: "object",
              properties: { location: { type: "string" }, unit: { type: "string" } },
              required: ["location"],
            },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(urls.some((u) => u.includes("/chat/completions"))).toBe(true)
    expect(urls.some((u) => u.includes("/v1/messages"))).toBe(false)
    expect(chatBody?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "get the weather",
          parameters: {
            type: "object",
            properties: { location: { type: "string" }, unit: { type: "string" } },
            required: ["location"],
          },
        },
      },
    ])
    expect(chatBody?.tool_choice).toBe("auto")

    const body = (await res.json()) as {
      type: string
      content: Array<Record<string, unknown>>
      stop_reason: string
      usage: Record<string, unknown>
    }
    expect(body.type).toBe("message")
    expect(body.content).toEqual([
      {
        type: "tool_use",
        id: "call_weather_1",
        name: "get_weather",
        input: { location: "Paris", unit: "c" },
      },
    ])
    expect(body.stop_reason).toBe("tool_use")
    expect(body.usage).toEqual({
      input_tokens: 7,
      output_tokens: 3,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  })

  test("GUARD: a claude request NEVER hits /chat/completions", async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(url)
      if (url.includes("/chat/completions")) throw new Error("Claude request must NOT hit /chat/completions")
      if (url.includes("/v1/messages")) {
        return new Response(
          JSON.stringify({
            id: "msg_native",
            type: "message",
            role: "assistant",
            model: "claude-opus-4.7",
            content: [{ type: "text", text: "native" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 2, output_tokens: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        )
      }
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(urls.some((u) => u.includes("/v1/messages"))).toBe(true)
    expect(urls.some((u) => u.includes("/chat/completions"))).toBe(false)
  })
})
