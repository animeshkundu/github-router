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

export interface InstallRequiredPayload {
  install_required: true
  reason: InstallReason
  auto_installed: ReadonlyArray<string>
  manual_steps: {
    chrome_web_store_url?: string
    edge_addons_url?: string
    load_unpacked_dir: string
    expected_extension_id: string
    instructions: string
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

function buildInstallRequired(
  reason: InstallReason,
  autoInstalled: ReadonlyArray<string>,
): InstallRequiredPayload {
  return {
    install_required: true,
    reason,
    auto_installed: autoInstalled,
    manual_steps: {
      load_unpacked_dir: extensionDir(),
      expected_extension_id: loadStableExtensionId(),
      instructions:
        reason === "no_supported_browser"
          ? "No Chrome or Edge installation was detected on this host. Install one and restart the github-router proxy."
          : reason === "bridge_bundle_missing"
            ? "The bridge bundle is missing. Run `bun run build` from the github-router checkout to produce dist/browser-bridge/index.js, then retry."
            : "Open chrome://extensions (or edge://extensions), enable Developer Mode, click 'Load unpacked', and select the load_unpacked_dir above. Then retry this tool call.",
    },
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
