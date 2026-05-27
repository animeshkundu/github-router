// Test harness for the browser-MCP end-to-end Playwright suite.
// Encapsulates the NMH manifest install/uninstall, browser launch with
// the extension loaded, bridge.json discovery, and a tiny RPC client
// for the bridge's WebSocket.
//
// Scope: macOS + Linux only for now (the test runs locally + on Ubuntu
// CI). Windows registry installation is exercised by a separate unit
// test (Phase 6) — the E2E harness skips Windows by checking
// process.platform and returning a no-op `unsupported()` from
// installNmhManifest.

import { createServer, type Server } from "node:http"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, platform, tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { type BrowserContext, chromium } from "playwright"
import WebSocket from "ws"

import {
  bridgeBundlePath,
  computeExtensionIdFromKey,
  extensionDir,
} from "../../src/lib/browser-mcp/native-host-installer"

const NMH_HOST_ID = "com.githubrouter.browser"

// ---------------------------------------------------------------------
// Extension ID — derived deterministically from the pinned manifest key
// so the NMH manifest's allowed_origins matches Chrome's runtime ID.
// ---------------------------------------------------------------------

let cachedExtensionId: string | undefined
export function stableExtensionId(): string {
  if (cachedExtensionId) return cachedExtensionId
  const manifest = JSON.parse(
    readFileSync(path.join(extensionDir(), "manifest.json"), "utf8"),
  ) as { key?: string }
  if (typeof manifest.key !== "string") {
    throw new Error("harness: extension manifest.json has no key field")
  }
  cachedExtensionId = computeExtensionIdFromKey(manifest.key)
  return cachedExtensionId
}

// ---------------------------------------------------------------------
// NMH manifest install (POSIX only for the E2E harness)
// ---------------------------------------------------------------------

function nmhManifestPaths(): Array<string> {
  // Playwright ships "Chrome for Testing" (Google's official testing
  // build, branded "Google Chrome for Testing"), NOT vanilla Chromium
  // and NOT Google Chrome Stable. Each Chromium-family build reads
  // NMH manifests from its own per-product directory based on the
  // build's branding. We write to all three so the harness works for
  // any of them.
  if (platform() === "darwin") {
    const base = path.join(homedir(), "Library", "Application Support")
    return [
      // Playwright's binary (Google Chrome for Testing).
      path.join(base, "Google", "Chrome for Testing", "NativeMessagingHosts", `${NMH_HOST_ID}.json`),
      // Vanilla Chromium (if someone installs the OSS build).
      path.join(base, "Chromium", "NativeMessagingHosts", `${NMH_HOST_ID}.json`),
      // Real Google Chrome Stable (developer's local browser).
      path.join(base, "Google", "Chrome", "NativeMessagingHosts", `${NMH_HOST_ID}.json`),
    ]
  }
  // Linux
  const cfg = path.join(homedir(), ".config")
  return [
    // Playwright's Chrome for Testing uses this dir on Linux.
    path.join(cfg, "google-chrome-for-testing", "NativeMessagingHosts", `${NMH_HOST_ID}.json`),
    path.join(cfg, "chromium", "NativeMessagingHosts", `${NMH_HOST_ID}.json`),
    path.join(cfg, "google-chrome", "NativeMessagingHosts", `${NMH_HOST_ID}.json`),
  ]
}

interface NmhInstall {
  manifestPaths: ReadonlyArray<string>
  launcherPath: string
  uninstall: () => void
}

/**
 * Write the NMH manifest pointing at a launcher script that wraps
 * `node dist/browser-bridge/index.js`. Returns an uninstall fn that
 * deletes the manifest + launcher; caller MUST invoke in finally.
 *
 * Pass `userDataDir` when the test launches Chromium with a custom
 * --user-data-dir; we write a copy of the manifest into
 * `<userDataDir>/NativeMessagingHosts/` which is the lookup path
 * Playwright's "Google Chrome for Testing" build actually checks
 * (the system-wide `~/Library/Application Support/.../NativeMessagingHosts/`
 * dirs are also written for completeness so the harness works against
 * a developer's local Chrome too).
 */
export function installNmhManifest(opts: { userDataDir?: string } = {}): NmhInstall {
  if (platform() === "win32") {
    throw new Error("E2E harness: Windows path is exercised by unit tests, not this harness")
  }
  const extId = stableExtensionId()
  const bridgeJs = bridgeBundlePath()
  if (!existsSync(bridgeJs)) {
    throw new Error(
      `E2E harness: bridge bundle missing at ${bridgeJs}. Run \`bun run build\` first.`,
    )
  }
  // Launcher: a per-test .sh wrapper in a tmpdir so concurrent test
  // runs and the real github-router install don't fight over a shared
  // path. NMH manifest's `path` field points at it.
  //
  // Use `node` explicitly (not process.execPath) — bun does NOT handle
  // the bridge's binary-stdin framing the way node does and would
  // close the bridge prematurely. The harness assumes node is on PATH;
  // CI ensures this.
  const tmpRoot = mkdtemp("browser-mcp-e2e-")
  const launcherPath = path.join(tmpRoot, "launcher.sh")
  writeFileSync(
    launcherPath,
    `#!/usr/bin/env bash\nexec node "${bridgeJs}" "$@"\n`,
    { mode: 0o755 },
  )
  const manifest = {
    name: NMH_HOST_ID,
    description: "github-router browser bridge (test harness)",
    path: launcherPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extId}/`],
  }
  const allPaths: Array<string> = [...nmhManifestPaths()]
  if (opts.userDataDir) {
    allPaths.push(
      path.join(opts.userDataDir, "NativeMessagingHosts", `${NMH_HOST_ID}.json`),
    )
  }
  for (const mp of allPaths) {
    mkdirSync(path.dirname(mp), { recursive: true })
    writeFileSync(mp, JSON.stringify(manifest, null, 2), "utf8")
  }
  return {
    manifestPaths: allPaths,
    launcherPath,
    uninstall: () => {
      for (const mp of allPaths) {
        try {
          rmSync(mp, { force: true })
        } catch {
          // ignore
        }
      }
      try {
        rmSync(tmpRoot, { recursive: true, force: true })
      } catch {
        // ignore
      }
    },
  }
}

function mkdtemp(prefix: string): string {
  const dir = path.join(
    tmpdir(),
    `${prefix}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------
// Bridge discovery
// ---------------------------------------------------------------------

function bridgeDiscoveryPath(): string {
  if (platform() === "win32") {
    const local = process.env.LOCALAPPDATA
    const base = local
      ? path.join(local, "github-router")
      : path.join(homedir(), "AppData", "Local", "github-router")
    return path.join(base, "browser-mcp", "bridge.json")
  }
  return path.join(homedir(), ".local", "share", "github-router", "browser-mcp", "bridge.json")
}

export interface BridgeInfo {
  port: number
  token: string
  pid: number
}

export async function pollBridgeJson(timeoutMs = 10_000): Promise<BridgeInfo> {
  const deadline = Date.now() + timeoutMs
  const filePath = bridgeDiscoveryPath()
  // Always remove any stale bridge.json from a prior aborted run so
  // we don't read it as a false positive.
  try {
    rmSync(filePath, { force: true })
  } catch {
    // ignore
  }
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<BridgeInfo>
        if (
          typeof parsed.port === "number"
          && typeof parsed.token === "string"
          && typeof parsed.pid === "number"
        ) {
          return parsed as BridgeInfo
        }
      } catch {
        // Mid-write; retry.
      }
    }
    await sleep(100)
  }
  throw new Error(
    `harness: bridge.json did not appear at ${filePath} within ${timeoutMs}ms`,
  )
}

// ---------------------------------------------------------------------
// Tiny RPC client over the bridge's WebSocket
// ---------------------------------------------------------------------

export interface WsCall {
  ok: boolean
  data?: unknown
  error?: string
  code?: string
}

export interface WsClient {
  call: (tool: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<WsCall>
  close: () => void
}

export async function wsClient(info: BridgeInfo): Promise<WsClient> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${info.port}`, {
      headers: { authorization: `Bearer ${info.token}` },
    })
    socket.once("open", () => resolve(socket))
    socket.once("error", reject)
  })
  const pending = new Map<string, (msg: WsCall) => void>()
  ws.on("message", (raw) => {
    try {
      const parsed = JSON.parse(raw.toString()) as { id?: string } & WsCall
      if (typeof parsed.id === "string") {
        const resolver = pending.get(parsed.id)
        if (resolver) {
          pending.delete(parsed.id)
          resolver(parsed)
        }
      }
    } catch {
      // ignore
    }
  })
  return {
    call(tool, args, timeoutMs = 15_000) {
      return new Promise<WsCall>((resolve, reject) => {
        const id = `t-${Math.random().toString(36).slice(2, 10)}`
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`ws call ${tool} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(id, (msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
        ws.send(JSON.stringify({ id, tool, args }))
      })
    },
    close() {
      try {
        ws.close()
      } catch {
        // ignore
      }
    },
  }
}

// ---------------------------------------------------------------------
// Playwright browser launch
// ---------------------------------------------------------------------

export interface LaunchedBrowser {
  context: BrowserContext
  userDataDir: string
  cleanup: () => Promise<void>
}

export async function launchBrowserWithExtension(opts: { userDataDir?: string } = {}): Promise<LaunchedBrowser> {
  const userDataDir = opts.userDataDir ?? mkdtemp("browser-mcp-e2e-profile-")
  const extDir = extensionDir()
  // MV3 service workers need persistent context; --headless=new
  // enables true headless that still supports SWs + native messaging.
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      "--headless=new",
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  })
  return {
    context,
    userDataDir,
    cleanup: async () => {
      await context.close()
      try {
        rmSync(userDataDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    },
  }
}

/** Create a fresh test-profile dir without launching anything yet. */
export function createTestProfileDir(): string {
  return mkdtemp("browser-mcp-e2e-profile-")
}

// ---------------------------------------------------------------------
// Local HTTP server for fixture pages
// ---------------------------------------------------------------------

export interface FixtureServer {
  port: number
  base: string
  close: () => void
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const fixturesDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "fixtures",
    "browser-mcp",
  )
  const server: Server = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400
      res.end()
      return
    }
    const safe = req.url.replace(/^\//, "").replace(/[?#].*$/, "")
    const filePath = path.join(fixturesDir, safe || "page.html")
    if (!filePath.startsWith(fixturesDir)) {
      res.statusCode = 403
      res.end()
      return
    }
    try {
      const body = readFileSync(filePath)
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end(body)
    } catch {
      res.statusCode = 404
      res.end("not found")
    }
  })
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  )
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("fixture server: no address")
  return {
    port: addr.port,
    base: `http://127.0.0.1:${addr.port}`,
    close: () => server.close(),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
