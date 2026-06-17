import { describe, expect, mock, test } from "bun:test"

import {
  callInference,
  callMcpTool,
  hookMcpRuntimeFromEnv,
} from "../src/lib/orchestration/hook-mcp-client"

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

type FetchMock = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

function headersFrom(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers)
}

describe("hookMcpRuntimeFromEnv", () => {
  test("returns undefined when either runtime env var is missing", () => {
    expect(hookMcpRuntimeFromEnv({})).toBeUndefined()
    expect(hookMcpRuntimeFromEnv({ GH_ROUTER_HOOK_MCP_URL: "http://127.0.0.1:3000" })).toBeUndefined()
    expect(hookMcpRuntimeFromEnv({ GH_ROUTER_HOOK_NONCE: "nonce" })).toBeUndefined()
  })

  test("returns the server URL and nonce when both env vars are present", () => {
    expect(hookMcpRuntimeFromEnv({
      GH_ROUTER_HOOK_MCP_URL: " http://127.0.0.1:3000 ",
      GH_ROUTER_HOOK_NONCE: " nonce ",
    })).toEqual({ serverUrl: "http://127.0.0.1:3000", nonce: "nonce" })
  })
})

describe("callMcpTool", () => {
  test("POSTs the JSON-RPC tool call shape and parses text content", async () => {
    const fetchMock = mock<FetchMock>(async () => jsonResponse({
      result: { content: [{ type: "text", text: "hello" }], isError: false },
    }))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    try {
      const result = await callMcpTool({
        runtime: { serverUrl: "http://127.0.0.1:3000/", nonce: "n1" },
        group: "search",
        tool: "code",
        args: { query: "auth", mode: "semantic" },
        timeoutMs: 1_000,
      })

      expect(result).toEqual({ text: "hello", isError: false })
      expect(fetchMock.mock.calls.length).toBe(1)
      const [url, init] = fetchMock.mock.calls[0]!
      expect(url).toBe("http://127.0.0.1:3000/mcp/search")
      expect(init?.method).toBe("POST")
      const headers = headersFrom(init)
      expect(headers.get("Authorization")).toBe("Bearer n1")
      expect(headers.get("Accept")).toBe("application/json")
      expect(headers.get("Content-Type")).toBe("application/json")
      expect(JSON.parse(init?.body as string)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "code", arguments: { query: "auth", mode: "semantic" } },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("maps a JSON-RPC error envelope to an isError tool result", async () => {
    const fetchMock = mock<FetchMock>(async () => jsonResponse({ error: { message: "boom" } }))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    try {
      const result = await callMcpTool({
        runtime: { serverUrl: "http://127.0.0.1:3000", nonce: "n1" },
        group: "workers",
        tool: "review",
        args: { diff: "x" },
        timeoutMs: 1_000,
      })

      expect(result).toEqual({ text: "boom", isError: true })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("throws on a non-2xx HTTP response", async () => {
    const fetchMock = mock<FetchMock>(async () => jsonResponse({ error: "nope" }, 500))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    try {
      await expect(callMcpTool({
        runtime: { serverUrl: "http://127.0.0.1:3000", nonce: "n1" },
        group: "search",
        tool: "code",
        args: {},
        timeoutMs: 1_000,
      })).rejects.toThrow(/HTTP 500/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("callInference", () => {
  test("POSTs to /v1/responses and returns assistant output_text", async () => {
    const fetchMock = mock<FetchMock>(async () => jsonResponse({
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
      }],
    }))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    try {
      const result = await callInference({
        serverUrl: "http://127.0.0.1:3000/",
        model: "gpt-5.5",
        instructions: "Be concise",
        input: "Say hi",
        effort: "low",
        timeoutMs: 1_000,
      })

      expect(result).toBe("hi")
      expect(fetchMock.mock.calls.length).toBe(1)
      const [url, init] = fetchMock.mock.calls[0]!
      expect(url).toBe("http://127.0.0.1:3000/v1/responses")
      expect(init?.method).toBe("POST")
      const headers = headersFrom(init)
      expect(headers.get("Accept")).toBe("application/json")
      expect(headers.get("Content-Type")).toBe("application/json")
      expect(JSON.parse(init?.body as string)).toEqual({
        model: "gpt-5.5",
        instructions: "Be concise",
        input: [{ role: "user", content: [{ type: "input_text", text: "Say hi" }] }],
        stream: false,
        reasoning: { effort: "low" },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
