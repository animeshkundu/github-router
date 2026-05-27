// native-host-installer.ts — writes the per-OS native-messaging host
// manifest and (on Windows) the registry key Chrome / Edge use to
// locate the bridge launcher.
//
// What gets installed:
//
// - Bridge launcher shim: `.bat` (Windows) or `.sh` (POSIX) that
//   invokes `node <abs path to dist/browser-bridge/index.js>`. Lives in
//   `<APP_DIR>/browser-mcp/launcher.{bat,sh}`.
// - NMH host manifest JSON containing `{name, description, path, type:
//   "stdio", allowed_origins: ["chrome-extension://<our-stable-id>/"]}`.
//   Path varies by OS + browser; see tables in the design doc.
// - Windows only: registry value at
//   `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.githubrouter.browser`
//   (REG_SZ pointing at the manifest JSON path). Plus the parallel
//   Microsoft\Edge\... key when Edge is detected.
//
// HKCU only — no admin needed. PowerShell-free (uses reg.exe).
//
// Stable extension ID: derived from the fixed RSA pubkey embedded in
// the extension's manifest.json `key` field. Until the extension is
// loaded once, we don't know the ID for sure (Chrome computes it from
// the key at load time). We hardcode the value below — computed from
// the same pubkey via the standard derivation
// (https://developer.chrome.com/docs/extensions/reference/manifest/key).
// See computeExtensionIdFromKey() for the algorithm; in dev mode the
// installer recomputes from the manifest to catch a key change at
// development time.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { PATHS } from "~/lib/paths"

import type { SupportedBrowser } from "./browser-detect"

const NMH_HOST_ID = "com.githubrouter.browser"

interface NativeHostManifestPayload {
  name: string
  description: string
  path: string
  type: "stdio"
  allowed_origins: ReadonlyArray<string>
}

// ---------------------------------------------------------------------
// Stable extension ID
// ---------------------------------------------------------------------

/**
 * Compute the deterministic 32-char chrome-extension ID from the
 * base64-DER-encoded RSA public key in the extension's manifest.json
 * `key` field. Chrome's derivation:
 *
 *   1. base64-decode the key into DER bytes.
 *   2. SHA-256 the bytes.
 *   3. Take the first 16 bytes of the digest as 32 hex chars.
 *   4. Map each hex digit VALUE (0..15) to a letter (a..p). hex value
 *      0 → 'a', 1 → 'b', …, 15 → 'p'. The result is 32 chars long.
 *
 * See https://developer.chrome.com/docs/extensions/reference/manifest/key
 * for the spec.
 */
export function computeExtensionIdFromKey(keyB64: string): string {
  const der = Buffer.from(keyB64, "base64")
  const digest = createHash("sha256").update(der).digest()
  const hex = digest.subarray(0, 16).toString("hex")
  const aCode = "a".charCodeAt(0)
  let out = ""
  for (let i = 0; i < hex.length; i++) {
    out += String.fromCharCode(aCode + parseInt(hex[i], 16))
  }
  return out
}

function readManifestKey(): string {
  // Tries dist first (installed npm package layout) then src (dev /
  // running from a checkout). Either path works.
  const candidates = [
    path.resolve(extensionDir(), "manifest.json"),
  ]
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, "utf8")
      const parsed = JSON.parse(raw) as { key?: string }
      if (typeof parsed.key === "string") return parsed.key
    } catch {
      // Try the next path.
    }
  }
  throw new Error(
    `native-host-installer: could not read manifest.json from ${candidates.join(", ")}`,
  )
}

/**
 * Walk up from a starting directory looking for the github-router
 * package.json. Returns the package root or undefined if not found
 * within `maxHops` levels.
 */
function findPackageRoot(startDir: string, maxHops = 10): string | undefined {
  let cur = startDir
  for (let i = 0; i < maxHops; i++) {
    try {
      const pkgPath = path.join(cur, "package.json")
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string }
      if (pkg.name && pkg.name.includes("github-router")) {
        return cur
      }
    } catch {
      // Not here; walk up.
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

/**
 * Resolve the github-router package root. Uses two sources in order:
 *   1. process.argv[1] — the entrypoint script, walks up from there.
 *   2. import.meta.url of THIS module, walks up from there.
 *   3. process.cwd() as last resort.
 *
 * Robust across bun (src/main.ts) and node (dist/main.js) launch paths.
 */
function packageRoot(): string {
  // Defensive guards: some test suites mock `process.argv` to
  // undefined or to an empty array. Treat any non-string entry as
  // "absent" rather than crashing the import.
  const entryPath =
    typeof process?.argv?.[1] === "string" ? process.argv[1] : undefined
  if (entryPath) {
    const fromEntry = findPackageRoot(path.dirname(entryPath))
    if (fromEntry) return fromEntry
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const fromHere = findPackageRoot(here)
    if (fromHere) return fromHere
  } catch {
    // ignore
  }
  return process?.cwd?.() ?? "."
}

/**
 * Absolute path to the extension's source directory. Layouts:
 *
 *   - Installed via npm: `<package>/dist/browser-ext/` (the published
 *     tarball ships only `dist/`, see package.json "files"). The build
 *     step copies `src/browser-ext/` → `dist/browser-ext/` so the
 *     unpacked extension is available to users.
 *   - Running from this repo: dist/browser-ext/ if it exists (after
 *     `bun run build`), else src/browser-ext/ for fresh-clone-pre-build.
 *
 * Override with `GH_ROUTER_BROWSER_EXT_DIR=<abs path>` for development
 * (lets you point at a working copy of the extension you're editing
 * without rebuilding between iterations).
 */
export function extensionDir(): string {
  const override = process.env.GH_ROUTER_BROWSER_EXT_DIR
  if (override && override.length > 0) return override
  const root = packageRoot()
  const distExt = path.join(root, "dist", "browser-ext")
  try {
    if (readFileSync(path.join(distExt, "manifest.json")).length > 0) {
      return distExt
    }
  } catch {
    // dist/browser-ext not built yet — fall back to src/.
  }
  return path.join(root, "src", "browser-ext")
}

/** Absolute path to the bundled bridge entrypoint. */
export function bridgeBundlePath(): string {
  return path.join(packageRoot(), "dist", "browser-bridge", "index.js")
}

// ---------------------------------------------------------------------
// Launcher shim — the single executable the NMH manifest's `path` field
// points at. Wraps `node <bridge.js>` so it runs under whatever node
// the user has on PATH; Bun on PATH works too because the bridge is
// pure ESM and node-compatible.
// ---------------------------------------------------------------------

function appBrowserMcpDir(): string {
  const dir = path.join(PATHS.APP_DIR, "browser-mcp")
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Pick a runtime interpreter for the bridge. The bridge uses Node's
 * binary-stdin framing for native messaging which Bun handles
 * differently (Bun closes the bridge prematurely as soon as anything
 * unexpected lands on stdin). So prefer `node` when available;
 * fall back to `process.execPath` (which may be bun or a packaged
 * binary) only if node isn't on PATH.
 */
function resolveBridgeInterpreter(): string {
  const probeCmd = platform() === "win32" ? "where" : "which"
  try {
    const out = execFileSync(probeCmd, ["node"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      windowsHide: true,
    })
      .toString()
      .trim()
      .split(/\r?\n/)[0]
    if (out) return out
  } catch {
    // Fall through.
  }
  return process.execPath
}

export function writeLauncherShim(): string {
  const dir = appBrowserMcpDir()
  const bridgeJs = bridgeBundlePath()
  const interp = resolveBridgeInterpreter()
  if (platform() === "win32") {
    const batPath = path.join(dir, "launcher.bat")
    const content = `@echo off\r\n"${interp}" "${bridgeJs}" %*\r\n`
    writeFileSync(batPath, content, "utf8")
    return batPath
  }
  const shPath = path.join(dir, "launcher.sh")
  // exec replaces our process so signals propagate cleanly.
  const content = `#!/usr/bin/env bash\nexec "${interp}" "${bridgeJs}" "$@"\n`
  writeFileSync(shPath, content, { mode: 0o755 })
  try {
    chmodSync(shPath, 0o755)
  } catch {
    // Windows ignores chmod; POSIX should have honored the write-mode
    // arg above. Either way, executable bit set or this fails fast on
    // the next invocation.
  }
  return shPath
}

// ---------------------------------------------------------------------
// Per-OS NMH manifest paths
// ---------------------------------------------------------------------

interface NmhPathInfo {
  /** Absolute filesystem path the manifest JSON is written to. */
  manifestPath: string
  /**
   * Windows only: HKCU registry key the manifest JSON path is
   * registered under. Chrome / Edge read this key to locate the
   * manifest; on POSIX they discover by file path alone, so this is
   * undefined off-Windows.
   */
  registryKey?: string
}

function nmhPathsFor(browser: SupportedBrowser): NmhPathInfo {
  switch (platform()) {
    case "win32": {
      const local = process.env.LOCALAPPDATA
      const base = local
        ? path.join(local, "github-router", "browser-mcp")
        : path.join(homedir(), "AppData", "Local", "github-router", "browser-mcp")
      mkdirSync(base, { recursive: true })
      const manifestPath = path.join(base, `${NMH_HOST_ID}.json`)
      const registryKey =
        browser === "chrome"
          ? `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NMH_HOST_ID}`
          : `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NMH_HOST_ID}`
      return { manifestPath, registryKey }
    }
    case "darwin": {
      const base =
        browser === "chrome"
          ? path.join(
              homedir(),
              "Library",
              "Application Support",
              "Google",
              "Chrome",
              "NativeMessagingHosts",
            )
          : path.join(
              homedir(),
              "Library",
              "Application Support",
              "Microsoft Edge",
              "NativeMessagingHosts",
            )
      mkdirSync(base, { recursive: true })
      return { manifestPath: path.join(base, `${NMH_HOST_ID}.json`) }
    }
    default: {
      const base =
        browser === "chrome"
          ? path.join(homedir(), ".config", "google-chrome", "NativeMessagingHosts")
          : path.join(homedir(), ".config", "microsoft-edge", "NativeMessagingHosts")
      mkdirSync(base, { recursive: true })
      return { manifestPath: path.join(base, `${NMH_HOST_ID}.json`) }
    }
  }
}

/**
 * Write the NMH manifest + (Windows) registry key for a given browser.
 * Returns the manifest path written; throws if any step fails (caller
 * surfaces as part of install_required.reason).
 */
export function installNativeHostFor(browser: SupportedBrowser): string {
  const launcher = writeLauncherShim()
  const extId = computeExtensionIdFromKey(readManifestKey())
  const manifest: NativeHostManifestPayload = {
    name: NMH_HOST_ID,
    description: "github-router browser bridge",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extId}/`],
  }
  const { manifestPath, registryKey } = nmhPathsFor(browser)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8")
  if (platform() !== "win32") {
    try {
      chmodSync(manifestPath, 0o644)
    } catch {
      // Windows path doesn't honor POSIX mode; harmless.
    }
  }
  if (registryKey) {
    // reg.exe is in System32 / always on PATH on Windows. HKCU writes
    // require no admin. /f forces overwrite without prompt.
    execFileSync(
      "reg.exe",
      ["add", registryKey, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"],
      { windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
    )
  }
  return manifestPath
}

/**
 * Install the NMH manifest for every supported browser detected on
 * this host. Returns the list of (browser, manifestPath) tuples
 * actually written so the install_required response can report what
 * auto-installed.
 */
export function installNativeHostForAll(
  browsers: ReadonlyArray<SupportedBrowser>,
): ReadonlyArray<{ browser: SupportedBrowser; manifestPath: string }> {
  const results: Array<{ browser: SupportedBrowser; manifestPath: string }> = []
  for (const b of browsers) {
    try {
      const manifestPath = installNativeHostFor(b)
      results.push({ browser: b, manifestPath })
    } catch (err) {
      console.warn(
        `[browser-mcp] failed to install NMH manifest for ${b}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
  return results
}

export const __NMH_HOST_ID_FOR_TESTS = NMH_HOST_ID
