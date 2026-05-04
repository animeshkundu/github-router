import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test"

import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalFetch = globalThis.fetch
let savedModels: typeof state.models

function makeModel(overrides: {
  id?: string
  adaptive_thinking?: boolean
  reasoning_effort?: Array<string>
}) {
  return {
    id: overrides.id ?? "claude-opus-4.7",
    name: "Claude Opus 4.7",
    object: "model",
    preview: false,
    vendor: "anthropic",
    version: "1",
    model_picker_enabled: true,
    capabilities: {
      family: "claude",
      limits: { max_output_tokens: 8192 },
      object: "model",
      supports: {
        ...(overrides.adaptive_thinking !== undefined && {
          adaptive_thinking: overrides.adaptive_thinking,
        }),
        ...(overrides.reasoning_effort && {
          reasoning_effort: overrides.reasoning_effort,
        }),
      },
      tokenizer: "claude",
      type: "chat",
    },
  }
}

function emptyMessageResponse() {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-opus-4.7",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3 },
    }),
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
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = savedModels
})

describe("thinking-mode translation on /v1/messages", () => {
  test("translates enabled+budget 5000 to adaptive+effort 'medium'", async () => {
    state.models = {
      object: "list",
      data: [
        makeModel({
          id: "claude-opus-4.7",
          adaptive_thinking: true,
          reasoning_effort: ["low", "medium", "high", "xhigh"],
        }),
      ],
    }

    let capturedBody: string | undefined
    const fetchMock = mock((url: string, opts?: { body?: string }) => {
      if (url.includes("/v1/messages")) {
        capturedBody = opts?.body
        return emptyMessageResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        thinking: { type: "enabled", budget_tokens: 5000 },
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(capturedBody ?? "{}") as {
      thinking?: { type?: string; budget_tokens?: number }
      output_config?: { effort?: string }
    }
    expect(forwarded.thinking).toEqual({ type: "adaptive" })
    expect(forwarded.output_config?.effort).toBe("medium")
  })

  test("clamps to supported reasoning_effort when bucketed not in list", async () => {
    state.models = {
      object: "list",
      data: [
        makeModel({
          id: "claude-opus-4.7",
          adaptive_thinking: true,
          reasoning_effort: ["medium"],
        }),
      ],
    }

    let capturedBody: string | undefined
    const fetchMock = mock((url: string, opts?: { body?: string }) => {
      if (url.includes("/v1/messages")) {
        capturedBody = opts?.body
        return emptyMessageResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        // budget 30000 → bucketed "xhigh" → clamps to "medium"
        thinking: { type: "enabled", budget_tokens: 30000 },
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(capturedBody ?? "{}") as {
      thinking?: { type?: string }
      output_config?: { effort?: string }
    }
    expect(forwarded.thinking).toEqual({ type: "adaptive" })
    expect(forwarded.output_config?.effort).toBe("medium")
  })

  test("leaves thinking unchanged when model lacks adaptive_thinking", async () => {
    state.models = {
      object: "list",
      data: [
        makeModel({
          id: "claude-opus-4.7",
          // adaptive_thinking absent
        }),
      ],
    }

    let capturedBody: string | undefined
    const fetchMock = mock((url: string, opts?: { body?: string }) => {
      if (url.includes("/v1/messages")) {
        capturedBody = opts?.body
        return emptyMessageResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        thinking: { type: "enabled", budget_tokens: 5000 },
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(capturedBody ?? "{}") as {
      thinking?: { type?: string; budget_tokens?: number }
      output_config?: unknown
    }
    expect(forwarded.thinking).toEqual({
      type: "enabled",
      budget_tokens: 5000,
    })
    expect(forwarded.output_config).toBeUndefined()
  })

  test("preserves client-supplied output_config.effort", async () => {
    state.models = {
      object: "list",
      data: [
        makeModel({
          id: "claude-opus-4.7",
          adaptive_thinking: true,
          reasoning_effort: ["low", "medium", "high", "xhigh"],
        }),
      ],
    }

    let capturedBody: string | undefined
    const fetchMock = mock((url: string, opts?: { body?: string }) => {
      if (url.includes("/v1/messages")) {
        capturedBody = opts?.body
        return emptyMessageResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        // budget 5000 buckets to "medium", but client says "high" — client wins
        thinking: { type: "enabled", budget_tokens: 5000 },
        output_config: { effort: "high" },
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(capturedBody ?? "{}") as {
      thinking?: { type?: string }
      output_config?: { effort?: string }
    }
    expect(forwarded.thinking).toEqual({ type: "adaptive" })
    expect(forwarded.output_config?.effort).toBe("high")
  })
})
