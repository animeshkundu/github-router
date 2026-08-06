// Regression tests for two defects in the bridge's per-client WebSocket
// lifecycle, both of which shipped because `src/browser-bridge/**` was
// excluded from `tsc` AND the logic lived in an entry point that could not be
// imported without starting servers:
//
//   1. **No `'error'` listener.** `ws` emits `'error'` on a socket reset, and
//      an EventEmitter `'error'` with no listener THROWS. index.ts's
//      process-level `uncaughtException` handler merely logged it, so the
//      bridge kept running around a half-dead socket AND kept its 5s heartbeat
//      interval alive — that interval was cleared only in `'close'`, which
//      does not reliably follow `'error'`.
//   2. **No `return` after `terminate()`.** On hitting the missed-heartbeat
//      limit the code fell through and pinged the socket it had just killed.
//
// The tests below assert the FIX, not just the absence of a crash: a bare
// `'error'` listener would stop the throw while still leaking the interval, so
// every case checks that teardown actually ran.

import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"

import type { WebSocket } from "ws"

import { attachWsLifecycle } from "../src/browser-bridge/ws-connection"

/** Minimal `ws` stand-in: records what the lifecycle did to the socket. */
class FakeSocket extends EventEmitter {
  pings = 0
  terminations = 0
  /** When true, `ping()` throws — the half-closed-socket case. */
  pingThrows = false

  ping(): void {
    if (this.pingThrows) throw new Error("socket is half-closed")
    this.pings += 1
  }

  terminate(): void {
    this.terminations += 1
  }
}

/** A hand-driven interval so the heartbeat advances without wall-clock waits. */
function fakeTimer() {
  let tick: (() => void) | undefined
  let cleared = 0
  return {
    get cleared() {
      return cleared
    },
    setIntervalFn: ((fn: () => void) => {
      tick = fn
      return 1 as unknown as ReturnType<typeof setInterval>
    }) as (fn: () => void, ms: number) => ReturnType<typeof setInterval>,
    clearIntervalFn: () => {
      cleared += 1
    },
    advance(times = 1) {
      for (let i = 0; i < times; i++) tick?.()
    },
  }
}

function attach(
  ws: FakeSocket,
  timer: ReturnType<typeof fakeTimer>,
  onTeardown: (client: WebSocket) => void = () => {},
) {
  return attachWsLifecycle(ws as unknown as WebSocket, {
    heartbeatMs: 5000,
    heartbeatMissLimit: 3,
    onTeardown,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  })
}

describe("bridge WS lifecycle", () => {
  test("a socket 'error' tears down instead of throwing", () => {
    const ws = new FakeSocket()
    const timer = fakeTimer()
    let torndownClients = 0
    const handle = attach(ws, timer, () => {
      torndownClients += 1
    })

    // With no listener this line THROWS (EventEmitter semantics). That it
    // returns at all is half the fix.
    expect(() => ws.emit("error", new Error("ECONNRESET"))).not.toThrow()

    // The other half, and the one a bare no-op listener would fail: the
    // heartbeat interval is cleared and per-client state is released. Without
    // this the bridge leaks a 5s timer per reset socket for its whole life.
    expect(handle.tornDown).toBe(true)
    expect(timer.cleared).toBe(1)
    expect(torndownClients).toBe(1)
    expect(ws.terminations).toBe(1)
  })

  test("the missed-heartbeat limit terminates and does NOT ping afterwards", () => {
    const ws = new FakeSocket()
    const timer = fakeTimer()
    const handle = attach(ws, timer)

    // Tick 1: alive was true, so it flips to false and pings.
    timer.advance()
    expect(ws.pings).toBe(1)
    expect(handle.misses).toBe(0)

    // Ticks 2 and 3: no pong arrived, so misses climb and it keeps pinging.
    timer.advance(2)
    expect(handle.misses).toBe(2)
    expect(ws.pings).toBe(3)

    // Tick 4 hits the limit of 3: terminate, and STOP. The missing `return`
    // is exactly what made the old code ping a terminated socket here.
    const pingsBefore = ws.pings
    timer.advance()
    expect(handle.misses).toBe(3)
    expect(ws.terminations).toBe(1)
    expect(ws.pings).toBe(pingsBefore) // no ping after terminate
    expect(handle.tornDown).toBe(true)
    expect(timer.cleared).toBe(1)
  })

  test("a pong resets the miss counter so a live socket is never terminated", () => {
    const ws = new FakeSocket()
    const timer = fakeTimer()
    const handle = attach(ws, timer)

    for (let i = 0; i < 10; i++) {
      timer.advance()
      ws.emit("pong")
    }

    expect(handle.misses).toBe(0)
    expect(ws.terminations).toBe(0)
    expect(handle.tornDown).toBe(false)
  })

  test("teardown is idempotent across error, close, and the heartbeat limit", () => {
    // All three ends can fire for one socket; per-client state must be
    // released exactly once.
    const ws = new FakeSocket()
    const timer = fakeTimer()
    let torndownClients = 0
    const handle = attach(ws, timer, () => {
      torndownClients += 1
    })

    ws.emit("error", new Error("reset"))
    ws.emit("close")
    timer.advance(5)

    expect(handle.tornDown).toBe(true)
    expect(torndownClients).toBe(1)
    expect(timer.cleared).toBe(1)
  })

  test("'close' alone tears down (the pre-existing path still works)", () => {
    const ws = new FakeSocket()
    const timer = fakeTimer()
    let torndownClients = 0
    const handle = attach(ws, timer, () => {
      torndownClients += 1
    })

    ws.emit("close")

    expect(handle.tornDown).toBe(true)
    expect(torndownClients).toBe(1)
    expect(timer.cleared).toBe(1)
  })

  test("a throwing ping does not escape the heartbeat", () => {
    // A half-closed socket throws from ping(); the interval must survive it,
    // otherwise one bad tick kills the heartbeat for a recoverable socket.
    const ws = new FakeSocket()
    ws.pingThrows = true
    const timer = fakeTimer()
    const handle = attach(ws, timer)

    expect(() => timer.advance(2)).not.toThrow()
    expect(handle.tornDown).toBe(false)
  })
})
