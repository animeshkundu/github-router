import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import consola from "consola"

import { resolveExecutable, runCommandCapture } from "./exec"
import { queueDetachedGlobalInstall } from "./self-update"
import { withInstallLock } from "./update-lock"

export const PI_NPM_PACKAGE = "@earendil-works/pi-coding-agent"
/**
 * Minimum Pi version the `pi` launcher supports.
 *
 * The floor is pinned to the first release whose `before_agent_start` event
 * carries the `messageType` discriminator (present at 1.3.0, absent at 1.1.0).
 * The generated extension's prompt hook stands down for non-user events using
 * that field, and without it the hook would fire on subagent and system turns
 * the user never typed, which is a wrong brief rather than a missing one.
 * Below-floor Pi hard-exits at the launcher (`src/pi.ts`), but only where the
 * gate actually runs: the install probe, the background refresh, and this floor
 * check all sit inside `--update-check` (default on), so `--no-update-check`
 * (documented for offline/CI) skips the floor as well. That path is still
 * fail-closed rather than silently wrong: the generated extension's own shape
 * probe sees the missing `messageType`, warns once with the fix, and injects
 * nothing.
 */
export const PI_MIN_VERSION = "1.3.0"

/**
 * Registry used for the PI PACKAGE ONLY.
 *
 * Pi must come from a registry that actually carries it. A corporate npm mirror
 * can lag npmjs far enough that its `latest` sits below `PI_MIN_VERSION`, and
 * the launcher then fail-closes on an upgrade command the user cannot satisfy
 * (their `npm install -g` resolves through the same lagging mirror). Pointing
 * the Pi probe and install at npmjs by default keeps the floor reachable;
 * `GH_ROUTER_NPM_REGISTRY` overrides it for a mirror that does carry the
 * package. Everything else this repo installs still resolves through the user's
 * configured registry.
 */
export const PI_DEFAULT_REGISTRY = "https://registry.npmjs.org/"

/**
 * Resolve the registry for Pi package operations. Accepts `GH_ROUTER_NPM_REGISTRY`
 * when it is an http(s) URL and falls back to `PI_DEFAULT_REGISTRY` with a
 * warning otherwise, so a typo degrades to the working default rather than
 * bricking the launcher.
 */
export function resolvePiRegistry(): string {
  const raw = process.env.GH_ROUTER_NPM_REGISTRY?.trim()
  if (!raw) return PI_DEFAULT_REGISTRY
  if (!/^https?:\/\//i.test(raw)) {
    consola.warn(
      `Ignoring GH_ROUTER_NPM_REGISTRY=${JSON.stringify(raw)}: expected an http(s) URL. Using ${PI_DEFAULT_REGISTRY}.`,
    )
    return PI_DEFAULT_REGISTRY
  }
  return raw.endsWith("/") ? raw : `${raw}/`
}

/** `npm` args that pin an operation to the resolved Pi registry. */
export function piRegistryArgs(registry: string = resolvePiRegistry()): string[] {
  return [`--registry=${registry}`]
}

const THROTTLE_HOURS = 1
const NPM_VIEW_TIMEOUT_MS = 5000
const PI_VERSION_TIMEOUT_MS = 3000

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
      [
        npmPath,
        "view",
        PI_NPM_PACKAGE,
        "version",
        "--silent",
        ...piRegistryArgs(),
      ],
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

/*
 * `updatePi` / `ensurePiInstalled` used to live here: they ran
 * `npm install -g @earendil-works/pi-coding-agent@<v>` and then re-probed PATH.
 * They were removed deliberately, not refactored.
 *
 * Two reasons, both observed:
 *
 * 1. **They mutate a tree the user owns.** `-g` is not ours (user decision 4).
 *    Rewriting it to satisfy `PI_MIN_VERSION` made the launcher's floor check a
 *    silent `npm install -g` on every below-floor machine, which can break an
 *    unrelated project pinned to the older Pi.
 * 2. **`-g` cannot be updated while it is in use.** On Windows that is `EPERM`;
 *    everywhere it needs the detached post-exit waiter. The managed install
 *    avoids the whole problem by publishing a new directory and swapping a file
 *    pointer, so the below-floor repair path is now
 *    `managed-install/pi-command.ts` → `ensureManagedInstall` (see
 *    `resolvePiCommand`), and the explicit form is `github-router update --pi`.
 *
 * The user-owned `pi` still keeps its own channel: `refreshPiInBackground`
 * below queues the same detached `-g` install it always did.
 */

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
        queueDetachedGlobalInstall(
          npmPath,
          `${PI_NPM_PACKAGE}@${latestVersion}`,
          piRegistryArgs(),
        )
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
