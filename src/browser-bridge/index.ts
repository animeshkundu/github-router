// github-router browser bridge.
//
// Spawned by Chrome / Edge as a native-messaging host (process started
// when the extension calls chrome.runtime.connectNative). Reads
// length-prefixed JSON frames over stdin/stdout from the browser, and
// exposes a localhost WebSocket on a random port so the github-router
// proxy can dispatch tool calls TO the extension via this process.
//
// Lifecycle: browser owns this process. When the extension disconnects
// (browser quit, extension uninstall, user kills the tab), the browser
// closes stdin/stdout and we exit. The github-router proxy watches the
// bridge.json discovery file; a vanished port means the bridge is gone.
//
// Wire protocol (shared with the extension's background.ts):
//
//   request:  { id: string, tool: string, args: Record<string, unknown> }
//   response: { id: string, ok: true,  data: unknown }
//          or { id: string, ok: false, error: string, code?: string }
//
// The bridge is a transparent forwarder between the WS (github-router
// side) and the native-messaging stdio (browser side). It does NOT
// translate the schema — same frame on both sides. The translation
// would only invite drift; the dispatcher and the extension can speak
// the same dialect.
//
// SECURITY: localhost-only bind, bearer-token auth on every WS frame,
// random port + nonce written to a per-user discovery file
// (`<APP_DIR>/browser-mcp/bridge.json`) with mode 0o600 (POSIX) so a
// sibling process can't impersonate the proxy. See Phase 3's
// install-check.ts for the dispatcher side.

import { randomBytes, randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs"
import { createServer } from "node:http"
import { platform, tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"

import type { Socket } from "node:net"

// Lazy import to keep startup fast and let the bridge crash with a
// clear error if ws is missing rather than a cryptic ESM resolution
// failure deep in some dependency tree.
import { WebSocketServer, type WebSocket } from "ws"

// Path resolution lives in a tiny sibling module so the bridge and the
// install-check resolve `bridge.json` identically — see the comment in
// `bridge-paths.ts` for the historical win32-divergence bug.
import { discoveryPath } from "../lib/browser-mcp/bridge-paths"

// Pending-entry management: tracks in-flight requests from the WS client
// to the browser extension, with per-entry TTL timers so entries are
// cleaned up even when the extension hangs (MV3 SW dormancy, tab crash).
import { pendingAdd, pendingDropClient, pendingResolve } from "./pending"

// Early-boot trace: write a line to a debug log whenever the bridge
// process starts. Native-messaging hosts run under the browser so we
// can't see their stdout/stderr by default; this trace file is the
// fastest way to confirm "Chrome actually invoked the launcher and
// the bridge actually started" when debugging install issues.
try {
  const debugLog = path.join(tmpdir(), "github-router-bridge-boot.log")
  appendFileSync(
    debugLog,
    `${new Date().toISOString()} pid=${process.pid} argv=${JSON.stringify(process.argv)}\n`,
  )
} catch {
  // ignore — diagnostics should never crash boot
}

const HEARTBEAT_MS = 5000
const HEARTBEAT_MISS_LIMIT = 3
// Per-entry TTL for pending requests. Mirrors the dispatcher-side maxMs for
// the longest tool (browser_download: 300 000 ms). Entries not resolved
// within this window — because the extension hung or a tab crashed — are
// forcibly resolved with a structured timeout error so the dispatcher and
// the pending Map don't leak for the lifetime of a long proxy session.
const PENDING_TTL_MS = 300_000

type BridgeRequest = {
  id: string
  tool: string
  args: Record<string, unknown>
}

type BridgeResponse =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: string; code?: string }

type WsRequest = BridgeRequest | { id: string; type: "__heartbeat__" }

interface BridgeDiscoveryFile {
  pid: number
  port: number
  token: string
  startedAt: number
}

function writeDiscoveryFile(payload: BridgeDiscoveryFile): void {
  const file = discoveryPath()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf8")
  if (platform() !== "win32") {
    try {
      chmodSync(file, 0o600)
    } catch {
      // Windows file ACL via Node is fragile; the OS-level Local user
      // dir (`%LOCALAPPDATA%`) is already user-scoped. Mode is moot.
    }
  }
}

// ---------------------------------------------------------------------
// Native-messaging stdio framing
// ---------------------------------------------------------------------
// Browser writes 4-byte little-endian length + JSON body to our stdin.
// We do the same on stdout. The reader is a small streaming state
// machine: collect bytes into a buffer, peel off complete frames as
// they accumulate.

let pendingFromBrowser = Buffer.alloc(0)
const fromBrowserListeners: Array<(msg: unknown) => void> = []

function emitFromBrowser(msg: unknown): void {
  for (const fn of fromBrowserListeners) {
    try {
      fn(msg)
    } catch (err) {
      console.error("[bridge] fromBrowser listener crashed:", err)
    }
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  pendingFromBrowser = Buffer.concat([pendingFromBrowser, chunk])
  while (pendingFromBrowser.length >= 4) {
    const len = pendingFromBrowser.readUInt32LE(0)
    if (pendingFromBrowser.length < 4 + len) break
    const body = pendingFromBrowser.subarray(4, 4 + len).toString("utf8")
    pendingFromBrowser = pendingFromBrowser.subarray(4 + len)
    try {
      emitFromBrowser(JSON.parse(body))
    } catch (err) {
      console.error("[bridge] failed to parse frame from browser:", err)
    }
  }
})

process.stdin.on("end", () => {
  // Browser disconnected stdin. MV3 SWs are torn down between events,
  // so transient disconnects are NORMAL and must not kill the bridge —
  // any subsequent SW spin-up calls connectNative again, which would
  // spawn a SECOND bridge if we exited here. Instead we keep running
  // for as long as a WS client is connected (the github-router
  // dispatcher) so in-flight tool calls don't get stranded. After all
  // WS clients drop AND stdin is still closed past a grace window, we
  // exit so a permanently-closed browser frees the process.
  scheduleIdleExit()
})

let idleExitTimer: ReturnType<typeof setTimeout> | undefined
function scheduleIdleExit(): void {
  if (idleExitTimer) return
  idleExitTimer = setTimeout(() => {
    if (wss.clients.size === 0) {
      process.exit(0)
    }
    idleExitTimer = undefined
    // Re-arm — a WS client is still hanging on, so check again later.
    scheduleIdleExit()
  }, 60_000)
}

function sendToBrowser(msg: unknown): void {
  const body = Buffer.from(JSON.stringify(msg), "utf8")
  const frame = Buffer.alloc(4 + body.length)
  frame.writeUInt32LE(body.length, 0)
  body.copy(frame, 4)
  process.stdout.write(frame)
}

// ---------------------------------------------------------------------
// WS server (github-router proxy side)
// ---------------------------------------------------------------------

const token = randomBytes(32).toString("hex")
let extensionLoadedVersion: string | undefined
const httpServer = createServer((req, res) => {
  // Tiny health endpoint so the dispatcher can probe without opening a
  // WS. Bearer-token auth applies here too — leaking "yes the bridge
  // is running" to a sibling process is harmless but matching the WS
  // policy keeps the surface uniform.
  const auth = req.headers.authorization ?? ""
  if (auth !== `Bearer ${token}`) {
    res.statusCode = 401
    res.end("unauthorized")
    return
  }
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json")
    res.end(
      JSON.stringify({
        ok: true,
        pid: process.pid,
        extension_connected: extensionConnected(),
        extension_loaded_version: extensionLoadedVersion,
      }),
    )
    return
  }
  if (req.url === "/reload" && req.method === "POST") {
    // Triggers chrome.runtime.reload() in the extension via a control
    // frame. Pre-flight uses this when the loaded extension version is
    // stale relative to the version stamped into
    // dist/browser-ext/manifest.json. After the extension reloads, a
    // fresh extension SW connects via NMH and Chrome spawns a NEW
    // bridge process; pre-flight then re-reads the discovery file to
    // probe the new bridge.
    try {
      sendToBrowser({ type: "__reload__" })
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      res.statusCode = 500
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }
    return
  }
  res.statusCode = 404
  res.end("not found")
})

const wss = new WebSocketServer({ noServer: true })

httpServer.on("upgrade", (req, socket: Socket, head) => {
  const auth = req.headers.authorization ?? ""
  if (auth !== `Bearer ${token}`) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleWsConnection(ws)
  })
})

// Pending requests are now managed by pending.ts (with per-entry TTL timers).

function handleWsConnection(ws: WebSocket): void {
  let alive = true
  let misses = 0
  const heartbeat = setInterval(() => {
    if (!alive) {
      misses++
      if (misses >= HEARTBEAT_MISS_LIMIT) {
        clearInterval(heartbeat)
        try {
          ws.terminate()
        } catch {
          // Closing a stale socket can throw; ignore.
        }
      }
    }
    alive = false
    try {
      ws.ping()
    } catch {
      // Ping on a half-closed socket — let onclose handle teardown.
    }
  }, HEARTBEAT_MS)
  ws.on("pong", () => {
    alive = true
    misses = 0
  })
  ws.on("message", (data) => {
    let msg: WsRequest
    try {
      msg = JSON.parse(data.toString("utf8")) as WsRequest
    } catch {
      return
    }
    if ("type" in msg && msg.type === "__heartbeat__") {
      // Application-layer heartbeat in addition to WS ping/pong, for
      // proxies / wrappers that swallow control frames.
      ws.send(JSON.stringify({ id: msg.id, ok: true, data: { pong: true } }))
      return
    }
    if (typeof msg.id !== "string" || typeof msg.tool !== "string") return
    pendingAdd(
      msg.id,
      ws,
      PENDING_TTL_MS,
      (resp) => ws.send(JSON.stringify(resp)),
    )
    sendToBrowser(msg)
  })
  ws.on("close", () => {
    clearInterval(heartbeat)
    // Drop any pending requests bound to this client so we don't leak
    // memory if the dispatcher disconnects mid-flight.
    pendingDropClient(ws)
  })
}

let lastBrowserContactMs = 0
function extensionConnected(): boolean {
  // The browser opens the NMH connection at extension load; until then
  // we never see any inbound frames. After the first inbound frame, we
  // assume the extension is connected until process exit.
  return lastBrowserContactMs > 0
}

fromBrowserListeners.push((msg) => {
  lastBrowserContactMs = Date.now()
  // Hello frame from the extension carries chrome.runtime.getManifest()
  // .version. Pre-flight on the dispatcher side compares this against
  // the version stamped into dist/browser-ext/manifest.json at build
  // time to detect when a loaded extension is stale (package was
  // updated after Chrome loaded the extension).
  if (
    msg
    && typeof msg === "object"
    && (msg as { type?: unknown }).type === "__hello__"
    && typeof (msg as { version?: unknown }).version === "string"
  ) {
    extensionLoadedVersion = (msg as { version: string }).version
    return
  }
  const r = msg as BridgeResponse
  if (typeof r.id !== "string") return
  pendingResolve(r.id, r)
})

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

httpServer.listen(0, "127.0.0.1", () => {
  const addr = httpServer.address()
  if (!addr || typeof addr === "string") {
    console.error("[bridge] failed to bind WS server")
    process.exit(1)
    return
  }
  writeDiscoveryFile({
    pid: process.pid,
    port: addr.port,
    token,
    startedAt: Date.now(),
  })
  // Optional liveness ping back to the browser so the extension's
  // onMessage handler fires once on boot and the extension knows we're
  // here even if the dispatcher hasn't sent anything yet.
  sendToBrowser({ id: randomUUID(), tool: "__ping__", args: {} })
})

// Defensive: surface unexpected errors instead of dying silently.
// Without this an uncaught exception in a listener kills the bridge
// silently and the dispatcher sees "no port" with no clue why.
process.on("uncaughtException", (err) => {
  console.error("[bridge] uncaught exception:", err)
})
process.on("unhandledRejection", (err) => {
  console.error("[bridge] unhandled rejection:", err)
})
