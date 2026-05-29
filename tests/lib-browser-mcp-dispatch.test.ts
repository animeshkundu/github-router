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

import {
  afterEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { EventEmitter } from "node:events"

// Fake WebSocket that gives us precise control over which events fire and when.
// close() and terminate() do NOT auto-emit "close" — this lets the test
// control the event ordering without the ws.close() in finish() triggering
// a recursive finish() call before we've confirmed the settled state.
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

// Mutable container so the constructor can register the instance without
// aliasing `this` directly (avoids @typescript-eslint/no-this-alias).
const fakeWsRef: { current: FakeWs | undefined } = { current: undefined }

// Mock the "ws" module so `new WebSocket(...)` returns our FakeWs.
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

// Mock install-check so ensureBridgeReady() returns "ready" instantly.
mock.module("~/lib/browser-mcp/install-check", () => ({
  ensureBridgeReady: () =>
    Promise.resolve({
      install_required: false,
      port: 19999,
      token: "test-token",
      pid: 1,
    }),
  installRequiredToolResult: (p: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(p) }],
    isError: true,
  }),
}))

// Mock policy so it never blocks.
mock.module("~/lib/browser-mcp/policy", () => ({
  preflightUrlPolicy: () => ({ blocked: false }),
}))

afterEach(() => {
  fakeWsRef.current = undefined
  mock.restore()
})

describe("Bug #3 — bridgeCall ghost execution after timeout", () => {
  test("send() is NOT called when 'open' fires after timeout has already settled", async () => {
    // Import AFTER mocks are registered so it picks up the mocked modules.
    const { dispatchBrowserTool } = await import(
      "../src/lib/browser-mcp/dispatch"
    )

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
    while (!fakeWsRef.current && waited < 200) {
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
