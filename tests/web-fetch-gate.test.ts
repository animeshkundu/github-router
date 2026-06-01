import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"
import { server } from "../src/server"

/**
 * web_fetch fail-fast gate (parity: Anthropic hosted web_fetch tool).
 *
 * The proxy rejects the hosted `web_fetch` tool with a 400 because Copilot has
 * no web_fetch backend and the URL is model-chosen mid-generation (can't be
 * pre-fulfilled like web_search). Two load-bearing properties under test:
 *   1. detection matches ONLY the hosted-tool `type` slug, never a tool/
 *      function NAME — a client-side custom tool named "web_fetch" must still
 *      pass through (Copilot's allowlist accepts `custom`/`function`).
 *   2. the gate fires BEFORE any side-effecting web_search pre-fulfillment, so
 *      a mixed web_search+web_fetch request rejects without an upstream call.
 */

const originalFetch = globalThis.fetch
let savedModels: typeof state.models

beforeEach(() => {
  state.copilotToken = "test-token"
  state.githubToken = "ghu_test"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "enterprise"
  savedModels = state.models
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = savedModels
})

/** Mock upstream; counts calls so we can assert "no upstream call on reject". */
function mockUpstream() {
  const calls: string[] = []
  const fetchMock = mock((url: string) => {
    calls.push(url)
    if (url.includes("/chat/completions")) {
      return new Response(
        JSON.stringify({
          id: "chatcmpl_test",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        }),
        { headers: { "content-type": "application/json" } },
      )
    }
    if (url.includes("/v1/messages") || url.includes("/messages")) {
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
        { headers: { "content-type": "application/json" } },
      )
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error override fetch
  globalThis.fetch = fetchMock
  return { calls }
}

const msg = (tools: unknown[]) =>
  JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 50,
    messages: [{ role: "user", content: "hi" }],
    tools,
  })

// ── /v1/messages ──────────────────────────────────────────────────────

test("/v1/messages rejects hosted web_fetch (type slug) with 400", async () => {
  const { calls } = mockUpstream()
  const res = await server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: msg([{ type: "web_fetch_20260209" }]),
  })
  expect(res.status).toBe(400)
  const body = (await res.json()) as { type: string; error: { type: string; message: string } }
  expect(body.type).toBe("error")
  expect(body.error.type).toBe("invalid_request_error")
  expect(body.error.message).toContain("web_fetch")
  // Rejected before any upstream forward.
  expect(calls.length).toBe(0)
})

test("/v1/messages allows a CUSTOM tool merely named web_fetch (type=custom) — must not over-match on name", async () => {
  const { calls } = mockUpstream()
  const res = await server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: msg([{ type: "custom", name: "web_fetch", input_schema: { type: "object" } }]),
  })
  expect(res.status).toBe(200)
  expect(calls.some((u) => u.includes("messages"))).toBe(true)
})

test("/v1/messages rejects a mixed web_search+web_fetch request BEFORE running a web search (no upstream/MCP call)", async () => {
  const { calls } = mockUpstream()
  const res = await server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: msg([
      { type: "web_search_20250305", name: "web_search" },
      { type: "web_fetch_20250910" },
    ]),
  })
  expect(res.status).toBe(400)
  // The load-bearing property: no side-effecting search fired.
  expect(calls.length).toBe(0)
})

test("/v1/messages rejects hosted web_fetch even when the type slug is JSON-unicode-escaped (no raw-substring bypass)", async () => {
  const { calls } = mockUpstream()
  // Raw body where the slug is escaped (`web_fetch…`) — a naive
  // rawBody.includes("web_fetch") pre-gate would miss this; the parse-based
  // gate must still catch it.
  const res = await server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"model":"claude-haiku-4-5","max_tokens":50,"messages":[{"role":"user","content":"hi"}],"tools":[{"type":"web\\u005ffetch_20260209"}]}',
  })
  expect(res.status).toBe(400)
  expect(calls.length).toBe(0)
})

// ── /v1/chat/completions ──────────────────────────────────────────────

test("/v1/chat/completions rejects hosted web_fetch (type slug) with 400", async () => {
  const { calls } = mockUpstream()
  const res = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_fetch_20250910" }],
    }),
  })
  expect(res.status).toBe(400)
  const body = (await res.json()) as { error: { message: string } }
  expect(body.error.message).toContain("web_fetch")
  expect(calls.length).toBe(0)
})

test("/v1/chat/completions allows a function tool named web_fetch — must not over-match on function.name", async () => {
  const { calls } = mockUpstream()
  const res = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "web_fetch", parameters: { type: "object" } } }],
    }),
  })
  expect(res.status).toBe(200)
  expect(calls.some((u) => u.includes("chat/completions"))).toBe(true)
})
