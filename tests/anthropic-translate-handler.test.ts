// Handler-level non-regression guard: verifies the branch point in
// src/routes/messages/handler.ts routes by model — Claude models hit the
// native /v1/messages passthrough (createMessages), non-Claude /responses
// models (gpt-5.5) are diverted to the translation shim (/responses).

import { afterEach, beforeEach, expect, test, describe } from "bun:test"

import { state } from "~/lib/state"
import { server } from "~/server"

const originalFetch = globalThis.fetch
let savedModels: typeof state.models
let savedGithubToken: typeof state.githubToken

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

const gptModel = {
  id: "gpt-5.5",
  name: "GPT 5.5",
  object: "model",
  vendor: "openai",
  version: "1",
  preview: false,
  model_picker_enabled: true,
  capabilities: {
    family: "gpt",
    object: "model",
    tokenizer: "o200k_base",
    type: "chat",
    supports: { tool_calls: true, vision: true, reasoning_effort: ["low", "medium", "high", "xhigh"] },
    limits: {
      vision: {
        max_prompt_images: 1,
        max_prompt_image_size: 3145728,
        supported_media_types: ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"],
      },
    },
  },
  supported_endpoints: ["/responses"],
}

const gptSolModel = {
  ...gptModel,
  id: "gpt-5.6-sol",
  name: "GPT 5.6 SOL",
  capabilities: {
    ...gptModel.capabilities,
    supports: { tool_calls: true, vision: true, reasoning_effort: ["high", "xhigh"] },
  },
}

function anthropicPassthroughResponse() {
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

function responsesObjectResponse() {
  return new Response(
    JSON.stringify({
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "shimmed" }] },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    }),
    { headers: { "content-type": "application/json" } },
  )
}

function responsesToolCallResponse() {
  return new Response(
    JSON.stringify({
      id: "resp_tool",
      object: "response",
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "fc_weather",
          call_id: "call_weather",
          name: "get_weather",
          arguments: JSON.stringify({ city: "Paris", unit: "celsius" }),
        },
      ],
      usage: { input_tokens: 9, output_tokens: 4 },
    }),
    { headers: { "content-type": "application/json" } },
  )
}

function responsesSseResponse(events: Array<Record<string, unknown>>) {
  const sseBody =
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(sseBody, { headers: { "content-type": "text/event-stream" } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function recordFrom(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  throw new Error("expected object")
}

function arrayFrom(value: unknown): Array<unknown> {
  if (Array.isArray(value)) return value
  throw new Error("expected array")
}

function stringFrom(value: unknown): string {
  if (typeof value === "string") return value
  throw new Error("expected string")
}

function numberFrom(value: unknown): number {
  if (typeof value === "number") return value
  throw new Error("expected number")
}

function parseRequestBody(opts?: { body?: string }): Record<string, unknown> {
  return recordFrom(JSON.parse(opts?.body ?? "{}") as unknown)
}

function parseAnthropicSseData(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const frame of text.split("\n\n")) {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "))
    if (!dataLine) continue
    const data = dataLine.slice("data: ".length)
    if (data === "[DONE]") continue
    out.push(recordFrom(JSON.parse(data) as unknown))
  }
  return out
}

function collectInputParts(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = []
  const input = payload.input
  if (!Array.isArray(input)) return parts
  for (const item of input) {
    if (!isRecord(item)) continue
    const content = item.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (isRecord(part)) parts.push(part)
    }
  }
  return parts
}

beforeEach(() => {
  savedModels = state.models
  savedGithubToken = state.githubToken
  state.copilotToken = "test-token"
  state.githubToken = "test-gh-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.models = { object: "list", data: [claudeModel, gptModel] as never }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = savedModels
  state.githubToken = savedGithubToken
})

describe("/v1/messages branch routing", () => {
  test("GUARD: claude-* request goes to native /v1/messages, NEVER the /responses shim", async () => {
    const urls: Array<string> = []
    globalThis.fetch =((url: string) => {
      urls.push(url)
      if (url.includes("/responses")) throw new Error("Claude request must NOT hit /responses")
      if (url.includes("/v1/messages")) return anthropicPassthroughResponse()
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
    const body = (await res.json()) as { id: string; content: Array<{ text: string }> }
    // Passthrough returns the upstream Anthropic object verbatim.
    expect(body.id).toBe("msg_native")
    expect(body.content[0].text).toBe("native")
    expect(urls.some((u) => u.includes("/v1/messages"))).toBe(true)
    expect(urls.some((u) => u.includes("/responses"))).toBe(false)
  })

  test("gpt-5.5 non-streaming request is diverted to /responses and translated back to Anthropic shape", async () => {
    const urls: Array<string> = []
    let responsesBody: Record<string, unknown> | undefined
    globalThis.fetch =((url: string, opts?: { body?: string }) => {
      urls.push(url)
      if (url.includes("/responses")) {
        responsesBody = JSON.parse(opts?.body ?? "{}") as Record<string, unknown>
        return responsesObjectResponse()
      }
      if (url.includes("/v1/messages")) throw new Error("gpt request must NOT hit native /v1/messages")
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 256,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(urls.some((u) => u.includes("/responses"))).toBe(true)
    expect(urls.some((u) => u.includes("/v1/messages"))).toBe(false)

    // Request was translated to Responses shape.
    expect(responsesBody?.model).toBe("gpt-5.5")
    expect(responsesBody?.max_output_tokens).toBe(256)
    expect(responsesBody?.input).toEqual([{ role: "user", content: "hi" }])

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

  test("gpt-5.5 streaming request produces Anthropic SSE from a /responses SSE stream", async () => {
    const responsesEvents = [
      { type: "response.created", response: { status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m0" } },
      { type: "response.output_text.delta", output_index: 0, delta: "he" },
      { type: "response.output_text.delta", output_index: 0, delta: "llo" },
      { type: "response.output_text.done", output_index: 0, text: "hello" },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 4, output_tokens: 2 } } },
    ]
    const sseBody =
      responsesEvents.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n"

    const urls: Array<string> = []
    globalThis.fetch =((url: string) => {
      urls.push(url)
      if (url.includes("/responses")) {
        return new Response(sseBody, { headers: { "content-type": "text/event-stream" } })
      }
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(urls.some((u) => u.includes("/responses"))).toBe(true)

    const text = await res.text()
    expect(text).toContain("event: message_start\n")
    expect(text).toContain('"type":"text_delta","text":"he"')
    expect(text).toContain('"type":"text_delta","text":"llo"')
    expect(text).toContain("event: message_delta\n")
    expect(text).toContain('"stop_reason":"end_turn"')
    expect(text).toContain("event: message_stop\n")
  })

  test("gpt-5.5 + ADVISOR beta → gracefully degrades to the /responses shim (advisor tool stripped, NOT a 400)", async () => {
    // The `claude` launcher auto-enables the advisor beta, so a non-Claude
    // model chosen via `-m gpt-5.5` (or switched at runtime via /model) would
    // 400 on EVERY request under the old fail-fast. The handler now strips the
    // injected __anthropic_advisor tool (advisor is a Claude-only feature — its
    // server-side translate-loop only exists on native /v1/messages) and
    // forwards to the shim so the request succeeds.
    const urls: Array<string> = []
    let responsesBody: Record<string, unknown> | undefined
    globalThis.fetch =((url: string, opts?: { body?: string }) => {
      urls.push(url)
      if (url.includes("/responses")) {
        responsesBody = JSON.parse(opts?.body ?? "{}") as Record<string, unknown>
        return responsesObjectResponse()
      }
      if (url.includes("/v1/messages")) throw new Error("gpt request must NOT hit native /v1/messages")
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "advisor-tool-2026-03-01",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        // The proxy injects __anthropic_advisor when the advisor beta is
        // present; include it explicitly (injection is idempotent) alongside a
        // benign tool so the assertion proves the advisor tool is STRIPPED
        // while the other tool survives to the shim.
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

    // Degrades to the shim rather than 400ing.
    expect(res.status).toBe(200)
    expect(urls.some((u) => u.includes("/responses"))).toBe(true)
    expect(urls.some((u) => u.includes("/v1/messages"))).toBe(false)

    // The forwarded /responses request has the advisor tool stripped; the
    // benign tool survives.
    const forwarded = JSON.stringify(responsesBody)
    expect(forwarded).not.toContain("__anthropic_advisor")
    expect(forwarded).toContain("get_weather")
  })

  test("stripAdvisorTool tolerates a null tools[] entry (no TypeError/500)", async () => {
    // Regression: the tool_choice reconciliation must not dereference a null
    // tools[] element. A malformed `tools:[null, ...]` with a tool_choice that
    // forces a missing tool previously threw a TypeError → unhandled 500.
    const urls: Array<string> = []
    globalThis.fetch =((url: string) => {
      urls.push(url)
      if (url.includes("/responses")) return responsesObjectResponse()
      if (url.includes("/v1/messages")) throw new Error("gpt must NOT hit native /v1/messages")
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-beta": "advisor-tool-2026-03-01" },
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          null,
          { name: "__anthropic_advisor", description: "advisor", input_schema: { type: "object", properties: {} } },
          { name: "get_weather", description: "weather", input_schema: { type: "object", properties: {} } },
        ],
        // Forces a tool that won't be present after the strip → the some()
        // reconciliation iterates every element, including the null.
        tool_choice: { type: "tool", name: "nonexistent_tool" },
      }),
    })

    // No crash: routes to the shim with a clean 200.
    expect(res.status).toBe(200)
    expect(urls.some((u) => u.includes("/responses"))).toBe(true)
  })

  test("advisor tool is stripped on the shim path even WITHOUT the advisor beta (defense-in-depth)", async () => {
    // The reserved __anthropic_advisor tool is a proxy-internal contract with no
    // handler off the Claude path; it must never reach gpt/gemini even if a
    // hand-crafted client sends it without the advisor beta.
    const urls: Array<string> = []
    let responsesBody: Record<string, unknown> | undefined
    globalThis.fetch =((url: string, opts?: { body?: string }) => {
      urls.push(url)
      if (url.includes("/responses")) {
        responsesBody = JSON.parse(opts?.body ?? "{}") as Record<string, unknown>
        return responsesObjectResponse()
      }
      if (url.includes("/v1/messages")) throw new Error("gpt must NOT hit native /v1/messages")
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" }, // NO advisor beta
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { name: "__anthropic_advisor", description: "advisor", input_schema: { type: "object", properties: {} } },
          { name: "get_weather", description: "weather", input_schema: { type: "object", properties: {} } },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const forwarded = JSON.stringify(responsesBody)
    expect(forwarded).not.toContain("__anthropic_advisor")
    expect(forwarded).toContain("get_weather")
  })

  test("GUARD (#2): a Claude-prefixed alias that resolveModel maps onto a non-Claude /responses model stays on native passthrough (original id reaches the classifier)", async () => {
    // Adversarial routing case. The ORIGINAL request model is Claude-like
    // (`claude-codex`), but resolveModel's codex-family preference resolves it
    // onto a non-Claude /responses catalog model (`gpt-5.3-codex`). The
    // classifier must STILL return "claude-passthrough" because its 3rd
    // argument — the pre-resolution original id — is Claude-like (fail-closed to
    // Claude, never diverted to the shim). This only holds if handler.ts
    // forwards the original id to classifyMessagesRoute (fix #2); without it the
    // request would classify as "responses-shim" and wrongly hit /responses.
    const codexModel = {
      ...gptModel,
      id: "gpt-5.3-codex",
      name: "GPT 5.3 Codex",
      capabilities: { ...gptModel.capabilities, family: "gpt" },
    }
    state.models = {
      object: "list",
      data: [claudeModel, gptModel, codexModel] as never,
    }

    const urls: Array<string> = []
    globalThis.fetch =((url: string) => {
      urls.push(url)
      if (url.includes("/responses")) {
        throw new Error(
          "Claude-prefixed alias must NOT hit /responses — the original id must reach the classifier",
        )
      }
      if (url.includes("/v1/messages")) return anthropicPassthroughResponse()
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-codex",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string }
    // Passthrough returns the upstream Anthropic object verbatim.
    expect(body.id).toBe("msg_native")
    expect(urls.some((u) => u.includes("/v1/messages"))).toBe(true)
    expect(urls.some((u) => u.includes("/responses"))).toBe(false)
  })

  test("gpt-5.5 streaming parallel function calls emit complete tool_use blocks", async () => {
    const responsesEvents = [
      { type: "response.created", response: { status: "in_progress" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_first", call_id: "call_first", name: "first_tool" },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", id: "fc_second", call_id: "call_second", name: "second_tool" },
      },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_first", delta: "{\"alpha\":" },
      { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_second", delta: "{\"beta\":" },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_first", delta: "\"one\",\"n\":1}" },
      { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_second", delta: "\"two\",\"flag\":true}" },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: "fc_first",
        arguments: JSON.stringify({ alpha: "one", n: 1 }),
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 1,
        item_id: "fc_second",
        arguments: JSON.stringify({ beta: "two", flag: true }),
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_first",
          call_id: "call_first",
          name: "first_tool",
          arguments: JSON.stringify({ alpha: "one", n: 1 }),
        },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_second",
          call_id: "call_second",
          name: "second_tool",
          arguments: JSON.stringify({ beta: "two", flag: true }),
        },
      },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 12, output_tokens: 6 } } },
    ]

    const urls: Array<string> = []
    globalThis.fetch =((url: string) => {
      urls.push(url)
      if (url.includes("/responses")) return responsesSseResponse(responsesEvents)
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "call both tools" }],
        tools: [
          {
            name: "first_tool",
            description: "first",
            input_schema: { type: "object", properties: { alpha: { type: "string" }, n: { type: "number" } } },
          },
          {
            name: "second_tool",
            description: "second",
            input_schema: { type: "object", properties: { beta: { type: "string" }, flag: { type: "boolean" } } },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(urls.some((u) => u.includes("/responses"))).toBe(true)

    const text = await res.text()
    const events = parseAnthropicSseData(text)
    const toolStarts: Array<{ index: number; id: string; name: string }> = []
    const partialsByIndex = new Map<number, string>()
    for (const ev of events) {
      if (ev.type === "content_block_start") {
        const block = recordFrom(ev.content_block)
        if (block.type === "tool_use") {
          toolStarts.push({
            index: numberFrom(ev.index),
            id: stringFrom(block.id),
            name: stringFrom(block.name),
          })
        }
      } else if (ev.type === "content_block_delta") {
        const delta = recordFrom(ev.delta)
        if (delta.type === "input_json_delta") {
          const index = numberFrom(ev.index)
          partialsByIndex.set(index, (partialsByIndex.get(index) ?? "") + stringFrom(delta.partial_json))
        }
      }
    }

    expect(toolStarts).toHaveLength(2)
    expect(new Set(toolStarts.map((tool) => tool.index)).size).toBe(2)

    const argsByName = new Map<string, Record<string, unknown>>()
    for (const tool of toolStarts) {
      expect(tool.id.length).toBeGreaterThan(0)
      const partialJson = partialsByIndex.get(tool.index) ?? ""
      expect(partialJson.length).toBeGreaterThan(2)
      const parsed = recordFrom(JSON.parse(partialJson) as unknown)
      expect(Object.keys(parsed).length).toBeGreaterThan(0)
      argsByName.set(tool.name, parsed)
    }
    expect(argsByName.get("first_tool")).toEqual({ alpha: "one", n: 1 })
    expect(argsByName.get("second_tool")).toEqual({ beta: "two", flag: true })
    expect(text).toContain('"stop_reason":"tool_use"')
  })

  test("gpt-5.5 document block forwards as Responses input_file file_data", async () => {
    const pdfData = "JVBERi0xLjQKJcTl8uXr"
    let responsesBody: Record<string, unknown> | undefined
    globalThis.fetch =((url: string, opts?: { body?: string }) => {
      if (url.includes("/responses")) {
        responsesBody = parseRequestBody(opts)
        return responsesObjectResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarize this" },
              {
                type: "document",
                title: "brief.pdf",
                source: { type: "base64", media_type: "application/pdf", data: pdfData },
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const parts = collectInputParts(recordFrom(responsesBody))
    const files = parts.filter((part) => part.type === "input_file")
    expect(files).toHaveLength(1)
    const file = recordFrom(files[0])
    expect(file.filename).toBe("brief.pdf")
    expect(file.file_data).toBe(`data:application/pdf;base64,${pdfData}`)
  })

  test("gpt-5.5 image block forwards as Responses input_image", async () => {
    const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAE="
    let responsesBody: Record<string, unknown> | undefined
    globalThis.fetch =((url: string, opts?: { body?: string }) => {
      if (url.includes("/responses")) {
        responsesBody = parseRequestBody(opts)
        return responsesObjectResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is in this image?" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: imageData } },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const parts = collectInputParts(recordFrom(responsesBody))
    const images = parts.filter((part) => part.type === "input_image")
    expect(images).toHaveLength(1)
    const image = recordFrom(images[0])
    expect(image.image_url).toBe(`data:image/png;base64,${imageData}`)
  })

  test("gpt-5.6-sol without thinking defaults Responses reasoning effort to high", async () => {
    state.models = { object: "list", data: [claudeModel, gptModel, gptSolModel] as never }
    let responsesBody: Record<string, unknown> | undefined
    globalThis.fetch =((url: string, opts?: { body?: string }) => {
      if (url.includes("/responses")) {
        responsesBody = parseRequestBody(opts)
        return responsesObjectResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        max_tokens: 64,
        messages: [{ role: "user", content: "reason deeply" }],
      }),
    })

    expect(res.status).toBe(200)
    const reasoning = recordFrom(recordFrom(responsesBody).reasoning)
    expect(reasoning.effort).toBe("high")
  })

  test("frontier xhigh opt-IN restores xhigh effort", async () => {
    state.models = { object: "list", data: [claudeModel, gptModel, gptSolModel] as never }
    let responsesBody: Record<string, unknown> | undefined
    globalThis.fetch =((url: string, opts?: { body?: string }) => {
      if (url.includes("/responses")) {
        responsesBody = parseRequestBody(opts)
        return responsesObjectResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const saved = process.env.GH_ROUTER_FRONTIER_XHIGH_DEFAULT
    process.env.GH_ROUTER_FRONTIER_XHIGH_DEFAULT = "1"
    try {
      const res = await server.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          max_tokens: 64,
          messages: [{ role: "user", content: "reason normally" }],
        }),
      })

      expect(res.status).toBe(200)
      const reasoning = recordFrom(recordFrom(responsesBody).reasoning)
      expect(reasoning.effort).toBe("xhigh")
    } finally {
      if (saved === undefined) {
        delete process.env.GH_ROUTER_FRONTIER_XHIGH_DEFAULT
      } else {
        process.env.GH_ROUTER_FRONTIER_XHIGH_DEFAULT = saved
      }
    }
  })

  test("gpt-5.6-sol explicit thinking budget is not overridden by the injected default", async () => {
    state.models = { object: "list", data: [claudeModel, gptModel, gptSolModel] as never }
    let responsesBody: Record<string, unknown> | undefined
    globalThis.fetch =((url: string, opts?: { body?: string }) => {
      if (url.includes("/responses")) {
        responsesBody = parseRequestBody(opts)
        return responsesObjectResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        max_tokens: 64,
        thinking: { type: "enabled", budget_tokens: 1000 },
        messages: [{ role: "user", content: "think briefly" }],
      }),
    })

    expect(res.status).toBe(200)
    const reasoning = recordFrom(recordFrom(responsesBody).reasoning)
    expect(reasoning.effort).toBe("high")
  })

  test("gpt-5.5 thinking budget maps to Responses reasoning effort", async () => {
    let responsesBody: Record<string, unknown> | undefined
    globalThis.fetch =((url: string, opts?: { body?: string }) => {
      if (url.includes("/responses")) {
        responsesBody = parseRequestBody(opts)
        return responsesObjectResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 64,
        thinking: { type: "enabled", budget_tokens: 1000 },
        messages: [{ role: "user", content: "think briefly" }],
      }),
    })

    expect(res.status).toBe(200)
    const payload = recordFrom(responsesBody)
    const reasoning = recordFrom(payload.reasoning)
    expect(reasoning.effort).toBe("low")
  })

  test("gpt-5.5 max_tokens below Responses minimum is clamped upstream", async () => {
    let responsesBody: Record<string, unknown> | undefined
    globalThis.fetch =((url: string, opts?: { body?: string }) => {
      if (url.includes("/responses")) {
        responsesBody = parseRequestBody(opts)
        return responsesObjectResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 1,
        messages: [{ role: "user", content: "short" }],
      }),
    })

    expect(res.status).toBe(200)
    const payload = recordFrom(responsesBody)
    expect(numberFrom(payload.max_output_tokens)).toBeGreaterThanOrEqual(16)
  })

  test("gpt-5.5 non-streaming function_call returns an Anthropic tool_use block", async () => {
    let responsesBody: Record<string, unknown> | undefined
    globalThis.fetch =((url: string, opts?: { body?: string }) => {
      if (url.includes("/responses")) {
        responsesBody = parseRequestBody(opts)
        return responsesToolCallResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 64,
        messages: [{ role: "user", content: "what is the weather?" }],
        tools: [
          {
            name: "get_weather",
            description: "get the weather",
            input_schema: {
              type: "object",
              properties: { city: { type: "string" }, unit: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.stringify(responsesBody)).toContain("get_weather")
    const body = recordFrom(await res.json())
    expect(body.stop_reason).toBe("tool_use")
    const content = arrayFrom(body.content)
    expect(content).toHaveLength(1)
    const tool = recordFrom(content[0])
    expect(tool.type).toBe("tool_use")
    expect(tool.id).toBe("call_weather")
    expect(tool.name).toBe("get_weather")
    expect(recordFrom(tool.input)).toEqual({ city: "Paris", unit: "celsius" })
  })

  test("gpt-5.5 web_search tool is handled then stripped before Responses shim", async () => {
    const urls: Array<string> = []
    let responsesBody: Record<string, unknown> | undefined
    globalThis.fetch =((url: string, opts?: { body?: string; method?: string }) => {
      urls.push(url)
      if (url.includes("/mcp")) {
        if (opts?.method === "DELETE") return new Response(null, { status: 202 })
        const mcpBody = parseRequestBody(opts)
        if (mcpBody.method === "initialize") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
            headers: { "content-type": "application/json", "mcp-session-id": "sid_test" },
          })
        }
        if (mcpBody.method === "notifications/initialized") return new Response(null, { status: 202 })
        if (mcpBody.method === "tools/call") {
          const id = numberFrom(mcpBody.id)
          const resultText = JSON.stringify({
            text: {
              value: "Search result body",
              annotations: [{ url_citation: { title: "Result", url: "https://example.test/result" } }],
            },
            bing_searches: [],
          })
          return responsesSseResponse([
            {
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: resultText }], isError: false },
            },
          ])
        }
        throw new Error(`Unexpected MCP body ${JSON.stringify(mcpBody)}`)
      }
      if (url.includes("/responses")) {
        responsesBody = parseRequestBody(opts)
        const tools = responsesBody.tools
        if (
          Array.isArray(tools)
          && tools.some((tool) => isRecord(tool) && tool.type === "function" && tool.name === "web_search")
        ) {
          throw new Error("web_search reached /responses as a plain function tool")
        }
        return responsesObjectResponse()
      }
      if (url.includes("/v1/messages")) throw new Error("gpt request must NOT hit native /v1/messages")
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 64,
        messages: [{ role: "user", content: "search for router docs" }],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            description: "search the web",
            input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          },
        ],
        tool_choice: { type: "tool", name: "web_search" },
      }),
    })

    expect(res.status).toBe(200)
    const payload = recordFrom(responsesBody)
    expect(urls.some((u) => u.includes("/mcp"))).toBe(true)
    expect(urls.some((u) => u.includes("/responses"))).toBe(true)
    expect(payload.tools).toBeUndefined()
    expect(payload.tool_choice).toBeUndefined()
    expect(stringFrom(payload.instructions)).toContain("Search result body")
  })

  test("count_tokens with a gpt model forwards to native count_tokens and returns input_tokens", async () => {
    const urls: Array<string> = []
    let countBody: Record<string, unknown> | undefined
    globalThis.fetch =((url: string, opts?: { body?: string }) => {
      urls.push(url)
      if (url.includes("/responses")) throw new Error("count_tokens must NOT hit /responses")
      if (url.includes("/v1/messages/count_tokens")) {
        countBody = parseRequestBody(opts)
        return new Response(JSON.stringify({ input_tokens: 123 }), {
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/v1/messages")) throw new Error("count_tokens must use the count_tokens endpoint")
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 64,
        messages: [{ role: "user", content: "count this" }],
      }),
    })

    expect(res.status).toBe(200)
    const body = recordFrom(await res.json())
    expect(body.input_tokens).toBe(123)
    expect(recordFrom(countBody).model).toBe("gpt-5.5")
    expect(urls.some((u) => u.includes("/v1/messages/count_tokens"))).toBe(true)
    expect(urls.some((u) => u.includes("/responses"))).toBe(false)
  })

  test("non-streaming shim threads NO consumer-abort signal (not abortable — upstream completes regardless)", async () => {
    // A buffered non-streaming response has no consumer-cancel hook, and Bun
    // poisons c.req.raw.signal after body consumption (CLAUDE.md "Bun
    // request-signal quirk"), so nothing could ever fire an AbortController.
    // The shim passes `undefined` rather than an inert controller that would
    // misleadingly imply cancellation. (Non-streaming success itself is covered
    // by the "diverted to /responses" test above.) This guards against
    // re-introducing an inert AbortController on the non-streaming path.
    let capturedSignal: AbortSignal | null | undefined = null
    globalThis.fetch =((url: string, init?: RequestInit) => {
      if (url.includes("/responses")) {
        capturedSignal = init?.signal
        return responsesObjectResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 256,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(res.status).toBe(200)
    // No consumer-abort signal is composed for non-streaming (test env sets no
    // UPSTREAM_FETCH_TIMEOUT_MS, so createResponses composes none from undefined).
    expect(capturedSignal == null).toBe(true)
  })
})
