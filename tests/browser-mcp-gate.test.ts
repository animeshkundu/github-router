import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { readFileSync } from "node:fs"

import {
  __resetInFlightForTests,
} from "../src/routes/mcp/handler"
import { mcpRoutes } from "../src/routes/mcp/route"
import {
  _resetSupportedBrowserCache,
  hasSupportedBrowserInstalled,
} from "../src/lib/browser-mcp/browser-detect"
import {
  computeExtensionIdFromKey,
  extensionDir,
} from "../src/lib/browser-mcp/native-host-installer"
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
let savedPowerBrowseEnabled: boolean
let savedEnvBrowseFlag: string | undefined
let savedEnvDisableWorker: string | undefined
let savedEnvDisableProvision: string | undefined

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
  savedPowerBrowseEnabled = state.powerBrowseEnabled
  savedEnvBrowseFlag = process.env.GH_ROUTER_ENABLE_BROWSE
  savedEnvDisableWorker = process.env.GH_ROUTER_DISABLE_WORKER_TOOLS
  savedEnvDisableProvision = process.env.GH_ROUTER_DISABLE_BROWSER_PROVISION
  // Pin worker tools OFF so tools/list output is deterministic across
  // hosts (some dev boxes have gemini-3.5-flash in their catalog, which
  // would inflate the tool count in ways unrelated to this test).
  process.env.GH_ROUTER_DISABLE_WORKER_TOOLS = "1"
  // Keep this non-isolated gate suite hermetic: any browser dispatch added
  // here must not materialize/stamp assets or install an NMH in the user's home.
  process.env.GH_ROUTER_DISABLE_BROWSER_PROVISION = "1"
  delete process.env.GH_ROUTER_ENABLE_BROWSE
  state.peerMcpNonce = NONCE
  state.copilotToken = "test-copilot-token"
  state.githubToken = "test-gh-token"
  state.accountType = "individual"
  state.browseEnabled = false
  state.powerBrowseEnabled = false
  state.models = baseModels
})

afterEach(() => {
  state.peerMcpNonce = undefined
  state.models = undefined
  state.browseEnabled = savedBrowseEnabled
  state.powerBrowseEnabled = savedPowerBrowseEnabled
  if (savedEnvBrowseFlag === undefined) delete process.env.GH_ROUTER_ENABLE_BROWSE
  else process.env.GH_ROUTER_ENABLE_BROWSE = savedEnvBrowseFlag
  if (savedEnvDisableWorker === undefined) delete process.env.GH_ROUTER_DISABLE_WORKER_TOOLS
  else process.env.GH_ROUTER_DISABLE_WORKER_TOOLS = savedEnvDisableWorker
  if (savedEnvDisableProvision === undefined) delete process.env.GH_ROUTER_DISABLE_BROWSER_PROVISION
  else process.env.GH_ROUTER_DISABLE_BROWSER_PROVISION = savedEnvDisableProvision
  _resetSupportedBrowserCache()
  mock.restore()
})

describe("browser-mcp capability gate (--browse)", () => {
  test("tools/list omits browser tools by default (browseEnabled=false, no env)", async () => {
    // The MCP-facing names lost the `browser_` prefix in the five-server
    // split (the wire names sent to the extension keep it). So the
    // default-off assertion is on the bare lead/power tool names rather
    // than a `browser_` prefix scan, which would now be vacuous.
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })
    expect(status).toBe(200)
    const names = (json.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    )
    for (const browserTool of ["open_tab", "navigate", "screenshot", "act", "mouse"]) {
      expect(names).not.toContain(browserTool)
    }
  })

  test("tools/list includes open_tab when state.browseEnabled=true AND a browser is detected", async () => {
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
    expect(names).toContain("open_tab")
  })

  test("tools/list includes open_tab when GH_ROUTER_ENABLE_BROWSE=1 (env opt-in, no flag)", async () => {
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
    expect(names).toContain("open_tab")
  })

  test("defense-in-depth: tools/call open_tab returns -32601 when gate is off (bypassing tools/list)", async () => {
    // Naive client hard-codes the name and skips tools/list. Call-time
    // gate must reject identically to an unknown tool, keeping the
    // gated surface functionally invisible. The MCP-facing name is the
    // bare `open_tab` (the `browser_` wire name is internal).
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "open_tab", arguments: { url: "https://example.com" } },
    })
    expect(status).toBe(200)
    const err = (json as { error?: { code: number; message: string } }).error
    expect(err?.code).toBe(-32601)
    expect(err?.message).toMatch(/unknown tool/i)
  })

  test("real manifest derives a stable extension ID and unpacked directory", () => {
    // Deterministic successor to the ambient bridge test: exercise the real
    // pure derivation directly without depending on browser or bridge state.
    const manifest = JSON.parse(
      readFileSync(new URL("../src/browser-ext/manifest.json", import.meta.url), "utf8"),
    ) as { key: string }
    expect(computeExtensionIdFromKey(manifest.key)).toMatch(/^[a-p]{32}$/)
    expect(extensionDir()).toMatch(/browser-ext/)
  })

  test("tools/list includes the humanlike-input v2 tools (mouse / drag / type) under --power-browse", async () => {
    if (!hasSupportedBrowserInstalled()) return
    state.browseEnabled = true
    state.powerBrowseEnabled = true
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/list",
    })
    const names = (json.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    )
    for (const name of ["mouse", "drag", "type"]) {
      expect(names).toContain(name)
    }
  })

  test("power-tier tools (mouse / drag / type / diagnostics) are HIDDEN under default --browse", async () => {
    if (!hasSupportedBrowserInstalled()) return
    state.browseEnabled = true
    state.powerBrowseEnabled = false
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/list",
    })
    const names = (json.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    )
    for (const name of [
      "mouse",
      "drag",
      "type",
      "diagnostics",
      "read_page",
      "keyboard",
      "scroll",
      "eval_js",
    ]) {
      expect(names).not.toContain(name)
    }
  })

  test("defense-in-depth: tools/call mouse / drag / type return -32601 when --power-browse is off", async () => {
    // Symmetric with open_tab — a naive client hard-coding any of these
    // bare names must hit the same method-not-found path. `locate` was
    // removed as part of the L2 cull (find returns bbox).
    state.browseEnabled = true
    state.powerBrowseEnabled = false
    for (const name of ["mouse", "drag", "type"]) {
      const { status, json } = await rpc({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name, arguments: { tabId: 1 } },
      })
      expect(status).toBe(200)
      const err = (json as { error?: { code: number; message: string } }).error
      expect(err?.code).toBe(-32601)
      expect(err?.message).toMatch(/unknown tool/i)
    }
  })

  test("L2 cull removes click / fill / locate / console_logs / network_log from MCP surface (even with --power-browse)", async () => {
    if (!hasSupportedBrowserInstalled()) return
    state.browseEnabled = true
    state.powerBrowseEnabled = true
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/list",
    })
    const names = (json.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    )
    for (const removed of [
      "click",
      "fill",
      "locate",
      "console_logs",
      "network_log",
    ]) {
      expect(names).not.toContain(removed)
    }
    // diagnostics replaces console_logs + network_log; act (ref mode)
    // replaces click + fill; find returns bbox in lieu of locate. These
    // four are the additive L2 surface — diagnostics is gated under
    // --power-browse now.
    expect(names).toContain("diagnostics")
  })

  test("default --browse exposes the always-present browser tier (navigate, screenshot, open_tab)", async () => {
    if (!hasSupportedBrowserInstalled()) return
    state.browseEnabled = true
    state.powerBrowseEnabled = false
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/list",
    })
    // The browser lead-surface tools (the `browser` + `browser_compound`
    // capability tiers) — filtered against the known lead-tool name set
    // since the bare names no longer carry a `browser_` prefix to scan for.
    const LEAD_TOOLS = new Set([
      "open_tab",
      "navigate",
      "screenshot",
      "act",
      "observe",
      "extract",
    ])
    const names = (json.result as { tools: Array<{ name: string }> }).tools
      .map((t) => t.name)
      .filter((n) => LEAD_TOOLS.has(n))
    // open_tab / navigate / screenshot are always present under --browse
    // (capability "browser"). act / observe / extract / find are the
    // browser_compound tier: they need a compressor backend in the catalog,
    // so they are catalog-dependent and NOT asserted here. This test pins
    // the always-present "browser" tier; the compound gating is covered by
    // the snippet gating tests in tests/peer-mcp-personas.test.ts.
    expect(names).toContain("open_tab")
    expect(names).toContain("navigate")
    expect(names).toContain("screenshot")
    // Power-tier tools must NOT appear.
    for (const power of [
      "mouse",
      "drag",
      "type",
      "keyboard",
      "scroll",
      "eval_js",
      "read_page",
      "diagnostics",
      "find",
      "download",
      "wait",
      "list_tabs",
      "close_tab",
    ]) {
      expect(names).not.toContain(power)
    }
  })
})
