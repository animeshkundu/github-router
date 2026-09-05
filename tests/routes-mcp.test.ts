import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { mcpRoutes } from "../src/routes/mcp/route"
import { registerLaunch, unregisterLaunch } from "../src/lib/launch-registry"
import {
  __getInFlightForTests,
  __resetInFlightForTests,
  applySessionWorkspace,
} from "../src/routes/mcp/handler"
import { MAX_INFLIGHT_TOOLS_CALL } from "../src/lib/mcp-inflight"
import { state } from "../src/lib/state"
import type { ModelsResponse } from "../src/services/copilot/get-models"
import {
  __resetForTests as __resetWorkerSlotsForTests,
  acquireWorkerSlot,
  MAX_INFLIGHT_WORKER_CALLS,
} from "../src/lib/worker-agent/semaphore"

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
    fakeModel("claude-opus-5", ["/v1/messages", "/v1/chat/completions"]),
  ],
}

const originalFetch = globalThis.fetch
let savedDisableSemantic: string | undefined
const artifactEnvKeys = [
  "AIORDIE_BASE_URL",
  "AIORDIE_TOKEN",
  "AIORDIE_SESSION_ID",
] as const
let savedArtifactEnv: Record<(typeof artifactEnvKeys)[number], string | undefined>

beforeEach(() => {
  __resetInFlightForTests()
  __resetWorkerSlotsForTests()
  // Pin semantic_search OFF so tools/list surface assertions are
  // deterministic regardless of whether the colgrep sidecar happens to
  // be provisioned on the test host (the availability gate would
  // otherwise add `semantic_search` to the search group on a dev box
  // that has run it). Mirrors the GH_ROUTER_DISABLE_WORKER_TOOLS pin.
  savedDisableSemantic = process.env.GH_ROUTER_DISABLE_SEMANTIC_SEARCH
  process.env.GH_ROUTER_DISABLE_SEMANTIC_SEARCH = "1"
  savedArtifactEnv = {
    AIORDIE_BASE_URL: process.env.AIORDIE_BASE_URL,
    AIORDIE_TOKEN: process.env.AIORDIE_TOKEN,
    AIORDIE_SESSION_ID: process.env.AIORDIE_SESSION_ID,
  }
  for (const key of artifactEnvKeys) delete process.env[key]
  state.peerMcpNonce = NONCE
  state.serveMode = false
  state.copilotToken = "test-copilot-token"
  state.githubToken = "test-gh-token"
  state.vsCodeVersion = "1.99.0"
  state.copilotVersion = "0.43.0"
  state.accountType = "individual"
  state.models = baseModels
})

afterEach(() => {
  state.peerMcpNonce = undefined
  state.serveMode = undefined
  state.models = undefined
  if (savedDisableSemantic === undefined) {
    delete process.env.GH_ROUTER_DISABLE_SEMANTIC_SEARCH
  } else {
    process.env.GH_ROUTER_DISABLE_SEMANTIC_SEARCH = savedDisableSemantic
  }
  for (const key of artifactEnvKeys) {
    const value = savedArtifactEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  globalThis.fetch = originalFetch
})

function buildReq(body: unknown, opts: { auth?: string; host?: string; workspace?: string } = {}) {
  return new Request(`http://${PROXY_HOST}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: opts.auth ?? AUTH_HEADER,
      host: opts.host ?? PROXY_HOST,
      ...(opts.workspace ? { "X-GH-Workspace": opts.workspace } : {}),
    },
    body: JSON.stringify(body),
  })
}

async function rpc(body: unknown, opts: { auth?: string; host?: string; workspace?: string } = {}) {
  const res = await mcpRoutes.request(buildReq(body, opts))
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

/**
 * Build a request against a SCOPED `/mcp/<group>` endpoint. The unscoped
 * `buildReq`/`rpc` helpers hit `/` (scope "all"); these target the
 * path-scoped routes the split introduced so a single group's tool
 * surface (and the per-group serverInfo.name / scope reject) can be
 * exercised.
 */
function buildScopedReq(
  group: string,
  body: unknown,
  opts: { auth?: string; host?: string } = {},
) {
  return new Request(`http://${PROXY_HOST}/${group}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: opts.auth ?? AUTH_HEADER,
      host: opts.host ?? PROXY_HOST,
    },
    body: JSON.stringify(body),
  })
}

async function scopedRpc(
  group: string,
  body: unknown,
  opts: { auth?: string; host?: string } = {},
) {
  const res = await mcpRoutes.request(buildScopedReq(group, body, opts))
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

describe("/mcp session workspace header", () => {
  test("applySessionWorkspace injects an absolute header only when workspace is absent or empty", () => {
    const args: Record<string, unknown> = { prompt: "inspect" }
    applySessionWorkspace(args, process.cwd())
    expect(args.workspace).toBe(process.cwd())

    const explicit: Record<string, unknown> = { workspace: "/explicit" }
    applySessionWorkspace(explicit, process.cwd())
    expect(explicit.workspace).toBe("/explicit")

    const empty: Record<string, unknown> = { workspace: "" }
    applySessionWorkspace(empty, process.cwd())
    expect(empty.workspace).toBe(process.cwd())

    const relative: Record<string, unknown> = {}
    applySessionWorkspace(relative, "relative/path")
    expect(relative.workspace).toBeUndefined()
  })

  test("applySessionWorkspace reports which source the workspace came from", () => {
    // The merge into `args` makes a header-derived workspace look identical to
    // one the caller chose, and those warrant different treatment: a caller
    // knows where it is, a per-connection header only knows where the SESSION
    // is. The return value is how that distinction survives.
    expect(applySessionWorkspace({ workspace: "/explicit" }, process.cwd())).toBe(
      "argument",
    )
    expect(applySessionWorkspace({ prompt: "x" }, process.cwd())).toBe("session")
    expect(applySessionWorkspace({ workspace: "" }, process.cwd())).toBe("session")
    expect(applySessionWorkspace({ prompt: "x" }, undefined)).toBe("absent")
    // A relative header is not usable, so it is not a source.
    expect(applySessionWorkspace({ prompt: "x" }, "relative/path")).toBe("absent")
  })

  test("persona calls do not receive a workspace from the session header", async () => {
    let captured: Record<string, unknown> | undefined
    globalThis.fetch = mock(async (_url: unknown, init?: { body?: string }) => {
      if (init?.body) captured = JSON.parse(init.body) as Record<string, unknown>
      return new Response(JSON.stringify({
        id: "resp_1",
        object: "response",
        created_at: Date.now(),
        model: "gpt-5.5",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch

    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 90,
      method: "tools/call",
      params: { name: "codex_critic", arguments: { prompt: "review this tiny plan" } },
    }, { workspace: process.cwd() })

    expect(status).toBe(200)
    expect((json.result as { isError?: boolean }).isError).toBeFalsy()
    expect(JSON.stringify(captured)).not.toContain("workspace")
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

  test("tools/list returns 5 personas + web + code + stand_in when all required models are in catalog", async () => {
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
      "attest_step",
      "code",
      "codex_critic",
      "codex_reviewer",
      "gemini_critic",
      "gemini_reviewer",
      "opus_critic",
      "stand_in",
      "verify_workflow",
      "web",
    ])
    for (const t of result.tools) {
      expect(t.description.length).toBeGreaterThan(20)
      expect(t.inputSchema).toBeDefined()
    }
    const standIn = result.tools.find((t) => t.name === "stand_in")
    const standInSchema = standIn!.inputSchema as { required: Array<string> }
    expect(standInSchema.required).toEqual(["decision", "options", "context"])
  })

  test("tools/list omits gemini_critic AND stand_in when no gemini-3.x-pro in catalog (web + code still present)", async () => {
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
      "attest_step",
      "code",
      "codex_critic",
      "codex_reviewer",
      "opus_critic",
      "verify_workflow",
      "web",
    ])
  })

  // Regression: activePersonas() (the actual /mcp dispatch path, distinct from
  // personasFor()'s own already-covered test) used to set `.model` to the
  // resolved fallback while leaving `.description` unchanged, so `tools/list`
  // would advertise "backed by gemini-3.1-pro-preview" for a persona actually
  // dispatching to gemini-3.8-flash. Assert the two never disagree.
  test("tools/list persona descriptions agree with the resolved model when Pro is absent and Flash is present", async () => {
    state.models = {
      object: "list",
      data: [
        ...baseModels.data.filter((m) => !m.id.startsWith("gemini")),
        fakeModel("gemini-3.8-flash", ["/v1/chat/completions"]),
      ],
    }
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })
    const result = json.result as { tools: Array<{ name: string; description: string }> }
    const critic = result.tools.find((t) => t.name === "gemini_critic")
    const reviewer = result.tools.find((t) => t.name === "gemini_reviewer")
    expect(critic).toBeDefined()
    expect(reviewer).toBeDefined()
    for (const t of [critic, reviewer]) {
      expect(t!.description).toContain("gemini-3.8-flash")
      expect(t!.description).not.toContain("gemini-3.1-pro-preview")
    }
  })

  test("tools/list web entry has {query} input schema (no prompt/effort)", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })
    const result = json.result as {
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>
    }
    const entry = result.tools.find((t) => t.name === "web")
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

describe("/mcp scoped endpoints (/mcp/:group)", () => {
  test("POST /mcp/search tools/list returns ONLY the search group's tools (code + web), no personas or browser", async () => {
    const { status, json } = await scopedRpc("search", {
      jsonrpc: "2.0",
      id: 800,
      method: "tools/list",
    })
    expect(status).toBe(200)
    const result = json.result as { tools: Array<{ name: string }> }
    const names = result.tools.map((t) => t.name).sort()
    // Scoped to `search`: exactly `code` + `web`.
    expect(names).toEqual(["code", "web"])
    // Personas live in the `peers` group — must NOT leak onto /mcp/search.
    expect(names).not.toContain("codex_critic")
    expect(names).not.toContain("opus_critic")
    expect(names).not.toContain("gemini_critic")
    // stand_in is the `decide` group; browser tools the `browser` group.
    expect(names).not.toContain("stand_in")
    expect(names).not.toContain("navigate")
  })

  test("POST /mcp/peers tools/list returns the persona tools, not search/decide tools", async () => {
    const { status, json } = await scopedRpc("peers", {
      jsonrpc: "2.0",
      id: 801,
      method: "tools/list",
    })
    expect(status).toBe(200)
    const names = (json.result as { tools: Array<{ name: string }> }).tools
      .map((t) => t.name)
      .sort()
    // Personas present (4 read personas with gemini in the base catalog).
    expect(names).toContain("codex_critic")
    expect(names).toContain("codex_reviewer")
    expect(names).toContain("gemini_critic")
    expect(names).toContain("opus_critic")
    // Other groups' tools absent.
    expect(names).not.toContain("code")
    expect(names).not.toContain("web")
    expect(names).not.toContain("stand_in")
  })

  test("POST /mcp/orchestrate tools/list returns the always-on orchestration tools, not other groups'", async () => {
    const { status, json } = await scopedRpc("orchestrate", {
      jsonrpc: "2.0",
      id: 803,
      method: "tools/list",
    })
    expect(status).toBe(200)
    const names = (json.result as { tools: Array<{ name: string }> }).tools
      .map((t) => t.name)
      .sort()
    // Pure, always-on orchestration tools (no capability gate).
    expect(names).toContain("verify_workflow")
    expect(names).toContain("attest_step")
    // decompose / run_workflow are worker-gated; this catalog has no worker
    // backend, so they are filtered out of the scoped list.
    expect(names).not.toContain("decompose")
    expect(names).not.toContain("run_workflow")
    // Other groups' tools absent.
    expect(names).not.toContain("code")
    expect(names).not.toContain("codex_critic")
  })

  test("calling a persona on /mcp/search returns -32601 (tool not in this group)", async () => {
    // The scope reject mirrors an unknown-tool rejection: codex_critic is a
    // `peers`-group tool, so dispatching it on the `search` endpoint must
    // fail with method-not-found, NOT route to the persona.
    const sentinel = mock(async () => {
      throw new Error("upstream MUST NOT be called for a cross-group tool")
    })
    globalThis.fetch = sentinel as unknown as typeof globalThis.fetch
    const { status, json } = await scopedRpc("search", {
      jsonrpc: "2.0",
      id: 802,
      method: "tools/call",
      params: { name: "codex_critic", arguments: { prompt: "x" } },
    })
    expect(status).toBe(200)
    const err = json.error as { code: number; message: string }
    expect(err.code).toBe(-32601)
    expect(err.message).toMatch(/unknown tool/i)
    expect(sentinel).not.toHaveBeenCalled()
  })

  test("calling the search-group `web` tool on /mcp/search dispatches normally (in-group)", async () => {
    // Positive control: a tool that DOES belong to the scoped group routes
    // through to its handler. Mocks the Copilot /mcp upstream the web tool
    // relays to (initialize → notifications/initialized → tools/call SSE).
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
      // tools/call → SSE result envelope
      const inner = { text: { value: "in-group ok", annotations: null } }
      return new Response(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: JSON.stringify(inner) }] },
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    }) as unknown as typeof globalThis.fetch

    const { status, json } = await scopedRpc("search", {
      jsonrpc: "2.0",
      id: 803,
      method: "tools/call",
      params: { name: "web", arguments: { query: "hi" } },
    })
    expect(status).toBe(200)
    const result = json.result as { content: Array<{ text: string }>; isError?: boolean }
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain("in-group ok")
  })

  test("POST /mcp/bogus (unknown group) returns 404 with a JSON-RPC -32601 envelope and id:null", async () => {
    const res = await mcpRoutes.request(
      buildScopedReq("bogus", {
        jsonrpc: "2.0",
        id: 804,
        method: "tools/list",
      }),
    )
    expect(res.status).toBe(404)
    const json = (await res.json()) as {
      jsonrpc: string
      id: unknown
      error: { code: number; message: string }
    }
    expect(json.jsonrpc).toBe("2.0")
    expect(json.id).toBeNull()
    expect(json.error.code).toBe(-32601)
    expect(json.error.message).toMatch(/unknown mcp group/i)
  })

  test("initialize serverInfo.name is scope-specific: /mcp/search → github-router-search", async () => {
    const { status, json } = await scopedRpc("search", {
      jsonrpc: "2.0",
      id: 805,
      method: "initialize",
    })
    expect(status).toBe(200)
    const result = json.result as { serverInfo: { name: string } }
    expect(result.serverInfo.name).toBe("github-router-search")
  })

  test("initialize serverInfo.name on the unscoped / union stays github-router-peers", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 806,
      method: "initialize",
    })
    const result = json.result as { serverInfo: { name: string } }
    expect(result.serverInfo.name).toBe("github-router-peers")
  })

  test("unscoped / tools/list returns the FULL union across groups (personas + code + web + stand_in)", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 807,
      method: "tools/list",
    })
    expect(status).toBe(200)
    const names = (json.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    )
    // Personas (peers group).
    expect(names).toContain("codex_critic")
    expect(names).toContain("opus_critic")
    // search group.
    expect(names).toContain("code")
    expect(names).toContain("web")
    // decide group (gpt-5.5 + opus-4-7 + gemini present in base catalog).
    expect(names).toContain("stand_in")
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
        model: "claude-opus-5",
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

  test("codex_critic call hits /responses with model=gpt-5.6-sol and persona instructions", async () => {
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
    expect(upstream.model).toBe("gpt-5.6-sol")
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

  test("verify_workflow dispatches to the static verifier (ok IR vs invalid IR)", async () => {
    const validIr = {
      rawAskHash: "r", acceptanceCriteriaHash: "a", maxDepth: 1,
      nodes: [
        { id: "baseline", role: "baseline", inputs: [], gate: { kind: "none" }, onFail: "baseline" },
        { id: "impl", role: "implement", producerLab: "openai", inputs: [], gate: { kind: "executable", gateId: "typecheck-test" }, onFail: "loop" },
        { id: "select", role: "selector", inputs: ["baseline", "impl"], gate: { kind: "none" }, onFail: "baseline", judgesOnRawAsk: true },
      ],
    }
    const ok = await rpc({
      jsonrpc: "2.0", id: 200, method: "tools/call",
      params: { name: "verify_workflow", arguments: { ir: validIr } },
    })
    expect(ok.status).toBe(200)
    const okResult = ok.json.result as { content: Array<{ text: string }>; isError?: boolean }
    expect(okResult.isError).toBeUndefined()
    expect(JSON.parse(okResult.content[0].text).ok).toBe(true)

    const bad = await rpc({
      jsonrpc: "2.0", id: 201, method: "tools/call",
      params: { name: "verify_workflow", arguments: { ir: { nodes: [] } } },
    })
    const badResult = bad.json.result as { content: Array<{ text: string }> }
    const parsed = JSON.parse(badResult.content[0].text) as { ok: boolean; violations: unknown[] }
    expect(parsed.ok).toBe(false)
    expect(parsed.violations.length).toBeGreaterThan(0)
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

  test("opus_critic with no explicit effort uses persona.defaultEffort=high", async () => {
    const captured = mockMessagesUpstream("no material objection")
    await rpc({
      jsonrpc: "2.0",
      id: 302,
      method: "tools/call",
      params: {
        name: "opus_critic",
        arguments: { prompt: "review" },  // omit effort → persona.defaultEffort = "high"
      },
    })
    const upstream = captured.lastBody as {
      max_tokens?: number
      thinking?: { type?: string }
      output_config?: { effort?: string }
    }
    expect(upstream.thinking?.type).toBe("adaptive")
    expect(upstream.output_config?.effort).toBe("high")
    expect(upstream.max_tokens).toBe(16384)
  })

  test("opus_critic accepts effort:'xhigh' when resolved to Opus 5 (dynamic widening)", async () => {
    // opus_critic's effective model resolves to claude-opus-5 on this catalog,
    // which advertises xhigh; activePersonas() widens allowedEfforts to include
    // xhigh accordingly, so the call passes validation and dispatches xhigh.
    const captured = mockMessagesUpstream("ok")
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 303,
      method: "tools/call",
      params: {
        name: "opus_critic",
        arguments: { prompt: "deep dive", effort: "xhigh" },
      },
    })
    expect(status).toBe(200)
    expect(json.error).toBeUndefined()
    const upstream = captured.lastBody as { output_config?: { effort?: string } }
    expect(upstream.output_config?.effort).toBe("xhigh")
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

  // ---------------------------------------------------------------------------
  // Peer-critic image attachments (`imagePaths`)
  // ---------------------------------------------------------------------------

  describe("persona imagePaths", () => {
    /** 1x1 red PNG, colour type 2. */
    const PNG_B64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

    test("the schema advertises it, with the per-call budget stated up front", async () => {
      const { json } = await rpc({ jsonrpc: "2.0", id: 900, method: "tools/list", params: {} })
      const tools = (json as { result?: { tools?: Array<Record<string, unknown>> } }).result?.tools ?? []
      const critic = tools.find((t) => t.name === "codex_critic")
      const props = (critic?.inputSchema as { properties?: Record<string, { description?: string }> })
        ?.properties
      expect(props?.imagePaths).toBeDefined()
      // The budget has to be known BEFORE the call, so it lives in the
      // description rather than in a response field. It states the proxy's own
      // per-call cap, NOT a per-model image ceiling: that number is upstream's,
      // and the catalog field that used to be quoted here said 1 for models
      // upstream serves at 50.
      expect(props?.imagePaths?.description).toMatch(/up to 10 per call/)
      expect(props?.imagePaths?.description).not.toMatch(/accept 1\b/)
    })

    test("a non-image file is refused without any upstream call", async () => {
      const captured = mockResponsesUpstream("should not be called")
      const file = path.join(process.cwd(), "package.json")
      const { json } = await rpc({
        jsonrpc: "2.0",
        id: 901,
        method: "tools/call",
        params: {
          name: "codex_critic",
          arguments: { prompt: "look", imagePaths: [file] },
        },
      })
      const err = (json as { error?: { message?: string } }).error
      expect(err?.message).toMatch(/not a supported image/i)
      expect(captured.lastBody).toBeUndefined()
    })

    test("a path outside the workspace is refused", async () => {
      // Second file-reading path, same confinement as the first. Content
      // identification is the backstop, but the boundary is still enforced.
      const outside = mkdtempSync(path.join(os.tmpdir(), "gh-router-outside-"))
      const file = path.join(outside, "shot.png")
      writeFileSync(file, Buffer.from(PNG_B64, "base64"))
      try {
        const { json } = await rpc({
          jsonrpc: "2.0",
          id: 904,
          method: "tools/call",
          params: { name: "codex_critic", arguments: { prompt: "look", imagePaths: [file] } },
        })
        expect((json as { error?: { message?: string } }).error?.message).toMatch(/imagePaths\[0\]/)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })

    test("the confinement root is the CALLING session's directory, not the proxy's cwd", async () => {
      // The proxy is long-lived and started from wherever the operator was; a
      // caller running in a git worktree keeps its screenshots there. Rooting
      // the check at our own cwd rejected every one of them, which reads to
      // the caller as "the image is broken" rather than "you are somewhere I
      // did not look". The same path is accepted once the connection says
      // where the session actually is.
      const elsewhere = realpathSync.native(
        mkdtempSync(path.join(os.tmpdir(), "gh-router-session-ws-")),
      )
      const file = path.join(elsewhere, "shot.png")
      writeFileSync(file, Buffer.from(PNG_B64, "base64"))
      try {
        const withoutHeader = await rpc({
          jsonrpc: "2.0",
          id: 905,
          method: "tools/call",
          params: { name: "codex_critic", arguments: { prompt: "look", imagePaths: [file] } },
        })
        expect(
          (withoutHeader.json as { error?: { message?: string } }).error?.message,
        ).toMatch(/imagePaths\[0\]/)

        mockResponsesUpstream("saw the image")
        const withHeader = await rpc(
          {
            jsonrpc: "2.0",
            id: 906,
            method: "tools/call",
            params: { name: "codex_critic", arguments: { prompt: "look", imagePaths: [file] } },
          },
          { workspace: elsewhere },
        )
        expect((withHeader.json as { error?: unknown }).error).toBeUndefined()
      } finally {
        rmSync(elsewhere, { recursive: true, force: true })
      }
    })

    test("a non-array argument is rejected at the boundary", async () => {
      const { json } = await rpc({
        jsonrpc: "2.0",
        id: 902,
        method: "tools/call",
        params: {
          name: "codex_critic",
          arguments: { prompt: "look", imagePaths: "not-an-array" },
        },
      })
      expect((json as { error?: { message?: string } }).error?.message).toMatch(
        /must be an array of strings/i,
      )
    })

    test("a real image is read server-side and reaches /responses as input_image", async () => {
      const captured = mockResponsesUpstream("looks fine")
      // INSIDE the workspace: `imagePaths` is confined to the proxy's cwd by
      // the same chokepoint the worker file tools use, so an os.tmpdir() path
      // is refused (asserted separately below).
      const dir = mkdtempSync(path.join(process.cwd(), ".gh-router-mcpimg-"))
      const file = path.join(dir, "shot.png")
      writeFileSync(file, Buffer.from(PNG_B64, "base64"))
      try {
        const { json } = await rpc({
          jsonrpc: "2.0",
          id: 903,
          method: "tools/call",
          params: {
            name: "codex_critic",
            arguments: { prompt: "what is in this image?", imagePaths: [file] },
          },
        })
        expect((json as { result?: { isError?: boolean } }).result?.isError).toBeUndefined()
        const body = captured.lastBody as { input?: Array<{ content?: Array<Record<string, unknown>> }> }
        const parts = body?.input?.[0]?.content ?? []
        const image = parts.find((p) => p.type === "input_image")
        expect(image).toBeDefined()
        // Encoded by the proxy — no base64 ever crossed the MCP boundary.
        expect(image?.image_url).toBe(`data:image/png;base64,${PNG_B64}`)
        // The brief still rides alongside it.
        expect(parts.some((p) => p.type === "input_text")).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})

describe("/mcp stand_in tool", () => {
  const MAX_NONCE = "a".repeat(64)
  let maxLaunchId: string | undefined

  afterEach(() => {
    if (maxLaunchId) unregisterLaunch(maxLaunchId)
    maxLaunchId = undefined
  })

  test("bound max peers list exposes only the allowed cold-start contracts", async () => {
    const capable = (
      id: string,
      context: number,
      endpoint: string,
      vendor: string,
      adaptive = false,
    ) => ({
      ...fakeModel(id, [endpoint]),
      vendor,
      capabilities: {
        ...fakeModel(id, [endpoint]).capabilities,
        limits: {
          max_context_window_tokens: context,
          max_prompt_tokens: Math.max(1, context - 20_000),
          max_output_tokens: 16_000,
        },
        supports: {
          tool_calls: true,
          reasoning_effort: ["medium", "high", "xhigh"],
          ...(adaptive ? { adaptive_thinking: true } : {}),
        },
      },
    })
    state.models = {
      object: "list",
      data: [
        capable("gpt-5.6-sol", 1_050_000, "/responses", "openai"),
        capable("gpt-5.3-codex", 400_000, "/responses", "openai"),
        capable("claude-opus-5", 1_000_000, "/v1/messages", "anthropic", true),
        capable("claude-sonnet-5", 1_000_000, "/v1/messages", "anthropic", true),
        capable("gemini-3.8-flash", 1_000_000, "/chat/completions", "google"),
        capable("grok-4.6", 500_000, "/responses", "xai"),
      ] as never,
    }
    const expectedPersonas = new Set([
      "sol_critic",
      "codex_reviewer",
      "opus_critic",
      "gemini_critic",
      "gemini_reviewer",
      "grok_critic",
      "grok_reviewer",
    ])
    maxLaunchId = registerLaunch({
      profileId: "max",
      nonce: MAX_NONCE,
      secret: "max-secret",
      allowedGroups: new Set(["peers"]),
      allowedPersonas: new Set([...expectedPersonas, "sonnet_reviewer"]),
    }).launchId

    const listed = await scopedRpc("peers", {
      jsonrpc: "2.0",
      id: 3998,
      method: "tools/list",
    }, { auth: `Bearer ${MAX_NONCE}` })
    expect(listed.status).toBe(200)
    const tools = (listed.json.result as { tools: Array<{ name: string; description: string }> }).tools
    expect(new Set(tools.map((tool) => tool.name))).toEqual(expectedPersonas)
    for (const tool of tools) {
      expect(tool.description).toContain("Use when:")
      expect(tool.description).toContain("Not for:")
      expect(tool.description).toContain("Cold-start:")
      expect(tool.description).toContain("no repository or transcript access")
    }

    state.models = {
      ...state.models!,
      data: state.models!.data.filter((model) => model.id !== "gpt-5.3-codex"),
    }
    const fallback = await scopedRpc("peers", {
      jsonrpc: "2.0",
      id: 3999,
      method: "tools/list",
    }, { auth: `Bearer ${MAX_NONCE}` })
    const fallbackNames = (fallback.json.result as { tools: Array<{ name: string }> })
      .tools.map((tool) => tool.name)
    expect(fallbackNames).toContain("sonnet_reviewer")
    expect(fallbackNames).not.toContain("codex_reviewer")
  })

  test("bound max call advertises and dispatches Grok/high instead of Gemini Pro", async () => {
    const capable = (
      id: string,
      context: number,
      endpoint: string,
      vendor: string,
    ) => ({
      ...fakeModel(id, [endpoint]),
      vendor,
      capabilities: {
        ...fakeModel(id, [endpoint]).capabilities,
        limits: {
          max_context_window_tokens: context,
          max_prompt_tokens: Math.max(1, context - 20_000),
          max_output_tokens: 16_000,
        },
        supports: {
          tool_calls: true,
          reasoning_effort: ["medium", "high", "xhigh"],
          ...(id === "claude-opus-5" ? { adaptive_thinking: true } : {}),
        },
      },
    })
    state.models = {
      object: "list",
      data: [
        capable("gpt-5.6-sol", 1_050_000, "/responses", "openai"),
        capable("claude-opus-5", 1_000_000, "/v1/messages", "anthropic"),
        capable("gemini-3.1-pro-preview", 1_000_000, "/chat/completions", "google"),
        capable("gemini-3.8-flash", 1_000_000, "/chat/completions", "google"),
        capable("grok-4.6", 500_000, "/responses", "xai"),
      ] as never,
    }
    maxLaunchId = registerLaunch({
      profileId: "max",
      nonce: MAX_NONCE,
      secret: "max-secret",
      allowedGroups: new Set(["decide"]),
      allowedPersonas: new Set(),
    }).launchId

    const listed = await rpc(
      { jsonrpc: "2.0", id: 3999, method: "tools/list" },
      { auth: `Bearer ${MAX_NONCE}` },
    )
    const standIn = (listed.json.result as { tools: Array<{ name: string; description: string }> })
      .tools.find((tool) => tool.name === "stand_in")
    expect(standIn?.description).toContain("Grok 4.6 at high")
    expect(standIn?.description).not.toContain("gemini-3.1-pro-preview")

    const requests: Array<Record<string, unknown>> = []
    globalThis.fetch = mock(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(body)
      const vote = VOTE_A_HIGH
      if (String(url).includes("/v1/messages")) {
        return new Response(JSON.stringify({
          id: "m", type: "message", role: "assistant", model: "claude-opus-5",
          content: [{ type: "text", text: vote }], stop_reason: "end_turn",
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({
        id: "r", object: "response", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: vote }] }],
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof globalThis.fetch

    const called = await rpc({
      jsonrpc: "2.0",
      id: 4000,
      method: "tools/call",
      params: { name: "stand_in", arguments: TINY_INPUT },
    }, { auth: `Bearer ${MAX_NONCE}` })
    const result = called.json.result as { content: Array<{ text: string }> }
    const parsed = JSON.parse(result.content[0].text) as { votes: Record<string, unknown> }
    expect(parsed.votes["grok-4.6"]).toBeDefined()
    expect(parsed.votes["gemini-3.1-pro-preview"]).toBeUndefined()
    expect(requests.some((body) => body.model === "gemini-3.1-pro-preview")).toBe(false)
    expect((requests.find((body) => body.model === "grok-4.6")?.reasoning as { effort?: string })?.effort).toBe("high")
  })

  // ──────────────────────────────────────────────────────────────────
  // Helper: mock all three peer upstreams in one fetch shim. Routes by
  // URL to the appropriate response shape (Responses / Messages / Chat
  // Completions). Each model is given a queue of pre-canned vote JSON
  // strings; nth call consumes nth entry.
  // ──────────────────────────────────────────────────────────────────
  function mockThreePeers(queues: {
    "gpt-5.5": Array<string>
    "claude-opus-5": Array<string>
    "gemini-3.1-pro-preview": Array<string>
  }) {
    const consumed = { "gpt-5.5": 0, "claude-opus-5": 0, "gemini-3.1-pro-preview": 0 }
    globalThis.fetch = mock(async (url) => {
      const u = typeof url === "string" ? url : (url as URL).toString()
      let text: string
      if (u.includes("/responses")) {
        text = queues["gpt-5.5"][consumed["gpt-5.5"]++]
        return new Response(JSON.stringify({
          id: "resp_test",
          object: "response",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (u.includes("/v1/messages")) {
        text = queues["claude-opus-5"][consumed["claude-opus-5"]++]
        return new Response(JSON.stringify({
          id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5",
          content: [{ type: "text", text }], stop_reason: "end_turn",
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      // chat completions (gemini)
      text = queues["gemini-3.1-pro-preview"][consumed["gemini-3.1-pro-preview"]++]
      return new Response(JSON.stringify({
        id: "chatcmpl_test", object: "chat.completion", created: 0,
        model: "gemini-3.1-pro-preview",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop", logprobs: null }],
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof globalThis.fetch
    return { consumed }
  }

  const VOTE_A_HIGH = JSON.stringify({ choice: "A", confidence: 0.9, reasoning: "A wins on tree-shaking" })
  const TINY_INPUT = {
    decision: "Which date library?",
    options: [
      { id: "A", summary: "date-fns" },
      { id: "B", summary: "luxon" },
    ],
    context: "The frontend bundle targets modern browsers and prioritizes tree-shaking.",
  }

  test("tools/call stand_in dispatches to all three peers and returns a consensus envelope", async () => {
    mockThreePeers({
      "gpt-5.5":                [VOTE_A_HIGH],
      "claude-opus-5":          [VOTE_A_HIGH],
      "gemini-3.1-pro-preview": [VOTE_A_HIGH],
    })
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 4001,
      method: "tools/call",
      params: { name: "stand_in", arguments: TINY_INPUT },
    })
    expect(status).toBe(200)
    const result = json.result as { content: Array<{ text: string }>; isError?: boolean }
    expect(result.isError).toBeUndefined()
    // The handler JSON-stringifies the StandInResult into a single text
    // block — re-parse it and assert verdict shape.
    const parsed = JSON.parse(result.content[0].text) as {
      verdict: string; recommendation: string | null; confidence: number
    }
    expect(parsed.verdict).toBe("consensus")
    expect(parsed.recommendation).toBe("A")
  })

  test("tools/call stand_in releases its in-flight slot after completion (slot count returns to 0)", async () => {
    mockThreePeers({
      "gpt-5.5":                [VOTE_A_HIGH],
      "claude-opus-5":          [VOTE_A_HIGH],
      "gemini-3.1-pro-preview": [VOTE_A_HIGH],
    })
    expect(__getInFlightForTests()).toBe(0)
    await rpc({
      jsonrpc: "2.0",
      id: 4002,
      method: "tools/call",
      params: { name: "stand_in", arguments: TINY_INPUT },
    })
    // Slot count returns to 0 after the call (cleanup invariant).
    expect(__getInFlightForTests()).toBe(0)
  })

  test("stand_in holds exactly ONE in-flight slot despite making 3 internal upstream calls", async () => {
    // Suspend the gemini upstream until we've peeked the in-flight
    // counter. The other two mocks resolve immediately, but the
    // stand_in orchestrator awaits the parallel Promise.all of all
    // three — so the slot stays acquired until gemini's promise settles.
    let releaseGemini!: () => void
    const geminiPending = new Promise<void>((resolve) => { releaseGemini = resolve })

    globalThis.fetch = mock(async (url) => {
      const u = typeof url === "string" ? url : (url as URL).toString()
      if (u.includes("/responses")) {
        return new Response(JSON.stringify({
          id: "r", object: "response", status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: VOTE_A_HIGH }] }],
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (u.includes("/v1/messages")) {
        return new Response(JSON.stringify({
          id: "m", type: "message", role: "assistant", model: "claude-opus-5",
          content: [{ type: "text", text: VOTE_A_HIGH }], stop_reason: "end_turn",
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      await geminiPending
      return new Response(JSON.stringify({
        id: "c", object: "chat.completion", created: 0, model: "gemini-3.1-pro-preview",
        choices: [{ index: 0, message: { role: "assistant", content: VOTE_A_HIGH }, finish_reason: "stop", logprobs: null }],
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof globalThis.fetch

    const callPromise = rpc({
      jsonrpc: "2.0",
      id: 4003,
      method: "tools/call",
      params: { name: "stand_in", arguments: TINY_INPUT },
    })

    // Give the event loop a few turns to start the upstream calls and
    // acquire the slot. With 3 parallel internal calls, this would be 3
    // slots if dispatchModelCall re-acquired — but it does NOT (per the
    // CLAUDE.md invariant): only the MCP boundary acquires a slot.
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(__getInFlightForTests()).toBe(1)

    releaseGemini()
    await callPromise
    expect(__getInFlightForTests()).toBe(0)
  })

  test("JSON-path tools/call accepts stand_in context between the old 6KB and new 32KB caps", async () => {
    mockThreePeers({
      "gpt-5.5":                [VOTE_A_HIGH],
      "claude-opus-5":        [VOTE_A_HIGH],
      "gemini-3.1-pro-preview": [VOTE_A_HIGH],
    })

    const midSizeContext = "x".repeat(20 * 1024)
    const res = await mcpRoutes.request(
      new Request(`http://${PROXY_HOST}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: AUTH_HEADER,
          host: PROXY_HOST,
          accept: "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4004,
          method: "tools/call",
          params: {
            name: "stand_in",
            arguments: { ...TINY_INPUT, context: midSizeContext },
          },
        }),
      }),
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      result?: { content: Array<{ text: string }>; isError?: boolean }
    }
    expect(json.result?.isError).toBeFalsy()
    expect(json.result?.content[0].text).not.toMatch(/pre-flight rejected/i)
    expect(JSON.parse(json.result?.content[0].text ?? "{}").verdict).toBe("consensus")
    expect(__getInFlightForTests()).toBe(0)
  })

  test("JSON-path tools/call with oversized stand_in input hits predictedTooLong cap (slot NOT acquired)", async () => {
    // Same pattern as the codex_critic predictedTooLong test above. The
    // cap fires in handleMcpPost BEFORE handleToolsCall, so no upstream
    // fetch and no slot acquisition. The error message must point the
    // caller at the SSE bypass.
    const sentinel = mock(async () => {
      throw new Error("upstream MUST NOT be called when pre-flight rejects")
    })
    globalThis.fetch = sentinel as unknown as typeof globalThis.fetch

    const oversizedContext = "x".repeat(33 * 1024)
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
          id: 4004,
          method: "tools/call",
          params: {
            name: "stand_in",
            arguments: { ...TINY_INPUT, context: oversizedContext },
          },
        }),
      }),
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      id?: number
      result?: { content: Array<{ text: string }>; isError?: boolean }
    }
    expect(json.id).toBe(4004)
    expect(json.result?.isError).toBe(true)
    expect(json.result?.content[0].text).toMatch(/pre-flight rejected/i)
    expect(json.result?.content[0].text).toContain("stand_in")
    expect(json.result?.content[0].text).toContain("text/event-stream")
    expect(sentinel).not.toHaveBeenCalled()
    expect(__getInFlightForTests()).toBe(0)
  })

  test("tools/call stand_in returns isError on shape failure (missing options)", async () => {
    const sentinel = mock(async () => {
      throw new Error("upstream MUST NOT be called when arg validation rejects")
    })
    globalThis.fetch = sentinel as unknown as typeof globalThis.fetch
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 4005,
      method: "tools/call",
      params: { name: "stand_in", arguments: { decision: "pick one" } },
    })
    expect(status).toBe(200)
    const result = json.result as { content: Array<{ text: string }>; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("options")
    expect(sentinel).not.toHaveBeenCalled()
  })

  test("tools/call stand_in returns isError when context is omitted", async () => {
    const withoutContext = { decision: TINY_INPUT.decision, options: TINY_INPUT.options }
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 4006,
      method: "tools/call",
      params: { name: "stand_in", arguments: withoutContext },
    })
    expect(status).toBe(200)
    const result = json.result as { content: Array<{ text: string }>; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("context")
  })

  test("tools/call stand_in returns isError when context is whitespace-only", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 4007,
      method: "tools/call",
      params: { name: "stand_in", arguments: { ...TINY_INPUT, context: "   " } },
    })
    expect(status).toBe(200)
    const result = json.result as { content: Array<{ text: string }>; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("context")
  })

  test("tools/call stand_in returns isError when context is non-string", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 4008,
      method: "tools/call",
      params: { name: "stand_in", arguments: { ...TINY_INPUT, context: 123 } },
    })
    expect(status).toBe(200)
    const result = json.result as { content: Array<{ text: string }>; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("context")
  })

  test("tools/list omits stand_in when gpt-5.5 is missing from catalog (other personas + tools still present)", async () => {
    state.models = {
      object: "list",
      data: baseModels.data.filter((m) => m.id !== "gpt-5.5"),
    }
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 4006,
      method: "tools/list",
    })
    const result = json.result as { tools: Array<{ name: string }> }
    const names = result.tools.map((t) => t.name)
    expect(names).not.toContain("stand_in")
    // codex_critic remains (its model is not catalog-gated; gating is at
    // request time via resolveModel; the registration gate is only on
    // requiresGeminiCatalog). Verify by presence:
    expect(names).toContain("codex_critic")
    expect(names).toContain("opus_critic")
    expect(names).toContain("web")
  })
})

describe("/mcp concurrency cap", () => {
  test("the (cap+1)th in-flight tools/call returns queue-full isError", async () => {
    // The shared MAX_INFLIGHT_TOOLS_CALL slots bound concurrent tool
    // calls; the next call past the cap returns a clean "queue full"
    // isError so a runaway client (or a fan-out wave) backs off instead
    // of growing unbounded.
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

    // Fire exactly the cap — all occupy in-flight slots.
    const inflight = Array.from({ length: MAX_INFLIGHT_TOOLS_CALL }, () =>
      fire(),
    )
    // Brief tick so the calls increment the in-flight counter.
    await new Promise((r) => setTimeout(r, 10))
    expect(__getInFlightForTests()).toBe(MAX_INFLIGHT_TOOLS_CALL)

    // The next call should immediately return queue-full.
    const overflow = await fire()
    const result = overflow.json.result as { isError: boolean; content: Array<{ text: string }> }
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
      params: { name: "web", arguments: { query: "Hono latest version" } },
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
      params: { name: "web", arguments: { query: "obscure niche query" } },
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
      params: { name: "web", arguments: { query: "x" } },
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
      params: { name: "web", arguments: {} },
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
      params: { name: "web", arguments: { query: 42 } },
    })
    const result = json.result as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/query is required/i)
  })

  test("web_search upstream failure surfaces as tool isError with `web failed:` prefix", async () => {
    mockUpstreamMcp({ forceCallError: true })
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 605,
      method: "tools/call",
      params: { name: "web", arguments: { query: "x" } },
    })
    expect(status).toBe(200)
    const result = json.result as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^web failed:/i)
  })

  test("web_search counts against MAX_INFLIGHT_TOOLS_CALL (slot accounting symmetric with personas)", async () => {
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
      params: { name: "web", arguments: { query: "hold" } },
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
          params: { name: "web", arguments: { query: oversize } },
        }),
      }),
    )
    expect(res.status).toBe(200)
    const json = await res.json() as { result?: { isError?: boolean; content: Array<{ text: string }> } }
    expect(json.result?.isError).toBeUndefined()
    expect(captured.tcCalled).toBe(true)
  })
})

// =============================================================================
// /mcp worker_* tools — registration + thin-closure routing
// =============================================================================
// The gate has two arms (both must hold for the tools to appear in tools/list
// AND for tools/call to dispatch):
//   1. state.models?.data contains `gemini-3.1-pro-preview` with
//      capabilities.supports.tool_calls === true
//   2. process.env.GH_ROUTER_DISABLE_WORKER_TOOLS !== "1"
// The tests below exercise each arm independently plus the full mocked-call
// happy path, the engine's pre-fetch failure modes (semaphore overflow,
// unknown model, worktree-without-git), and the silent thinking clamp.

/**
 * Build a synthetic model entry that DOES advertise tool_calls (the worker
 * gate requires this) and an explicit reasoning_effort allowlist.
 *
 * `fakeModel` defaults to `supports: {}` (no tool_calls) so it cannot be
 * used as-is for the worker gate. We deep-clone-ish via spread + override.
 */
const fakeWorkerModel = (
  id: string,
  opts: {
    tool_calls?: boolean
    reasoning_effort?: ReadonlyArray<string>
  } = {},
) => {
  const base = fakeModel(id, ["/v1/chat/completions"])
  return {
    ...base,
    capabilities: {
      ...base.capabilities,
      supports: {
        ...(opts.tool_calls === false ? {} : { tool_calls: true }),
        ...(opts.reasoning_effort
          ? { reasoning_effort: [...opts.reasoning_effort] }
          : {}),
      },
    },
  }
}

/**
 * Drop a single SSE chunk that finishes immediately. The worker streams
 * `text_start`/`text_delta`/`text_end` events from the delta content and
 * an assistant `message_end` from `finish_reason: "stop"` — the runWorkerAgent
 * `agent.waitForIdle()` then resolves with `finalText` set to the delta text.
 */
function workerSseResponse(
  text: string,
  opts: { capturePayload?: (p: Record<string, unknown>) => void } = {},
): typeof globalThis.fetch {
  const chunks = [
    {
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ]
  const body =
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"

  return mock(async (_url: unknown, init?: { body?: string }) => {
    if (opts.capturePayload && init?.body) {
      try {
        opts.capturePayload(JSON.parse(init.body) as Record<string, unknown>)
      } catch {
        // ignore
      }
    }
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }) as unknown as typeof globalThis.fetch
}

describe("/mcp worker_* tools — registration + gating", () => {
  for (const gateModel of ["gpt-5.4-mini", "gpt-5.6-luna"]) {
    test(`tools/list includes worker tools on a ${gateModel}-only gate catalog`, async () => {
      state.models = {
        object: "list",
        data: [fakeWorkerModel(gateModel)],
      }
      const { status, json } = await rpc({
        jsonrpc: "2.0",
        id: 700,
        method: "tools/list",
      })
      expect(status).toBe(200)
      const result = json.result as { tools: Array<{ name: string }> }
      const names = result.tools.map((t) => t.name)
      expect(names).toContain("explore")
      expect(names).toContain("implement")
    })
  }

  test("tools/list omits both worker tools when GH_ROUTER_DISABLE_WORKER_TOOLS=1 (even if model is present)", async () => {
    const prev = process.env.GH_ROUTER_DISABLE_WORKER_TOOLS
    process.env.GH_ROUTER_DISABLE_WORKER_TOOLS = "1"
    try {
      state.models = {
        object: "list",
        data: [
        ...baseModels.data.filter((m) => m.id !== "gpt-5.4-mini"),
        fakeWorkerModel("gpt-5.4-mini"),
      ],
      }
      const { json } = await rpc({
        jsonrpc: "2.0",
        id: 701,
        method: "tools/list",
      })
      const names = (json.result as { tools: Array<{ name: string }> }).tools.map(
        (t) => t.name,
      )
      expect(names).not.toContain("explore")
      expect(names).not.toContain("implement")
    } finally {
      if (prev === undefined) delete process.env.GH_ROUTER_DISABLE_WORKER_TOOLS
      else process.env.GH_ROUTER_DISABLE_WORKER_TOOLS = prev
    }
  })

  test("tools/list omits both worker tools when the entire gate chain is absent", async () => {
    state.models = {
      object: "list",
      data: baseModels.data,
    }
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 702,
      method: "tools/list",
    })
    const names = (json.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    )
    expect(names).not.toContain("explore")
    expect(names).not.toContain("implement")
  })

  test("tools/list omits both when every gate model lacks tool_calls", async () => {
    state.models = {
      object: "list",
      data: [
        fakeWorkerModel("gpt-5.6-luna", { tool_calls: false }),
        fakeWorkerModel("gpt-5.4-mini", { tool_calls: false }),
      ],
    }
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 703,
      method: "tools/list",
    })
    const names = (json.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    )
    expect(names).not.toContain("explore")
    expect(names).not.toContain("implement")
  })

  test("defense-in-depth: tools/call for worker_explore returns method-not-found when gate fails (even if client bypasses tools/list)", async () => {
    // No gate-chain model in catalog → gate fails. A naive client could
    // skip tools/list and hard-code the name; the call-time gate must
    // reject identically to an unknown tool (-32601), keeping the gated
    // surface functionally invisible.
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 704,
      method: "tools/call",
      params: { name: "explore", arguments: { prompt: "hi" } },
    })
    expect(status).toBe(200)
    const err = (json as { error?: { code: number; message: string } }).error
    expect(err?.code).toBe(-32601)
    expect(err?.message).toMatch(/unknown tool/i)
  })
})

describe("/mcp worker_* tools — call routing (mocked upstream)", () => {
  beforeEach(() => {
    state.models = {
      object: "list",
      data: [
        ...baseModels.data.filter(
          (m) =>
            ![
              "gpt-5.4-mini",
              "gpt-5.5",
              "gpt-5.6-sol",
              "gemini-3.1-pro-preview",
              "gpt-5.6-luna",
            ].includes(m.id),
        ),
        // explore + browse default and preferred worker gate/fallback model
        fakeWorkerModel("gpt-5.6-luna", {
          reasoning_effort: ["none", "low", "medium", "high", "xhigh", "max"],
        }),
        // broad-tier worker gate/fallback model
        fakeWorkerModel("gpt-5.4-mini", {
          reasoning_effort: ["minimal", "low", "medium", "high"],
        }),
        // implement default (routes to /responses)
        fakeWorkerModel("gpt-5.6-sol", {
          reasoning_effort: ["none", "low", "medium", "high", "xhigh"],
        }),
        // retained OpenAI fallback + explicit-model fixture
        fakeWorkerModel("gpt-5.5", {
          reasoning_effort: ["none", "low", "medium", "high", "xhigh"],
        }),
        // kept for the explicit-model clamp + unknown-model tests below
        fakeWorkerModel("gemini-3.1-pro-preview", {
          reasoning_effort: ["low", "medium", "high"],
        }),
      ],
    }
  })

  test("worker_explore happy path returns assistant text in result.content[0].text", async () => {
    globalThis.fetch = workerSseResponse("explore-result-text")
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 710,
      method: "tools/call",
      params: {
        name: "explore",
        arguments: { prompt: "what does foo do?", workspace: process.cwd() },
      },
    })
    expect(status).toBe(200)
    const result = json.result as {
      isError?: boolean
      content: Array<{ type: string; text: string }>
    }
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toBe("explore-result-text")
  })

  test("worker_implement (worktree:false, default) returns assistant text — in-place edit path", async () => {
    globalThis.fetch = workerSseResponse("implement-direct-result")
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 711,
      method: "tools/call",
      params: {
        name: "implement",
        arguments: {
          prompt: "add a comment to README",
          workspace: process.cwd(),
          // Pin a chat-endpoint model so the chat-SSE mock applies — this
          // test covers the in-place implement path, not the implement
          // default (gpt-5.6-sol, which routes to /responses).
          model: "gemini-3.1-pro-preview",
        },
      },
    })
    const result = json.result as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain("implement-direct-result")
  })

  test("worker_implement (worktree:true) succeeds inside the github-router repo (which IS a git repo)", async () => {
    // process.cwd() during tests is the github-router repo root — a real
    // git repo, so createWorktree should succeed and emit assistant text.
    // This validates the implement-worktree happy path round-trip.
    globalThis.fetch = workerSseResponse("implement-worktree-result")
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 712,
      method: "tools/call",
      params: {
        name: "implement",
        arguments: {
          prompt: "fix the typo",
          worktree: true,
          workspace: process.cwd(),
          // Chat-endpoint pin (see above) — gpt-5.6-sol default routes to
          // /responses, which the chat-SSE mock doesn't serve.
          model: "gemini-3.1-pro-preview",
        },
      },
    })
    const result = json.result as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain("implement-worktree-result")
    // Explicit budget, NOT a flake workaround. This test creates a REAL git
    // worktree of the github-router repo (process.cwd()), which is genuinely
    // I/O-bound: measured 3.9s/3.9s/4.2s in isolation on Windows, stable
    // across runs, so there is no leak or race — the default 5s budget was
    // simply mis-sized for the work. Under lane-1 parallel load it tipped
    // over and timed out. 30s leaves real headroom while still bounding a
    // genuine hang. If this ever needs raising again, profile first: a
    // GROWING time means a leak, and that would be a bug, not a budget.
  }, 30_000)

  test("worker_explore accepts an explicit absolute workspace override", async () => {
    // The model can override the default (process.cwd()) when the parent
    // agent operates against multiple workspaces. We use the github-router
    // repo root (resolved from import.meta.url) as a known-absolute path.
    globalThis.fetch = workerSseResponse("explore-with-workspace-override")
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 720,
      method: "tools/call",
      params: {
        name: "explore",
        arguments: {
          prompt: "investigate something",
          workspace: process.cwd(),
        },
      },
    })
    expect(status).toBe(200)
    const result = json.result as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toBe("explore-with-workspace-override")
  })

  test("worker_explore uses the session workspace header when no workspace arg is provided", async () => {
    state.serveMode = true
    let captured: Record<string, unknown> | undefined
    globalThis.fetch = workerSseResponse("explore-with-header-workspace", {
      capturePayload: (payload) => {
        captured = payload
      },
    })
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 723,
      method: "tools/call",
      params: {
        name: "explore",
        arguments: { prompt: "investigate something" },
      },
    }, { workspace: process.cwd() })
    expect(status).toBe(200)
    const result = json.result as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    expect(result.isError).toBeFalsy()
    // The header supplied the workspace, so the result carries the
    // provenance note naming the tree the worker actually ran in.
    expect(result.content[0].text).toContain("explore-with-header-workspace")
    expect(result.content[0].text).toContain(`[workspace: ${process.cwd()}`)
    expect(result.content[0].text).toContain("from your session's working directory")
    expect(captured).toBeDefined()
  })

  test("explicit worker workspace overrides the session workspace header", async () => {
    state.serveMode = true
    const explicitWorkspace = process.cwd()
    let captured: Record<string, unknown> | undefined
    globalThis.fetch = workerSseResponse("explore-explicit-beats-header", {
      capturePayload: (payload) => {
        captured = payload
      },
    })
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 724,
      method: "tools/call",
      params: {
        name: "explore",
        arguments: { prompt: "investigate something", workspace: explicitWorkspace },
      },
    }, { workspace: "/header/workspace" })
    const result = json.result as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toBe("explore-explicit-beats-header")
    expect(captured).toBeDefined()
  })

  test("worker_explore in serve mode requires workspace when no header or arg is present", async () => {
    state.serveMode = true
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 725,
      method: "tools/call",
      params: {
        name: "explore",
        arguments: { prompt: "investigate something" },
      },
    })
    expect(status).toBe(200)
    const result = json.result as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("a workspace is required")
    expect(result.content[0].text).toContain("machine-wide github-router serve")
  })

  test("worker_explore rejects a relative workspace path with isError + actionable message", async () => {
    // No fetch mock: validation fails BEFORE the engine starts.
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 721,
      method: "tools/call",
      params: {
        name: "explore",
        arguments: {
          prompt: "anything",
          workspace: "./relative/path",
        },
      },
    })
    expect(status).toBe(200)
    const result = json.result as {
      isError: boolean
      content: Array<{ text: string }>
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/absolute path/i)
  })

  test("worker_implement rejects a non-string workspace value with isError", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 722,
      method: "tools/call",
      params: {
        name: "implement",
        arguments: {
          prompt: "do a thing",
          workspace: 42,
        },
      },
    })
    const result = json.result as {
      isError: boolean
      content: Array<{ text: string }>
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/non-empty string/i)
  })

  test("9th concurrent worker call returns isError with 'Worker queue full' text (semaphore cap = 8)", async () => {
    // Fill the worker semaphore directly, leaving zero slots. The next
    // tools/call MUST return the engine's fast-fail envelope BEFORE
    // attempting fetch — so no fetch mock is needed.
    const releases: Array<() => void> = []
    for (let i = 0; i < MAX_INFLIGHT_WORKER_CALLS; i += 1) {
      const r = await acquireWorkerSlot()
      if (!r) throw new Error("test setup: semaphore filled too early")
      releases.push(r)
    }
    try {
      const { json } = await rpc({
        jsonrpc: "2.0",
        id: 713,
        method: "tools/call",
        params: {
          name: "explore",
          arguments: { prompt: "anything", workspace: process.cwd() },
        },
      })
      const result = json.result as {
        isError: boolean
        content: Array<{ text: string }>
      }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toMatch(/worker queue full/i)
    } finally {
      for (const release of releases) release()
    }
  })

  test("model:'nonexistent' returns isError listing the catalog's tool_call-capable model ids", async () => {
    // No fetch mock needed: resolveModelAndThinking fails BEFORE fetch.
    // The error message must enumerate the catalog candidates so the
    // caller can correct without guessing — gemini-3.1-pro-preview is the
    // only tool_call-capable model in the test catalog, so it should
    // be the only one listed.
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 714,
      method: "tools/call",
      params: {
        name: "explore",
        arguments: { prompt: "anything", model: "nonexistent", workspace: process.cwd() },
      },
    })
    const result = json.result as {
      isError: boolean
      content: Array<{ text: string }>
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("Unknown model: nonexistent")
    expect(result.content[0].text).toContain("gemini-3.1-pro-preview")
  })

  test("thinking:'xhigh' against gemini-3.1-pro-preview (max 'high') silently clamps to 'high' — no clamp notice in response text", async () => {
    let captured: Record<string, unknown> | undefined
    globalThis.fetch = workerSseResponse("silent-thinking-result", {
      capturePayload: (p) => {
        captured = p
      },
    })
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 715,
      method: "tools/call",
      params: {
        name: "explore",
        arguments: {
          prompt: "hi",
          thinking: "xhigh",
          model: "gemini-3.1-pro-preview",
          workspace: process.cwd(),
        },
      },
    })
    const result = json.result as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    expect(result.isError).toBeFalsy()
    // Response text MUST be exactly the assistant text — no clamp notice
    // injected by the engine (the plan calls this out explicitly).
    expect(result.content[0].text).toBe("silent-thinking-result")
    expect(result.content[0].text).not.toMatch(/clamp|notice/i)
    // The outbound payload's `reasoning_effort` field MUST be the
    // clamped value ("high" — the highest allowed for this model),
    // NOT the raw "xhigh" the caller asked for. We inspect the field
    // directly rather than substring-scanning the full payload (the
    // peer_review/advisor tool schemas legitimately mention "xhigh"
    // as an enum value, which would create a false positive).
    expect((captured as { reasoning_effort?: string }).reasoning_effort).toBe(
      "high",
    )
  })

  test("worker_implement worktree:true in a non-git workspace returns isError (hard fail, no silent fallback)", async () => {
    // Point the worker at a fresh non-git temp dir. The engine's Step-4
    // worktree provisioning calls `git rev-parse` and throws on
    // non-zero exit; runWorkerAgent surfaces the throw as the isError
    // envelope. No fetch mock — failure is pre-fetch. The workspace is
    // passed explicitly rather than by chdir'ing the test process: the
    // worker no longer reads `process.cwd()`, and mutating a process-global
    // from one test is a race against every other test in the lane.
    const dir = mkdtempSync(join(tmpdir(), "gh-router-worker-noregister-"))
    try {
      const { json } = await rpc({
        jsonrpc: "2.0",
        id: 716,
        method: "tools/call",
        params: {
          name: "implement",
          arguments: { prompt: "make a change", worktree: true, workspace: dir },
        },
      })
      const result = json.result as {
        isError: boolean
        content: Array<{ text: string }>
      }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toMatch(
        /not a (git )?repository|git unavailable/i,
      )
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Prompt-window guard + opus_critic model selection
// Window guard: reject (don't truncate) a brief that exceeds the persona
// model's real max_prompt_tokens, counted with the exact o200k tokenizer.
// opus_critic: prefer claude-opus-5, then a 1M opus-4.6 slug when present,
// else fall back to the 200K claude-opus-4-6.
// ─────────────────────────────────────────────────────────────────────
describe("/mcp peer prompt-window guard", () => {
  function mockResponses(text: string, captured: { lastBody?: unknown; called?: boolean } = {}) {
    globalThis.fetch = mock(async (_url, init) => {
      captured.called = true
      captured.lastBody = JSON.parse((init as RequestInit).body as string)
      return new Response(
        JSON.stringify({
          id: "resp_test",
          object: "response",
          status: "completed",
          output: [
            { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof globalThis.fetch
    return captured
  }

  function modelWith(id: string, maxPromptTokens: number, endpoints: string[]) {
    const m = fakeModel(id, endpoints)
    m.capabilities.limits = {
      max_context_window_tokens: maxPromptTokens + 50_000,
      max_prompt_tokens: maxPromptTokens,
    } as never
    return m
  }

  test("rejects a brief that exceeds the persona model's prompt window (no upstream call)", async () => {
    // gpt-5.6-sol with a deliberately tiny 200-token window; send a brief far
    // larger so the exact o200k count busts it.
    state.models = {
      object: "list",
      data: [modelWith("gpt-5.6-sol", 200, ["/v1/responses"])],
    }
    const captured = mockResponses("should-not-be-called")
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 700,
      method: "tools/call",
      params: {
        name: "codex_critic",
        arguments: { prompt: "word ".repeat(2000) }, // ~2000 tokens >> 200
      },
    })
    expect(status).toBe(200)
    const result = json.result as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/over the .*-token budget/i)
    expect(result.content[0].text).toMatch(/larger-window peer|split it into/i)
    // Guard fired BEFORE dispatch — upstream was never called.
    expect(captured.called).toBeUndefined()
  })

  test("allows a brief that fits the window (reaches upstream)", async () => {
    state.models = {
      object: "list",
      data: [modelWith("gpt-5.6-sol", 900_000, ["/v1/responses"])],
    }
    const captured = mockResponses("ok")
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 701,
      method: "tools/call",
      params: { name: "codex_critic", arguments: { prompt: "small brief" } },
    })
    const result = json.result as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBeUndefined()
    expect(captured.called).toBe(true)
  })

  test("no max_prompt_tokens in catalog → guard is a no-op (call proceeds)", async () => {
    // baseModels (from beforeEach) carry only max_context_window_tokens.
    const captured = mockResponses("ok")
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 702,
      method: "tools/call",
      params: { name: "codex_critic", arguments: { prompt: "x".repeat(100000) } },
    })
    const result = json.result as { isError?: boolean }
    expect(result.isError).toBeUndefined()
    expect(captured.called).toBe(true)
  })

  test("opus_critic prefers claude-opus-5 over the 4.6-1m fallback", async () => {
    state.models = {
      object: "list",
      data: [
        modelWith("claude-opus-5", 1_000_000, ["/v1/messages"]),
        modelWith("claude-opus-4.6", 168_000, ["/v1/messages"]),
        modelWith("claude-opus-4.6-1m", 936_000, ["/v1/messages"]),
      ],
    }
    const captured: { lastBody?: unknown; called?: boolean } = {}
    globalThis.fetch = mock(async (_url, init) => {
      captured.called = true
      captured.lastBody = JSON.parse((init as RequestInit).body as string)
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof globalThis.fetch

    await rpc({
      jsonrpc: "2.0",
      id: 703,
      method: "tools/call",
      params: { name: "opus_critic", arguments: { prompt: "review this" } },
    })
    expect((captured.lastBody as { model: string }).model).toBe("claude-opus-5")
  })

  test("opus_critic regex does NOT false-positive on 4.7-1m or 4.8 (version-anchored to 4.6)", async () => {
    // Regression guard: a catalog that has 4.7-1m-internal (stand_in's
    // pinned row) and 4.8 (the spawned-Claude-Code default) but NO
    // 4.6-1m sibling must fall back to the bare claude-opus-4-6.
    state.models = {
      object: "list",
      data: [
        modelWith("claude-opus-4.6", 168_000, ["/v1/messages"]),
        modelWith("claude-opus-4.7-1m-internal", 936_000, ["/v1/messages"]),
        modelWith("claude-opus-4.8", 1_000_000, ["/v1/messages"]),
      ],
    }
    const captured: { lastBody?: unknown } = {}
    globalThis.fetch = mock(async (_url, init) => {
      captured.lastBody = JSON.parse((init as RequestInit).body as string)
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-opus-4.6",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof globalThis.fetch

    await rpc({
      jsonrpc: "2.0",
      id: 705,
      method: "tools/call",
      params: { name: "opus_critic", arguments: { prompt: "review this" } },
    })
    // resolveModel maps dashed claude-opus-4-6 → dotted claude-opus-4.6.
    expect((captured.lastBody as { model: string }).model).toBe("claude-opus-4.6")
  })

  test("opus_critic rejects effort:'xhigh' when it falls back to opus-4.6 (no opus-5 in catalog)", async () => {
    // On a catalog without claude-opus-5, opus_critic's effective model falls
    // back to opus-4.6 (which lacks xhigh). activePersonas() does NOT widen
    // allowedEfforts past high there, so a caller-supplied xhigh rejects at
    // validation with no upstream call — instead of 400ing off Copilot.
    state.models = {
      object: "list",
      data: [modelWith("claude-opus-4.6", 168_000, ["/v1/messages"])],
    }
    const captured: { lastBody?: unknown } = {}
    globalThis.fetch = mock(async (_url, init) => {
      captured.lastBody = JSON.parse((init as RequestInit).body as string)
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch

    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 706,
      method: "tools/call",
      params: { name: "opus_critic", arguments: { prompt: "x", effort: "xhigh" } },
    })
    expect(json.error).toBeDefined()
    expect(captured.lastBody).toBeUndefined()
  })

  test("opus_critic regex matches dashed form opus-4-6-1m (forward-compat for catalog slug-shape changes)", async () => {
    // Forward-compat: if Copilot ever ships the 1M sibling as dashed
    // (`claude-opus-4-6-1m` instead of `claude-opus-4.6-1m`), the regex's
    // `[.-]` character class must still match. Without dashed tolerance,
    // opus_critic would silently downgrade to the 200K fallback.
    state.models = {
      object: "list",
      data: [
        modelWith("claude-opus-4.6", 168_000, ["/v1/messages"]),
        modelWith("claude-opus-4-6-1m", 936_000, ["/v1/messages"]),
      ],
    }
    const captured: { lastBody?: unknown } = {}
    globalThis.fetch = mock(async (_url, init) => {
      captured.lastBody = JSON.parse((init as RequestInit).body as string)
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-6-1m",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof globalThis.fetch

    await rpc({
      jsonrpc: "2.0",
      id: 706,
      method: "tools/call",
      params: { name: "opus_critic", arguments: { prompt: "review this" } },
    })
    expect((captured.lastBody as { model: string }).model).toBe("claude-opus-4-6-1m")
  })

  test("opus_critic regex does NOT false-positive on hypothetical opus-4.6-1max (suffix-boundary)", async () => {
    // Regression guard for an earlier permissive `/opus-4\.6.*1m/i` form
    // that would match `opus-4.6-1max` or `opus-4.6-foo-1m-bar`. The
    // tightened `/opus-4[.-]6-1m(?:$|-)/i` requires `-1m` followed by
    // either end-of-string or `-`, so unrelated `1m`-substrings can't
    // hijack the picker.
    state.models = {
      object: "list",
      data: [
        modelWith("claude-opus-4.6", 168_000, ["/v1/messages"]),
        // hypothetical garbage slug — must NOT match
        modelWith("claude-opus-4.6-1max", 1_000_000, ["/v1/messages"]),
      ],
    }
    const captured: { lastBody?: unknown } = {}
    globalThis.fetch = mock(async (_url, init) => {
      captured.lastBody = JSON.parse((init as RequestInit).body as string)
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-opus-4.6",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof globalThis.fetch

    await rpc({
      jsonrpc: "2.0",
      id: 707,
      method: "tools/call",
      params: { name: "opus_critic", arguments: { prompt: "review this" } },
    })
    expect((captured.lastBody as { model: string }).model).toBe("claude-opus-4.6")
  })

  test("opus_critic falls back to claude-opus-4.6 when no 1M variant present", async () => {
    state.models = {
      object: "list",
      data: [modelWith("claude-opus-4.6", 168_000, ["/v1/messages"])],
    }
    const captured: { lastBody?: unknown } = {}
    globalThis.fetch = mock(async (_url, init) => {
      captured.lastBody = JSON.parse((init as RequestInit).body as string)
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-opus-4.6",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof globalThis.fetch

    await rpc({
      jsonrpc: "2.0",
      id: 704,
      method: "tools/call",
      params: { name: "opus_critic", arguments: { prompt: "review this" } },
    })
    // resolveModel maps dashed claude-opus-4-6 → dotted claude-opus-4.6.
    expect((captured.lastBody as { model: string }).model).toBe("claude-opus-4.6")
  })
})

// Launch-profile scoping: a launch registered with a narrower
// `allowedGroups`/`allowedPersonas` (e.g. the fast profile's
// `{peers, search, browser}` / `{oracle}`) must be denied every tool outside
// that allow-list, in BOTH `tools/list` and `tools/call`, on EVERY scope
// including the unscoped "all" union — the restriction is bound to the
// caller's identity (its nonce), not to which URL path it happened to hit.
// `undefined` allowedGroups/allowedPersonas (the standard launch registered
// via `state.peerMcpNonce` in the outer `beforeEach`) must stay completely
// unaffected.
describe("launch-profile scoping (allowedGroups / allowedPersonas)", () => {
  const FAST_NONCE = "f".repeat(64)
  let fastLaunchId: string

  beforeEach(() => {
    fastLaunchId = registerLaunch({
      profileId: "fast",
      nonce: FAST_NONCE,
      secret: "fast-launch-secret",
      allowedGroups: new Set(["peers", "search", "workers", "browser"]),
      allowedPersonas: new Set(["oracle"]),
    }).launchId
  })

  afterEach(() => {
    unregisterLaunch(fastLaunchId)
  })

  test("tools/list on the unscoped union returns Oracle plus search, with standard peers/workers/orchestration hidden", async () => {
    const saved = state.models
    try {
      state.models = {
        object: "list",
        data: [{
          id: "claude-opus-5",
          name: "claude-opus-5",
          object: "model",
          vendor: "anthropic",
          version: "1",
          preview: false,
          model_picker_enabled: true,
          supported_endpoints: ["/v1/messages"],
          capabilities: {
            family: "claude-opus-5",
            object: "model_capabilities",
            tokenizer: "claude",
            type: "chat",
            limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 872_000 },
            supports: { adaptive_thinking: true, reasoning_effort: ["high"] },
          },
        }] as never,
      }
      const { status, json } = await rpc(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { auth: `Bearer ${FAST_NONCE}` },
      )
      expect(status).toBe(200)
      const names = (json.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
      expect(names).toContain("oracle")
      expect(names).toContain("code")
      expect(names).toContain("web")
      for (const forbidden of [
        "gemini_critic", "codex_critic", "codex_reviewer", "opus_critic",
        "gemini_reviewer", "explore", "implement", "review", "plan", "test",
        "decompose", "run_workflow",
      ]) expect(names).not.toContain(forbidden)
    } finally {
      state.models = saved
    }
  })

  test("tools/call rejects a persona outside allowedPersonas with -32601, even on the unscoped union", async () => {
    const { json } = await rpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "codex_critic", arguments: { prompt: "hi" } },
      },
      { auth: `Bearer ${FAST_NONCE}` },
    )
    expect((json.error as { code: number }).code).toBe(-32601)
  })

  test("tools/call rejects a core worker with -32601 even though Fast allows the browse-only workers group", async () => {
    const { json } = await scopedRpc(
      "workers",
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "explore", arguments: { workspace: "/tmp", prompt: "hi" } },
      },
      { auth: `Bearer ${FAST_NONCE}` },
    )
    expect((json.error as { code: number }).code).toBe(-32601)
  })

  test("tools/list on /mcp/workers contains no core workers when browse is unavailable", async () => {
    const { status, json } = await scopedRpc(
      "workers",
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
      { auth: `Bearer ${FAST_NONCE}` },
    )
    expect(status).toBe(200)
    const tools = (json.result as { tools: Array<{ name: string }> }).tools
    expect(tools).toEqual([])
  })

  test("Fast lists and dispatches Artifact as a non-persona tool when the tab gate is enabled", async () => {
    process.env.AIORDIE_BASE_URL = "https://ai.example"
    process.env.AIORDIE_TOKEN = "artifact-token"
    process.env.AIORDIE_SESSION_ID = "session-1"
    const calls: string[] = []
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      calls.push(input.toString())
      return Response.json({
        ok: true,
        status: "open",
        visibility: "visible",
        viewUrl: "https://ai.example/artifact/session-1/view",
        panelUrl: "https://ai.example/panel/session-1",
      })
    }) as unknown as typeof fetch

    const listed = await scopedRpc(
      "peers",
      { jsonrpc: "2.0", id: 41, method: "tools/list" },
      { auth: `Bearer ${FAST_NONCE}` },
    )
    const names = (listed.json.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)
    expect(names).toContain("artifact_refresh")

    const called = await scopedRpc(
      "peers",
      {
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: { name: "artifact_refresh", arguments: {} },
      },
      { auth: `Bearer ${FAST_NONCE}` },
    )
    expect(called.json.error).toBeUndefined()
    expect(calls).toEqual(["https://ai.example/api/artifact/session-1/refresh"])
  })

  test("Fast hides Artifact symmetrically when the tab gate is disabled", async () => {
    const listed = await scopedRpc(
      "peers",
      { jsonrpc: "2.0", id: 43, method: "tools/list" },
      { auth: `Bearer ${FAST_NONCE}` },
    )
    const names = (listed.json.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)
    expect(names).not.toContain("artifact_refresh")

    const called = await scopedRpc(
      "peers",
      {
        jsonrpc: "2.0",
        id: 44,
        method: "tools/call",
        params: { name: "artifact_refresh", arguments: {} },
      },
      { auth: `Bearer ${FAST_NONCE}` },
    )
    expect((called.json.error as { code: number }).code).toBe(-32601)
  })

  test("the standard (unrestricted) launch nonce is completely unaffected — full persona list still returned", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list" })
    const tools = (json.result as { tools: Array<{ name: string }> }).tools
    const names = tools.map((t) => t.name)
    expect(names).toContain("codex_critic")
    expect(names).toContain("gemini_critic")
    expect(names).toContain("opus_critic")
  })
})
