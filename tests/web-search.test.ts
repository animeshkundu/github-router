import { test, expect, mock, beforeEach, afterEach } from "bun:test"

import { HTTPError } from "../src/lib/error"
import { state } from "../src/lib/state"
import { searchWeb } from "../src/services/copilot/web-search"

// Mock state — searchWeb uses state.githubToken (NOT copilotToken).
state.githubToken = "ghu_test"
state.copilotToken = "test-copilot-token"
state.vsCodeVersion = "1.0.0"
state.copilotVersion = "0.43.0"
state.accountType = "individual"

const originalFetch = globalThis.fetch

interface FetchOpts {
  method?: string
  headers?: Record<string, string>
  body?: string
}

/** Build an SSE response body. Each entry becomes `event: message\ndata: <json>\n\n`. */
function sseBody(events: Array<unknown>): string {
  return (
    events
      .map((e) => `event: message\ndata: ${JSON.stringify(e)}\n\n`)
      .join("") + "\n"
  )
}

/** Standard inner-text payload (the tool result body). */
const innerTextOk = {
  type: "output_text",
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
          title: "Bing search results",
          url: "https://www.bing.com/search?q=hono",
        },
      },
    ],
  },
  bing_searches: [
    {
      text: "Hono npm latest version",
      url: "https://www.bing.com/search?q=hono+npm",
    },
  ],
}

/**
 * Build a fetch mock that responds to MCP requests by JSON-RPC method.
 * `callId` is the id used for tools/call (must match what searchWeb generates;
 * we don't know it ahead of time, so we read it back from the request body).
 */
function makeMcpMock(opts: {
  initStatus?: number
  initBody?: string | null
  initSessionId?: string | null
  notifStatus?: number
  callStatus?: number
  /** Build the SSE events for tools/call given the request body's id. */
  callEvents?: (callId: number) => Array<unknown>
}) {
  const calls: Array<{ url: string; opts: FetchOpts; body: unknown }> = []

  const fn = mock(async (url: string, init?: FetchOpts) => {
    const method = init?.method ?? "GET"
    let parsedBody: unknown = undefined
    if (init?.body) {
      try {
        parsedBody = JSON.parse(init.body)
      } catch {
        parsedBody = init.body
      }
    }
    calls.push({ url, opts: init ?? {}, body: parsedBody })

    // Session teardown — best-effort, return 204.
    if (method === "DELETE") {
      return new Response(null, { status: 204 })
    }

    const rpcMethod =
      typeof parsedBody === "object"
      && parsedBody !== null
      && "method" in parsedBody
        ? (parsedBody as { method: string }).method
        : undefined

    if (rpcMethod === "initialize") {
      const status = opts.initStatus ?? 200
      const sid =
        opts.initSessionId === undefined ? "test-sid" : opts.initSessionId
      const headers: Record<string, string> = {
        "content-type": "application/json",
      }
      if (sid !== null) headers["mcp-session-id"] = sid
      const body =
        opts.initBody !== undefined
          ? opts.initBody
          : JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { protocolVersion: "2024-11-05", capabilities: {} },
            })
      return new Response(body, { status, headers })
    }

    if (rpcMethod === "notifications/initialized") {
      return new Response(null, { status: opts.notifStatus ?? 202 })
    }

    if (rpcMethod === "tools/call") {
      const callId =
        typeof parsedBody === "object"
        && parsedBody !== null
        && "id" in parsedBody
          ? Number((parsedBody as { id: number }).id)
          : 0
      const status = opts.callStatus ?? 200
      const events = opts.callEvents
        ? opts.callEvents(callId)
        : [
            {
              jsonrpc: "2.0",
              id: callId,
              result: {
                content: [{ type: "text", text: JSON.stringify(innerTextOk) }],
              },
            },
          ]
      return new Response(sseBody(events), {
        status,
        headers: {
          "content-type": "text/event-stream",
        },
      })
    }

    return new Response("unexpected", { status: 500 })
  })

  return { fn, calls }
}

beforeEach(() => {
  state.githubToken = "ghu_test"
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.githubToken = "ghu_test"
})

test("searchWeb success: returns parsed value + references with bing.com filtered", async () => {
  const { fn, calls } = makeMcpMock({})
  // @ts-expect-error - mock fetch
  globalThis.fetch = fn

  const result = await searchWeb("Hono latest version")
  expect(result.content).toBe("Hono latest is 4.12.15.")
  // Only the npm reference — bing.com/search is filtered.
  expect(result.references).toEqual([
    { title: "hono - npm", url: "https://www.npmjs.com/package/hono" },
  ])

  // Verify auth + headers on the initialize call.
  const initCall = calls.find(
    (c) =>
      typeof c.body === "object"
      && c.body !== null
      && (c.body as { method?: string }).method === "initialize",
  )
  expect(initCall).toBeDefined()
  const initHeaders = initCall!.opts.headers!
  expect(initHeaders.Authorization).toBe("Bearer ghu_test")
  expect(initHeaders["X-MCP-Host"]).toBe("copilot-cli")
  expect(initHeaders["X-MCP-Toolsets"]).toBe("web_search")
  expect(initHeaders["Mcp-Protocol-Version"]).toBe("2025-06-18")
  expect(initHeaders.accept).toBe("application/json, text/event-stream")

  // Verify Mcp-Session-Id propagated to subsequent calls.
  const notifCall = calls.find(
    (c) =>
      typeof c.body === "object"
      && c.body !== null
      && (c.body as { method?: string }).method === "notifications/initialized",
  )
  expect(notifCall).toBeDefined()
  expect(notifCall!.opts.headers!["Mcp-Session-Id"]).toBe("test-sid")

  const toolCall = calls.find(
    (c) =>
      typeof c.body === "object"
      && c.body !== null
      && (c.body as { method?: string }).method === "tools/call",
  )
  expect(toolCall).toBeDefined()
  expect(toolCall!.opts.headers!["Mcp-Session-Id"]).toBe("test-sid")
  expect((toolCall!.body as { params: { name: string } }).params.name).toBe(
    "web_search",
  )
})

test("searchWeb throws HTTPError when initialize returns 401", async () => {
  const { fn } = makeMcpMock({
    initStatus: 401,
    initBody: JSON.stringify({
      error: { code: 401, message: "Token is not authorized" },
    }),
    initSessionId: null,
  })
  // @ts-expect-error - mock fetch
  globalThis.fetch = fn

  let caught: unknown
  try {
    await searchWeb("query")
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(HTTPError)
  expect((caught as HTTPError).response.status).toBe(401)
})

test("searchWeb throws HTTPError on JSON-RPC error envelope (-32602 unknown tool)", async () => {
  const { fn } = makeMcpMock({
    callEvents: (callId) => [
      {
        jsonrpc: "2.0",
        id: callId,
        error: { code: -32602, message: 'unknown tool "web_search"' },
      },
    ],
  })
  // @ts-expect-error - mock fetch
  globalThis.fetch = fn

  let caught: unknown
  try {
    await searchWeb("query")
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(HTTPError)
  expect((caught as HTTPError).message).toContain("-32602")
  expect((caught as HTTPError).message).toContain("unknown tool")
})

test("searchWeb throws HTTPError on result.isError:true", async () => {
  const { fn } = makeMcpMock({
    callEvents: (callId) => [
      {
        jsonrpc: "2.0",
        id: callId,
        result: {
          isError: true,
          content: [{ type: "text", text: '{"error":"rate limited"}' }],
        },
      },
    ],
  })
  // @ts-expect-error - mock fetch
  globalThis.fetch = fn

  let caught: unknown
  try {
    await searchWeb("query")
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(HTTPError)
  expect((caught as HTTPError).message).toBe("MCP web_search tool error")
})

test("searchWeb throws HTTPError when content array is empty", async () => {
  const { fn } = makeMcpMock({
    callEvents: (callId) => [
      {
        jsonrpc: "2.0",
        id: callId,
        result: { content: [] },
      },
    ],
  })
  // @ts-expect-error - mock fetch
  globalThis.fetch = fn

  let caught: unknown
  try {
    await searchWeb("query")
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(HTTPError)
  expect((caught as HTTPError).message).toContain("empty content")
})

test("searchWeb throws clear error when state.githubToken is undefined", async () => {
  state.githubToken = undefined
  // Even though we set fetch, the throw happens before fetch is called.
  const { fn } = makeMcpMock({})
  // @ts-expect-error - mock fetch
  globalThis.fetch = fn

  let caught: unknown
  try {
    await searchWeb("query")
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).message).toContain("re-run auth flow")
  expect((caught as Error).message).toContain("github_token")
  // Fetch should not have been called.
  expect(fn).not.toHaveBeenCalled()
})

test("searchWeb filters bing.com/search URLs from references", async () => {
  const inner = {
    type: "output_text",
    text: {
      value: "answer",
      annotations: [
        {
          url_citation: {
            title: "Bing",
            url: "https://www.bing.com/search?q=foo",
          },
        },
        {
          url_citation: { title: "Real", url: "https://example.com/page" },
        },
      ],
    },
    bing_searches: [],
  }
  const { fn } = makeMcpMock({
    callEvents: (callId) => [
      {
        jsonrpc: "2.0",
        id: callId,
        result: {
          content: [{ type: "text", text: JSON.stringify(inner) }],
        },
      },
    ],
  })
  // @ts-expect-error - mock fetch
  globalThis.fetch = fn

  const result = await searchWeb("query")
  expect(result.references).toEqual([
    { title: "Real", url: "https://example.com/page" },
  ])
})

test("searchWeb matches by id even with non-matching events earlier in stream", async () => {
  const { fn } = makeMcpMock({
    callEvents: (callId) => [
      // Progress / unrelated event first — must not poison the result.
      {
        jsonrpc: "2.0",
        id: 999,
        result: {
          content: [
            { type: "text", text: JSON.stringify({ wrong: "wrong-payload" }) },
          ],
        },
      },
      // Real result with the matching id.
      {
        jsonrpc: "2.0",
        id: callId,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                type: "output_text",
                text: {
                  value: "correct answer",
                  annotations: [
                    {
                      url_citation: {
                        title: "Doc",
                        url: "https://example.com/doc",
                      },
                    },
                  ],
                },
              }),
            },
          ],
        },
      },
    ],
  })
  // @ts-expect-error - mock fetch
  globalThis.fetch = fn

  const result = await searchWeb("query")
  expect(result.content).toBe("correct answer")
  expect(result.references).toEqual([
    { title: "Doc", url: "https://example.com/doc" },
  ])
})
