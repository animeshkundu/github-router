import { execFile, execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import consola from "consola"

const execFileAsync = promisify(execFile)

const NPM_PACKAGE = "@anthropic-ai/claude-code"
const THROTTLE_HOURS = 1
const NPM_VIEW_TIMEOUT_MS = 5000
const NPM_INSTALL_TIMEOUT_MS = 120_000 // 2 min — npm install can be slow on cold caches

interface VersionCheckCache {
  /** ISO timestamp of last check */
  checkedAt: string
  /** Installed version at last check */
  installedVersion: string | null
  /** Latest version on npm at last check */
  latestVersion: string | null
}

/** Path to the throttle cache. Created on demand. */
function cacheFilePath(): string {
  return path.join(
    os.homedir(),
    ".local",
    "share",
    "github-router",
    "last-update-check",
  )
}

/**
 * Read the throttle cache. Returns null on missing/corrupt file —
 * triggers a fresh check.
 */
async function readCache(): Promise<VersionCheckCache | null> {
  try {
    const raw = await fs.readFile(cacheFilePath(), "utf8")
    const parsed = JSON.parse(raw) as VersionCheckCache
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

async function writeCache(cache: VersionCheckCache): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cacheFilePath()), { recursive: true })
    await fs.writeFile(cacheFilePath(), JSON.stringify(cache), {
      mode: 0o600,
    })
  } catch (err) {
    // Throttle cache is best-effort — a write failure means we'll re-check
    // on next launch. Not worth surfacing.
    consola.debug("Failed to write claude version-check cache:", err)
  }
}

/** Check if it's been more than THROTTLE_HOURS since the last check. */
function shouldCheckNow(cache: VersionCheckCache | null): boolean {
  if (!cache) return true
  const lastCheck = new Date(cache.checkedAt).getTime()
  if (Number.isNaN(lastCheck)) return true
  const hoursSince = (Date.now() - lastCheck) / 1000 / 3600
  return hoursSince >= THROTTLE_HOURS
}

/**
 * Read the installed `claude` version. Returns null if claude is not
 * on PATH or the version probe fails (e.g. older versions that don't
 * support `--version` cleanly).
 */
function getInstalledVersion(): string | null {
  try {
    const out = execFileSync("claude", ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      encoding: "utf8",
    })
    // Output shape: "2.1.139 (Claude Code)\n"
    const match = out.match(/^(\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * Fetch the latest version of @anthropic-ai/claude-code from the npm
 * registry. Returns null on network failure / npm unavailable.
 */
async function getLatestVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["view", NPM_PACKAGE, "version", "--silent"],
      { timeout: NPM_VIEW_TIMEOUT_MS },
    )
    const v = stdout.trim()
    return /^\d+\.\d+\.\d+/.test(v) ? v : null
  } catch {
    return null
  }
}

/**
 * Compare two semver-shaped strings (only the leading X.Y.Z, no
 * pre-release / metadata handling — sufficient for npm-published
 * stable releases). Returns true if `latest` is strictly higher than
 * `installed`.
 */
function isNewer(installed: string | null, latest: string | null): boolean {
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

export interface VersionCheckResult {
  /** Whether claude is on PATH at all */
  installed: boolean
  installedVersion: string | null
  latestVersion: string | null
  /** True if a newer version is available */
  needsUpdate: boolean
  /** Whether the check was skipped (throttled or disabled) */
  skipped: boolean
  skipReason?: "throttled" | "disabled" | "no-npm" | "no-claude"
}

/**
 * Run a version check (subject to throttle). Side-effect: updates the
 * throttle cache. Returns the comparison result.
 */
export async function checkClaudeVersion(opts: {
  noCheck?: boolean
  /** Bypass the throttle (used when the check is the user's main intent) */
  force?: boolean
} = {}): Promise<VersionCheckResult> {
  if (opts.noCheck) {
    return {
      installed: false,
      installedVersion: null,
      latestVersion: null,
      needsUpdate: false,
      skipped: true,
      skipReason: "disabled",
    }
  }

  const cache = await readCache()
  if (!opts.force && !shouldCheckNow(cache)) {
    return {
      installed: cache?.installedVersion !== null,
      installedVersion: cache?.installedVersion ?? null,
      latestVersion: cache?.latestVersion ?? null,
      needsUpdate: isNewer(
        cache?.installedVersion ?? null,
        cache?.latestVersion ?? null,
      ),
      skipped: true,
      skipReason: "throttled",
    }
  }

  const installedVersion = getInstalledVersion()
  if (installedVersion === null) {
    return {
      installed: false,
      installedVersion: null,
      latestVersion: null,
      needsUpdate: false,
      skipped: true,
      skipReason: "no-claude",
    }
  }

  const latestVersion = await getLatestVersion()
  // Update cache regardless of whether latest fetched (so we still
  // throttle if npm is offline).
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
      skipped: true,
      skipReason: "no-npm",
    }
  }

  return {
    installed: true,
    installedVersion,
    latestVersion,
    needsUpdate: isNewer(installedVersion, latestVersion),
    skipped: false,
  }
}

/**
 * Run `npm install -g @anthropic-ai/claude-code@latest` synchronously.
 * Throws on failure — the caller decides whether to abort the launch
 * or continue with the older version.
 */
export async function autoUpdateClaude(latestVersion: string): Promise<void> {
  consola.info(
    `Updating ${NPM_PACKAGE} to ${latestVersion} (this may take ~30s)...`,
  )
  try {
    await execFileAsync(
      "npm",
      ["install", "-g", `${NPM_PACKAGE}@latest`, "--silent"],
      { timeout: NPM_INSTALL_TIMEOUT_MS },
    )
    consola.success(`${NPM_PACKAGE} updated to ${latestVersion}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`npm install failed: ${msg}`)
  }
}
