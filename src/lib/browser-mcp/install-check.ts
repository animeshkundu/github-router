// install-check.ts — pre-flight every browser_* tool runs to verify
// the bridge / extension is wired up. When something's missing, the
// dispatcher returns a structured `install_required` payload (with
// `isError: true`) so the model can act on it.
//
// Detection order (cheapest first):
//
//   1. Read the bridge's discovery file at `<APP_DIR>/browser-mcp/bridge.json`.
//      Absent → bridge not running.
//   2. Probe `GET http://127.0.0.1:<port>/health` with the file's
//      bearer token, 500 ms timeout. Non-200 → bridge dead, file
//      stale. Health JSON includes `extension_connected`; if false,
//      the bridge is up but no extension has connected over native
//      messaging — the user hasn't loaded the extension yet.
//
// The dispatcher CANNOT spawn the bridge itself — the bridge is
// browser-spawned (Chrome calls connectNative, which fork-execs the
// host process). All we can do on the install side is write the NMH
// manifest + (Windows) registry entries so the next time the user
// loads the extension, Chrome can find and spawn the bridge.

import { readFileSync } from "node:fs"
import path from "node:path"

import { getPackageVersion } from "../version"
import {
  detectSupportedBrowsers,
  type SupportedBrowser,
} from "./browser-detect"
import { discoveryPath } from "./bridge-paths"
import {
  bridgeBundlePath,
  computeExtensionIdFromKey,
  extensionDir,
  installNativeHostForAll,
} from "./native-host-installer"

export interface BridgeDiscovery {
  pid: number
  port: number
  token: string
  startedAt: number
}

export type InstallReason =
  | "no_supported_browser"
  | "bridge_bundle_missing"
  | "bridge_not_running"
  | "extension_not_loaded"
  | "extension_outdated"

export interface InstallRequiredPayload {
  install_required: true
  reason: InstallReason
  auto_installed: ReadonlyArray<string>
  /**
   * The github-router package version this proxy is running. Surfaced
   * in every install_required so crash reports / model-issued bug
   * reports can identify which build emitted the payload, even when
   * the user's stale extension is reporting a different (older)
   * version of the extension manifest.
   */
  proxy_version: string
  manual_steps: {
    chrome_web_store_url?: string
    edge_addons_url?: string
    load_unpacked_dir: string
    expected_extension_id: string
    instructions: string
  }
  /**
   * Populated only when reason is `extension_outdated`. Carries the
   * version currently loaded by the browser vs. the version stamped
   * into dist/browser-ext/manifest.json at build, so the model can
   * surface both numbers to the user when explaining why a reload is
   * needed.
   */
  version_mismatch?: {
    loaded: string
    expected: string
  }
}

export interface BridgeReady {
  install_required: false
  port: number
  token: string
  pid: number
}

export function readBridgeDiscovery(): BridgeDiscovery | undefined {
  try {
    const raw = readFileSync(discoveryPath(), "utf8")
    const parsed = JSON.parse(raw) as Partial<BridgeDiscovery>
    if (
      typeof parsed.pid === "number"
      && typeof parsed.port === "number"
      && typeof parsed.token === "string"
      && typeof parsed.startedAt === "number"
    ) {
      return parsed as BridgeDiscovery
    }
  } catch {
    // Missing or malformed file → no bridge.
  }
  return undefined
}

interface HealthResponse {
  ok?: boolean
  pid?: number
  extension_connected?: boolean
  extension_loaded_version?: string
}

async function probeHealth(
  port: number,
  token: string,
  timeoutMs = 500,
): Promise<HealthResponse | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (!res.ok) return undefined
    return (await res.json()) as HealthResponse
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

function bridgeBundleExists(): boolean {
  try {
    // statSync is more efficient than readFileSync for an existence
    // check, but we already use readFileSync elsewhere for JSON parses
    // — keep the call shape uniform.
    readFileSync(bridgeBundlePath())
    return true
  } catch {
    return false
  }
}

function loadStableExtensionId(): string {
  try {
    const manifestPath = path.join(extensionDir(), "manifest.json")
    const raw = readFileSync(manifestPath, "utf8")
    const parsed = JSON.parse(raw) as { key?: string }
    if (typeof parsed.key === "string") {
      return computeExtensionIdFromKey(parsed.key)
    }
  } catch {
    // fall through
  }
  return "unknown"
}

/**
 * Reads the `version` field from the on-disk extension manifest in
 * extensionDir(). Returns undefined if the file is missing, unreadable,
 * or doesn't have a string version. Used to detect when the loaded
 * extension is stale relative to a freshly-updated package.
 */
function loadExpectedExtensionVersion(): string | undefined {
  try {
    const manifestPath = path.join(extensionDir(), "manifest.json")
    const raw = readFileSync(manifestPath, "utf8")
    const parsed = JSON.parse(raw) as { version?: unknown }
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version
    }
  } catch {
    // fall through
  }
  return undefined
}

/**
 * Source-checkout dev sentinel — see scripts/copy-browser-ext.ts. When
 * extensionDir() resolves to src/browser-ext/ (dev iteration via
 * GH_ROUTER_BROWSER_EXT_DIR, or the dist fallback when the package
 * isn't built), the version is "0.0.0" and the auto-reload check is a
 * no-op: both sides agree, no mismatch, no reload triggered.
 */
const DEV_VERSION_SENTINEL = "0.0.0"

/**
 * Track which `(extensionId, expectedVersion)` pairs we've already
 * tried to auto-reload in this process. Prevents an infinite reload
 * loop if the on-disk version somehow stays ahead of what the browser
 * picks up (e.g. Chrome disabled the extension after reload because
 * a new permission was added — the loaded version stays stale).
 */
const attemptedReloads = new Set<string>()

/**
 * Send POST /reload to the bridge — triggers __reload__ control frame
 * over native messaging, which the extension's handler dispatches into
 * chrome.runtime.reload(). After this returns, the OLD bridge process
 * may still be running (its WS clients haven't dropped); the NEW
 * bridge spawned by Chrome on extension reconnect will overwrite the
 * discovery file.
 */
async function postReload(
  port: number,
  token: string,
  timeoutMs = 1000,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/reload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * After triggering a reload, poll the discovery file + /health until
 * we see the expected extension version (success) or run out of time
 * (caller falls back to install_required). Re-reads the discovery file
 * each cycle because the bridge process changes — old bridge exits
 * after its grace window, new bridge writes a new discovery file with
 * new port/token/pid.
 */
async function pollUntilExtensionVersion(
  expectedVersion: string,
  maxWaitMs: number,
  intervalMs: number,
): Promise<BridgeDiscovery | undefined> {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const disc = readBridgeDiscovery()
    if (!disc) continue
    const health = await probeHealth(disc.port, disc.token, 500)
    if (
      health
      && health.ok
      && health.extension_connected
      && health.extension_loaded_version === expectedVersion
    ) {
      return disc
    }
  }
  return undefined
}

function buildInstallRequired(
  reason: InstallReason,
  autoInstalled: ReadonlyArray<string>,
  versionMismatch?: { loaded: string; expected: string },
): InstallRequiredPayload {
  const instructions = (() => {
    if (reason === "no_supported_browser") {
      return "No Chrome or Edge installation was detected on this host. Install one and restart the github-router proxy."
    }
    if (reason === "bridge_bundle_missing") {
      return "The bridge bundle is missing. Run `bun run build` from the github-router checkout to produce dist/browser-bridge/index.js, then retry."
    }
    if (reason === "extension_outdated" && versionMismatch) {
      return `Your loaded github-router browser extension is version ${versionMismatch.loaded} but the github-router package shipped version ${versionMismatch.expected}. Auto-reload was attempted and did not converge — Chrome likely disabled the extension because the new manifest declares new permissions. Open chrome://extensions (or edge://extensions), find the github-router extension card, click "Enable" if it's disabled, then click the reload arrow. Retry this tool call afterwards.`
    }
    return "Open chrome://extensions (or edge://extensions), enable Developer Mode, click 'Load unpacked', and select the load_unpacked_dir above. Then retry this tool call. If you just updated the github-router package, an extension already loaded may need to be reloaded — click the reload arrow on its card."
  })()
  return {
    install_required: true,
    reason,
    auto_installed: autoInstalled,
    proxy_version: getPackageVersion(),
    manual_steps: {
      load_unpacked_dir: extensionDir(),
      expected_extension_id: loadStableExtensionId(),
      instructions,
    },
    ...(versionMismatch ? { version_mismatch: versionMismatch } : {}),
  }
}

/**
 * Full pre-flight. Returns either `{install_required: false, port,
 * token, pid}` (bridge ready, extension connected) or an
 * `install_required` payload the dispatcher hands directly to the
 * model. Side effect: when reason is `extension_not_loaded`, attempts
 * to install the NMH manifest for every detected browser so that the
 * extension can connect immediately on load.
 *
 * Single-flight: concurrent calls share one in-flight Promise so that
 * `installNativeHostForAll` (which writes files and spawns reg.exe on
 * Windows) is called exactly once per check cycle, regardless of how
 * many browser_* tool calls arrive concurrently.
 */

// In-flight single-flight promise shared across concurrent callers.
let _inFlightReady: Promise<BridgeReady | InstallRequiredPayload> | undefined

/**
 * @internal — counts how many times _ensureBridgeReadyImpl has started.
 * Used by regression tests for the single-flight property (Bug #6).
 * Always 0 in production (only incremented when imported by tests).
 */
export let __implInvocationsForTests = 0

export async function ensureBridgeReady(): Promise<
  BridgeReady | InstallRequiredPayload
> {
  if (_inFlightReady) return _inFlightReady
  _inFlightReady = _ensureBridgeReadyImpl().finally(() => {
    _inFlightReady = undefined
  })
  return _inFlightReady
}

/** @internal — exported only for tests. Resets single-flight state between test cases. */
export function __resetEnsureBridgeReadyForTests(): void {
  _inFlightReady = undefined
  __implInvocationsForTests = 0
  attemptedReloads.clear()
}

async function _ensureBridgeReadyImpl(): Promise<
  BridgeReady | InstallRequiredPayload
> {
  __implInvocationsForTests++
  const browsers = detectSupportedBrowsers()
  if (browsers.length === 0) {
    return buildInstallRequired("no_supported_browser", [])
  }
  if (!bridgeBundleExists()) {
    return buildInstallRequired("bridge_bundle_missing", [])
  }

  // Pre-emptively install the NMH manifest for every detected browser
  // BEFORE we probe — that way the very first probe-failure response
  // already reports the manifests as auto-installed and the user only
  // needs to do the unpacked-load step.
  const installed = installNativeHostForAll(browsers)
  const autoInstalled = installed.flatMap((r) => [
    `nmh_manifest_${r.browser}`,
  ])

  const discovery = readBridgeDiscovery()
  if (!discovery) {
    return buildInstallRequired("bridge_not_running", autoInstalled)
  }
  const health = await probeHealth(discovery.port, discovery.token)
  if (!health || !health.ok) {
    return buildInstallRequired("bridge_not_running", autoInstalled)
  }
  if (!health.extension_connected) {
    return buildInstallRequired("extension_not_loaded", autoInstalled)
  }

  // Version-mismatch detection + auto-reload. Only fires when:
  //   - the loaded extension reported a version via __hello__ (older
  //     bridge versions don't echo this field — treat as opt-in),
  //   - the on-disk manifest carries a string version,
  //   - neither side is the dev sentinel "0.0.0" (source-checkout
  //     loads are intentionally skipped).
  const expectedVersion = loadExpectedExtensionVersion()
  const loadedVersion = health.extension_loaded_version
  const versionCheckable =
    typeof expectedVersion === "string"
    && typeof loadedVersion === "string"
    && expectedVersion !== DEV_VERSION_SENTINEL
    && loadedVersion !== DEV_VERSION_SENTINEL
  if (versionCheckable && expectedVersion !== loadedVersion) {
    const reloadKey = `${loadStableExtensionId()}::${expectedVersion}`
    if (attemptedReloads.has(reloadKey)) {
      return buildInstallRequired("extension_outdated", autoInstalled, {
        loaded: loadedVersion,
        expected: expectedVersion,
      })
    }
    attemptedReloads.add(reloadKey)
    const reloadOk = await postReload(discovery.port, discovery.token)
    if (!reloadOk) {
      return buildInstallRequired("extension_outdated", autoInstalled, {
        loaded: loadedVersion,
        expected: expectedVersion,
      })
    }
    // Poll for the new bridge (Chrome spawns a fresh process on
    // extension reconnect) reporting the expected version. ~3s total
    // is the right ceiling: an SW startup + native-messaging connect
    // + hello frame round-trip typically lands well under 1s; the
    // headroom absorbs slow disks and Windows AV scanning the new
    // process.
    const newDiscovery = await pollUntilExtensionVersion(
      expectedVersion,
      3000,
      150,
    )
    if (!newDiscovery) {
      return buildInstallRequired("extension_outdated", autoInstalled, {
        loaded: loadedVersion,
        expected: expectedVersion,
      })
    }
    return {
      install_required: false,
      port: newDiscovery.port,
      token: newDiscovery.token,
      pid: newDiscovery.pid,
    }
  }

  return {
    install_required: false,
    port: discovery.port,
    token: discovery.token,
    pid: discovery.pid,
  }
}

export function installRequiredToolResult(
  payload: InstallRequiredPayload,
): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  }
}

// Re-export for callers (tests, dispatcher) that want to surface the
// detected browser list without re-importing browser-detect.
export type { SupportedBrowser }
