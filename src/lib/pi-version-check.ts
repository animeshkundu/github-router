import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import consola from "consola"

import {
  resolveExecutable,
  runCommandCapture,
  runCommandVoid,
} from "./exec"
import { queueDetachedGlobalInstall } from "./self-update"
import { withInstallLock } from "./update-lock"

export const PI_NPM_PACKAGE = "@earendil-works/pi-coding-agent"
/** Minimum Pi version the `pi` launcher supports. */
export const PI_MIN_VERSION = "0.87.1"
const THROTTLE_HOURS = 1
const NPM_VIEW_TIMEOUT_MS = 5000
const PI_VERSION_TIMEOUT_MS = 3000
const NPM_INSTALL_TIMEOUT_MS = 300_000 // 5 min — pi pulls a larger tree than claude

interface PiVersionCheckCache {
  /** ISO timestamp of last check */
  checkedAt: string
  /** Installed version at last check */
  installedVersion: string | null
  /** Latest version on npm at last check */
  latestVersion: string | null
}

/** Path to the throttle cache. Created on demand. Separate file from the Claude check. */
function cacheFilePath(): string {
  return path.join(
    os.homedir(),
    ".local",
    "share",
    "github-router",
    "last-pi-update-check",
  )
}

async function readCache(): Promise<PiVersionCheckCache | null> {
  try {
    const raw = await fs.readFile(cacheFilePath(), "utf8")
    const parsed = JSON.parse(raw) as PiVersionCheckCache
    if (
      typeof parsed.checkedAt !== "string"
      || (parsed.installedVersion !== null
        && typeof parsed.installedVersion !== "string")
      || (parsed.latestVersion !== null
        && typeof parsed.latestVersion !== "string")
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

async function writeCache(cache: PiVersionCheckCache): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cacheFilePath()), { recursive: true })
    await fs.writeFile(cacheFilePath(), JSON.stringify(cache), {
      mode: 0o600,
    })
  } catch (err) {
    consola.debug("Failed to write pi version-check cache:", err)
  }
}

function shouldCheckNow(cache: PiVersionCheckCache | null): boolean {
  if (!cache) return true
  const lastCheck = new Date(cache.checkedAt).getTime()
  if (Number.isNaN(lastCheck)) return true
  const hoursSince = (Date.now() - lastCheck) / 1000 / 3600
  return hoursSince >= THROTTLE_HOURS
}

/**
 * Read the installed `pi` version. Returns null if pi is not on PATH
 * or the version probe fails.
 *
 * Windows-safe: `pi` may be a `.cmd` shim; resolved to an absolute path
 * (excluding the cwd) before invocation via the shared exec helper.
 */
export async function getInstalledPiVersion(): Promise<string | null> {
  const piPath = resolveExecutable("pi")
  if (!piPath) return null
  try {
    const { stdout, code } = await runCommandCapture(
      [piPath, "--version"],
      { timeoutMs: PI_VERSION_TIMEOUT_MS },
    )
    if (code !== 0) return null
    const match = stdout.match(/(\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/** Fetch the latest Pi version from npm. Null on network/npm failure. */
async function getLatestPiVersion(): Promise<string | null> {
  const npmPath = resolveExecutable("npm")
  if (!npmPath) return null
  try {
    const { stdout, code } = await runCommandCapture(
      [npmPath, "view", PI_NPM_PACKAGE, "version", "--silent"],
      { timeoutMs: NPM_VIEW_TIMEOUT_MS },
    )
    if (code !== 0) return null
    const v = stdout.trim()
    return /^\d+\.\d+\.\d+/.test(v) ? v : null
  } catch {
    return null
  }
}

/**
 * Compare two semver-shaped strings (leading X.Y.Z only). True when
 * `latest` is strictly higher than `installed`.
 */
export function isPiNewer(
  installed: string | null,
  latest: string | null,
): boolean {
  if (!installed || !latest) return false
  const a = installed.split(".").map((n) => parseInt(n, 10))
  const b = latest.split(".").map((n) => parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av < bv) return true
    if (av > bv) return false
  }
  return false
}

/** True when `version` satisfies the minimum Pi floor (>= PI_MIN_VERSION). */
export function meetsPiMinVersion(version: string | null): boolean {
  if (!version) return false
  return !isPiNewer(version, PI_MIN_VERSION)
}

export interface PiVersionCheckResult {
  /** Whether pi is on PATH at all */
  installed: boolean
  installedVersion: string | null
  latestVersion: string | null
  /** True if a newer version is available */
  needsUpdate: boolean
  /** True if the installed version is below the supported floor */
  needsMinUpgrade: boolean
  /** Whether the check was skipped (throttled or disabled) */
  skipped: boolean
  skipReason?: "throttled" | "disabled" | "no-npm" | "no-pi"
}

/** Run a version check (subject to throttle). Side-effect: updates the cache. */
export async function checkPiVersion(opts: {
  noCheck?: boolean
  force?: boolean
} = {}): Promise<PiVersionCheckResult> {
  if (opts.noCheck) {
    return {
      installed: false,
      installedVersion: null,
      latestVersion: null,
      needsUpdate: false,
      needsMinUpgrade: false,
      skipped: true,
      skipReason: "disabled",
    }
  }

  const cache = await readCache()
  if (!opts.force && !shouldCheckNow(cache)) {
    const installedVersion = cache?.installedVersion ?? null
    const latestVersion = cache?.latestVersion ?? null
    return {
      installed: installedVersion !== null,
      installedVersion,
      latestVersion,
      needsUpdate: isPiNewer(installedVersion, latestVersion),
      needsMinUpgrade: !meetsPiMinVersion(installedVersion),
      skipped: true,
      skipReason: "throttled",
    }
  }

  const installedVersion = await getInstalledPiVersion()
  if (installedVersion === null) {
    return {
      installed: false,
      installedVersion: null,
      latestVersion: null,
      needsUpdate: false,
      needsMinUpgrade: true,
      skipped: true,
      skipReason: "no-pi",
    }
  }

  const latestVersion = await getLatestPiVersion()
  await writeCache({
    checkedAt: new Date().toISOString(),
    installedVersion,
    latestVersion,
  })

  if (latestVersion === null) {
    return {
      installed: true,
      installedVersion,
      latestVersion: null,
      needsUpdate: false,
      needsMinUpgrade: !meetsPiMinVersion(installedVersion),
      skipped: true,
      skipReason: "no-npm",
    }
  }

  return {
    installed: true,
    installedVersion,
    latestVersion,
    needsUpdate: isPiNewer(installedVersion, latestVersion),
    needsMinUpgrade: !meetsPiMinVersion(installedVersion),
    skipped: false,
  }
}

/**
 * Install (or upgrade) Pi from npm under the cross-process install lock.
 * Returns `true` when this call performed the install, `false` when
 * another process holds the lock (caller skips — its install will land
 * for a later launch). Best-effort: throws on failure; callers fall
 * back to the installed version with a visible warning rather than
 * stranding the launch.
 */
export function updatePi(version: string, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
  const npmPath = resolveExecutable("npm")
  if (!npmPath) {
    throw new Error("npm not found on PATH; cannot install Pi automatically")
  }
  return withInstallLock("pi-install.lock", async () => {
    consola.info(`Installing ${PI_NPM_PACKAGE}@${version}...`)
    await runCommandVoid(
      [npmPath, "install", "-g", `${PI_NPM_PACKAGE}@${version}`],
      { timeoutMs: NPM_INSTALL_TIMEOUT_MS, signal: opts.signal },
    )
  })
}

/**
 * Blocking fresh install for when Pi is absent entirely. Installs
 * `@latest`, then force re-checks; throws when Pi still is not on PATH
 * (caller exits with the install command). Only used when there is no
 * usable Pi at all — the healthy path never blocks on npm.
 */
export async function ensurePiInstalled(opts: { signal?: AbortSignal } = {}): Promise<string> {
  const acquired = await updatePi("latest", opts)
  const retry = await checkPiVersion({ force: true })
  if (retry.installed && retry.installedVersion) return retry.installedVersion
  throw new Error(
    acquired
      ? "install did not place pi on PATH"
      : "another Pi install is already running; retry in a moment",
  )
}

/**
 * Fire-and-forget freshness refresh for a healthy Pi install. Never
 * blocks launch and never throws: on the throttled schedule it probes
 * npm for a newer Pi and, when one exists, queues a DETACHED post-exit
 * install (same pattern as the proxy self-update) so neither startup
 * nor the running session nor shutdown ever waits on npm. The
 * cross-process install lock serializes against concurrent launches;
 * every failure degrades to a debug log.
 *
 * Deliberately never touches a below-floor install: the floor is
 * enforced foreground by the launcher (fail-closed), and a background
 * task must not change what the running session validated.
 */
export function refreshPiInBackground(opts: { autoUpdate: boolean }): void {
  if (!opts.autoUpdate) return
  void (async () => {
    try {
      const cache = await readCache()
      if (!shouldCheckNow(cache)) return
      const installedVersion = await getInstalledPiVersion()
      if (!meetsPiMinVersion(installedVersion)) return
      const npmPath = resolveExecutable("npm")
      const latestVersion = await getLatestPiVersion()
      // Optimistic throttle write: concurrent/next launches back off
      // even while the detached install is still settling.
      await writeCache({
        checkedAt: new Date().toISOString(),
        installedVersion,
        latestVersion,
      })
      if (!npmPath) return
      if (!latestVersion || !isPiNewer(installedVersion, latestVersion)) return
      const queued = await withInstallLock("pi-install.lock", async () => {
        queueDetachedGlobalInstall(npmPath, `${PI_NPM_PACKAGE}@${latestVersion}`)
      })
      if (queued) {
        consola.info(
          `Pi ${installedVersion} → ${latestVersion} update queued; it takes effect on the next launch.`,
        )
      }
    } catch (err) {
      consola.debug("Background Pi refresh failed:", err)
    }
  })().catch((err) => {
    consola.debug("Background Pi refresh failed:", err)
  })
}
