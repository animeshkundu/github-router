// Tests for the `browse` worker MCP tool (the Pi-driven autonomous browser
// agent wired in src/lib/peer-mcp-personas.ts + gated in
// src/routes/mcp/handler.ts via browseAgentEnabled()).
//
// Three things this file pins:
//   1. GATE: the `browse` tool is listed (and callable) iff
//      browseAgentEnabled() — i.e. the `--browse` opt-in + a supported
//      browser + the gpt-5.4-mini default reachable in the catalog. With
//      any of those missing the tool is invisible (tools/list) and rejects
//      with -32601 (tools/call), the same defense-in-depth as the other
//      capability tags.
//   2. SESSION CREATE: a call with no sessionId opens a fresh browse
//      session and threads it into runWorkerAgent + the result text.
//   3. SESSION REUSE: a call with an EXISTING sessionId reuses it (no new
//      session); an UNKNOWN id falls back to a fresh session.
//
// Test isolation note: this file lives in tests/isolated/ because it uses
// mock.module() (worker-agent runWorkerAgent stub + browser-detect force-on).
// The isolated/ directory runs one-process-per-file in CI so those
// module-scope mocks can't bleed into the production-path suites.
//
// NO live model / browser: runWorkerAgent is stubbed (captures opts, returns
// canned text) so the real browse engine + bridge are never reached. The
// session registry is REAL (it's an in-memory Map) and reset per test.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

// Real browse-default + worker-default slugs (deep path is NOT mocked — only
// the index is — so these are the genuine constants the gate keys on).
import {
  BROWSE_DEFAULT_MODEL,
  DEFAULT_MODEL,
} from "../../src/lib/worker-agent/engine"
import { state } from "../../src/lib/state"
import type { ModelsResponse } from "../../src/services/copilot/get-models"
import {
  __testExports as sessionRegistry,
  browseSessionCount,
  createBrowseSession,
  hasBrowseSession,
} from "../../src/lib/browser-mcp/session-registry"

// ---------------------------------------------------------------------
// Mocks (registered before the route graph is dynamically imported)
// ---------------------------------------------------------------------

interface BrowseCall {
  mode: string
  prompt: string
  sessionId?: string
  workspace?: string
}
const runWorkerAgentCalls: Array<BrowseCall> = []
let runWorkerAgentReturn: { text: string; isError?: boolean } = {
  text: "browse-done",
}

// Stub runWorkerAgent at the worker-agent index (what peer-mcp-personas
// imports). Provide the two constants mcp-capabilities reads so the gate
// keeps working with the mock in place.
mock.module("~/lib/worker-agent", () => ({
  DEFAULT_MODEL,
  BROWSE_DEFAULT_MODEL,
  runWorkerAgent: async (opts: BrowseCall) => {
    runWorkerAgentCalls.push(opts)
    return runWorkerAgentReturn
  },
}))

// Force a supported browser so browseAgentEnabled()'s browser half is
// deterministic regardless of the CI host.
mock.module("~/lib/browser-mcp/browser-detect", () => ({
  detectSupportedBrowsers: () => ["chrome"] as ["chrome"],
  _resetSupportedBrowserCache: () => undefined,
  hasSupportedBrowserInstalled: () => true,
}))

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const PROXY_PORT = 18801
const PROXY_HOST = `127.0.0.1:${PROXY_PORT}`
const NONCE = "0123456789abcdef".repeat(4)
const AUTH_HEADER = `Bearer ${NONCE}`

const fakeModel = (id: string, endpoints: Array<string>) => ({
  id,
  name: id,
  vendor: "Test" as const,
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
    supports: { tool_calls: true },
  },
  supported_endpoints: endpoints,
})

// Catalog WITH the browse default. The real Copilot catalog reports bare
// endpoint strings (no `/v1` prefix) — that's what `pickEndpoint` matches —
// and gpt-5.4-mini is /responses-only.
const modelsWithBrowse: ModelsResponse = {
  object: "list",
  data: [
    fakeModel("gpt-5.5", ["/responses"]),
    fakeModel(BROWSE_DEFAULT_MODEL, ["/responses"]),
  ],
}

// Catalog WITHOUT the browse default — exercises the model-reachability
// half of the gate.
const modelsWithoutBrowse: ModelsResponse = {
  object: "list",
  data: [fakeModel("gpt-5.5", ["/responses"])],
}

let savedBrowseEnabled: boolean
let savedEnvBrowseFlag: string | undefined
let savedEnvDisableWorker: string | undefined

function buildReq(body: unknown, urlPath = "/") {
  return new Request(`http://${PROXY_HOST}${urlPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: AUTH_HEADER,
      host: PROXY_HOST,
    },
    body: JSON.stringify(body),
  })
}

async function rpc(body: unknown, urlPath = "/") {
  const { mcpRoutes } = await import("../../src/routes/mcp/route")
  const res = await mcpRoutes.request(buildReq(body, urlPath))
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function listToolNames(): Promise<Array<string>> {
  const { json } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  return (json.result as { tools: Array<{ name: string }> }).tools.map(
    (t) => t.name,
  )
}

beforeEach(async () => {
  const { __resetInFlightForTests } = await import("../../src/routes/mcp/handler")
  __resetInFlightForTests()
  sessionRegistry.reset()
  runWorkerAgentCalls.length = 0
  runWorkerAgentReturn = { text: "browse-done" }

  savedBrowseEnabled = state.browseEnabled
  savedEnvBrowseFlag = process.env.GH_ROUTER_ENABLE_BROWSE
  savedEnvDisableWorker = process.env.GH_ROUTER_DISABLE_WORKER_TOOLS
  // Pin the filesystem worker tools OFF so tools/list is deterministic AND
  // so a passing browse assertion proves browse is gated independently of
  // the worker opt-out (different capability tag).
  process.env.GH_ROUTER_DISABLE_WORKER_TOOLS = "1"
  delete process.env.GH_ROUTER_ENABLE_BROWSE

  state.peerMcpNonce = NONCE
  state.copilotToken = "test-copilot-token"
  state.githubToken = "test-gh-token"
  state.browseEnabled = true
  state.models = modelsWithBrowse
})

afterEach(() => {
  state.peerMcpNonce = undefined
  state.models = undefined
  state.browseEnabled = savedBrowseEnabled
  if (savedEnvBrowseFlag === undefined) delete process.env.GH_ROUTER_ENABLE_BROWSE
  else process.env.GH_ROUTER_ENABLE_BROWSE = savedEnvBrowseFlag
  if (savedEnvDisableWorker === undefined) delete process.env.GH_ROUTER_DISABLE_WORKER_TOOLS
  else process.env.GH_ROUTER_DISABLE_WORKER_TOOLS = savedEnvDisableWorker
  sessionRegistry.reset()
})

const SESSION_SUFFIX_RE = /\[browse session: ([0-9a-f-]{36})\]/

// ============================================================
// Gate: tools/list
// ============================================================

describe("browse tool gate (browseAgentEnabled)", () => {
  test("tools/list includes `browse` when opted in + browser detected + model reachable", async () => {
    const names = await listToolNames()
    expect(names).toContain("browse")
    // Independent of the worker opt-out: explore/implement/review are OFF
    // (GH_ROUTER_DISABLE_WORKER_TOOLS=1) yet browse still shows.
    expect(names).not.toContain("explore")
  })

  test("tools/list OMITS `browse` when not opted in (browseEnabled=false, no env)", async () => {
    state.browseEnabled = false
    const names = await listToolNames()
    expect(names).not.toContain("browse")
  })

  test("tools/list OMITS `browse` when the gpt-5.4-mini default is absent from the catalog", async () => {
    state.models = modelsWithoutBrowse
    const names = await listToolNames()
    expect(names).not.toContain("browse")
  })

  test("defense-in-depth: tools/call `browse` returns -32601 when the gate is off", async () => {
    state.browseEnabled = false
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "browse", arguments: { task: "open example.com" } },
    })
    const err = (json as { error?: { code: number; message: string } }).error
    expect(err?.code).toBe(-32601)
    expect(err?.message).toMatch(/unknown tool/i)
    // The gated call must not have dispatched to the engine.
    expect(runWorkerAgentCalls.length).toBe(0)
  })
})

// ============================================================
// Session create / reuse
// ============================================================

describe("browse tool session handling", () => {
  test("a call with no sessionId creates a fresh session and threads it through", async () => {
    expect(browseSessionCount()).toBe(0)
    const { json } = await rpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "browse", arguments: { task: "read the homepage" } },
      },
      "/workers",
    )
    const result = json.result as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeUndefined()

    // Exactly one session was created.
    expect(browseSessionCount()).toBe(1)

    // The engine saw mode:browse + the task as prompt + a session id.
    expect(runWorkerAgentCalls.length).toBe(1)
    const call = runWorkerAgentCalls[0]!
    expect(call.mode).toBe("browse")
    expect(call.prompt).toBe("read the homepage")
    expect(typeof call.sessionId).toBe("string")
    expect(hasBrowseSession(call.sessionId!)).toBe(true)

    // The result text echoes the SAME session id for continuation.
    const m = SESSION_SUFFIX_RE.exec(result.content[0]!.text)
    expect(m).not.toBeNull()
    expect(m![1]).toBe(call.sessionId!)
    expect(result.content[0]!.text.startsWith("browse-done")).toBe(true)
  })

  test("a call with an EXISTING sessionId reuses it (no new session)", async () => {
    const existing = createBrowseSession()
    expect(browseSessionCount()).toBe(1)

    const { json } = await rpc(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "browse",
          arguments: { task: "click the second link", sessionId: existing },
        },
      },
      "/workers",
    )
    const result = json.result as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeUndefined()

    // No new session was opened — the existing one was reused.
    expect(browseSessionCount()).toBe(1)
    expect(runWorkerAgentCalls.length).toBe(1)
    expect(runWorkerAgentCalls[0]!.sessionId).toBe(existing)

    // The echoed id is the reused one.
    const m = SESSION_SUFFIX_RE.exec(result.content[0]!.text)
    expect(m![1]).toBe(existing)
  })

  test("an UNKNOWN sessionId falls back to a fresh session", async () => {
    expect(browseSessionCount()).toBe(0)
    const { json } = await rpc(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "browse",
          arguments: { task: "go to the docs", sessionId: "not-a-real-session" },
        },
      },
      "/workers",
    )
    const result = json.result as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeUndefined()

    // A fresh session was created (the bogus id was NOT adopted verbatim).
    expect(browseSessionCount()).toBe(1)
    const call = runWorkerAgentCalls[0]!
    expect(call.sessionId).not.toBe("not-a-real-session")
    expect(hasBrowseSession(call.sessionId!)).toBe(true)
  })

  test("two concurrent calls run as two parallel sessions", async () => {
    expect(browseSessionCount()).toBe(0)
    const mk = (id: number, task: string) =>
      rpc(
        {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "browse", arguments: { task } },
        },
        "/workers",
      )
    await Promise.all([mk(6, "task A"), mk(7, "task B")])
    expect(browseSessionCount()).toBe(2)
    expect(runWorkerAgentCalls.length).toBe(2)
    const ids = runWorkerAgentCalls.map((c) => c.sessionId)
    expect(new Set(ids).size).toBe(2) // distinct sessions
  })

  test("isError from the engine passes through, with the session id still appended", async () => {
    runWorkerAgentReturn = { text: "could not load page", isError: true }
    const { json } = await rpc(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "browse", arguments: { task: "open a dead url" } },
      },
      "/workers",
    )
    const result = json.result as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(SESSION_SUFFIX_RE.test(result.content[0]!.text)).toBe(true)
  })

  test("a missing `task` is a clean isError (no session created)", async () => {
    const { json } = await rpc(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "browse", arguments: {} },
      },
      "/workers",
    )
    const result = json.result as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/task is required/i)
    expect(browseSessionCount()).toBe(0)
    expect(runWorkerAgentCalls.length).toBe(0)
  })
})
