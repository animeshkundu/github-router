// Regression test for Bug #3: "bridgeCall open-after-settle ghost execution"
//
// The bug: ws.on("open", ...) does not check the `settled` flag.
// If timeout fires before the WS "open" event arrives, finish() rejects
// the promise, but the open handler still calls ws.send() — executing the
// tool in the browser even though the caller has moved on. For side-effectful
// tools (browser_click, browser_fill, browser_navigate, browser_download),
// this is a ghost action the user never intended.
//
// Fix: guard the open handler with `if (settled) { ws.close(); return }`.
//
// Test isolation note: this file lives in tests/isolated/ because it uses
// mock.module("ws") which must not interfere with production-path tests
// that use the real ws module.

import {
  afterEach,
  beforeAll,
  afterAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { EventEmitter } from "node:events"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// ---------------------------------------------------------------------------
// Fake bridge discovery + health server so ensureBridgeReady() returns
// {install_required: false} without us mocking the install-check module.
// We use a real HTTP server on a random port + a fake bridge.json pointing
// at it, routed through the real ensureBridgeReady() call chain.
// ---------------------------------------------------------------------------
import { createServer, type Server } from "node:http"
import { randomBytes } from "node:crypto"

// Override the discovery-file path so the real readBridgeDiscovery() finds
// our test file instead of the user's real one.
const testBridgeDir = path.join(tmpdir(), `gh-router-dispatch-test-${process.pid}`)
const testBridgeJson = path.join(testBridgeDir, "bridge.json")

let httpServer: Server | undefined
let bridgePort = 0
const bridgeToken = randomBytes(16).toString("hex")

mock.module("~/lib/browser-mcp/bridge-paths", () => ({
  discoveryPath: () => testBridgeJson,
}))

// Mock browser detection to always return ["chrome"].
mock.module("~/lib/browser-mcp/browser-detect", () => ({
  detectSupportedBrowsers: () => ["chrome"] as ["chrome"],
  _resetSupportedBrowserCache: () => undefined,
  hasSupportedBrowserInstalled: () => true,
}))

// Mock native-host-installer so installNativeHostForAll is a no-op.
// Note: unlike the install-check test, we don't COUNT calls here — we
// just need installation to not throw.
mock.module("~/lib/browser-mcp/native-host-installer", () => ({
  bridgeBundlePath: () => testBridgeJson, // points at our json file (exists)
  extensionDir: () => "/fake-dispatch/ext",
  computeExtensionIdFromKey: () => "a".repeat(32),
  installNativeHostForAll: () => [
    { browser: "chrome", manifestPath: "/fake-dispatch/manifest.json" },
  ],
  __NMH_HOST_ID_FOR_TESTS: "com.githubrouter.browser",
}))

// Mock the "ws" module so `new WebSocket(...)` returns our FakeWs.
// This is the core mock needed for Bug #3: we control when "open" fires.
class FakeWs extends EventEmitter {
  sendCalls = 0
  closeCalls = 0

  send(_data: string): void {
    this.sendCalls++
  }
  close(): void {
    this.closeCalls++
    // Do NOT emit "close" — keeps test ordering deterministic.
  }
  terminate(): void {
    // Same: don't auto-emit "close".
  }
}

const fakeWsRef: { current: FakeWs | undefined } = { current: undefined }

mock.module("ws", () => {
  const WsFake = class extends FakeWs {
    constructor() {
      super()
      fakeWsRef.current = this as FakeWs
    }
  }
  return {
    default: WsFake as unknown as typeof FakeWs,
    WebSocket: WsFake as unknown as typeof FakeWs,
  }
})

beforeAll(async () => {
  // Start a real HTTP server that responds with { ok:true, extension_connected:true }
  // so the real probeHealth() in ensureBridgeReady() reports the bridge as healthy.
  httpServer = createServer((req, res) => {
    const auth = req.headers.authorization ?? ""
    if (auth !== `Bearer ${bridgeToken}`) {
      res.statusCode = 401
      res.end("unauthorized")
      return
    }
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ ok: true, extension_connected: true }))
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", () => resolve()))
  const addr = httpServer.address()
  if (!addr || typeof addr === "string") throw new Error("dispatch-test: no addr")
  bridgePort = (addr as { port: number }).port

  // Write the discovery file so readBridgeDiscovery() returns our test bridge info.
  mkdirSync(testBridgeDir, { recursive: true })
  writeFileSync(
    testBridgeJson,
    JSON.stringify({ pid: process.pid, port: bridgePort, token: bridgeToken, startedAt: Date.now() }),
    "utf8",
  )
})

afterAll(() => {
  if (httpServer) httpServer.close()
  try {
    rmSync(testBridgeDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

afterEach(() => {
  fakeWsRef.current = undefined
})

describe("Bug #3 — bridgeCall ghost execution after timeout", () => {
  test("send() is NOT called when 'open' fires after timeout has already settled", async () => {
    // Import AFTER mocks are registered so it picks up the mocked ws module.
    const { dispatchBrowserTool } = await import(
      "../../src/lib/browser-mcp/dispatch"
    )

    // Reset the single-flight state so this test gets a fresh ensureBridgeReady call.
    const { __resetEnsureBridgeReadyForTests } = await import(
      "../../src/lib/browser-mcp/install-check"
    )
    __resetEnsureBridgeReadyForTests()

    // Use a short but non-zero timeout. The FakeWs never resolves the
    // promise on its own, so the timeout will fire and settle it first.
    const dispatchPromise = dispatchBrowserTool(
      "browser_click",
      { ref: "el-1" },
      undefined,
      { timeoutMs: 20 },
    )

    // Wait for fakeWsRef.current to be set (synchronous inside the Ctor but
    // the Promise chain for ensureBridgeReady adds a tick).
    let waited = 0
    while (!fakeWsRef.current && waited < 500) {
      await new Promise((r) => setTimeout(r, 5))
      waited += 5
    }
    const ws = fakeWsRef.current
    expect(ws).toBeDefined()

    // Wait for the 20ms timeout to fire and settle the promise.
    await new Promise((r) => setTimeout(r, 50))

    // The promise should now be settled (timeout). Awaiting it must be
    // immediate (it's already resolved internally).
    const result = await dispatchPromise
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/timeout/i)

    // Record send calls BEFORE emitting "open".
    const sendsBefore = ws!.sendCalls

    // Now simulate "open" arriving late — after the timeout already settled.
    // In production this happens when the TCP handshake completes a moment
    // after the timeout fires.
    ws!.emit("open")

    // Give the event loop one tick to process the open handler.
    await new Promise((r) => setTimeout(r, 10))

    // CRITICAL: send() must NOT have been called after the post-settle open.
    // A count > sendsBefore here means the ghost execution bug is still present.
    expect(ws!.sendCalls).toBe(sendsBefore)
    expect(ws!.sendCalls).toBe(0)

    // close() should have been called (the guard path calls ws.close()).
    expect(ws!.closeCalls).toBeGreaterThan(0)
  })
})
