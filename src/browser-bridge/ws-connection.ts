// ws-connection.ts — per-client WebSocket lifecycle for the browser bridge.
//
// Extracted from index.ts on the same reasoning as pending.ts: index.ts is an
// ENTRY POINT (importing it starts HTTP servers and wires process stdio), so
// the connection lifecycle could not be unit-tested where it lived. It shipped
// with two defects that a test would have caught immediately:
//
//   1. **No `'error'` listener.** `ws` emits `'error'` on a socket reset, and
//      an EventEmitter `'error'` with no listener THROWS. index.ts's
//      process-level `uncaughtException` handler merely logs it, so the bridge
//      kept running around a half-dead socket AND kept its 5s heartbeat
//      interval alive — the interval was cleared only in `'close'`, which does
//      not reliably follow `'error'`.
//   2. **No `return` after `terminate()`.** On hitting the missed-heartbeat
//      limit the code fell through and pinged the socket it had just killed.
//
// The fix is one idempotent `teardown()` reached from all three ends (close,
// error, heartbeat-limit). A bare `'error'` listener would have stopped the
// crash without stopping the leak, which is why this is a shared path rather
// than a third handler.

import type { WebSocket } from "ws"

/**
 * Opaque interval handle. Deliberately NOT `ReturnType<typeof setInterval>`:
 * this file is typechecked under BOTH the root config (Bun types, `Timer`) and
 * `tsconfig.browser.json` (Node types, `Timeout`), and those are structurally
 * incompatible. The module only ever passes the handle back to its own
 * `clearIntervalFn`, so an opaque token is the honest type.
 */
export type IntervalHandle = unknown

export interface WsConnectionOptions {
  heartbeatMs: number
  heartbeatMissLimit: number
  /** Release any per-client state (pending requests bound to this socket). */
  onTeardown: (ws: WebSocket) => void
  /** Injectable timers so tests drive the heartbeat without wall-clock waits. */
  setIntervalFn?: (fn: () => void, ms: number) => IntervalHandle
  clearIntervalFn?: (handle: IntervalHandle) => void
}

export interface WsConnectionHandle {
  /** True once teardown has run (any of the three paths). */
  readonly tornDown: boolean
  /** Consecutive missed heartbeats. Exposed for assertions. */
  readonly misses: number
}

/**
 * Attach heartbeat + teardown handling to one client socket.
 *
 * Message dispatch stays in index.ts: it needs the bridge's request plumbing,
 * whereas this is pure lifecycle. Returns a handle so a caller (or a test) can
 * observe teardown without reaching into the socket.
 */
export function attachWsLifecycle(
  ws: WebSocket,
  opts: WsConnectionOptions,
): WsConnectionHandle {
  const setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn
    = opts.clearIntervalFn
      ?? ((handle: IntervalHandle) => clearInterval(handle as Parameters<typeof clearInterval>[0]))

  let alive = true
  let misses = 0
  let tornDown = false

  const teardown = (): void => {
    if (tornDown) return
    tornDown = true
    clearIntervalFn(heartbeat)
    opts.onTeardown(ws)
  }

  const heartbeat = setIntervalFn(() => {
    if (!alive) {
      misses++
      if (misses >= opts.heartbeatMissLimit) {
        teardown()
        try {
          ws.terminate()
        } catch {
          // Closing a stale socket can throw; ignore.
        }
        // Load-bearing: without this we fall through and ping a socket we
        // just terminated.
        return
      }
    }
    alive = false
    try {
      ws.ping()
    } catch {
      // Ping on a half-closed socket — teardown handles the rest.
    }
  }, opts.heartbeatMs)

  ws.on("pong", () => {
    alive = true
    misses = 0
  })

  ws.on("error", () => {
    teardown()
    try {
      ws.terminate()
    } catch {
      // Already gone.
    }
  })

  ws.on("close", () => {
    teardown()
  })

  return {
    get tornDown() {
      return tornDown
    },
    get misses() {
      return misses
    },
  }
}
