import { afterEach, describe, expect, test } from "bun:test"

import {
  ADO_DEFAULT_TOOLSETS,
  ADO_TOKEN_ENV,
  ADO_TOOLSET_VALUES,
  AdoError,
  AdoMcpClient,
  adoToolsetHeader,
  getAdoToken,
  normalizeAdoOrganization,
  normalizeAdoToolsets,
  type AdoToolDescriptor,
} from "../src/lib/ado-client"
import { buildAdoToolEntries } from "../src/lib/ado-tools"

// Hermetic by construction: a fictional host passed as `baseUrl`, an injected
// `tokenProvider`, and a mocked global fetch. Nothing here reaches
// `mcp.dev.azure.com`, a real organization, or `az`. The bearer literal is
// deliberately synthetic so a leak is impossible to miss.

const BASE_URL = "https://ado.example.test"
const ORGANIZATION = "contoso"
const SYNTHETIC_TOKEN = "synthetic-ado-token-not-a-credential"

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

const originalFetch = globalThis.fetch
const originalAdoToken = process.env[ADO_TOKEN_ENV]

/**
 * A recorded `tools/list` fixture. Names and shapes are transcribed from the
 * live read-only listing (2026-10-15) so a silent upstream expansion is
 * visible here as a count change rather than only in production.
 */
const RECORDED_TOOLS: Array<AdoToolDescriptor> = [
  tool("core_list_projects", { top: { type: "number" } }),
  tool("core_get_identity_ids", { searchFilter: { type: "string" } }),
  tool("repo_list_repos_by_project", { project: { type: "string" } }),
  tool("repo_pull_request", { action: { type: "string" }, repositoryId: { type: "string" } }),
  tool("repo_search_commits", { searchText: { type: "string" } }),
  tool("wit_work_item", { action: { type: "string" }, id: { type: "number" } }),
  tool("wit_query", { query: { type: "string" } }),
  tool("pipelines_build", { action: { type: "string" }, buildId: { type: "number" } }),
  tool("wiki_wiki", { action: { type: "string" }, wikiIdentifier: { type: "string" } }),
]

function tool(name: string, properties: Record<string, unknown>): AdoToolDescriptor {
  return {
    name,
    description: `${name} (recorded fixture)`,
    inputSchema: { type: "object", properties },
  }
}

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
  tools?: Array<AdoToolDescriptor>
  /** Reply to a `tools/call`; default is a single text block. */
  callResult?: unknown
  /** Assign an `Mcp-Session-Id` on `initialize` (the live server does not). */
  sessionId?: string
  /** Frame every reply as SSE instead of JSON. */
  sse?: boolean
  /** Reply to `initialize` with this status. */
  initStatus?: number
}

/**
 * Install a mock server and return the recorded requests plus a client wired
 * to it. The transport is exercised for real: the client's own `initialize` /
 * `tools/list` / `tools/call` sequence runs against this handler.
 */
function installServer(opts: ServerOpts = {}) {
  const requests: Array<Captured> = []
  const tools = opts.tools ?? RECORDED_TOOLS
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value
    }
    const request = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {}
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: request,
    })

    if (request.method === "initialize") {
      if (opts.initStatus && opts.initStatus !== 200) {
        return new Response("denied", { status: opts.initStatus })
      }
      const payload = {
        jsonrpc: "2.0",
        id: request.id,
        result: { protocolVersion: "2025-06-18", serverInfo: { name: "AzureDevOps.Mcp" } },
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
      const payload = { jsonrpc: "2.0", id: request.id, result: { tools } }
      return opts.sse ? sseResponse(payload) : jsonResponse(payload)
    }
    if (request.method === "tools/call") {
      const payload = {
        jsonrpc: "2.0",
        id: request.id,
        result: opts.callResult ?? { content: [{ type: "text", text: "ok" }] },
      }
      return opts.sse ? sseResponse(payload) : jsonResponse(payload)
    }
    throw new Error(`unexpected method: ${String(request.method)}`)
  }) as typeof fetch

  const client = new AdoMcpClient({
    organization: ORGANIZATION,
    baseUrl: BASE_URL,
    token: SYNTHETIC_TOKEN,
    tokenProvider: async () => SYNTHETIC_TOKEN,
  })
  return { client, requests }
}

function callRequests(requests: Array<Captured>): Array<Captured> {
  return requests.filter((r) => r.body.method === "tools/call")
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalAdoToken === undefined) delete process.env[ADO_TOKEN_ENV]
  else process.env[ADO_TOKEN_ENV] = originalAdoToken
})

describe("normalizeAdoOrganization", () => {
  test("accepts the character set Azure DevOps issues", () => {
    expect(normalizeAdoOrganization("contoso")).toBe("contoso")
    expect(normalizeAdoOrganization("  contoso-eng  ")).toBe("contoso-eng")
    expect(normalizeAdoOrganization("a")).toBe("a")
  })

  test("rejects anything that would change which endpoint is addressed", () => {
    // The organization becomes a URL path segment. A dot, slash, or space here
    // silently reaches a different host or path, so none is encoded — each is
    // refused.
    expect(() => normalizeAdoOrganization("")).toThrow(AdoError)
    expect(() => normalizeAdoOrganization("contoso/../other")).toThrow(/letters, digits, or hyphens/)
    expect(() => normalizeAdoOrganization("contoso.visualstudio.com")).toThrow(AdoError)
    expect(() => normalizeAdoOrganization("-leading")).toThrow(AdoError)
    expect(() => normalizeAdoOrganization("a".repeat(65))).toThrow(AdoError)
  })
})

describe("normalizeAdoToolsets", () => {
  test("splits, trims, lowercases, and dedupes", () => {
    expect(normalizeAdoToolsets(" repos , WIT ,repos ")).toEqual(["repos", "wit"])
  })

  test("accepts a string array as well as a csv string", () => {
    expect(normalizeAdoToolsets(["pipelines", "wiki"])).toEqual(["pipelines", "wiki"])
  })

  test("collapses 'all' because it is the absence of a filter", () => {
    expect(normalizeAdoToolsets("repos,all")).toEqual(["all"])
    expect(normalizeAdoToolsets("all")).toEqual(["all"])
  })

  test("a typo is refused, naming the valid values", () => {
    // `core` and `repositories` are the values an earlier draft guessed and the
    // live server rejects. They must fail here, before the wire.
    expect(() => normalizeAdoToolsets("core")).toThrow(/Unknown Azure DevOps toolset/)
    expect(() => normalizeAdoToolsets("repositories")).toThrow(/Unknown Azure DevOps toolset/)
    expect(() => normalizeAdoToolsets("repos,nope")).toThrow(/repos, advsec/)
    expect(() => normalizeAdoToolsets("  ,  ")).toThrow(/empty/)
  })

  test("the documented value list is the one enforced", () => {
    expect([...ADO_TOOLSET_VALUES]).toEqual([
      "all",
      "repos",
      "advsec",
      "wit",
      "pipelines",
      "wiki",
      "work",
      "testplan",
      "elm",
    ])
  })
})

describe("adoToolsetHeader", () => {
  test("omits the header for the 'all' selection", () => {
    expect(adoToolsetHeader([])).toBeUndefined()
    expect(adoToolsetHeader(["all"])).toBeUndefined()
  })

  test("joins a real selection", () => {
    expect(adoToolsetHeader(ADO_DEFAULT_TOOLSETS)).toBe("repos,wit,pipelines,wiki")
  })
})

describe("AdoMcpClient read-only default", () => {
  test("sends X-MCP-Readonly and the curated toolsets on every request", async () => {
    const { client, requests } = installServer()
    await client.initialize()
    await client.callAdoTool("repo_pull_request", { action: "list" })

    expect(requests.length).toBeGreaterThanOrEqual(4)
    for (const request of requests) {
      expect(request.headers["x-mcp-readonly"]).toBe("true")
      expect(request.headers["x-mcp-toolsets"]).toBe("repos,wit,pipelines,wiki")
      expect(request.headers.authorization).toBe(`Bearer ${SYNTHETIC_TOKEN}`)
    }
    expect(requests[0]!.url).toBe(`${BASE_URL}/${ORGANIZATION}`)
  })

  test("--ado-write omits the read-only header and nothing else", async () => {
    const { requests: _ignored } = installServer()
    const writable = new AdoMcpClient({
      organization: ORGANIZATION,
      baseUrl: BASE_URL,
      readOnly: false,
      token: SYNTHETIC_TOKEN,
      tokenProvider: async () => SYNTHETIC_TOKEN,
    })
    await writable.initialize()
    expect(_ignored.length).toBeGreaterThan(0)
    expect(_ignored[0]!.headers["x-mcp-readonly"]).toBeUndefined()
    // The toolset filter is INDEPENDENT of the read-only switch: a write-capable
    // session still asks for the same curated toolsets.
    expect(_ignored[0]!.headers["x-mcp-toolsets"]).toBe("repos,wit,pipelines,wiki")
    expect(writable.readOnly).toBe(false)
  })

  test("the 'all' toolset selection omits the toolsets header entirely", async () => {
    const requests: Array<Captured> = []
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[key.toLowerCase()] = value
      }
      requests.push({ url: String(_url), method: init?.method ?? "GET", headers, body: request })
      if (request.method === "tools/list") {
        return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: RECORDED_TOOLS } })
      }
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: {} })
    }) as typeof fetch

    const all = new AdoMcpClient({
      organization: ORGANIZATION,
      baseUrl: BASE_URL,
      toolsets: ["all"],
      token: SYNTHETIC_TOKEN,
      tokenProvider: async () => SYNTHETIC_TOKEN,
    })
    await all.initialize()
    expect(requests[0]!.headers["x-mcp-toolsets"]).toBeUndefined()
    expect(requests[0]!.headers["x-mcp-readonly"]).toBe("true")
  })
})

describe("AdoMcpClient protocol", () => {
  test("is stateless: no Mcp-Session-Id is sent when the server assigns none", async () => {
    const { client, requests } = installServer()
    await client.initialize()
    await client.callAdoTool("wit_query", { query: "SELECT [System.Id] FROM WorkItems" })
    for (const request of requests) {
      expect(request.headers["mcp-session-id"]).toBeUndefined()
    }
  })

  test("honours a server-assigned session id when one is present", async () => {
    const { client, requests } = installServer({ sessionId: "session-1" })
    await client.initialize()
    await client.callAdoTool("wit_query", { query: "x" })
    // `initialize` itself cannot carry one (it is the response that assigns it),
    // but every subsequent request must.
    const calls = callRequests(requests)
    expect(calls.length).toBe(1)
    expect(calls[0]!.headers["mcp-session-id"]).toBe("session-1")
  })

  test("parses an SSE-framed reply", async () => {
    const { client } = installServer({
      sse: true,
      callResult: { content: [{ type: "text", text: "sse result" }] },
    })
    const result = await client.callAdoTool("core_list_projects", {})
    expect(result.content[0]!.text).toBe("sse result")
  })

  test("initialize populates the advertised tool set", async () => {
    const { client } = installServer()
    await client.initialize()
    expect(client.listAdoTools().map((t) => t.name)).toEqual(RECORDED_TOOLS.map((t) => t.name))
    expect(client.hasTool("repo_pull_request")).toBe(true)
    expect(client.hasTool("repo_delete_repository")).toBe(false)
  })

  test("a tool the server never advertised is refused locally, listing what exists", async () => {
    const { client, requests } = installServer()
    await client.initialize()
    const before = callRequests(requests).length
    const err = await client.callAdoTool("repo_delete_repository", {}).catch((e) => e)
    expect(err).toBeInstanceOf(AdoError)
    expect(err.message).toContain("does not advertise a tool named")
    expect(err.message).toContain("repo_pull_request")
    // Refused before the wire, so a hallucinated name cannot probe the server.
    expect(callRequests(requests).length).toBe(before)
  })

  test("a tool-level isError is passed through, not thrown", async () => {
    const { client } = installServer({
      callResult: { content: [{ type: "text", text: "not found" }], isError: true },
    })
    const result = await client.callAdoTool("wit_work_item", { id: 1 })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe("not found")
  })

  test("a result with no text blocks becomes a stated empty result", async () => {
    const { client } = installServer({ callResult: { content: [] } })
    const result = await client.callAdoTool("core_list_projects", {})
    expect(result.content[0]!.text).toBe("Azure DevOps returned an empty result.")
  })

  test("a result over the character cap is truncated with an explicit trailer", async () => {
    const { client } = installServer({
      callResult: { content: [{ type: "text", text: "z".repeat(70_000) }] },
    })
    const result = await client.callAdoTool("repo_search_commits", { searchText: "x" })
    const text = result.content[0]!.text
    expect(text.length).toBeLessThan(61_000)
    expect(text).toContain("result truncated at 60000 characters")
  })
})

describe("AdoMcpClient token refresh", () => {
  test("a 401 during tools/call mints a replacement token and retries once", async () => {
    let minted = 0
    let unauthorized = true
    const seen: Array<string> = []
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push(headers.Authorization ?? "")
      if (request.method === "tools/list") {
        return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: RECORDED_TOOLS } })
      }
      if (request.method === "tools/call") {
        if (unauthorized) {
          unauthorized = false
          return new Response("expired", { status: 401 })
        }
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { content: [{ type: "text", text: "after refresh" }] },
        })
      }
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: {} })
    }) as typeof fetch

    const client = new AdoMcpClient({
      organization: ORGANIZATION,
      baseUrl: BASE_URL,
      token: SYNTHETIC_TOKEN,
      tokenProvider: async () => {
        minted += 1
        return `refreshed-token-${minted}`
      },
    })
    const result = await client.callAdoTool("wit_query", { query: "x" })
    expect(result.content[0]!.text).toBe("after refresh")
    expect(minted).toBe(1)
    // The first request of the sequence carried the stale token; the last
    // carried the replacement. The refresh also resets the MCP session, so the
    // sequence is longer than one request per operation — which is why the
    // assertion is on the ENDS rather than on adjacent pairs.
    expect(seen[0]).toBe(`Bearer ${SYNTHETIC_TOKEN}`)
    expect(seen.at(-1)).toBe("Bearer refreshed-token-1")
    expect(seen).not.toContain("Bearer refreshed-token-2")
  })
})

describe("buildAdoToolEntries", () => {
  test("maps a recorded fixture to ado-grouped, ado-capability entries", () => {
    const entries = buildAdoToolEntries(RECORDED_TOOLS)
    expect(entries).toHaveLength(RECORDED_TOOLS.length)
    for (const entry of entries) {
      expect(entry.group).toBe("ado")
      expect(entry.capability).toBe("ado")
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.inputSchema).toBeDefined()
    }
    // The dispatcher tools carry their `action` argument through unchanged: it
    // is advertised as a plain string with no enum, so nothing here may invent
    // a classification the server did not publish.
    const pr = entries.find((e) => e.toolNameHttp === "repo_pull_request")!
    const properties = (pr.inputSchema as { properties: Record<string, { type: string }> }).properties
    expect(properties.action!.type).toBe("string")
    expect(properties.action).not.toHaveProperty("enum")
  })

  test("a name the proxy already serves is dropped rather than shadowed", () => {
    // `code` and `web` are proxy tools in the `search` group. An upstream tool
    // by either name would make one name reach two implementations.
    const entries = buildAdoToolEntries([
      tool("code", {}),
      tool("repo_list_repos_by_project", {}),
      tool("web", {}),
    ])
    expect(entries.map((e) => e.toolNameHttp)).toEqual(["repo_list_repos_by_project"])
  })

  test("a duplicate within the upstream list is kept once", () => {
    const entries = buildAdoToolEntries([
      tool("core_list_projects", {}),
      tool("core_list_projects", {}),
    ])
    expect(entries).toHaveLength(1)
  })

  test("a nameless entry is skipped", () => {
    const entries = buildAdoToolEntries([tool("  ", {}), tool("core_list_projects", {})])
    expect(entries.map((e) => e.toolNameHttp)).toEqual(["core_list_projects"])
  })
})

describe("getAdoToken", () => {
  test("ADO_MCP_TOKEN overrides the az path", async () => {
    process.env[ADO_TOKEN_ENV] = "  env-ado-token  "
    expect(await getAdoToken()).toBe("env-ado-token")
  })

  test("an already-aborted signal rejects with the abort reason", async () => {
    const controller = new AbortController()
    controller.abort(new Error("cancelled before start"))
    await expect(getAdoToken(controller.signal)).rejects.toThrow(/cancelled before start/)
  })
})
