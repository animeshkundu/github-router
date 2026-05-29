// pending.ts — per-request pending-Map management for the browser bridge.
//
// Extracted from index.ts so the TTL logic can be unit-tested without
// importing the bridge entry-point (which starts HTTP servers and wires
// process.stdin/stdout). The Map itself lives here and is exposed as a
// module export so tests can inspect its size without going through the
// bridge's WS handler.

import type { WebSocket } from "ws"

type BridgeResponse =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: string; code?: string }

interface PendingEntry {
  resolve: (msg: BridgeResponse) => void
  client: WebSocket
  /** clearTimeout handle — cancelled when the entry resolves normally. */
  ttlTimer: ReturnType<typeof setTimeout>
}

// Exported for tests: allows inspecting entry count without going through WS.
export const pendingMap = new Map<string, PendingEntry>()

/**
 * Register a pending request. The TTL timer ensures the entry is removed
 * even when the extension hangs (MV3 SW dormancy, tab crash, navigation
 * interrupt) and the WS client stays connected — which would otherwise
 * leave the entry in the Map for the lifetime of a long proxy session.
 *
 * On TTL expiry the caller receives a structured timeout error so the
 * dispatcher can surface a meaningful message rather than hanging.
 *
 * @param id       Request ID (must match the extension's response).
 * @param client   WS client to send the response back on.
 * @param ttlMs    How long to wait before forcibly resolving with an error.
 * @param sendResp Callback that encodes and writes BridgeResponse to `client`.
 */
export function pendingAdd(
  id: string,
  client: WebSocket,
  ttlMs: number,
  sendResp: (resp: BridgeResponse) => void,
): void {
  const ttlTimer = setTimeout(() => {
    if (!pendingMap.has(id)) return
    pendingMap.delete(id)
    sendResp({ id, ok: false, error: `bridge timeout after ${ttlMs}ms`, code: "timeout" })
  }, ttlMs)
  pendingMap.set(id, { resolve: sendResp, client, ttlTimer })
}

/**
 * Resolve a pending request with the browser's response and cancel the
 * TTL timer. No-ops if the id is unknown (double-resolve from a
 * misbehaving extension is harmless).
 */
export function pendingResolve(id: string, msg: BridgeResponse): void {
  const entry = pendingMap.get(id)
  if (!entry) return
  clearTimeout(entry.ttlTimer)
  pendingMap.delete(id)
  entry.resolve(msg)
}

/**
 * Drop all pending entries belonging to a specific WS client and cancel
 * their TTL timers. Called from the WS "close" handler so we don't leak
 * entries when the dispatcher disconnects mid-flight.
 */
export function pendingDropClient(client: WebSocket): void {
  for (const [id, entry] of pendingMap) {
    if (entry.client === client) {
      clearTimeout(entry.ttlTimer)
      pendingMap.delete(id)
    }
  }
}
