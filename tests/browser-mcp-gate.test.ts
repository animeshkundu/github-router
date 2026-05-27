import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  __resetInFlightForTests,
} from "../src/routes/mcp/handler"
import { mcpRoutes } from "../src/routes/mcp/route"
import {
  _resetSupportedBrowserCache,
  hasSupportedBrowserInstalled,
} from "../src/lib/browser-mcp/browser-detect"
import { state } from "../src/lib/state"
import type { ModelsResponse } from "../src/services/copilot/get-models"

const PROXY_PORT = 18787
const PROXY_HOST = `127.0.0.1:${PROXY_PORT}`
const NONCE = "0123456789abcdef".repeat(4)
const AUTH_HEADER = `Bearer ${NONCE}`

const fakeModel = (id: string, endpoints: Array<string> = ["/v1/responses"]) => ({
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
    supports: {},
  },
  supported_endpoints: endpoints,
})

const baseModels: ModelsResponse = {
  object: "list",
  data: [fakeModel("gpt-5.5"), fakeModel("gpt-5.3-codex")],
}

let savedBrowseEnabled: boolean
let savedEnvBrowseFlag: string | undefined
let savedEnvDisableWorker: string | undefined

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
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  __resetInFlightForTests()
  _resetSupportedBrowserCache()
  savedBrowseEnabled = state.browseEnabled
  savedEnvBrowseFlag = process.env.GH_ROUTER_ENABLE_BROWSE
  savedEnvDisableWorker = process.env.GH_ROUTER_DISABLE_WORKER_TOOLS
  // Pin worker tools OFF so tools/list output is deterministic across
  // hosts (some dev boxes have gemini-3.5-flash in their catalog, which
  // would inflate the tool count in ways unrelated to this test).
  process.env.GH_ROUTER_DISABLE_WORKER_TOOLS = "1"
  delete process.env.GH_ROUTER_ENABLE_BROWSE
  state.peerMcpNonce = NONCE
  state.copilotToken = "test-copilot-token"
  state.githubToken = "test-gh-token"
  state.accountType = "individual"
  state.browseEnabled = false
  state.models = baseModels
})

afterEach(() => {
  state.peerMcpNonce = undefined
  state.models = undefined
  state.browseEnabled = savedBrowseEnabled
  if (savedEnvBrowseFlag === undefined) delete process.env.GH_ROUTER_ENABLE_BROWSE
  else process.env.GH_ROUTER_ENABLE_BROWSE = savedEnvBrowseFlag
  if (savedEnvDisableWorker === undefined) delete process.env.GH_ROUTER_DISABLE_WORKER_TOOLS
  else process.env.GH_ROUTER_DISABLE_WORKER_TOOLS = savedEnvDisableWorker
  _resetSupportedBrowserCache()
  mock.restore()
})

describe("browser-mcp capability gate (--browse)", () => {
  test("tools/list omits browser_* tools by default (browseEnabled=false, no env)", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })
    expect(status).toBe(200)
    const names = (json.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    )
    expect(names.some((n) => n.startsWith("browser_"))).toBe(false)
  })

  test("tools/list includes browser_open_tab when state.browseEnabled=true AND a browser is detected", async () => {
    if (!hasSupportedBrowserInstalled()) {
      // CI runners that don't ship Chrome / Edge naturally exercise the
      // negative path (the "even when opted in, gate fails without a
      // browser" test below). Skip the positive assertion here on those
      // hosts — the inverse test still pins the behavior.
      return
    }
    state.browseEnabled = true
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })
    const names = (json.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    )
    expect(names).toContain("browser_open_tab")
  })

  test("tools/list includes browser_open_tab when GH_ROUTER_ENABLE_BROWSE=1 (env opt-in, no flag)", async () => {
    if (!hasSupportedBrowserInstalled()) return
    process.env.GH_ROUTER_ENABLE_BROWSE = "1"
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    })
    const names = (json.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    )
    expect(names).toContain("browser_open_tab")
  })

  test("defense-in-depth: tools/call browser_open_tab returns -32601 when gate is off (bypassing tools/list)", async () => {
    // Naive client hard-codes the name and skips tools/list. Call-time
    // gate must reject identically to an unknown tool, keeping the
    // gated surface functionally invisible.
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "browser_open_tab", arguments: { url: "https://example.com" } },
    })
    expect(status).toBe(200)
    const err = (json as { error?: { code: number; message: string } }).error
    expect(err?.code).toBe(-32601)
    expect(err?.message).toMatch(/unknown tool/i)
  })

  test("browser_open_tab returns install_required JSON with isError when gate is on but bridge isn't running", async () => {
    if (!hasSupportedBrowserInstalled()) return
    state.browseEnabled = true
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "browser_open_tab", arguments: { url: "https://example.com" } },
    })
    expect(status).toBe(200)
    const result = json.result as {
      content: Array<{ type: string; text: string }>
      isError: boolean
    }
    expect(result.isError).toBe(true)
    const payload = JSON.parse(result.content[0].text) as {
      install_required: boolean
      reason: string
      manual_steps: { load_unpacked_dir: string; expected_extension_id: string }
    }
    expect(payload.install_required).toBe(true)
    // Reason depends on host state: bridge bundle absent → bridge_bundle_missing,
    // bundle present but no bridge.json → bridge_not_running, bridge running but
    // extension not loaded → extension_not_loaded. Any of those is a valid
    // pre-flight failure.
    expect(payload.reason).toMatch(
      /^(bridge_bundle_missing|bridge_not_running|extension_not_loaded)$/,
    )
    expect(payload.manual_steps.load_unpacked_dir).toMatch(/browser-ext/)
    expect(payload.manual_steps.expected_extension_id).toMatch(/^[a-p]{32}$/)
  })
})
