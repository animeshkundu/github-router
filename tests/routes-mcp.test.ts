import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { mcpRoutes } from "../src/routes/mcp/route"
import {
  __getInFlightForTests,
  __resetInFlightForTests,
} from "../src/routes/mcp/handler"
import { state } from "../src/lib/state"
import type { ModelsResponse } from "../src/services/copilot/get-models"

const PROXY_PORT = 18787
const PROXY_HOST = `127.0.0.1:${PROXY_PORT}`
const NONCE = "0123456789abcdef".repeat(4) // 64 chars
const AUTH_HEADER = `Bearer ${NONCE}`

const fakeModel = (
  id: string,
  endpoints: Array<string> = ["/v1/responses"],
) => ({
  id,
  name: id,
  vendor: id.startsWith("gemini") ? "Google" : "OpenAI",
  version: id,
  preview: true,
  model_picker_enabled: true,
  object: "model" as const,
  capabilities: {
    type: "chat",
    family: id,
    object: "model_capabilities",
    tokenizer: "o200k_base",
    limits: { max_context_window_tokens: 200_000 },
    supports: {},
  },
  supported_endpoints: endpoints,
})

const baseModels: ModelsResponse = {
  object: "list",
  data: [
    fakeModel("gpt-5.5", ["/v1/responses"]),
    fakeModel("gpt-5.3-codex", ["/v1/responses"]),
    fakeModel("gemini-3.1-pro-preview", ["/v1/chat/completions"]),
    fakeModel("claude-opus-4.7", ["/v1/messages", "/v1/chat/completions"]),
  ],
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  __resetInFlightForTests()
  state.peerMcpNonce = NONCE
  state.copilotToken = "test-copilot-token"
  state.githubToken = "test-gh-token"
  state.vsCodeVersion = "1.99.0"
  state.copilotVersion = "0.43.0"
  state.accountType = "individual"
  state.models = baseModels
})

afterEach(() => {
  state.peerMcpNonce = undefined
  state.models = undefined
  globalThis.fetch = originalFetch
})

function buildReq(body: unknown, opts: { auth?: string; host?: string } = {}) {
  return new Request(`http://${PROXY_HOST}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: opts.auth ?? AUTH_HEADER,
      host: opts.host ?? PROXY_HOST,
    },
    body: JSON.stringify(body),
  })
}

async function rpc(body: unknown, opts: { auth?: string; host?: string } = {}) {
  const res = await mcpRoutes.request(buildReq(body, opts))
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

describe("/mcp auth + host", () => {
  test("rejects non-loopback Host header with 403", async () => {
    const res = await mcpRoutes.request(
      buildReq({ jsonrpc: "2.0", id: 1, method: "initialize" }, { host: "evil.com" }),
    )
    expect(res.status).toBe(403)
  })

  test("rejects missing Authorization with 401", async () => {
    const res = await mcpRoutes.request(
      buildReq({ jsonrpc: "2.0", id: 1, method: "initialize" }, { auth: "" }),
    )
    expect(res.status).toBe(401)
  })

  test("rejects wrong-nonce Authorization with 401", async () => {
    const res = await mcpRoutes.request(
      buildReq(
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { auth: "Bearer not-the-real-nonce" },
      ),
    )
    expect(res.status).toBe(401)
  })

  test("rejects all requests when state.peerMcpNonce is unset (proxy not in claude mode)", async () => {
    state.peerMcpNonce = undefined
    const res = await mcpRoutes.request(
      buildReq({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    )
    expect(res.status).toBe(401)
  })
})

describe("/mcp protocol methods", () => {
  test("initialize returns server capabilities and protocol version (no Mcp-Session-Id)", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    })
    expect(status).toBe(200)
    const result = json.result as {
      protocolVersion: string
      capabilities: { tools: { listChanged: boolean } }
      serverInfo: { name: string }
    }
    expect(result.protocolVersion).toBe("2025-06-18")
    expect(result.capabilities.tools.listChanged).toBe(false)
    expect(result.serverInfo.name).toBe("github-router-peers")
  })

  test("notifications/initialized returns 202 with empty body", async () => {
    const res = await mcpRoutes.request(
      buildReq({ jsonrpc: "2.0", method: "notifications/initialized" }),
    )
    expect(res.status).toBe(202)
  })

  test("tools/list returns 3 tools when gemini is in catalog", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })
    expect(status).toBe(200)
    const result = json.result as {
      tools: Array<{ name: string; description: string; inputSchema: unknown }>
    }
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      "codex_critic",
      "codex_reviewer",
      "gemini_critic",
    ])
    for (const t of result.tools) {
      expect(t.description.length).toBeGreaterThan(20)
      expect(t.inputSchema).toBeDefined()
    }
  })

  test("tools/list omits gemini_critic when no gemini-3.x-pro in catalog", async () => {
    state.models = {
      object: "list",
      data: baseModels.data.filter((m) => !m.id.startsWith("gemini")),
    }
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })
    const result = json.result as { tools: Array<{ name: string }> }
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      "codex_critic",
      "codex_reviewer",
    ])
  })

  test("unknown method → JSON-RPC method-not-found", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/whatever",
    })
    expect(status).toBe(200)
    const err = json.error as { code: number; message: string }
    expect(err.code).toBe(-32601)
  })

  test("invalid JSON-RPC envelope (missing method) → invalid-request", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 1 })
    const err = json.error as { code: number; message: string }
    expect(err.code).toBe(-32600)
  })

  test("null JSON body → invalid-request (-32600), NOT internal-error (-32603)", async () => {
    // Regression for codex_reviewer batch 6 finding #1: previously a
    // `null` body threw on `body.jsonrpc` access, fell into the outer
    // catch in handleMcpPost, and surfaced as -32603 internal-error
    // when the JSON-RPC spec wants -32600 invalid-request for shape
    // errors. Now the handler shape-guards before dereferencing.
    const res = await mcpRoutes.request(
      new Request(`http://${PROXY_HOST}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: AUTH_HEADER,
          host: PROXY_HOST,
        },
        body: "null",
      }),
    )
    expect(res.status).toBe(200)
    const json = await res.json() as { error?: { code: number } }
    expect(json.error?.code).toBe(-32600)
  })

  test("array JSON body → invalid-request (-32600), not a crash", async () => {
    // Same shape-guard applies to arrays.
    const res = await mcpRoutes.request(
      new Request(`http://${PROXY_HOST}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: AUTH_HEADER,
          host: PROXY_HOST,
        },
        body: "[1,2,3]",
      }),
    )
    expect(res.status).toBe(200)
    const json = await res.json() as { error?: { code: number } }
    expect(json.error?.code).toBe(-32600)
  })

  test("notification (id missing) for tools/list → 202 with empty body, no JSON-RPC response", async () => {
    // Regression for codex_reviewer batch 6 finding #2: per JSON-RPC 2.0,
    // requests without an `id` are notifications and MUST NOT receive a
    // response body. Previously the handler returned the regular result
    // body anyway (forcing `id ?? null`), which breaks strict clients.
    const res = await mcpRoutes.request(
      buildReq({ jsonrpc: "2.0", method: "tools/list" }),
    )
    expect(res.status).toBe(202)
    const text = await res.text()
    expect(text).toBe("")
  })

  test("DELETE /mcp returns 200 ack regardless of body", async () => {
    const res = await mcpRoutes.request(
      new Request(`http://${PROXY_HOST}/`, {
        method: "DELETE",
        headers: { authorization: AUTH_HEADER, host: PROXY_HOST },
        body: "garbage-not-json",
      }),
    )
    expect(res.status).toBe(200)
  })
})

describe("/mcp tools/call routing", () => {
  function mockResponsesUpstream(text: string, captured: { lastBody?: unknown } = {}) {
    globalThis.fetch = mock(async (_url, init) => {
      captured.lastBody = JSON.parse((init as RequestInit).body as string)
      const responseBody = {
        id: "resp_test",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        ],
      }
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch
    return captured
  }

  function mockChatCompletionsUpstream(text: string, captured: { lastBody?: unknown } = {}) {
    globalThis.fetch = mock(async (_url, init) => {
      captured.lastBody = JSON.parse((init as RequestInit).body as string)
      const responseBody = {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: 0,
        model: "gemini-3.1-pro-preview",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      }
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch
    return captured
  }

  test("codex_critic call hits /responses with model=gpt-5.5 and persona instructions", async () => {
    const captured = mockResponsesUpstream("no material objection")
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "codex_critic",
        arguments: { prompt: "Review this trivial design.", context: "ctx-123" },
      },
    })
    expect(status).toBe(200)
    const upstream = captured.lastBody as {
      model: string
      instructions: string
      input: Array<{ role: string; content: Array<{ type: string; text: string }> }>
      stream?: boolean
    }
    expect(upstream.model).toBe("gpt-5.5")
    expect(upstream.instructions).toContain("codex-critic")
    expect(upstream.instructions).toContain("1–5") // grading rubric
    expect(upstream.stream).toBe(false)
    const userText = upstream.input[0].content[0].text
    expect(userText).toContain("Review this trivial design.")
    expect(userText).toContain("ctx-123")

    const result = json.result as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe("no material objection")
  })

  test("codex_reviewer call hits /responses with model=gpt-5.3-codex", async () => {
    const captured = mockResponsesUpstream("Clean review — no findings.")
    await rpc({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "codex_reviewer",
        arguments: { prompt: "review this diff" },
      },
    })
    const upstream = captured.lastBody as { model: string; instructions: string }
    expect(upstream.model).toBe("gpt-5.3-codex")
    expect(upstream.instructions).toContain("codex-reviewer")
  })

  test("gemini_critic call hits /chat/completions with model=gemini-3.1-pro-preview", async () => {
    const captured = mockChatCompletionsUpstream("no material objection")
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "gemini_critic",
        arguments: { prompt: "Critique this approach." },
      },
    })
    const upstream = captured.lastBody as {
      model: string
      messages: Array<{ role: string; content: string }>
      stream?: boolean
    }
    expect(upstream.model).toBe("gemini-3.1-pro-preview")
    expect(upstream.messages[0].role).toBe("system")
    expect(upstream.messages[0].content).toContain("gemini-critic")
    expect(upstream.messages[1].role).toBe("user")
    expect(upstream.messages[1].content).toContain("Critique this approach.")
    expect(upstream.stream).toBe(false)

    const result = json.result as { content: Array<{ text: string }> }
    expect(result.content[0].text).toBe("no material objection")
  })

  test("unknown tool → JSON-RPC method-not-found", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: { prompt: "x" } },
    })
    const err = json.error as { code: number }
    expect(err.code).toBe(-32601)
  })

  test("missing prompt argument → JSON-RPC invalid-params", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: "codex_critic", arguments: {} },
    })
    const err = json.error as { code: number }
    expect(err.code).toBe(-32602)
  })

  test("upstream error → MCP result isError:true with message preserved", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("upstream is sick", {
        status: 502,
        headers: { "content-type": "text/plain" },
      })
    }) as unknown as typeof globalThis.fetch

    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: { name: "codex_critic", arguments: { prompt: "anything" } },
    })
    expect(status).toBe(200)
    const result = json.result as { content: Array<{ text: string }>; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("codex-critic")
  })
})

describe("/mcp concurrency cap", () => {
  test("3rd in-flight tools/call returns queue-full isError", async () => {
    // Mock a slow upstream so calls overlap.
    let resolveSlow: ((res: Response) => void) | null = null
    const slow = new Promise<Response>((r) => {
      resolveSlow = r
    })
    globalThis.fetch = mock(() => slow) as unknown as typeof globalThis.fetch

    const fire = () =>
      rpc({
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1_000_000),
        method: "tools/call",
        params: { name: "codex_critic", arguments: { prompt: "x" } },
      })

    const a = fire()
    const b = fire()
    // Brief tick so the two calls increment the in-flight counter.
    await new Promise((r) => setTimeout(r, 10))
    expect(__getInFlightForTests()).toBe(2)

    // Third call should immediately return queue-full.
    const c = await fire()
    const result = c.json.result as { isError: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/queue full/i)

    // Now release the slow upstream so the in-flight pair resolves.
    resolveSlow!(
      new Response(
        JSON.stringify({
          id: "x",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    await Promise.all([a, b])
    expect(__getInFlightForTests()).toBe(0)
  })
})
