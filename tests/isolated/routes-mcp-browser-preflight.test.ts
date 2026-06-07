// Regression test: browser readiness pre-flight runs BEFORE the inflight
// slot is acquired.
//
// The bug (docs/research/mcp-concurrency-audit.md §4/§6): browser_* tools
// dispatch through `dispatchBrowserTool`, which awaits `ensureBridgeReady()`
// at its head. That await happened INSIDE the held MCP concurrency
// slot. On a cold-start NMH install, up to MAX_INFLIGHT_TOOLS_CALL
// concurrent browser calls could park their slots on the one shared
// readiness probe, starving peers/search/workers/decide out of the pool.
// This contradicts the load-bearing invariant the same handler enforces
// for personas: a pre-flight that can reject/await MUST run before
// `acquireInFlightSlot()` (a reject after acquisition leaks a slot).
//
// The fix hoists the readiness pre-flight (`browserPreflight`) ahead of
// `acquireInFlightSlot()` in `handleToolsCall`. Proof shape: saturate the
// inflight pool, then fire a not-ready browser call. Under the OLD code
// the call would try to acquire a slot first and get "queue full". Under
// the fix, the pre-flight rejects with the structured `install_required`
// envelope WITHOUT taking a slot, so the response is install_required,
// not queue-full, and the inflight count never rises above the saturated
// level.
//
// Test isolation note: this file lives in tests/isolated/ because it uses
// mock.module() for browser-detect / native-host-installer / bridge-paths
// (shared with sibling browser-mcp tests), the isolated/ directory keeps
// those module-scope mocks from bleeding into the production-path suites.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { tmpdir } from "node:os"
import { writeFileSync } from "node:fs"
import path from "node:path"

import { mock } from "bun:test"

import { state } from "../../src/lib/state"
import type { ModelsResponse } from "../../src/services/copilot/get-models"

// Real temp file for the bridge bundle so bridgeBundleExists() = true; the
// readiness probe then falls through to the discovery-file read, which
// misses (file does not exist) to install_required, reason "bridge_not_running".
const tmpBridgeBundle = path.join(
  tmpdir(),
  `gh-router-browser-preflight-bundle-${process.pid}.js`,
)
writeFileSync(tmpBridgeBundle, "// fake bundle", "utf8")

const nonExistentDiscovery = path.join(
  tmpdir(),
  `gh-router-browser-preflight-no-bridge-${process.pid}.json`,
)

mock.module("~/lib/browser-mcp/browser-detect", () => ({
  detectSupportedBrowsers: () => ["chrome"] as ["chrome"],
  _resetSupportedBrowserCache: () => undefined,
  // Forces browserToolsEnabled() true regardless of host browser presence.
  hasSupportedBrowserInstalled: () => true,
}))

mock.module("~/lib/browser-mcp/native-host-installer", () => ({
  bridgeBundlePath: () => tmpBridgeBundle, // real file, bridgeBundleExists() = true
  extensionDir: () => "/fake-preflight/ext",
  computeExtensionIdFromKey: () => "a".repeat(32),
  installNativeHostForAll: () => [
    { browser: "chrome", manifestPath: "/fake-preflight/manifest.json" },
  ],
  __NMH_HOST_ID_FOR_TESTS: "com.githubrouter.browser",
}))

mock.module("~/lib/browser-mcp/bridge-paths", () => ({
  discoveryPath: () => nonExistentDiscovery,
}))

const PROXY_PORT = 18799
const PROXY_HOST = `127.0.0.1:${PROXY_PORT}`
const NONCE = "fedcba9876543210".repeat(4) // 64 chars
const AUTH_HEADER = `Bearer ${NONCE}`

const fakeModel = (id: string) => ({
  id,
  name: id,
  vendor: "OpenAI",
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
  supported_endpoints: ["/v1/responses"],
})

const baseModels: ModelsResponse = {
  object: "list",
  data: [fakeModel("gpt-5.5")],
}

function browserReq(body: unknown) {
  // Browser tools live in the `browser` group; the scoped endpoint is the
  // cleanest target, but the unscoped union ("/") works too. Use the
  // scoped path so the test mirrors how Claude Code routes mcp__browser__*.
  return new Request(`http://${PROXY_HOST}/browser`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: AUTH_HEADER,
      host: PROXY_HOST,
    },
    body: JSON.stringify(body),
  })
}

describe("browser readiness pre-flight runs before slot acquisition", () => {
  beforeEach(() => {
    state.peerMcpNonce = NONCE
    state.copilotToken = "test-copilot-token"
    state.githubToken = "test-gh-token"
    state.models = baseModels
    state.browseEnabled = true
    state.powerBrowseEnabled = true
  })

  afterEach(() => {
    state.peerMcpNonce = undefined
    state.models = undefined
    state.browseEnabled = false
    state.powerBrowseEnabled = false
  })

  test("a not-ready browser call returns install_required WITHOUT consuming an inflight slot, even when the pool is saturated", async () => {
    const { mcpRoutes } = await import("../../src/routes/mcp/route")
    const { __getInFlightForTests, __resetInFlightForTests } = await import(
      "../../src/routes/mcp/handler"
    )
    const { acquireInFlightSlot, MAX_INFLIGHT_TOOLS_CALL } = await import(
      "../../src/lib/mcp-inflight"
    )
    const { __resetEnsureBridgeReadyForTests } = await import(
      "../../src/lib/browser-mcp/install-check"
    )

    __resetInFlightForTests()
    __resetEnsureBridgeReadyForTests()

    // Saturate the shared inflight pool by hand so there are zero free slots.
    const releases: Array<() => void> = []
    for (let i = 0; i < MAX_INFLIGHT_TOOLS_CALL; i++) {
      const release = acquireInFlightSlot()
      expect(release).not.toBeNull()
      releases.push(release as () => void)
    }
    expect(__getInFlightForTests()).toBe(MAX_INFLIGHT_TOOLS_CALL)

    // Fire a browser tools/call. The bridge isn't running (discovery file
    // missing), so the readiness pre-flight resolves to install_required.
    // With the pool saturated, the OLD code would return "queue full"
    // (slot acquired first); the fix returns install_required because the
    // pre-flight ran BEFORE slot acquisition.
    const res = await mcpRoutes.request(
      browserReq({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "open_tab",
          arguments: { url: "https://example.com" },
        },
      }),
    )
    const json = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> }
    }

    // The pre-flight rejected with the structured install_required payload,
    // NOT the queue-full message, proof the readiness check ran before the
    // (saturated) slot acquisition.
    expect(json.result?.isError).toBe(true)
    const text = json.result?.content?.[0]?.text ?? ""
    expect(text).not.toMatch(/queue full/i)
    expect(text).toMatch(/install_required/i)
    expect(text).toMatch(/bridge_not_running/i)

    // CRITICAL: the not-ready browser call must not have taken a slot. The
    // inflight count is exactly the saturated level we held, never N+1 or a
    // leaked slot left behind after the reject.
    expect(__getInFlightForTests()).toBe(MAX_INFLIGHT_TOOLS_CALL)

    // Release the manually held slots.
    for (const release of releases) release()
    expect(__getInFlightForTests()).toBe(0)
  })

  test("a blocked-URL browser call returns the blocked envelope WITHOUT consuming a slot, even when the pool is saturated", async () => {
    const { mcpRoutes } = await import("../../src/routes/mcp/route")
    const { __getInFlightForTests, __resetInFlightForTests } = await import(
      "../../src/routes/mcp/handler"
    )
    const { acquireInFlightSlot, MAX_INFLIGHT_TOOLS_CALL } = await import(
      "../../src/lib/mcp-inflight"
    )
    const { __resetEnsureBridgeReadyForTests } = await import(
      "../../src/lib/browser-mcp/install-check"
    )

    __resetInFlightForTests()
    __resetEnsureBridgeReadyForTests()

    const releases: Array<() => void> = []
    for (let i = 0; i < MAX_INFLIGHT_TOOLS_CALL; i++) {
      const release = acquireInFlightSlot()
      expect(release).not.toBeNull()
      releases.push(release as () => void)
    }
    expect(__getInFlightForTests()).toBe(MAX_INFLIGHT_TOOLS_CALL)

    // A blocked URL (chrome://settings) must fail closed in the hoisted
    // pre-flight, before slot acquisition and WITHOUT probing/installing
    // the bridge. With the pool saturated, the OLD code would have returned
    // "queue full"; the fix returns the blocked envelope.
    const res = await mcpRoutes.request(
      browserReq({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "open_tab",
          arguments: { url: "chrome://settings" },
        },
      }),
    )
    const json = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> }
    }
    expect(json.result?.isError).toBe(true)
    const text = json.result?.content?.[0]?.text ?? ""
    expect(text).not.toMatch(/queue full/i)
    expect(text).toMatch(/"blocked":\s*true/i)

    expect(__getInFlightForTests()).toBe(MAX_INFLIGHT_TOOLS_CALL)
    for (const release of releases) release()
    expect(__getInFlightForTests()).toBe(0)
  })
})
