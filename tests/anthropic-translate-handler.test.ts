// Handler-level non-regression guard: verifies the branch point in
// src/routes/messages/handler.ts routes by model — Claude models hit the
// native /v1/messages passthrough (createMessages), non-Claude /responses
// models (gpt-5.5) are diverted to the translation shim (/responses).

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
    supports: { tool_calls: true, reasoning_effort: ["low", "medium", "high", "xhigh"] },
  },
  supported_endpoints: ["/responses"],
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

beforeEach(() => {
  savedModels = state.models
  state.copilotToken = "test-token"
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
