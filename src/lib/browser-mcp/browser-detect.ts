import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import process from "node:process"

/**
 * Per-platform Chrome / Edge installation probes. The browser-control
 * MCP tools are dormant-registered behind two gates: the operator's
 * `--browse` flag AND a positive result from `hasSupportedBrowserInstalled()`.
 * Without at least one supported browser on disk there's nothing for
 * the bridge to attach to, so the tools stay invisible in `tools/list`
 * rather than fail at call-time.
 *
 * Detection is intentionally permissive — any positive signal that
 * Chrome or Edge is installed wins. We don't validate version or check
 * that a browser is currently running; the bridge supervisor handles
 * the live-attach concerns separately.
 *
 * Result is cached for the proxy lifetime; a user installing a browser
 * mid-session needs to restart the proxy to surface the tools.
 */
export type SupportedBrowser = "chrome" | "edge"

let cached: ReadonlyArray<SupportedBrowser> | undefined

function probeWindows(): Array<SupportedBrowser> {
  const found: Array<SupportedBrowser> = []
  // App Paths registry key — the canonical "is this binary installed" probe
  // on Windows. `reg query` is in System32 and needs no admin. We squelch
  // stderr; a missing key produces a non-zero exit which we treat as absent.
  const probe = (subkey: string): boolean => {
    try {
      execFileSync(
        "reg.exe",
        ["query", `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${subkey}`, "/ve"],
        { windowsHide: true, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
      )
      return true
    } catch {
      try {
        execFileSync(
          "reg.exe",
          ["query", `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${subkey}`, "/ve"],
          { windowsHide: true, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
        )
        return true
      } catch {
        return false
      }
    }
  }
  if (probe("chrome.exe")) found.push("chrome")
  if (probe("msedge.exe")) found.push("edge")
  // Final fallback: literal paths under Program Files / LocalAppData. Per-user
  // installs land in LocalAppData; system installs in Program Files. Edge ships
  // pre-installed on Windows 11 so the literal-path fallback usually catches it.
  if (!found.includes("chrome")) {
    const localApp = process.env.LOCALAPPDATA
    const pf = process.env["PROGRAMFILES"]
    const pf86 = process.env["PROGRAMFILES(X86)"]
    const candidates = [
      localApp ? path.join(localApp, "Google", "Chrome", "Application", "chrome.exe") : undefined,
      pf ? path.join(pf, "Google", "Chrome", "Application", "chrome.exe") : undefined,
      pf86 ? path.join(pf86, "Google", "Chrome", "Application", "chrome.exe") : undefined,
    ].filter((p): p is string => typeof p === "string")
    if (candidates.some(existsSync)) found.push("chrome")
  }
  if (!found.includes("edge")) {
    const pf86 = process.env["PROGRAMFILES(X86)"]
    const pf = process.env["PROGRAMFILES"]
    const candidates = [
      pf86 ? path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
      pf ? path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
    ].filter((p): p is string => typeof p === "string")
    if (candidates.some(existsSync)) found.push("edge")
  }
  return found
}

function probeMacOS(): Array<SupportedBrowser> {
  const found: Array<SupportedBrowser> = []
  if (existsSync("/Applications/Google Chrome.app")) found.push("chrome")
  if (existsSync("/Applications/Microsoft Edge.app")) found.push("edge")
  return found
}

function probeLinux(): Array<SupportedBrowser> {
  const found: Array<SupportedBrowser> = []
  const which = (cmd: string): boolean => {
    try {
      execFileSync("which", [cmd], {
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      })
      return true
    } catch {
      return false
    }
  }
  if (
    which("google-chrome") ||
    which("google-chrome-stable") ||
    which("chromium") ||
    which("chromium-browser")
  ) {
    found.push("chrome")
  }
  if (which("microsoft-edge") || which("microsoft-edge-stable")) {
    found.push("edge")
  }
  return found
}

/**
 * Returns the supported browsers detected on this host. Result is
 * cached on first call; restart the proxy to re-detect after a fresh
 * install.
 */
export function detectSupportedBrowsers(): ReadonlyArray<SupportedBrowser> {
  if (cached !== undefined) return cached
  let found: Array<SupportedBrowser>
  switch (process.platform) {
    case "win32":
      found = probeWindows()
      break
    case "darwin":
      found = probeMacOS()
      break
    default:
      found = probeLinux()
      break
  }
  cached = Object.freeze(found)
  return cached
}

/** Convenience: true iff Chrome OR Edge is detected. */
export function hasSupportedBrowserInstalled(): boolean {
  return detectSupportedBrowsers().length > 0
}

/**
 * Reset the cache. Test-only — production code should restart the proxy
 * to re-detect.
 */
export function _resetSupportedBrowserCache(): void {
  cached = undefined
}
