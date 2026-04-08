/**
 * End-to-end tests that start an actual HTTP server and make real fetch()
 * calls to it. These test the full TCP → Hono → handler → response path.
 *
 * Each test gets its own server on a port in the 11000+ range.
 * Upstream Copilot calls are intercepted via globalThis.fetch mock that
 * only intercepts upstream URLs while passing through local proxy requests.
 */

import { test, expect, mock, afterEach, describe } from "bun:test"
import { serve } from "srvx"

import { server as app } from "../../src/server"
import { state } from "../../src/lib/state"
import type { Model, ModelsResponse } from "../../src/services/copilot/get-models"

// --- Test model fixtures ---

const gpt54: Model = {
  id: "gpt-5.4",
  model_picker_enabled: true,
  name: "GPT-5.4",
  object: "model",
  preview: false,
  vendor: "OpenAI",
  version: "gpt-5.4",
  capabilities: {
    family: "gpt-5.4",
    limits: {
      max_context_window_tokens: 400000,
      max_output_tokens: 128000,
      max_prompt_tokens: 272000,
    },
    object: "model_capabilities",
    supports: { streaming: true, tool_calls: true, parallel_tool_calls: true },
    tokenizer: "o200k_base",
    type: "chat",
  },
  supported_endpoints: ["/responses"],
}

const codexModel: Model = {
  id: "gpt-5.3-codex",
  model_picker_enabled: true,
  name: "GPT-5.3-Codex",
  object: "model",
  preview: false,
  vendor: "OpenAI",
  version: "gpt-5.3-codex",
  capabilities: {
    family: "gpt-5.3-codex",
    limits: {
      max_context_window_tokens: 400000,
      max_output_tokens: 128000,
      max_prompt_tokens: 272000,
    },
    object: "model_capabilities",
    supports: { streaming: true, tool_calls: true, parallel_tool_calls: true },
    tokenizer: "o200k_base",
    type: "chat",
  },
  supported_endpoints: ["/responses"],
}

const codexOldModel: Model = {
  id: "gpt-5.2-codex",
  model_picker_enabled: true,
  name: "GPT-5.2-Codex",
  object: "model",
  preview: false,
  vendor: "OpenAI",
  version: "gpt-5.2-codex",
  capabilities: {
    family: "gpt-5.2-codex",
    limits: { max_output_tokens: 128000, max_prompt_tokens: 272000 },
    object: "model_capabilities",
    supports: { streaming: true },
    tokenizer: "o200k_base",
    type: "chat",
  },
  supported_endpoints: ["/responses"],
}

const claudeOpus1m: Model = {
  id: "claude-opus-4.6-1m",
  model_picker_enabled: true,
  name: "Claude Opus 4.6 (1M context)",
  object: "model",
  preview: false,
  vendor: "Anthropic",
  version: "claude-opus-4.6-1m",
  capabilities: {
    family: "claude-opus-4.6-1m",
    limits: {
      max_context_window_tokens: 1000000,
      max_output_tokens: 64000,
      max_prompt_tokens: 936000,
    },
    object: "model_capabilities",
    supports: { streaming: true, tool_calls: true, adaptive_thinking: true },
    tokenizer: "o200k_base",
    type: "chat",
  },
  supported_endpoints: ["/v1/messages", "/chat/completions"],
}

const claudeOpus: Model = {
  id: "claude-opus-4.6",
  model_picker_enabled: true,
  name: "Claude Opus 4.6",
  object: "model",
  preview: false,
  vendor: "Anthropic",
  version: "claude-opus-4.6",
  capabilities: {
    family: "claude-opus-4.6",
    limits: { max_output_tokens: 64000, max_prompt_tokens: 128000 },
    object: "model_capabilities",
    supports: { streaming: true, tool_calls: true },
    tokenizer: "o200k_base",
    type: "chat",
  },
  supported_endpoints: ["/v1/messages", "/chat/completions"],
}

const gpt41: Model = {
  id: "gpt-4.1",
  model_picker_enabled: true,
  name: "GPT-4.1",
  object: "model",
  preview: false,
  vendor: "Azure OpenAI",
  version: "gpt-4.1",
  capabilities: {
    family: "gpt-4.1",
    limits: { max_output_tokens: 32768 },
    object: "model_capabilities",
    supports: { streaming: true },
    tokenizer: "o200k_base",
    type: "chat",
  },
  supported_endpoints: ["/chat/completions", "/responses"],
}

const allModels: Model[] = [gpt54, codexModel, codexOldModel, claudeOpus1m, claudeOpus, gpt41]

// --- Helpers ---

const realFetch = globalThis.fetch
let testServer: ReturnType<typeof serve> | undefined
let testPort = 11100

function nextPort(): number {
  return testPort++
}

function setupState(models: Model[] = allModels) {
  state.accountType = "enterprise"
  state.copilotToken = "test-token"
  state.githubToken = "gh-test"
  state.vsCodeVersion = "1.104.3"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.showToken = false
  state.models = { object: "list", data: models } as ModelsResponse
}

async function startServer(): Promise<string> {
  const port = nextPort()
  testServer = serve({
    fetch: app.fetch as Parameters<typeof serve>[0]["fetch"],
    hostname: "127.0.0.1",
    port,
    silent: true,
  })
  await testServer.ready()
  return testServer.url!.replace(/\/$/, "")
}

/**
 * Install a fetch mock that intercepts upstream Copilot calls while
 * passing through local requests to the actual proxy.
 */
function mockUpstream(
  handler: (url: string, opts?: RequestInit) => Response,
): {
  capturedUrl: () => string | undefined
  capturedBody: () => string | undefined
  capturedHeaders: () => Record<string, string> | undefined
} {
  let lastUrl: string | undefined
  let lastBody: string | undefined
  let lastHeaders: Record<string, string> | undefined

  const fetchMock = mock((input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url
    // Local proxy requests pass through to real fetch
    if (url.startsWith("http://127.0.0.1:")) {
      return realFetch(input, init)
    }
    // Upstream Copilot calls are mocked
    lastUrl = url
    lastBody = (init?.body as string) ?? undefined
    if (init?.headers) {
      lastHeaders = init.headers as Record<string, string>
    }
    return handler(url, init)
  })
  // @ts-expect-error - override fetch
  globalThis.fetch = fetchMock

  return {
    capturedUrl: () => lastUrl,
    capturedBody: () => lastBody,
    capturedHeaders: () => lastHeaders,
  }
}

afterEach(async () => {
  globalThis.fetch = realFetch
  if (testServer) {
    await testServer.close(true).catch(() => {})
    testServer = undefined
  }
})

// --- Tests ---

describe("E2E: /v1/models", () => {
  test("returns model list with capabilities and supported_endpoints", async () => {
    setupState()
    const url = await startServer()

    const res = await realFetch(`${url}/v1/models`)
    expect(res.status).toBe(200)

    const data = (await res.json()) as { object: string; data: Array<Record<string, unknown>> }
    expect(data.object).toBe("list")
    expect(data.data.length).toBe(allModels.length)

    const codex = data.data.find((m) => m.id === "gpt-5.3-codex")
    expect(codex).toBeDefined()
    expect(codex!.display_name).toBe("GPT-5.3-Codex")
    expect(codex!.supported_endpoints).toEqual(["/responses"])
    expect(codex!.owned_by).toBe("OpenAI")

    const opus = data.data.find((m) => m.id === "claude-opus-4.6-1m")
    expect(opus).toBeDefined()
    expect(opus!.supported_endpoints).toEqual(["/v1/messages", "/chat/completions"])
  })
})

describe("E2E: /v1/responses", () => {
  test("forwards correct model to upstream without injecting max_output_tokens", async () => {
    setupState()
    const url = await startServer()

    const upstream = mockUpstream(() =>
      new Response(JSON.stringify({ id: "resp", object: "response", output: [], status: "completed" })),
    )

    const res = await realFetch(`${url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.3-codex", input: "hello", stream: false }),
    })

    expect(res.status).toBe(200)
    expect(upstream.capturedUrl()).toContain("/responses")
    const forwarded = JSON.parse(upstream.capturedBody() ?? "{}") as { model: string; max_output_tokens?: number }
    expect(forwarded.model).toBe("gpt-5.3-codex")
    expect(forwarded.max_output_tokens).toBeUndefined()
  })

  test("normalizes old format gpt5.3-codex via codex family preference", async () => {
    setupState()
    const url = await startServer()

    const upstream = mockUpstream(() =>
      new Response(JSON.stringify({ id: "resp", object: "response", output: [] })),
    )

    const res = await realFetch(`${url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt5.3-codex", input: "hello", stream: false }),
    })

    expect(res.status).toBe(200)
    const forwarded = JSON.parse(upstream.capturedBody() ?? "{}") as { model: string }
    // "gpt5.3-codex" contains "codex" → family preference picks best gpt-5* model
    expect(forwarded.model).toBe("gpt-5.4")
  })
})

describe("E2E: /v1/messages", () => {
  const anthropicResponse = JSON.stringify({
    id: "msg_123",
    type: "message",
    role: "assistant",
    model: "claude-opus-4.6-1m",
    content: [{ type: "text", text: "hi" }],
    usage: { input_tokens: 5, output_tokens: 2 },
  })

  test("resolves opus keyword to opus-1m variant", async () => {
    setupState()
    const url = await startServer()

    const upstream = mockUpstream(() => new Response(anthropicResponse))

    // "opus" is not an exact match — should resolve to claude-opus-4.6-1m via family preference
    await realFetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "opus",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    const forwarded = JSON.parse(upstream.capturedBody() ?? "{}") as { model: string }
    expect(forwarded.model).toBe("claude-opus-4.6-1m")
  })

  test("resolves claude-opus-4-6 (Claude Code format) to opus-1m, not opus 200K", async () => {
    setupState()
    const url = await startServer()

    const upstream = mockUpstream(() => new Response(anthropicResponse))

    // Claude Code sends "claude-opus-4-6" (dashes, no dots).
    // Must resolve to 1m variant (1M context), NOT claude-opus-4.6 (200K).
    await realFetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    const forwarded = JSON.parse(upstream.capturedBody() ?? "{}") as { model: string }
    expect(forwarded.model).toBe("claude-opus-4.6-1m")
  })

  test("applies default beta headers for Claude models when client sends none", async () => {
    setupState()
    const url = await startServer()

    const upstream = mockUpstream(() => new Response(anthropicResponse))

    await realFetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-opus-4.6-1m",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    const headers = upstream.capturedHeaders()
    expect(headers).toBeDefined()
    expect(headers!["anthropic-beta"]).toContain("interleaved-thinking")
    expect(headers!["anthropic-beta"]).toContain("context-management")
  })

  test("filters client beta headers to VS Code whitelist by default", async () => {
    setupState()
    const url = await startServer()

    const upstream = mockUpstream(() => new Response(anthropicResponse))

    await realFetch(`${url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "interleaved-thinking-2025-05-14,context-1m-2025-04-14,claude-code-20250219,output-128k-2025-02-19",
      },
      body: JSON.stringify({
        model: "claude-opus-4.6-1m",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    const headers = upstream.capturedHeaders()
    expect(headers).toBeDefined()
    const beta = headers!["anthropic-beta"]
    expect(beta).toContain("interleaved-thinking-2025-05-14")
    // Default mode: VS Code whitelist only — non-VS-Code betas stripped
    expect(beta).not.toContain("context-1m")
    expect(beta).not.toContain("claude-code")
    expect(beta).not.toContain("output-128k")
  })

  test("strips cache_control.scope from system blocks before forwarding", async () => {
    setupState()
    const url = await startServer()

    const upstream = mockUpstream(() => new Response(anthropicResponse))

    await realFetch(`${url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4.6-1m",
        max_tokens: 10,
        system: [
          { type: "text", text: "You are helpful." },
          {
            type: "text",
            text: "Main prompt.",
            cache_control: { type: "ephemeral", scope: "global" },
          },
        ],
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    const forwarded = JSON.parse(upstream.capturedBody() ?? "{}") as Record<string, unknown>
    const system = forwarded.system as Array<Record<string, unknown>>
    // scope should be stripped, type preserved
    expect(system[1].cache_control).toEqual({ type: "ephemeral" })
  })

  test("does not re-serialize body when scope appears only in message text", async () => {
    setupState()
    const url = await startServer()

    const upstream = mockUpstream(() => new Response(anthropicResponse))

    const body = JSON.stringify({
      model: "claude-opus-4.6-1m",
      max_tokens: 10,
      messages: [{ role: "user", content: "Explain the scope of this project" }],
    })

    await realFetch(`${url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body,
    })

    // Body should be forwarded as-is (no re-serialization)
    expect(upstream.capturedBody()).toBe(body)
  })
})

describe("E2E: /v1/chat/completions", () => {
  test("injects default max_tokens from model capabilities", async () => {
    setupState()
    const url = await startServer()

    const upstream = mockUpstream(() =>
      new Response(JSON.stringify({
        id: "chatcmpl-123",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "hi" }, index: 0, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      })),
    )

    await realFetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    const forwarded = JSON.parse(upstream.capturedBody() ?? "{}") as { max_tokens?: number }
    expect(forwarded.max_tokens).toBe(32768)
  })

  test("does not crash when model has no capabilities", async () => {
    // Simulate a model with no capabilities data (as seen in some Copilot responses)
    const modelWithoutCaps = {
      id: "bare-model",
      model_picker_enabled: true,
      name: "Bare Model",
      object: "model",
      preview: false,
      vendor: "test",
      version: "1",
    }
    // @ts-expect-error - intentionally omitting capabilities
    setupState([...allModels, modelWithoutCaps])
    const url = await startServer()

    const upstream = mockUpstream(() =>
      new Response(JSON.stringify({
        id: "chatcmpl-123",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "hi" }, index: 0, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      })),
    )

    const res = await realFetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "bare-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    // Should not crash — capabilities?.limits?.max_output_tokens is undefined
    expect(res.status).toBe(200)
    const forwarded = JSON.parse(upstream.capturedBody() ?? "{}") as { max_tokens?: number }
    expect(forwarded.max_tokens).toBeUndefined()
  })
})

describe("E2E: model resolution edge cases", () => {
  test("case-insensitive model resolution", async () => {
    setupState()
    const url = await startServer()

    const upstream = mockUpstream(() =>
      new Response(JSON.stringify({ id: "resp", object: "response", output: [] })),
    )

    await realFetch(`${url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "GPT-5.3-CODEX", input: "hi", stream: false }),
    })

    const forwarded = JSON.parse(upstream.capturedBody() ?? "{}") as { model: string }
    expect(forwarded.model).toBe("gpt-5.3-codex")
  })

  test("codex family keyword resolves to highest gpt-5 version", async () => {
    setupState()
    const url = await startServer()

    const upstream = mockUpstream(() =>
      new Response(JSON.stringify({ id: "resp", object: "response", output: [] })),
    )

    await realFetch(`${url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex", input: "hi", stream: false }),
    })

    const forwarded = JSON.parse(upstream.capturedBody() ?? "{}") as { model: string }
    expect(forwarded.model).toBe("gpt-5.4")
  })
})

describe("E2E: endpoint-model mismatch", () => {
  test("codex model on /v1/messages forwards but upstream rejects", async () => {
    setupState()
    const url = await startServer()

    const upstream = mockUpstream(() =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "model not supported" },
        }),
        { status: 400 },
      ),
    )

    const res = await realFetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "gpt-5.3-codex",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(res.status).toBe(400)
    const body = JSON.parse(upstream.capturedBody() ?? "{}") as { model: string }
    expect(body.model).toBe("gpt-5.3-codex")
  })

  test("claude model on /v1/responses forwards but upstream rejects", async () => {
    setupState()
    const url = await startServer()

    mockUpstream(() =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "model not supported" },
        }),
        { status: 400 },
      ),
    )

    const res = await realFetch(`${url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4.6", input: "hi", stream: false }),
    })

    expect(res.status).toBe(400)
  })
})
