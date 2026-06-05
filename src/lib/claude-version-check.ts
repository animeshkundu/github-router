import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import consola from "consola"

import {
  resolveExecutable,
  runCommandCapture,
  runCommandVoid,
} from "./exec"
import { withInstallLock } from "./update-lock"

const NPM_PACKAGE = "@anthropic-ai/claude-code"
const THROTTLE_HOURS = 1
const NPM_VIEW_TIMEOUT_MS = 5000
const CLAUDE_VERSION_TIMEOUT_MS = 3000
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
 *
 * Windows-safe: `claude` is a `.cmd` shim that `execFile` cannot launch
 * directly. We resolve it to an absolute path (excluding the cwd, so a
 * planted `claude.cmd` in an untrusted repo can't run) and invoke it
 * through the shared exec helper.
 */
async function getInstalledVersion(): Promise<string | null> {
  const claudePath = resolveExecutable("claude")
  if (!claudePath) return null
  try {
    const { stdout, code } = await runCommandCapture(
      [claudePath, "--version"],
      { timeoutMs: CLAUDE_VERSION_TIMEOUT_MS },
    )
    if (code !== 0) return null
    // Output shape: "2.1.139 (Claude Code)\n"
    const match = stdout.match(/(\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * Fetch the latest version of @anthropic-ai/claude-code from the npm
 * registry. Returns null on network failure / npm unavailable.
 *
 * Windows-safe: `npm` is `npm.cmd`; resolved to an absolute path
 * (excluding cwd) before invocation.
 */
async function getLatestVersion(): Promise<string | null> {
  const npmPath = resolveExecutable("npm")
  if (!npmPath) return null
  try {
    const { stdout, code } = await runCommandCapture(
      [npmPath, "view", NPM_PACKAGE, "version", "--silent"],
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
 * Compare two semver-shaped strings (only the leading X.Y.Z, no
 * pre-release / metadata handling — sufficient for npm-published
 * stable releases). Returns true if `latest` is strictly higher than
 * `installed`.
 */
export function isNewer(installed: string | null, latest: string | null): boolean {
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

  const installedVersion = await getInstalledVersion()
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
 * Heuristic: did `claude update` fail because the subcommand does not
 * exist (a build predating `claude update`), as opposed to a transient
 * update error? We only npm-fall-back on this specific signal — falling
 * back on any failure would install a conflicting npm copy on
 * native-installer machines.
 *
 * Matches the usage/Commander-style "unknown command" messages CLIs emit
 * for an unrecognized subcommand. Deliberately narrow.
 */
export function looksLikeUnknownUpdateCommand(output: string): boolean {
  return /unknown command|unknown subcommand|unrecognized (sub)?command|invalid command|command not found|is not a (known|valid) command/i.test(
    output,
  )
}

/**
 * Update Claude Code to the latest version.
 *
 * Strategy (decided in the plan, corrected after a real-world false
 * negative): run `claude update` directly — it respects the user's
 * actual install method (native installer or npm), so it never creates a
 * conflicting second install, and it is NOT blocked by the
 * `DISABLE_AUTOUPDATER` the proxy sets in the *child* env (this runs from
 * the proxy's own env, and `claude update` is a manual command
 * unaffected by that flag).
 *
 * Only if `claude update` reports the subcommand is unknown (a build too
 * old to have it) do we fall back to `npm install -g
 * @anthropic-ai/claude-code@latest` with a VISIBLE warning. The earlier
 * `claude --help` capability probe was removed: it timed out / mismatched
 * on slow cold starts and wrongly forced the npm path every launch,
 * creating dual npm-global + native installs.
 *
 * Serialized across concurrent proxies via an install lock. Throws on
 * failure — the caller decides whether to warn and continue.
 */
export interface UpdateClaudeDeps {
  resolveExecutable: typeof resolveExecutable
  runCommandCapture: typeof runCommandCapture
  runCommandVoid: typeof runCommandVoid
  withInstallLock: typeof withInstallLock
}

export async function updateClaude(
  latestVersion: string,
  deps: Partial<UpdateClaudeDeps> = {},
): Promise<void> {
  const _resolve = deps.resolveExecutable ?? resolveExecutable
  const _capture = deps.runCommandCapture ?? runCommandCapture
  const _void = deps.runCommandVoid ?? runCommandVoid
  const _lock = deps.withInstallLock ?? withInstallLock

  const claudePath = _resolve("claude")
  if (!claudePath) throw new Error("claude not found on PATH")

  const ran = await _lock("claude-update.lock", async () => {
    consola.info(`Updating Claude Code to ${latestVersion} via \`claude update\`...`)
    // Capture (not inherit) so we can detect an unknown-command signal;
    // echo the output afterward so the user still sees what happened.
    const { code, stdout, stderr } = await _capture([claudePath, "update"], {
      timeoutMs: NPM_INSTALL_TIMEOUT_MS,
    })
    const combined = `${stdout}${stderr}`
    const trimmed = combined.trim()
    if (trimmed) process.stdout.write(trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`)

    if (code === 0) {
      consola.success(`Claude Code updated to ${latestVersion}`)
      return
    }

    if (!looksLikeUnknownUpdateCommand(combined)) {
      throw new Error(`\`claude update\` exited with code ${code}`)
    }

    // Fallback: npm. Only reachable on installs too old to have
    // `claude update` at all.
    const npmPath = _resolve("npm")
    if (!npmPath) {
      throw new Error(
        "this Claude Code build predates `claude update` and npm is not on PATH; " +
          `update manually: npm install -g ${NPM_PACKAGE}@latest`,
      )
    }
    consola.warn(
      "This Claude Code build predates `claude update`; falling back to " +
        `\`npm install -g ${NPM_PACKAGE}@latest\`.`,
    )
    const { code: npmCode, stderr: npmStderr } = await _void(
      [npmPath, "install", "-g", `${NPM_PACKAGE}@latest`, "--silent"],
      { timeoutMs: NPM_INSTALL_TIMEOUT_MS },
    )
    if (npmCode !== 0) {
      throw new Error(`npm install failed: ${npmStderr.trim() || `exit ${npmCode}`}`)
    }
    consola.success(`${NPM_PACKAGE} updated to ${latestVersion}`)
  })

  if (!ran) {
    consola.debug("Claude Code update already in progress in another process; skipping.")
  }
}
