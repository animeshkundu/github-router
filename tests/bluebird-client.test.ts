import { afterEach, describe, expect, test } from "bun:test"

import {
  BluebirdClientManager,
  BluebirdMcpClient,
  bluebirdScopeSummary,
  type BluebirdScope,
  type ResolvedBluebirdProvision,
} from "../src/lib/bluebird-client"
import { state } from "../src/lib/state"

const originalFetch = globalThis.fetch
const originalBluebirdToken = process.env.BLUEBIRD_TOKEN

const scope: BluebirdScope = {
  organization: "org",
  project: "project",
  repositories: ["repo"],
  branch: "main",
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  })
}

function tool(name: string, properties: Record<string, unknown>): Record<string, unknown> {
  return {
    name,
    inputSchema: {
      type: "object",
      properties,
    },
  }
}

function installServer(
  tools: Array<Record<string, unknown>>,
  result: unknown,
): Array<Record<string, unknown>> {
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push(request)
    if (request.method === "initialize") {
      return jsonResponse(
        { jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18" } },
        { headers: { "mcp-session-id": "session-1" } },
      )
    }
    if (request.method === "notifications/initialized") {
      return new Response(null, { status: 204 })
    }
    if (request.method === "tools/list") {
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools } })
    }
    if (request.method === "tools/call") {
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result })
    }
    throw new Error(`unexpected method: ${String(request.method)}`)
  }) as typeof fetch
  return requests
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalBluebirdToken === undefined) delete process.env.BLUEBIRD_TOKEN
  else process.env.BLUEBIRD_TOKEN = originalBluebirdToken
})

describe("BluebirdMcpClient deployed code_search contract", () => {
  test("uses unified semantic search and parses live nested results", async () => {
    const requests = installServer(
      [tool("bluebird_code_search", {
        method: { enum: ["keyword", "semantic"] },
        query: { type: "string" },
        search_index: { enum: ["General", "File"] },
        limit: { type: "integer" },
      })],
      {
        content: [{
          type: "text",
          text: `${JSON.stringify([{
            SimilaritySearchResult: [{
              node_name: "PeopleTargetingService",
              node_file_path: "/packages/service.ts",
              code_startRow: 71,
              code_endRow: 1290,
              page_content: "Manages people targeting tags.",
              similarity_score: 0.56,
            }],
          }])}\n\n⚠️ Branch selection guidance`,
        }],
        isError: false,
      },
    )
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    const rows = await client.doVectorSearch("people targeting", { limit: 3 })

    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ])
    const call = requests[3].params as Record<string, unknown>
    expect(call.name).toBe("bluebird_code_search")
    expect(call.arguments).toEqual({
      method: "semantic",
      query: "people targeting",
      search_index: "General",
      limit: 3,
    })
    expect(rows).toEqual([{
      file: "packages/service.ts",
      line: 71,
      endLine: 1290,
      name: "PeopleTargetingService",
      snippet: "Manages people targeting tags.",
      score: 0.56,
    }])
  })

  test("uses unified keyword search and accepts valid empty results", async () => {
    const requests = installServer(
      [tool("code_search", {
        method: { enum: ["keyword", "semantic"] },
        query: { type: "string" },
      })],
      { content: [{ type: "text", text: "[]" }], isError: false },
    )
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    await expect(client.searchFileContent("missing symbol")).resolves.toEqual([])
    const call = requests[3].params as Record<string, unknown>
    expect(call.name).toBe("code_search")
    expect(call.arguments).toEqual({ method: "keyword", query: "missing symbol" })
  })

  test("falls back to advertised legacy tools only", async () => {
    const requests = installServer(
      [
        tool("do_vector_search", {
          similarity_search_text: { type: "string" },
          search_index: { type: "string" },
        }),
        tool("search_file_content", { searchText: { type: "string" } }),
      ],
      [{ file: "src/result.ts", line: 4, snippet: "result" }],
    )
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    await client.doVectorSearch("result")

    const call = requests[3].params as Record<string, unknown>
    expect(call.name).toBe("do_vector_search")
    expect(call.arguments).toEqual({
      similarity_search_text: "result",
      search_index: "General",
    })
  })

  test("rejects servers without complete search capabilities", async () => {
    installServer(
      [tool("do_vector_search", { query: { type: "string" } })],
      [],
    )
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    await expect(client.initialize()).rejects.toThrow(
      "did not advertise code_search or both legacy",
    )
  })

  test("reads paginated tool lists and keeps the required tool", async () => {
    const requests: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(request)
      if (request.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: request.id, result: {} })
      }
      if (request.method === "notifications/initialized") {
        return new Response(null, { status: 202 })
      }
      if (request.method === "tools/list") {
        const params = request.params as Record<string, unknown>
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: params.cursor === "page-2"
            ? { tools: [tool("code_search", { method: {}, query: {} })] }
            : { tools: [tool("metadata", {})], nextCursor: "page-2" },
        })
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: "[]" }], isError: false },
      })
    }) as typeof fetch
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    await expect(client.searchFileContent("nothing")).resolves.toEqual([])
    const lists = requests.filter((request) => request.method === "tools/list")
    expect(lists).toHaveLength(2)
    expect(lists[1].params).toEqual({ cursor: "page-2" })
  })

  test("parses multiline SSE data and ignores unrelated response IDs", async () => {
    const requests: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(request)
      const response = request.method === "initialize"
        ? { jsonrpc: "2.0", id: request.id, result: {} }
        : request.method === "tools/list"
          ? { jsonrpc: "2.0", id: request.id, result: { tools: [tool("code_search", { method: {}, query: {} })] } }
          : request.method === "tools/call"
            ? { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "[]" }], isError: false } }
            : undefined
      if (!response) return new Response(null, { status: 204 })
      const serialized = JSON.stringify(response)
      const splitMarker = '"result":'
      const split = serialized.indexOf(splitMarker) + splitMarker.length
      const body = [
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} })}`,
        "",
        `data: ${serialized.slice(0, split)}`,
        `data: ${serialized.slice(split)}`,
        "",
        "",
      ].join("\n")
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }) as typeof fetch
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    await expect(client.searchFileContent("nothing")).resolves.toEqual([])
    expect(requests.at(-1)?.method).toBe("tools/call")
  })

  test("refreshes once after initialization 401 and recreates the session", async () => {
    process.env.BLUEBIRD_TOKEN = "refreshed-token"
    const authHeaders: Array<string | null> = []
    let initializeCalls = 0
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      const headers = new Headers(init?.headers)
      authHeaders.push(headers.get("authorization"))
      if (request.method === "initialize") {
        initializeCalls++
        if (initializeCalls === 1) return new Response(null, { status: 401 })
        return jsonResponse({ jsonrpc: "2.0", id: request.id, result: {} })
      }
      if (request.method === "notifications/initialized") return new Response(null, { status: 204 })
      if (request.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: [tool("code_search", { method: {}, query: {} })] },
        })
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: "[]" }], isError: false },
      })
    }) as typeof fetch
    const client = new BluebirdMcpClient(scope, "stale-token", "https://example.test/mcp")

    await expect(client.searchFileContent("nothing")).resolves.toEqual([])
    expect(initializeCalls).toBe(2)
    expect(authHeaders[0]).toBe("Bearer stale-token")
    expect(authHeaders.at(-1)).toBe("Bearer refreshed-token")
  })

  test("reinitializes once after an expired MCP session", async () => {
    let session = 0
    let callCount = 0
    const seenSessions: Array<string | null> = []
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      const headers = new Headers(init?.headers)
      seenSessions.push(headers.get("mcp-session-id"))
      if (request.method === "initialize") {
        session++
        return jsonResponse(
          { jsonrpc: "2.0", id: request.id, result: {} },
          { headers: { "mcp-session-id": `session-${session}` } },
        )
      }
      if (request.method === "notifications/initialized") return new Response(null, { status: 204 })
      if (request.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: [tool("code_search", { method: {}, query: {} })] },
        })
      }
      callCount++
      if (callCount === 1) return new Response(null, { status: 404 })
      return jsonResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: "[]" }], isError: false },
      })
    }) as typeof fetch
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    await expect(client.searchFileContent("nothing")).resolves.toEqual([])
    expect(session).toBe(2)
    expect(callCount).toBe(2)
    expect(seenSessions).toContain("session-1")
    expect(seenSessions.at(-1)).toBe("session-2")
  })

  test("rejects malformed deployed result wrappers", async () => {
    installServer(
      [tool("code_search", {
        method: { type: "string" },
        query: { type: "string" },
      })],
      {
        content: [{
          type: "text",
          text: JSON.stringify([{ SimilaritySearchResult: { bad: true } }]),
        }],
        isError: false,
      },
    )
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    await expect(client.doVectorSearch("query")).rejects.toThrow(
      "malformed SimilaritySearchResult wrapper",
    )
  })

  test("redacts credential-shaped text from HTTP error bodies", async () => {
    globalThis.fetch = (async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(
      "authorization=super-secret-value Bearer abcdefghijklmnopqrstuvwxyz",
      { status: 400 },
    )) as typeof fetch
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    const error = await client.initialize().then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain("super-secret-value")
    expect((error as Error).message).not.toContain("abcdefghijklmnopqrstuvwxyz")
    expect((error as Error).message).toContain("[REDACTED]")
  })
})

describe("BluebirdMcpClient lifecycle, concurrency, and cancellation", () => {
  test("concurrent 401s from two searches trigger exactly one recovery initialize cycle", async () => {
    process.env.BLUEBIRD_TOKEN = "refreshed-token"
    let initializeCalls = 0
    const toolsCallAuthHeaders: Array<string | null> = []
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      const headers = new Headers(init?.headers)
      if (request.method === "initialize") {
        initializeCalls++
        return jsonResponse({ jsonrpc: "2.0", id: request.id, result: {} })
      }
      if (request.method === "notifications/initialized") return new Response(null, { status: 204 })
      if (request.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: [tool("code_search", { method: {}, query: {} })] },
        })
      }
      if (request.method === "tools/call") {
        const auth = headers.get("authorization")
        toolsCallAuthHeaders.push(auth)
        if (auth === "Bearer stale-token") return new Response(null, { status: 401 })
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { content: [{ type: "text", text: "[]" }], isError: false },
        })
      }
      throw new Error(`unexpected method: ${String(request.method)}`)
    }) as typeof fetch
    const client = new BluebirdMcpClient(scope, "stale-token", "https://example.test/mcp")

    const [a, b] = await Promise.all([
      client.searchFileContent("first"),
      client.searchFileContent("second"),
    ])

    expect(a).toEqual([])
    expect(b).toEqual([])
    // One initial initialize + exactly one recovery initialize == 2. A
    // regression that double-refreshes/double-reinitializes would show 3.
    expect(initializeCalls).toBe(2)
    expect(toolsCallAuthHeaders.filter((h) => h === "Bearer stale-token")).toHaveLength(2)
    expect(toolsCallAuthHeaders.filter((h) => h === "Bearer refreshed-token")).toHaveLength(2)
  })

  test("concurrent 404s from two searches trigger exactly one session recreation", async () => {
    let session = 0
    let initializeCalls = 0
    const toolsCallSessionIds: Array<string | null> = []
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      const headers = new Headers(init?.headers)
      if (request.method === "initialize") {
        initializeCalls++
        session++
        return jsonResponse(
          { jsonrpc: "2.0", id: request.id, result: {} },
          { headers: { "mcp-session-id": `session-${session}` } },
        )
      }
      if (request.method === "notifications/initialized") return new Response(null, { status: 204 })
      if (request.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: [tool("code_search", { method: {}, query: {} })] },
        })
      }
      if (request.method === "tools/call") {
        const sid = headers.get("mcp-session-id")
        toolsCallSessionIds.push(sid)
        if (sid === "session-1") return new Response(null, { status: 404 })
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { content: [{ type: "text", text: "[]" }], isError: false },
        })
      }
      throw new Error(`unexpected method: ${String(request.method)}`)
    }) as typeof fetch
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    const [a, b] = await Promise.all([
      client.searchFileContent("first"),
      client.searchFileContent("second"),
    ])

    expect(a).toEqual([])
    expect(b).toEqual([])
    // One initial initialize + exactly one session-recreation initialize.
    expect(initializeCalls).toBe(2)
    expect(session).toBe(2)
    expect(toolsCallSessionIds.filter((s) => s === "session-1")).toHaveLength(2)
    expect(toolsCallSessionIds.filter((s) => s === "session-2")).toHaveLength(2)
  })

  test("one caller aborting its wait on a shared initialize() does not cancel other callers", async () => {
    let initializeStarted = false
    let initializeCompleted = false
    let signalInitializeStarted: (() => void) | undefined
    let releaseInitialize: (() => void) | undefined
    const initializeHasStarted = new Promise<void>((resolve) => {
      signalInitializeStarted = resolve
    })
    const initializeCanComplete = new Promise<void>((resolve) => {
      releaseInitialize = resolve
    })
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (request.method === "initialize") {
        initializeStarted = true
        signalInitializeStarted?.()
        await initializeCanComplete
        initializeCompleted = true
        return jsonResponse({ jsonrpc: "2.0", id: request.id, result: {} })
      }
      if (request.method === "notifications/initialized") return new Response(null, { status: 204 })
      if (request.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: [tool("code_search", { method: {}, query: {} })] },
        })
      }
      throw new Error(`unexpected method: ${String(request.method)}`)
    }) as typeof fetch
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    const callerA = new AbortController()
    const callA = client.initialize(callerA.signal)
    const callB = client.initialize()

    await initializeHasStarted
    callerA.abort(new Error("caller A gave up"))
    const callerAError = await callA.then(
      () => undefined,
      (error: unknown) => error,
    )

    try {
      expect(callerAError).toBeInstanceOf(Error)
      expect((callerAError as Error).message).toBe("caller A gave up")
      expect(initializeStarted).toBe(true)
      expect(initializeCompleted).toBe(false)
    } finally {
      releaseInitialize?.()
    }

    await callB
    expect(initializeCompleted).toBe(true)
  })

  test("dispose() aborts a pending initialize fetch via the composed request signal", async () => {
    let capturedSignal: AbortSignal | undefined
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted.", "AbortError"))
        })
      })
    }) as typeof fetch
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    const initPromise = client.initialize()
    await Promise.resolve()
    expect(capturedSignal?.aborted).toBe(false)

    await client.dispose()

    await expect(initPromise).rejects.toThrow("Bluebird client has been disposed.")
    expect(capturedSignal?.aborted).toBe(true)
  })

  test("disposal aborts a pending SSE reader.read() instead of hanging forever", async () => {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (request.method === "initialize") {
        // A real, never-closing stream: `reader.read()` pends forever unless
        // something external cancels it.
        const stream = new ReadableStream<Uint8Array>({
          start() {
            // Intentionally never enqueue or close.
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      }
      throw new Error(`unexpected method: ${String(request.method)}`)
    }) as typeof fetch
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    const initPromise = client.initialize()
    initPromise.catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 20))

    let unhandled = 0
    const onUnhandledRejection = () => {
      unhandled++
    }
    process.on("unhandledRejection", onUnhandledRejection)
    try {
      await client.dispose()
      await expect(initPromise).rejects.toThrow()
    } finally {
      process.off("unhandledRejection", onUnhandledRejection)
    }
    expect(unhandled).toBe(0)
  })

  test("manager disposal aborts unresolved provisioning and remains reusable", async () => {
    let firstSignal: AbortSignal | undefined
    let provisionCalls = 0
    const provision = (
      _workspace: string,
      signal?: AbortSignal,
    ): Promise<ResolvedBluebirdProvision> => {
      provisionCalls++
      if (provisionCalls > 1) {
        return Promise.resolve({
          organization: "org",
          project: "project",
          repositories: ["repo"],
          branch: "main",
          token: "test-token",
        })
      }
      firstSignal = signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(signal.reason)
        }, { once: true })
      })
    }
    const initializedClient = {
      initialize: async () => {},
      dispose: async () => {},
    } as unknown as BluebirdMcpClient
    const manager = new BluebirdClientManager(
      provision,
      () => initializedClient,
    )

    const pending = manager.getOrCreate("C:\\workspace")
    await Promise.resolve()
    expect(firstSignal?.aborted).toBe(false)

    await manager.disposeAll()
    await expect(pending).rejects.toThrow("manager has been disposed")
    expect(firstSignal?.aborted).toBe(true)

    await manager.disposeAll()
    await expect(manager.getOrCreate("C:\\workspace")).resolves.toBe(
      initializedClient,
    )
    expect(provisionCalls).toBe(2)
    await manager.disposeAll()
  })

  test("manager disposes a client created after its generation is invalidated", async () => {
    let releaseProvision: ((scope: ResolvedBluebirdProvision) => void) | undefined
    let initializeCalls = 0
    let disposeCalls = 0
    const provision = () => new Promise<ResolvedBluebirdProvision>((resolve) => {
      releaseProvision = resolve
    })
    const client = {
      initialize: async () => {
        initializeCalls++
      },
      dispose: async () => {
        disposeCalls++
      },
    } as unknown as BluebirdMcpClient
    const manager = new BluebirdClientManager(provision, () => client)

    const pending = manager.getOrCreate("C:\\workspace")
    await Promise.resolve()
    const disposal = manager.disposeAll()
    releaseProvision?.({
      organization: "org",
      project: "project",
      repositories: ["repo"],
      branch: "main",
      token: "test-token",
    })

    await expect(pending).rejects.toThrow("disposed during provisioning")
    await disposal
    expect(initializeCalls).toBe(0)
    expect(disposeCalls).toBe(0)
  })

  test("manager disposes an unpublished client invalidated during initialization", async () => {
    let initializationStarted: (() => void) | undefined
    let initializeSignal: AbortSignal | undefined
    let disposeCalls = 0
    const started = new Promise<void>((resolve) => {
      initializationStarted = resolve
    })
    const client = {
      initialize: (signal?: AbortSignal) => {
        initializeSignal = signal
        initializationStarted?.()
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        })
      },
      dispose: async () => {
        disposeCalls++
      },
    } as unknown as BluebirdMcpClient
    const manager = new BluebirdClientManager(
      async () => ({
        organization: "org",
        project: "project",
        repositories: ["repo"],
        branch: "main",
        token: "test-token",
      }),
      () => client,
    )

    const pending = manager.getOrCreate("C:\\workspace")
    await started
    const disposal = manager.disposeAll()

    await expect(pending).rejects.toThrow()
    await disposal
    expect(initializeSignal?.aborted).toBe(true)
    expect(disposeCalls).toBeGreaterThanOrEqual(1)
  })
})

describe("BluebirdMcpClient upstream path guard", () => {
  test("drops directory-traversal, drive-letter, and NUL paths while keeping legit hits", async () => {
    installServer(
      [tool("code_search", { method: {}, query: {} })],
      [
        { file: "../evil.ts", line: 1, snippet: "escape" },
        { file: "C:\\Windows\\secret.ts", line: 2, snippet: "drive" },
        { file: "src/ne\0w.ts", line: 3, snippet: "nul" },
        { file: "src//nested/../ok.ts", line: 4, snippet: "dotdot" },
        { file: "src/legit.ts", line: 5, snippet: "legit" },
      ],
    )
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    const rows = await client.searchFileContent("traversal")
    expect(rows.map((row) => row.file)).toEqual(["src/legit.ts"])
  })

  test("relativizes server-absolute paths instead of letting them escape the workspace", async () => {
    installServer(
      [tool("code_search", { method: {}, query: {} })],
      [{ file: "/etc/passwd", line: 1, snippet: "absolute" }],
    )
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    const rows = await client.searchFileContent("absolute")
    // Leading slashes are stripped so downstream workspace resolution stays
    // contained; the row is repo-relative, never host-absolute.
    expect(rows.map((row) => row.file)).toEqual(["etc/passwd"])
  })

  test("an all-traversal array surfaces a clean error instead of empty results", async () => {
    installServer(
      [tool("code_search", { method: {}, query: {} })],
      [{ file: "../../escape.ts", line: 1, snippet: "escape" }],
    )
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    await expect(client.searchFileContent("traversal")).rejects.toThrow(
      "no parseable code hits",
    )
  })
})

describe("BluebirdMcpClient Retry-After handling", () => {
  function installFlakyServer(retryAfter: string | null): { calls: () => number } {
    let calls = 0
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (request.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: request.id, result: {} })
      }
      if (request.method === "notifications/initialized") {
        return new Response(null, { status: 204 })
      }
      if (request.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: [tool("code_search", { method: {}, query: {} })] },
        })
      }
      calls++
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          ...(retryAfter === null ? {} : { headers: { "retry-after": retryAfter } }),
        })
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: [{ file: "src/a.ts", line: 1, snippet: "a" }],
      })
    }) as typeof fetch
    return { calls: () => calls }
  }

  test("honors Retry-After: 0 and retries the call", async () => {
    const counter = installFlakyServer("0")
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    const rows = await client.doVectorSearch("retry me")
    expect(counter.calls()).toBe(2)
    expect(rows).toHaveLength(1)
    expect(rows[0].file).toBe("src/a.ts")
  })

  test("falls back to default backoff on a garbage Retry-After header", async () => {
    const counter = installFlakyServer("not-a-date")
    const client = new BluebirdMcpClient(scope, "test-token", "https://example.test/mcp")

    const rows = await client.doVectorSearch("retry me")
    expect(counter.calls()).toBe(2)
    expect(rows).toHaveLength(1)
  })
})

describe("bluebirdScopeSummary", () => {
  const saved = {
    organization: state.bluebirdOrganization,
    project: state.bluebirdProject,
    repositories: state.bluebirdRepositories,
    branch: state.bluebirdBranch,
  }
  afterEach(() => {
    state.bluebirdOrganization = saved.organization
    state.bluebirdProject = saved.project
    state.bluebirdRepositories = saved.repositories
    state.bluebirdBranch = saved.branch
  })

  test("returns null when unprovisioned", () => {
    state.bluebirdOrganization = null
    state.bluebirdProject = null
    expect(bluebirdScopeSummary()).toBeNull()
  })

  test("formats org/project, repos, and branch", () => {
    state.bluebirdOrganization = "contoso"
    state.bluebirdProject = "webApp"
    state.bluebirdRepositories = ["portal", "admin"]
    state.bluebirdBranch = "main"
    expect(bluebirdScopeSummary()).toBe("contoso/webApp [portal,admin] @ main")
  })

  test("omits the branch suffix when no branch is set", () => {
    state.bluebirdOrganization = "contoso"
    state.bluebirdProject = "webApp"
    state.bluebirdRepositories = ["portal"]
    state.bluebirdBranch = null
    expect(bluebirdScopeSummary()).toBe("contoso/webApp [portal]")
  })
})
