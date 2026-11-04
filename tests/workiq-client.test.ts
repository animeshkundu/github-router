import { afterEach, describe, expect, test } from "bun:test"

import { RemoteMcpClient } from "../src/lib/remote-mcp-client"
import { WorkiqError, WorkiqMcpClient, workiqResultText } from "../src/lib/workiq/client"
import { WORKIQ_PROTOCOL_VERSION } from "../src/lib/workiq/constants"

// Hermetic by construction: a fictional host passed as `baseUrl`, an injected
// `tokenProvider`, and a mocked global fetch. Nothing here reaches
// `workiq.svc.cloud.microsoft`. The bearer literals are synthetic so a leak is
// impossible to miss.

const BASE_URL = "https://workiq.example.test/mcp"
const SYNTHETIC_TOKEN = "synthetic-workiq-token-not-a-credential"

/**
 * The live surface, transcribed from a `tools/list` against the hosted server
 * (2026-11-02). Pinned here so an upstream rename shows up as a test failure
 * rather than only in a launch log.
 */
const RECORDED_TOOLS = [
  "ask",
  "retrieve",
  "fetch",
  "fetch_blob",
  "list_agents",
  "get_schema",
  "search_paths",
  "call_function",
  "create_entity",
  "update_entity",
  "delete_entity",
  "do_action",
]

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  })
}

function sseResponse(payload: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

interface ServerOpts {
  /** Assign a session id on `initialize` (the live server does NOT). */
  sessionId?: string
  /** Frame replies as SSE instead of JSON. */
  sse?: boolean
  /** Page size for `tools/list`; the server hands back a cursor per page. */
  pageSize?: number
  /** Return 401 for a `tools/call` whose bearer is in this set. */
  rejectTokens?: Set<string>
  /** `tools/call` result; defaults to a single text block. */
  callResult?: unknown
}

function installServer(opts: ServerOpts = {}) {
  const requests: Array<Captured> = []
  const pageSize = opts.pageSize ?? 100
  const rejectTokens = opts.rejectTokens ?? new Set<string>()

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value
    }
    const request = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {}
    requests.push({ url: String(input), method: init?.method ?? "GET", headers, body: request })

    if (request.method === "initialize") {
      const payload = {
        jsonrpc: "2.0",
        id: request.id,
        result: { protocolVersion: WORKIQ_PROTOCOL_VERSION, serverInfo: { name: "WorkIQ" } },
      }
      if (opts.sessionId) {
        return jsonResponse(payload, { headers: { "mcp-session-id": opts.sessionId } })
      }
      return opts.sse ? sseResponse(payload) : jsonResponse(payload)
    }
    if (request.method === "notifications/initialized") {
      return new Response(null, { status: 204 })
    }
    if (request.method === "tools/list") {
      const params = (request.params ?? {}) as Record<string, unknown>
      const start = typeof params.cursor === "string" ? Number(params.cursor) : 0
      const page = RECORDED_TOOLS.slice(start, start + pageSize)
      const next = start + pageSize < RECORDED_TOOLS.length ? String(start + pageSize) : undefined
      const payload = {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: page.map((name) => ({
            name,
            description: `${name} (recorded fixture)`,
            inputSchema: { type: "object", properties: {} },
          })),
          ...(next ? { nextCursor: next } : {}),
        },
      }
      return opts.sse ? sseResponse(payload) : jsonResponse(payload)
    }
    if (request.method === "tools/call") {
      if (rejectTokens.has(headers.authorization ?? "")) {
        return new Response("unauthorized", { status: 401 })
      }
      const payload = {
        jsonrpc: "2.0",
        id: request.id,
        result: opts.callResult ?? { content: [{ type: "text", text: "ok" }] },
      }
      return opts.sse ? sseResponse(payload) : jsonResponse(payload)
    }
    if (request.method === "DELETE") {
      return new Response(null, { status: 204 })
    }
    throw new Error(`unexpected method: ${String(request.method)}`)
  }) as typeof fetch

  const client = new WorkiqMcpClient({
    baseUrl: BASE_URL,
    token: SYNTHETIC_TOKEN,
    tokenProvider: async () => SYNTHETIC_TOKEN,
  })
  return { client, requests }
}

function calls(requests: Array<Captured>, method: string): Array<Captured> {
  return requests.filter((r) => r.body.method === method)
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("per-request deadline", () => {
  // The transport default is 30 s, measured as too short for `retrieve` and
  // `ask`: the first live retrieval was killed at 30.004 s. The client passes
  // its own value, and this pins the seam so a caller that sets one is never
  // silently held to the default.
  test("a configured requestTimeoutMs bounds a request that never answers", async () => {
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        )
      })) as typeof fetch

    const client = new RemoteMcpClient({
      label: "Probe",
      baseUrl: BASE_URL,
      protocolVersion: WORKIQ_PROTOCOL_VERSION,
      clientName: "github-router",
      clientVersion: "test",
      errorClass: WorkiqError,
      token: SYNTHETIC_TOKEN,
      tokenProvider: async () => SYNTHETIC_TOKEN,
      requestTimeoutMs: 25,
    })

    const started = Date.now()
    await expect(client.initialize()).rejects.toThrow(/Probe request timed out\./)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe("WorkiqMcpClient against a stateless server", () => {
  test("initialize + tools/list sends no session header and captures every tool", async () => {
    const { client, requests } = installServer()

    await client.initialize()

    const names = client.listWorkiqTools().map((t) => t.name)
    expect(names).toEqual(RECORDED_TOOLS)
    expect(client.hasTool("retrieve")).toBe(true)
    expect(client.hasTool("drop_database")).toBe(false)

    // The live server assigns no `mcp-session-id`; a client that invented one
    // would break against it.
    for (const request of requests) {
      expect(request.headers["mcp-session-id"]).toBeUndefined()
      expect(request.headers.authorization).toBe(`Bearer ${SYNTHETIC_TOKEN}`)
      expect(request.headers["mcp-protocol-version"]).toBe(WORKIQ_PROTOCOL_VERSION)
      expect(request.url).toBe(BASE_URL)
    }
  })

  test("follows a pagination cursor instead of stopping at the first page", async () => {
    const { client, requests } = installServer({ pageSize: 5 })

    await client.initialize()

    expect(client.listWorkiqTools().length).toBe(RECORDED_TOOLS.length)
    const lists = calls(requests, "tools/list")
    expect(lists.length).toBe(3)
    expect((lists[1]!.body.params as Record<string, unknown>).cursor).toBe("5")
    expect((lists[2]!.body.params as Record<string, unknown>).cursor).toBe("10")
  })

  test("SSE-framed replies are parsed the same way", async () => {
    const { client } = installServer({ sse: true })
    await client.initialize()
    expect(client.listWorkiqTools().length).toBe(RECORDED_TOOLS.length)
  })

  test("a tool the server never advertised is refused before the wire", async () => {
    const { client, requests } = installServer()
    await client.initialize()
    const before = calls(requests, "tools/call").length

    await expect(client.callWorkiqTool("delete_everything", {})).rejects.toThrow(WorkiqError)
    await expect(client.callWorkiqTool("delete_everything", {})).rejects.toThrow(/ask, call_function/)
    expect(calls(requests, "tools/call").length).toBe(before)
  })
})

describe("WorkiqMcpClient against a sessionful server", () => {
  test("replays the assigned session id on every later request", async () => {
    const { client, requests } = installServer({ sessionId: "session-abc" })

    await client.initialize()
    await client.callWorkiqTool("ask", { question: "hello" })

    // initialize is the only request that cannot carry it (it is what assigns
    // it); everything after must.
    const init = calls(requests, "initialize")
    expect(init.length).toBe(1)
    expect(init[0]!.headers["mcp-session-id"]).toBeUndefined()
    for (const request of requests.filter((r) => r.body.method !== "initialize")) {
      expect(request.headers["mcp-session-id"]).toBe("session-abc")
    }
  })
})

describe("WorkiqMcpClient 401 recovery", () => {
  test("a rejected token triggers exactly one forced refresh, then one retry", async () => {
    let provided = 0
    const { requests } = installServer({
      rejectTokens: new Set([`Bearer ${SYNTHETIC_TOKEN}`]),
    })

    const client = new WorkiqMcpClient({
      baseUrl: BASE_URL,
      token: SYNTHETIC_TOKEN,
      tokenProvider: async () => {
        provided++
        return "synthetic-workiq-token-refreshed"
      },
    })

    const result = await client.callWorkiqTool("ask", { question: "hello" })

    expect(result.content[0]!.text).toBe("ok")
    expect(provided).toBe(1)

    const tokenCalls = calls(requests, "tools/call")
    expect(tokenCalls.length).toBe(2)
    expect(tokenCalls[0]!.headers.authorization).toBe(`Bearer ${SYNTHETIC_TOKEN}`)
    expect(tokenCalls[1]!.headers.authorization).toBe(
      "Bearer synthetic-workiq-token-refreshed",
    )

    // The refresh resets the session, so the retry is preceded by a fresh
    // initialize + tools/list rather than reusing the rejected session state.
    expect(calls(requests, "initialize").length).toBe(2)
  })
})

describe("workiqResultText", () => {
  function retrievalResult(overrides: Record<string, unknown> = {}, structured?: unknown) {
    return {
      content: [{ type: "text", text: "generic copy that the service truncates first" }],
      structuredContent: structured ?? {
        "application/vnd.ms-workiq.retrieval": {
          markdown: "## Answer\n\nUse the **Q3** deck. [^h1]",
          retrievalHits: [
            { title: "Q3 review deck", entityType: "file", webUrl: "https://ex.test/q3" },
            { name: "Chat with Ana", type: "chat", url: "https://ex.test/chat" },
          ],
          resultCount: 2,
          stoppedReason: "complete",
          ...overrides,
        },
      },
    }
  }

  test("prefers the structured markdown over the generic text copy", () => {
    const text = workiqResultText(retrievalResult())
    expect(text).toContain("Use the **Q3** deck.")
    expect(text).not.toContain("generic copy")
  })

  test("appends the citation list the inline [^hN] markers point at", () => {
    const text = workiqResultText(retrievalResult())
    expect(text).toContain("Sources:")
    expect(text).toContain("1. Q3 review deck (file) — https://ex.test/q3")
    expect(text).toContain("2. Chat with Ana (chat) — https://ex.test/chat")
  })

  test("caps the sources block so a hundred hits cannot flood the model", () => {
    const hits = Array.from({ length: 100 }, (_, i) => ({
      title: `Hit ${i}`,
      webUrl: `https://ex.test/${i}`,
    }))
    const text = workiqResultText(retrievalResult({ retrievalHits: hits, resultCount: 100 }))
    expect(text).toContain("2. Hit 1")
    expect(text).toContain("(75 more)")
    expect(text).not.toContain("Hit 30")
  })

  test("isError is an error, not an answer", () => {
    expect(() =>
      workiqResultText({
        isError: true,
        content: [{ type: "text", text: "The tenant has no Work IQ license." }],
      }),
    ).toThrow(/Work IQ reported an error: The tenant has no Work IQ license\./)
  })

  test("a stoppedReason of error or cancelled throws even on a 200 envelope", () => {
    const overrides = { stoppedReason: "error", error: "Graph throttled the request." }
    expect(() => workiqResultText(retrievalResult(overrides))).toThrow(/Graph throttled the request\./)
    expect(() => workiqResultText(retrievalResult({ stoppedReason: "cancelled" }))).toThrow(
      /\(cancelled\)/,
    )
  })

  test("keeps the service's recovery action so the caller can act on it", () => {
    expect(() =>
      workiqResultText(
        retrievalResult({ stoppedReason: "error", recoveryAction: "Sign in again as the owner." }),
      ),
    ).toThrow(/Suggested action: Sign in again as the owner\./)
  })

  test("falls back to the text blocks for tools that return no retrieval payload", () => {
    const text = workiqResultText({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    })
    expect(text).toBe("first\n\nsecond")
  })

  test("an empty retrieval says so instead of returning an empty string", () => {
    const text = workiqResultText({
      content: [{ type: "text", text: "   " }],
      structuredContent: {
        "application/vnd.ms-workiq.retrieval": {
          resultCount: 0,
          retrievalHits: [],
          stoppedReason: "complete",
        },
      },
    })
    expect(text).toBe("Work IQ found no results.")
  })

  test("a non-object result throws rather than being silently dropped", () => {
    expect(() => workiqResultText(null)).toThrow(WorkiqError)
  })

  // The live server (measured 2026-11) sends neither a top-level `markdown`
  // nor `retrievalHits`: the retrieval object carries `results`, and each hit
  // keeps its body in its own `markdown` with the display fields one level
  // down under `resourceMetadata`. Rendering that hit list is what keeps a
  // real retrieval from reaching the model as tens of KB of raw JSON.
  function liveRetrievalResult(results: Array<Record<string, unknown>>) {
    return {
      content: [],
      structuredContent: {
        "application/vnd.ms-workiq.retrieval": {
          results,
          resultCount: results.length,
          stoppedReason: "completed",
        },
      },
    }
  }

  const liveHit = {
    markdown: "The Q3 review moved to Thursday.",
    id: "h1",
    resourceId: "abc",
    webUrl: "https://outlook.ex/message/1",
    entityUrl: "https://graph.ex/me/messages/1",
    entityType: "email",
    contentProtection: "none",
    resourceMetadata: { email: { subject: "Q3 review", sentTime: "2026-11-01T10:00:00Z" } },
  }

  test("renders the live results shape as numbered grounding sections", () => {
    const text = workiqResultText(liveRetrievalResult([liveHit]))
    expect(text).toContain("[h1] Q3 review (email)")
    expect(text).toContain("https://outlook.ex/message/1")
    expect(text).toContain("The Q3 review moved to Thursday.")
    expect(text).not.toContain("resourceMetadata")
  })

  test("renders every live hit, not only the first", () => {
    const second = {
      ...liveHit,
      id: "h2",
      markdown: "Budget sign-off is blocked.",
      webUrl: "https://outlook.ex/message/2",
      resourceMetadata: { email: { subject: "Budget", sentTime: "2026-11-02T10:00:00Z" } },
    }
    const text = workiqResultText(liveRetrievalResult([liveHit, second]))
    expect(text).toContain("[h1] Q3 review (email)")
    expect(text).toContain("[h2] Budget (email)")
    expect(text).toContain("Budget sign-off is blocked.")
  })

  test("a hit with no body still surfaces its source line", () => {
    const text = workiqResultText(
      liveRetrievalResult([{ id: "h1", entityType: "file", webUrl: "https://ex.test/file" }]),
    )
    expect(text).toContain("(file) — https://ex.test/file")
  })

  test("an empty live retrieval says so instead of returning raw JSON", () => {
    expect(workiqResultText(liveRetrievalResult([]))).toBe("Work IQ found no results.")
  })
})
