import { describe, test, expect, mock, afterEach } from "bun:test"

import { state } from "../src/lib/state"
import { createMessages, countTokens } from "../src/services/copilot/create-messages"
import { HTTPError } from "../src/lib/error"

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("createMessages", () => {
  test("sends request to copilot /v1/messages endpoint", async () => {
    let capturedUrl = ""
    const fetchMock = mock((url: string) => {
      capturedUrl = url
      return new Response(
        JSON.stringify({
          type: "message",
          id: "msg_test",
          role: "assistant",
          model: "claude-sonnet-4.5",
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
      )
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock

    await createMessages('{"model":"claude-sonnet-4.5","max_tokens":100,"messages":[]}')
    expect(capturedUrl).toBe("https://api.githubcopilot.com/v1/messages?beta=true")
  })

  test("uses copilotApiUrl from token response when set", async () => {
    state.copilotApiUrl = "https://api.enterprise.githubcopilot.com"
    let capturedUrl = ""
    const fetchMock = mock((url: string) => {
      capturedUrl = url
      return new Response(JSON.stringify({ type: "message", id: "msg", role: "assistant", model: "m", content: [], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }))
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock

    await createMessages('{"model":"claude-sonnet-4.5","max_tokens":100,"messages":[]}')
    expect(capturedUrl).toBe("https://api.enterprise.githubcopilot.com/v1/messages?beta=true")
    state.copilotApiUrl = undefined
  })

  test("sends correct VS Code-compatible headers", async () => {
    let capturedHeaders: Record<string, string> = {}
    const fetchMock = mock((_url: string, opts: { headers: Record<string, string> }) => {
      capturedHeaders = opts.headers
      return new Response(JSON.stringify({ type: "message", id: "msg", role: "assistant", model: "m", content: [], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }))
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock

    await createMessages('{}')

    // Copilot auth and identification headers
    expect(capturedHeaders.Authorization).toBe("Bearer test-token")
    expect(capturedHeaders["content-type"]).toBe("application/json")
    expect(capturedHeaders["copilot-integration-id"]).toBe("vscode-chat")
    expect(capturedHeaders["editor-version"]).toBe("vscode/1.0.0")
    expect(capturedHeaders["editor-plugin-version"]).toMatch(/^copilot-chat\//)
    expect(capturedHeaders["user-agent"]).toMatch(/^GitHubCopilotChat\//)
    expect(capturedHeaders["openai-intent"]).toBe("conversation-panel")
    expect(capturedHeaders["x-interaction-type"]).toBe("conversation-panel")
    expect(capturedHeaders["x-github-api-version"]).toBe("2025-10-01")
    expect(capturedHeaders["x-request-id"]).toBeDefined()
    expect(capturedHeaders["x-vscode-user-agent-library-version"]).toBe("electron-fetch")

    // Messages-specific headers
    expect(capturedHeaders["X-Initiator"]).toBe("agent")
    expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01")
    expect(capturedHeaders["X-Interaction-Id"]).toBeDefined()
  })

  test("does not send copilot-vision-request header", async () => {
    let capturedHeaders: Record<string, string> = {}
    const fetchMock = mock((_url: string, opts: { headers: Record<string, string> }) => {
      capturedHeaders = opts.headers
      return new Response(JSON.stringify({ type: "message", id: "msg", role: "assistant", model: "m", content: [], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }))
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock

    await createMessages('{}')
    expect(capturedHeaders["copilot-vision-request"]).toBeUndefined()
  })

  test("forwards request body as-is without parsing", async () => {
    let capturedBody = ""
    const rawBody = '{"model":"claude-opus-4-6","max_tokens":16000,"thinking":{"type":"enabled","budget_tokens":2000},"messages":[{"role":"user","content":"hello"}]}'
    const fetchMock = mock((_url: string, opts: { body: string }) => {
      capturedBody = opts.body
      return new Response(JSON.stringify({ type: "message", id: "msg", role: "assistant", model: "m", content: [], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }))
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock

    await createMessages(rawBody)
    expect(capturedBody).toBe(rawBody)
  })

  test("returns raw Response for streaming", async () => {
    const sseBody = 'event: message_start\ndata: {"type":"message_start"}\n\n'
    const fetchMock = mock(() => {
      return new Response(sseBody, {
        headers: { "content-type": "text/event-stream" },
      })
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock

    const response = await createMessages('{"stream":true}')
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const text = await response.text()
    expect(text).toContain("message_start")
  })

  test("throws HTTPError on non-ok response", async () => {
    const fetchMock = mock(() => {
      return new Response(
        JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model not found" } }),
        { status: 404 },
      )
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock

    try {
      await createMessages('{"model":"nonexistent"}')
      expect(true).toBe(false) // Should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
      expect((error as HTTPError).response.status).toBe(404)
    }
  })

  test("throws when copilot token is missing", async () => {
    const savedToken = state.copilotToken
    state.copilotToken = undefined

    try {
      await createMessages('{}')
      expect(true).toBe(false)
    } catch (error) {
      expect((error as Error).message).toBe("Copilot token not found")
    }

    state.copilotToken = savedToken
  })

  test("generates unique X-Request-Id per call", async () => {
    const requestIds: Array<string> = []
    const fetchMock = mock((_url: string, opts: { headers: Record<string, string> }) => {
      requestIds.push(opts.headers["x-request-id"])
      return new Response(JSON.stringify({ type: "message", id: "msg", role: "assistant", model: "m", content: [], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }))
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock

    await createMessages('{}')
    await createMessages('{}')
    expect(requestIds[0]).not.toBe(requestIds[1])
  })

  test("forwards extra headers when provided", async () => {
    let capturedHeaders: Record<string, string> = {}
    const fetchMock = mock((_url: string, opts: { headers: Record<string, string> }) => {
      capturedHeaders = opts.headers
      return new Response(JSON.stringify({ type: "message", id: "msg", role: "assistant", model: "m", content: [], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }))
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock

    await createMessages('{}', {
      "anthropic-beta": "interleaved-thinking-2025-05-14,context-management-2025-06-27",
      "capi-beta-1": "true",
    })

    expect(capturedHeaders["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14,context-management-2025-06-27")
    expect(capturedHeaders["capi-beta-1"]).toBe("true")
    // Base headers should still be present
    expect(capturedHeaders["X-Initiator"]).toBe("agent")
    expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01")
  })

  test("does not include extra headers when not provided", async () => {
    let capturedHeaders: Record<string, string> = {}
    const fetchMock = mock((_url: string, opts: { headers: Record<string, string> }) => {
      capturedHeaders = opts.headers
      return new Response(JSON.stringify({ type: "message", id: "msg", role: "assistant", model: "m", content: [], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }))
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock

    await createMessages('{}')

    expect(capturedHeaders["anthropic-beta"]).toBeUndefined()
    expect(capturedHeaders["capi-beta-1"]).toBeUndefined()
  })
})

describe("countTokens", () => {
  test("sends request to copilot /v1/messages/count_tokens endpoint", async () => {
    let capturedUrl = ""
    const fetchMock = mock((url: string) => {
      capturedUrl = url
      return new Response(JSON.stringify({ input_tokens: 42 }))
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock

    await countTokens('{"model":"claude-sonnet-4.5","messages":[]}')
    expect(capturedUrl).toBe("https://api.githubcopilot.com/v1/messages/count_tokens?beta=true")
  })

  test("sends same VS Code-compatible headers as createMessages", async () => {
    let capturedHeaders: Record<string, string> = {}
    const fetchMock = mock((_url: string, opts: { headers: Record<string, string> }) => {
      capturedHeaders = opts.headers
      return new Response(JSON.stringify({ input_tokens: 10 }))
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock

    await countTokens('{}')

    expect(capturedHeaders.Authorization).toBe("Bearer test-token")
    expect(capturedHeaders["X-Initiator"]).toBe("agent")
    expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01")
    expect(capturedHeaders["x-github-api-version"]).toBe("2025-10-01")
  })

  test("forwards body as-is", async () => {
    let capturedBody = ""
    const rawBody = '{"model":"claude-haiku-4-5-20251001","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
    const fetchMock = mock((_url: string, opts: { body: string }) => {
      capturedBody = opts.body
      return new Response(JSON.stringify({ input_tokens: 15 }))
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock

    await countTokens(rawBody)
    expect(capturedBody).toBe(rawBody)
  })

  test("throws HTTPError on upstream error", async () => {
    const fetchMock = mock(() => {
      return new Response(
        JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad request" } }),
        { status: 400 },
      )
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock

    try {
      await countTokens('{}')
      expect(true).toBe(false)
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
      expect((error as HTTPError).response.status).toBe(400)
    }
  })
})
