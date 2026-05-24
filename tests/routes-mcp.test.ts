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

  test("tools/list returns 4 personas + web_search + code_search when gemini is in catalog", async () => {
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
      "code_search",
      "codex_critic",
      "codex_reviewer",
      "gemini_critic",
      "opus_critic",
      "web_search",
    ])
    for (const t of result.tools) {
      expect(t.description.length).toBeGreaterThan(20)
      expect(t.inputSchema).toBeDefined()
    }
  })

  test("tools/list omits gemini_critic when no gemini-3.x-pro in catalog (web_search + code_search still present)", async () => {
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
      "code_search",
      "codex_critic",
      "codex_reviewer",
      "opus_critic",
      "web_search",
    ])
  })

  test("tools/list web_search entry has {query} input schema (no prompt/effort)", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })
    const result = json.result as {
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>
    }
    const entry = result.tools.find((t) => t.name === "web_search")
    expect(entry).toBeDefined()
    const schema = entry!.inputSchema as {
      type: string
      required: Array<string>
      properties: Record<string, unknown>
    }
    expect(schema.type).toBe("object")
    expect(schema.required).toEqual(["query"])
    expect(Object.keys(schema.properties)).toEqual(["query"])
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

  // --- Phase D P1.1: MCP method stubs with full handshake coherence ---

  test("initialize advertises tools+resources+prompts capabilities (codex-critic Phase D requirement)", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 100,
      method: "initialize",
    })
    const result = json.result as {
      capabilities: {
        tools?: { listChanged?: boolean }
        resources?: Record<string, unknown>
        prompts?: Record<string, unknown>
      }
    }
    // Must advertise resources/prompts to legitimize the empty-list
    // stubs we ship below; otherwise codex-critic warned a strict
    // client would error on probing them.
    expect(result.capabilities.tools).toBeDefined()
    expect(result.capabilities.resources).toBeDefined()
    expect(result.capabilities.prompts).toBeDefined()
  })

  test("resources/list returns empty list (stub for forward-compat with Phase 3 async-MCP)", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 101,
      method: "resources/list",
    })
    expect(status).toBe(200)
    expect((json.result as { resources: Array<unknown> }).resources).toEqual([])
  })

  test("resources/templates/list returns empty list (codex-critic: 'if advertising resources:{}, also handle templates')", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 102,
      method: "resources/templates/list",
    })
    expect(status).toBe(200)
    expect(
      (json.result as { resourceTemplates: Array<unknown> }).resourceTemplates,
    ).toEqual([])
  })

  test("resources/read returns -32602 invalid params (parametric — empty list inappropriate)", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 103,
      method: "resources/read",
      params: { uri: "review://job-fake-uuid" },
    })
    expect(status).toBe(200)
    const err = (json as { error?: { code: number; message: string } }).error
    expect(err?.code).toBe(-32602)
    expect(err?.message).toContain("review://job-fake-uuid")
  })

  test("resources/read with no uri returns -32602 with diagnostic message", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 104,
      method: "resources/read",
    })
    const err = (json as { error?: { code: number; message: string } }).error
    expect(err?.code).toBe(-32602)
    expect(err?.message).toContain("missing/invalid uri")
  })

  test("prompts/list returns empty list", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 105,
      method: "prompts/list",
    })
    expect(status).toBe(200)
    expect((json.result as { prompts: Array<unknown> }).prompts).toEqual([])
  })

  test("prompts/get returns -32602 invalid params (parametric)", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 106,
      method: "prompts/get",
      params: { name: "nonexistent-prompt" },
    })
    expect(status).toBe(200)
    const err = (json as { error?: { code: number; message: string } }).error
    expect(err?.code).toBe(-32602)
    expect(err?.message).toContain("nonexistent-prompt")
  })

  test("notifications/claude/channel accepted silently (no response body)", async () => {
    const res = await mcpRoutes.request(
      buildReq({
        jsonrpc: "2.0",
        method: "notifications/claude/channel",
        params: { channel: "permission" },
      }),
    )
    // Notifications return 202 with empty body per JSON-RPC 2.0
    expect(res.status).toBe(202)
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

  /** Mock /v1/messages upstream (used by opus_critic via createMessages). */
  function mockMessagesUpstream(text: string, captured: { lastBody?: unknown; called?: boolean } = {}) {
    globalThis.fetch = mock(async (_url, init) => {
      captured.called = true
      captured.lastBody = JSON.parse((init as RequestInit).body as string)
      const responseBody = {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
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
      reasoning?: { effort?: string }
    }
    expect(upstream.model).toBe("gpt-5.5")
    expect(upstream.instructions).toContain("codex-critic")
    expect(upstream.instructions).toContain("1–5") // grading rubric
    expect(upstream.stream).toBe(false)
    // Default effort is "xhigh" (raised from "high" — SSE-streamed
    // responses bypass the 60s tools/call ceiling, so the deepest
    // reasoning bucket is the right default. Lower per call via the
    // effort argument when wall-clock matters more than depth.)
    expect(upstream.reasoning?.effort).toBe("xhigh")
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

  test("explicit effort:xhigh on codex_critic reaches the upstream payload", async () => {
    // Now that gemini_critic dropped xhigh too (Copilot's gemini route
    // 400s on xhigh per the per-persona gate), use codex_critic for the
    // "xhigh reaches upstream" assertion. SSE-streamed /mcp responses
    // bypass the 60s ceiling so codex@xhigh works transparently.
    const captured = mockResponsesUpstream("ok")
    await rpc({
      jsonrpc: "2.0",
      id: 109,
      method: "tools/call",
      params: {
        name: "codex_critic",
        arguments: { prompt: "deep dive", effort: "xhigh" },
      },
    })
    const upstream = captured.lastBody as { reasoning?: { effort?: string } }
    expect(upstream.reasoning?.effort).toBe("xhigh")
  })

  test("codex_critic accepts effort:xhigh (SSE-streamed responses bypass the 60s ceiling)", async () => {
    // Previously codex-critic@xhigh was rejected because gpt-5.5 at xhigh on
    // a tiny prompt = 56s wall (probed 2026-05-14), right at Claude Code's
    // 60s tools/call ceiling. With SSE-streamed /mcp responses
    // (handler.ts:handleToolsCallSSE), the connection stays open past the
    // ceiling and long calls succeed transparently — so the gate is lifted.
    const captured = mockResponsesUpstream("ok")
    await rpc({
      jsonrpc: "2.0",
      id: 200,
      method: "tools/call",
      params: {
        name: "codex_critic",
        arguments: { prompt: "deep dive", effort: "xhigh" },
      },
    })
    const upstream = captured.lastBody as { reasoning?: { effort?: string } }
    expect(upstream.reasoning?.effort).toBe("xhigh")
  })

  test("opus_critic accepts effort:high (SSE-streamed responses bypass the 60s ceiling)", async () => {
    // Previously opus-critic was capped at low|medium because the thinking-
    // budget math (~80-150 tps × 6k+ tokens) busts the 60s ceiling. With
    // SSE-streamed responses, the long path works transparently.
    const captured = mockMessagesUpstream("ok")
    await rpc({
      jsonrpc: "2.0",
      id: 201,
      method: "tools/call",
      params: {
        name: "opus_critic",
        arguments: { prompt: "review", effort: "high" },
      },
    })
    expect(captured.called).toBe(true)
    // Verify the Copilot-shape adaptive-thinking payload (NOT the
    // Anthropic-spec thinking.type=enabled shape — Copilot 400s on that
    // for opus). Empirically observed 2026-05-14.
    const upstream = captured.lastBody as {
      max_tokens?: number
      thinking?: { type?: string; budget_tokens?: unknown }
      output_config?: { effort?: string }
    }
    expect(upstream.thinking?.type).toBe("adaptive")
    expect(upstream.thinking?.budget_tokens).toBeUndefined()
    expect(upstream.output_config?.effort).toBe("high")
    expect(upstream.max_tokens).toBe(16384)  // high tier ceiling
  })

  test("invalid effort value is rejected with -32602 (not silently forwarded)", async () => {
    mockResponsesUpstream("ok")
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 110,
      method: "tools/call",
      params: {
        name: "codex_critic",
        arguments: { prompt: "x", effort: "extreme" },
      },
    })
    const err = json.error as { code: number; message: string }
    expect(err.code).toBe(-32602)
    expect(err.message).toMatch(/effort/)
  })

  test("gemini_critic rejects effort:'xhigh' with -32602 (Copilot's gemini route only allows low|medium|high)", async () => {
    // Per-persona allowedEfforts gate. Empirically: Copilot returns 400
    // "reasoning_effort 'xhigh' is not supported by model
    // gemini-3.1-pro-preview; supported values: [low medium high]"
    // (verified 2026-05-14). The persona's allowedEfforts dropped xhigh
    // to surface this as a clean RPC_INVALID_PARAMS pre-flight rejection
    // rather than a silent upstream 400.
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 111,
      method: "tools/call",
      params: {
        name: "gemini_critic",
        arguments: { prompt: "x", effort: "xhigh" },
      },
    })
    const err = json.error as { code: number; message: string }
    expect(err.code).toBe(-32602)
    expect(err.message).toContain("xhigh")
    expect(err.message).toContain("Allowed: low|medium|high")
  })

  test("SSE-path tools/call with Accept: text/event-stream is NOT subject to predictedTooLong cap", async () => {
    // Companion to the JSON-path test below. The SSE path keeps the
    // connection open past Claude Code's ~60s tools/call ceiling via
    // heartbeats, so size-based pre-flight rejection there would just
    // lock SSE clients out of higher-effort calls on bigger briefs.
    // Verify the upstream fetch IS invoked (cap not applied) when the
    // client sends `Accept: text/event-stream`.
    const captured = mockResponsesUpstream("ok")
    const oversize = "x".repeat(9 * 1024)
    const res = await mcpRoutes.request(
      new Request(`http://${PROXY_HOST}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: AUTH_HEADER,
          host: PROXY_HOST,
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 300,
          method: "tools/call",
          params: {
            name: "codex_critic",
            arguments: { prompt: oversize, effort: "high" },
          },
        }),
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    // Drain the stream so the upstream fetch resolves before assertions.
    const body = await res.text()
    expect(body).toContain('"id":300')
    // Upstream WAS called — captured.lastBody is set (cap not applied).
    expect(captured.lastBody).toBeDefined()
  })

  test("JSON-path tools/call with Accept: application/json hits predictedTooLong cap on 9KB brief at codex_critic@high", async () => {
    // SSE-streamed responses bypass Claude Code's ~60s tools/call
    // ceiling via heartbeats, but JSON-path clients (raw curl with
    // `Accept: application/json`, older MCP clients without SSE
    // awareness) still hit the underlying timer. The predictedTooLong
    // cap fires in handleMcpPost BEFORE inFlightToolsCall++ to surface
    // the failure as a clean fast-fail (isError envelope) instead of
    // a slot-leaking timeout — and to point the caller at SSE / a
    // lower effort tier / decomposition as remediations.
    const captured = mockResponsesUpstream("should not be called")
    const oversize = "x".repeat(9 * 1024)
    const res = await mcpRoutes.request(
      new Request(`http://${PROXY_HOST}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: AUTH_HEADER,
          host: PROXY_HOST,
          accept: "application/json", // NO text/event-stream
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 311,
          method: "tools/call",
          params: {
            name: "codex_critic",
            arguments: { prompt: oversize, effort: "high" },
          },
        }),
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    const json = (await res.json()) as {
      id?: number
      result?: { content: Array<{ text: string }>; isError?: boolean }
    }
    expect(json.id).toBe(311)
    expect(json.result?.isError).toBe(true)
    expect(json.result?.content[0].text).toMatch(/pre-flight rejected/i)
    expect(json.result?.content[0].text).toContain("codex_critic")
    expect(json.result?.content[0].text).toContain("text/event-stream")
    // Upstream NOT called — pre-flight rejected before fetch.
    expect(captured.lastBody).toBeUndefined()
    // Slot not acquired — invariant from CLAUDE.md.
    expect(__getInFlightForTests()).toBe(0)
  })

  test("opus_critic at effort:'low' routes to /v1/messages with adaptive thinking + effort:low", async () => {
    const captured = mockMessagesUpstream("no material objection")
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 301,
      method: "tools/call",
      params: {
        name: "opus_critic",
        arguments: { prompt: "review this", effort: "low" },
      },
    })
    expect(status).toBe(200)
    const result = json.result as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe("no material objection")
    // Verify Copilot-shape adaptive payload (NOT thinking.type=enabled).
    const upstream = captured.lastBody as {
      model?: string
      max_tokens?: number
      thinking?: { type?: string; budget_tokens?: unknown }
      output_config?: { effort?: string }
      messages?: Array<{ role?: string; content?: string }>
      system?: string
    }
    expect(upstream.thinking?.type).toBe("adaptive")
    expect(upstream.thinking?.budget_tokens).toBeUndefined()
    expect(upstream.output_config?.effort).toBe("low")
    expect(upstream.max_tokens).toBe(4096)
    expect(upstream.messages?.[0]?.role).toBe("user")
    expect(upstream.messages?.[0]?.content).toBe("review this")
    expect(upstream.system).toContain("opus-critic")
  })

  test("opus_critic with no explicit effort uses persona.defaultEffort=xhigh", async () => {
    const captured = mockMessagesUpstream("no material objection")
    await rpc({
      jsonrpc: "2.0",
      id: 302,
      method: "tools/call",
      params: {
        name: "opus_critic",
        arguments: { prompt: "review" },  // omit effort → persona.defaultEffort = "xhigh"
      },
    })
    const upstream = captured.lastBody as {
      max_tokens?: number
      thinking?: { type?: string }
      output_config?: { effort?: string }
    }
    expect(upstream.thinking?.type).toBe("adaptive")
    expect(upstream.output_config?.effort).toBe("xhigh")
    expect(upstream.max_tokens).toBe(32768)
  })

  test("opus_critic at effort:'xhigh' routes with output_config.effort=xhigh", async () => {
    const captured = mockMessagesUpstream("verdict")
    await rpc({
      jsonrpc: "2.0",
      id: 303,
      method: "tools/call",
      params: {
        name: "opus_critic",
        arguments: { prompt: "deep dive", effort: "xhigh" },
      },
    })
    const upstream = captured.lastBody as {
      max_tokens?: number
      thinking?: { type?: string }
      output_config?: { effort?: string }
    }
    expect(upstream.thinking?.type).toBe("adaptive")
    expect(upstream.output_config?.effort).toBe("xhigh")
    expect(upstream.max_tokens).toBe(32768)
  })

  test("tools/call with Accept: text/event-stream returns SSE-streamed response with heartbeat + final result", async () => {
    // Empirical wire-shape test for handleToolsCallSSE — validates the
    // structural fix that lets xhigh work on every persona by bypassing
    // Claude Code's ~60s tools/call ceiling. Per MCP 2025-06-18
    // Streamable HTTP spec, when the client sends Accept: text/event-stream
    // the server can respond with Content-Type: text/event-stream and
    // emit JSON-RPC messages as SSE events.
    mockResponsesUpstream("verdict")
    const res = await mcpRoutes.request(
      new Request(`http://${PROXY_HOST}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: AUTH_HEADER,
          host: PROXY_HOST,
          // Claude Code's MCP HTTP client sends both per spec.
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1000,
          method: "tools/call",
          params: { name: "codex_critic", arguments: { prompt: "x", effort: "xhigh" } },
        }),
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    expect(res.headers.get("cache-control")).toContain("no-cache")
    const body = await res.text()
    // At least one heartbeat (initial event before the upstream call resolves).
    expect(body).toContain("event: message")
    expect(body).toContain('"method":"notifications/progress"')
    expect(body).toContain('"progressToken":1000')
    // Final tools/call result envelope is the closing message event.
    expect(body).toContain('"id":1000')
    expect(body).toContain('"result"')
    expect(body).toContain("verdict")
  })

  test("tools/call with Accept: application/json (no SSE) keeps the JSON path unchanged", async () => {
    mockResponsesUpstream("ok")
    const res = await mcpRoutes.request(
      new Request(`http://${PROXY_HOST}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: AUTH_HEADER,
          host: PROXY_HOST,
          accept: "application/json",  // ← NO event-stream
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1001,
          method: "tools/call",
          params: { name: "codex_critic", arguments: { prompt: "x", effort: "high" } },
        }),
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    const json = await res.json() as { result?: unknown; id?: number }
    expect(json.id).toBe(1001)
    expect(json.result).toBeDefined()
  })

  test("non-tools/call requests stay on JSON path even with Accept: text/event-stream", async () => {
    // initialize / tools/list / etc. don't benefit from streaming; the
    // SSE branch is gated on method === "tools/call" specifically.
    const res = await mcpRoutes.request(
      new Request(`http://${PROXY_HOST}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: AUTH_HEADER,
          host: PROXY_HOST,
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1002, method: "tools/list" }),
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
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
  test("9th in-flight tools/call returns queue-full isError (cap = 8)", async () => {
    // Phase 2D of the peer-MCP plan raised MAX_INFLIGHT_TOOLS_CALL from 2
    // to 8 so the decomposition pattern (Track 2B) — "split a >20 KB
    // artifact into 2-4 batches and call in parallel" — can actually run
    // in parallel without the (3+)th call returning isError "queue full".
    // The cap at 8 covers a 7-fork wave with one slot of headroom and is
    // still a hard upper bound against runaway clients.
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

    // Fire 8 calls — all should occupy in-flight slots.
    const inflight = [
      fire(), fire(), fire(), fire(),
      fire(), fire(), fire(), fire(),
    ]
    // Brief tick so the calls increment the in-flight counter.
    await new Promise((r) => setTimeout(r, 10))
    expect(__getInFlightForTests()).toBe(8)

    // Ninth call should immediately return queue-full.
    const ninth = await fire()
    const result = ninth.json.result as { isError: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/queue full/i)

    // Now release the slow upstream so the in-flight 8 resolve.
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
    await Promise.all(inflight)
    expect(__getInFlightForTests()).toBe(0)
  })

  // --- Phase D P1.5: notifications/cancelled handling ---

  test("notifications/cancelled aborts in-flight tools/call and frees the slot", async () => {
    // Mock fetch that respects AbortSignal — exactly what real fetch does.
    // The promise pends forever unless the signal aborts (then rejects).
    let abortHandler: (() => void) | null = null
    const slow = (init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          // No signal provided — pend forever (test will time out).
          return
        }
        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"))
          return
        }
        abortHandler = () => {
          reject(new DOMException("aborted", "AbortError"))
        }
        signal.addEventListener("abort", abortHandler, { once: true })
      })
    globalThis.fetch = mock((_url: unknown, init?: { signal?: AbortSignal }) =>
      slow(init),
    ) as unknown as typeof globalThis.fetch

    // Fire one tools/call with a known id we can target with cancel.
    const REQUEST_ID = 9999
    const callPromise = rpc({
      jsonrpc: "2.0",
      id: REQUEST_ID,
      method: "tools/call",
      params: { name: "codex_critic", arguments: { prompt: "x" } },
    })

    // Brief tick so the call increments in-flight + registers AbortController.
    await new Promise((r) => setTimeout(r, 10))
    expect(__getInFlightForTests()).toBe(1)

    // Send the cancel notification.
    const cancelRes = await mcpRoutes.request(
      buildReq({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: REQUEST_ID, reason: "test cancel" },
      }),
    )
    expect(cancelRes.status).toBe(202)

    // The original tools/call must complete with isError (caught by the
    // try/catch in handleToolsCall and reported as tool-error). Slot freed.
    const { json } = await callPromise
    const result = json.result as {
      isError: boolean
      content: Array<{ text: string }>
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/aborted|abort|cancellation/i)
    expect(__getInFlightForTests()).toBe(0)
  })

  test("notifications/cancelled with unknown requestId is no-op (no error)", async () => {
    // No in-flight calls — the cancel must not throw or error.
    const res = await mcpRoutes.request(
      buildReq({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 12345, reason: "race after completion" },
      }),
    )
    expect(res.status).toBe(202)
    expect(__getInFlightForTests()).toBe(0)
  })

  test("notifications/cancelled with missing requestId is no-op", async () => {
    const res = await mcpRoutes.request(
      buildReq({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: {},
      }),
    )
    expect(res.status).toBe(202)
  })
})

describe("/mcp web_search tool", () => {
  /**
   * Mock the upstream Copilot /mcp endpoint that searchWeb hits.
   *
   * searchWeb's flow: initialize → notifications/initialized → tools/call
   * (SSE stream) → DELETE. We mock all four shapes by inspecting the
   * request body's JSON-RPC method field.
   */
  function mockUpstreamMcp(opts: {
    /** SSE inner-text JSON payload for tools/call success. */
    inner?: {
      text: { value: string; annotations?: Array<{ url_citation?: { title: string; url: string } }> | null }
      bing_searches?: Array<unknown> | null
    }
    /** Override tools/call HTTP status (200 = success path). */
    callStatus?: number
    /** Force the upstream tools/call to throw a generic error. */
    forceCallError?: boolean
  } = {}) {
    const captured: { tcCalled?: boolean; lastQuery?: string } = {}
    globalThis.fetch = mock(async (_url: unknown, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET"
      if (method === "DELETE") {
        return new Response(null, { status: 204 })
      }
      let body: { method?: string; id?: number; params?: { arguments?: { query?: string } } } = {}
      try {
        body = JSON.parse(init?.body ?? "{}") as typeof body
      } catch {
        // ignore
      }
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2024-11-05", capabilities: {} },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "test-sid",
            },
          },
        )
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 })
      }
      if (body.method === "tools/call") {
        captured.tcCalled = true
        captured.lastQuery = body.params?.arguments?.query
        if (opts.forceCallError) {
          return new Response("upstream sick", { status: 502 })
        }
        const inner = opts.inner ?? {
          text: {
            value: "Default search content.",
            annotations: [
              {
                url_citation: { title: "Source One", url: "https://example.com/1" },
              },
            ],
          },
        }
        const sseBody =
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [{ type: "text", text: JSON.stringify(inner) }],
            },
          })}\n\n`
        return new Response(sseBody, {
          status: opts.callStatus ?? 200,
          headers: { "content-type": "text/event-stream" },
        })
      }
      return new Response("unexpected", { status: 500 })
    }) as unknown as typeof globalThis.fetch
    return captured
  }

  test("web_search call returns formatted content + ## References section", async () => {
    const captured = mockUpstreamMcp({
      inner: {
        text: {
          value: "Hono latest is 4.12.15.",
          annotations: [
            {
              url_citation: {
                title: "hono - npm",
                url: "https://www.npmjs.com/package/hono",
              },
            },
            {
              url_citation: {
                title: "Hono docs",
                url: "https://hono.dev",
              },
            },
          ],
        },
      },
    })
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 600,
      method: "tools/call",
      params: { name: "web_search", arguments: { query: "Hono latest version" } },
    })
    expect(status).toBe(200)
    expect(captured.tcCalled).toBe(true)
    expect(captured.lastQuery).toBe("Hono latest version")
    const result = json.result as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeUndefined()
    expect(result.content[0].type).toBe("text")
    expect(result.content[0].text).toContain("Hono latest is 4.12.15.")
    expect(result.content[0].text).toContain("## References")
    expect(result.content[0].text).toContain("- [hono - npm](https://www.npmjs.com/package/hono)")
    expect(result.content[0].text).toContain("- [Hono docs](https://hono.dev)")
  })

  test("web_search omits ## References section when there are no references", async () => {
    mockUpstreamMcp({
      inner: {
        text: {
          value: "Some content with no citations.",
          annotations: null,
        },
      },
    })
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 601,
      method: "tools/call",
      params: { name: "web_search", arguments: { query: "obscure niche query" } },
    })
    const result = json.result as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe("Some content with no citations.")
    expect(result.content[0].text).not.toContain("## References")
  })

  test("web_search filters bing.com/search citations from the references list", async () => {
    // Behavior comes from searchWeb itself, but assert it surfaces through
    // the MCP tool — bing redirect URLs should not appear in the formatted
    // output we hand to the lead.
    mockUpstreamMcp({
      inner: {
        text: {
          value: "Result.",
          annotations: [
            {
              url_citation: {
                title: "Real source",
                url: "https://real.example.com/page",
              },
            },
            {
              url_citation: {
                title: "Bing redirect",
                url: "https://www.bing.com/search?q=foo",
              },
            },
          ],
        },
      },
    })
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 602,
      method: "tools/call",
      params: { name: "web_search", arguments: { query: "x" } },
    })
    const result = json.result as { content: Array<{ text: string }> }
    expect(result.content[0].text).toContain("Real source")
    expect(result.content[0].text).not.toContain("bing.com/search")
  })

  test("web_search with missing query returns isError tool envelope (not -32602 RPC error)", async () => {
    // Per the architect's spec, arg validation lives inside the tool's
    // handler closure (not pre-validated at the RPC layer). Result:
    // missing/invalid args surface as a tool-error envelope, not a
    // JSON-RPC -32602 — the call still "succeeds" at the protocol layer.
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 603,
      method: "tools/call",
      params: { name: "web_search", arguments: {} },
    })
    expect(status).toBe(200)
    const result = json.result as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/query is required/i)
  })

  test("web_search with non-string query returns isError tool envelope", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 604,
      method: "tools/call",
      params: { name: "web_search", arguments: { query: 42 } },
    })
    const result = json.result as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/query is required/i)
  })

  test("web_search upstream failure surfaces as tool isError with `web_search failed:` prefix", async () => {
    mockUpstreamMcp({ forceCallError: true })
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 605,
      method: "tools/call",
      params: { name: "web_search", arguments: { query: "x" } },
    })
    expect(status).toBe(200)
    const result = json.result as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^web_search failed:/i)
  })

  test("web_search counts against MAX_INFLIGHT_TOOLS_CALL=8 (slot accounting symmetric with personas)", async () => {
    // Hold the upstream tools/call open with a never-resolving promise so
    // the slot stays incremented; verify __getInFlightForTests bumps to 1
    // mid-call. (Architect's spec point 5: keeps accounting symmetric.)
    let resolveSlow: ((res: Response) => void) | null = null
    const slow = new Promise<Response>((r) => {
      resolveSlow = r
    })
    globalThis.fetch = mock(async (_url: unknown, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET"
      if (method === "DELETE") return new Response(null, { status: 204 })
      let body: { method?: string; id?: number } = {}
      try {
        body = JSON.parse(init?.body ?? "{}") as typeof body
      } catch {
        // ignore
      }
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2024-11-05", capabilities: {} },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "test-sid",
            },
          },
        )
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 })
      }
      if (body.method === "tools/call") {
        return slow  // hangs — slot stays acquired
      }
      return new Response("unexpected", { status: 500 })
    }) as unknown as typeof globalThis.fetch

    const callPromise = rpc({
      jsonrpc: "2.0",
      id: 606,
      method: "tools/call",
      params: { name: "web_search", arguments: { query: "hold" } },
    })
    // Brief tick so the call increments the in-flight counter.
    await new Promise((r) => setTimeout(r, 10))
    expect(__getInFlightForTests()).toBe(1)

    // Release the upstream so the call resolves and the slot is freed.
    const innerOk = {
      text: { value: "released", annotations: [] },
    }
    resolveSlow!(
      new Response(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: 606,
          result: { content: [{ type: "text", text: JSON.stringify(innerOk) }] },
        })}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
    )
    await callPromise
    expect(__getInFlightForTests()).toBe(0)
  })

  test("web_search call hits the JSON path even with a multi-KB query (predictedTooLong cap is persona-only)", async () => {
    // The predictedTooLong cap exists for thinking-budget-bearing peer
    // calls (codex_critic@high>8KB, etc.). Non-persona tools have no
    // such cost surface — verify a 9 KB query goes through to the
    // upstream rather than being pre-flight rejected.
    const captured = mockUpstreamMcp({
      inner: { text: { value: "ok", annotations: null } },
    })
    const oversize = "x".repeat(9 * 1024)
    const res = await mcpRoutes.request(
      new Request(`http://${PROXY_HOST}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: AUTH_HEADER,
          host: PROXY_HOST,
          accept: "application/json",  // JSON path — would trigger cap on personas
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 607,
          method: "tools/call",
          params: { name: "web_search", arguments: { query: oversize } },
        }),
      }),
    )
    expect(res.status).toBe(200)
    const json = await res.json() as { result?: { isError?: boolean; content: Array<{ text: string }> } }
    expect(json.result?.isError).toBeUndefined()
    expect(captured.tcCalled).toBe(true)
  })
})
