// Regression test for Bug #4: "Bridge pending Map TTL leak"
//
// The bug: pending entries in src/browser-bridge/index.ts are deleted on
// (a) browser response or (b) WS-client close, but NOT on a per-request
// timeout. If the extension hangs (MV3 SW dormancy edge case, browser tab
// crash, navigation interrupt) but the WS client stays connected, the entry
// persists indefinitely. For a long-running proxy session (hours/days), this
// memory growth aggregates across all proxy sessions sharing one bridge process.
//
// Fix: extracted pending management into src/browser-bridge/pending.ts which
// adds a per-entry setTimeout(ttlMs). On expiry the entry is removed from the
// Map and the caller receives a structured { ok:false, code:"timeout" } error.
// clearTimeout is called when the entry resolves normally or the client closes
// so timers don't leak either.

import { afterEach, describe, expect, test } from "bun:test"

import { EventEmitter } from "node:events"

import {
  pendingAdd,
  pendingDropClient,
  pendingMap,
  pendingResolve,
} from "../src/browser-bridge/pending"

// Minimal fake WebSocket — only needs to satisfy the type constraint.
class FakeClient extends EventEmitter {
  sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
}

afterEach(() => {
  // Clean up any entries left by a test so tests are isolated.
  pendingMap.clear()
})

describe("Bug #4 — pending Map TTL leak", () => {
  test("entry is removed and caller receives timeout error within ttlMs", async () => {
    const client = new FakeClient() as unknown as import("ws").WebSocket

    let resolved: unknown
    pendingAdd("req-1", client, 30, (resp) => {
      resolved = resp
    })

    // Entry must be in the map immediately.
    expect(pendingMap.has("req-1")).toBe(true)
    expect(pendingMap.size).toBe(1)

    // Wait for TTL to fire (30ms + slack).
    await new Promise((r) => setTimeout(r, 80))

    // CRITICAL: entry must be gone from the map.
    expect(pendingMap.has("req-1")).toBe(false)
    expect(pendingMap.size).toBe(0)

    // CRITICAL: caller must have received a timeout error, not silence.
    expect(resolved).toBeDefined()
    const r = resolved as { id: string; ok: boolean; code?: string; error?: string }
    expect(r.id).toBe("req-1")
    expect(r.ok).toBe(false)
    expect(r.code).toBe("timeout")
    expect(r.error).toMatch(/timeout/i)
  })

  test("normal resolution cancels TTL timer (no spurious timeout after resolve)", async () => {
    const client = new FakeClient() as unknown as import("ws").WebSocket

    const responses: unknown[] = []
    pendingAdd("req-2", client, 30, (resp) => {
      responses.push(resp)
    })

    // Resolve before TTL fires.
    pendingResolve("req-2", { id: "req-2", ok: true, data: { foo: 1 } })

    expect(pendingMap.has("req-2")).toBe(false)
    expect(responses).toHaveLength(1)

    // Wait past the original TTL — the timer must NOT fire a second time.
    await new Promise((r) => setTimeout(r, 80))
    expect(responses).toHaveLength(1)
  })

  test("pendingDropClient removes entries for that client and cancels timers", async () => {
    const clientA = new FakeClient() as unknown as import("ws").WebSocket
    const clientB = new FakeClient() as unknown as import("ws").WebSocket

    const timeoutsA: string[] = []
    const timeoutsB: string[] = []

    pendingAdd("a-1", clientA, 30, (r) => timeoutsA.push(r.id))
    pendingAdd("a-2", clientA, 30, (r) => timeoutsA.push(r.id))
    pendingAdd("b-1", clientB, 30, (r) => timeoutsB.push(r.id))

    expect(pendingMap.size).toBe(3)

    // Drop client A.
    pendingDropClient(clientA)
    expect(pendingMap.size).toBe(1)
    expect(pendingMap.has("b-1")).toBe(true)
    expect(pendingMap.has("a-1")).toBe(false)
    expect(pendingMap.has("a-2")).toBe(false)

    // Wait past TTL — timers for clientA must NOT fire (they were cancelled).
    await new Promise((r) => setTimeout(r, 80))
    expect(timeoutsA).toHaveLength(0)
    // clientB's entry was not dropped — its TTL fires normally.
    expect(timeoutsB).toHaveLength(1)
    expect(pendingMap.size).toBe(0)
  })
})
