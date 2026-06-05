/**
 * Self-update for the `github-router` proxy.
 *
 * The proxy is a *running* process, so updating its own global install
 * in place (`npm install -g github-router@latest`) deletes/overwrites
 * files the OS holds open — on Windows that fails deterministically
 * (EPERM/EBUSY) and can corrupt the install. So we never install in
 * place: when a newer version exists we spawn a **detached updater that
 * waits for this process to exit**, then installs. The update takes
 * effect on the next launch — no re-exec, no restart prompt.
 *
 * Best-effort throughout: every failure is swallowed to debug/warn and
 * never blocks startup. The startup probe is bounded and the install is
 * off the critical path (detached), so even a blackholed network can't
 * delay the proxy from serving.
 */

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import consola from "consola"

import { isNewer } from "./claude-version-check"
import {
  parseBoolEnv,
  resolveExecutable,
  runCommandCapture,
} from "./exec"
import { withInstallLock } from "./update-lock"
import { getPackageVersion } from "./version"

// The published, installable package is the UNSCOPED name. The scoped
// `@animeshkundu/github-router` is GitHub-Packages-only and must NOT be
// used for `npm view` / `npm install` here.
const NPM_PACKAGE = "github-router"
const THROTTLE_HOURS = 1
const NPM_VIEW_TIMEOUT_MS = 5000

interface SelfUpdateCache {
  checkedAt: string
  installedVersion: string | null
  latestVersion: string | null
}

function cacheFilePath(): string {
  return path.join(
    os.homedir(),
    ".local",
    "share",
    "github-router",
    // Distinct from the Claude Code check's `last-update-check` so the
    // two throttles don't cross-suppress.
    "last-self-update-check",
  )
}

async function readCache(): Promise<SelfUpdateCache | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(cacheFilePath(), "utf8"),
    ) as SelfUpdateCache
    if (typeof parsed.checkedAt !== "string") return null
    return parsed
  } catch {
    return null
  }
}

async function writeCache(cache: SelfUpdateCache): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cacheFilePath()), { recursive: true })
    await fs.writeFile(cacheFilePath(), JSON.stringify(cache), { mode: 0o600 })
  } catch (err) {
    consola.debug("Failed to write self-update cache:", err)
  }
}

function shouldCheckNow(cache: SelfUpdateCache | null): boolean {
  if (!cache) return true
  const last = new Date(cache.checkedAt).getTime()
  if (Number.isNaN(last)) return true
  return (Date.now() - last) / 1000 / 3600 >= THROTTLE_HOURS
}

async function getLatestVersion(npmPath: string): Promise<string | null> {
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
 * Spawn a detached process that waits for THIS proxy (pid) to exit,
 * then runs `npm install -g github-router@latest`. Fully detached and
 * unref'd so it outlives the proxy; output discarded.
 *
 * The waiter is a tiny inline Node script (Node is guaranteed present —
 * the proxy runs on it) that polls `process.kill(pid, 0)` until the
 * parent is gone, then execs npm. This avoids the Windows file-lock by
 * never touching the global install while the proxy holds it open.
 */
function spawnDetachedUpdater(npmPath: string): void {
  const parentPid = process.pid
  // Inline waiter: poll until the parent disappears, then install.
  const waiter = `
    const pid = ${parentPid};
    const { spawn } = require("node:child_process");
    function alive() { try { process.kill(pid, 0); return true } catch { return false } }
    const timer = setInterval(() => {
      if (alive()) return;
      clearInterval(timer);
      const args = ["install", "-g", ${JSON.stringify(`${NPM_PACKAGE}@latest`)}, "--silent"];
      const isWin = process.platform === "win32";
      const child = spawn(${JSON.stringify(npmPath)}, args, {
        stdio: "ignore", windowsHide: true, shell: isWin, detached: !isWin,
      });
      child.on("error", () => process.exit(0));
      child.on("exit", () => process.exit(0));
      // Safety: never hang forever.
      setTimeout(() => process.exit(0), 180000).unref();
    }, 500);
    // Safety cap on the wait itself (e.g. extremely long sessions still
    // eventually give up rather than leak the waiter).
    setTimeout(() => { clearInterval(timer); process.exit(0); }, 24 * 3600 * 1000).unref();
  `.trim()

  const child = spawn(process.execPath, ["-e", waiter], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  child.unref()
}

export interface RunSelfUpdateOpts {
  /** From `args["self-update"]` (default true). */
  selfUpdate: boolean
  /** Bypass the throttle (used by tests / explicit forcing). */
  force?: boolean
}

/**
 * Probe npm for a newer `github-router` and, if found, queue a detached
 * post-exit update. Returns quickly; never throws. Call AFTER the
 * server is listening so the bounded probe can't delay binding.
 */
export async function runSelfUpdate(opts: RunSelfUpdateOpts): Promise<void> {
  if (!opts.selfUpdate) return
  if (parseBoolEnv(process.env.GH_ROUTER_NO_SELF_UPDATE) === true) return

  try {
    const cache = await readCache()
    if (!opts.force && !shouldCheckNow(cache)) return

    const installed = getPackageVersion()
    if (installed === "unknown") return // can't compare; skip silently

    const npmPath = resolveExecutable("npm")
    if (!npmPath) return // npm not on PATH; skip

    const latest = await getLatestVersion(npmPath)
    // Write the throttle BEFORE acting so concurrent/next launches back
    // off even if the install is still settling (optimistic lock).
    await writeCache({
      checkedAt: new Date().toISOString(),
      installedVersion: installed,
      latestVersion: latest,
    })
    if (!latest || !isNewer(installed, latest)) return

    const queued = await withInstallLock("self-update.lock", async () => {
      spawnDetachedUpdater(npmPath)
    })
    if (queued) {
      consola.info(
        `github-router ${installed} → ${latest} update queued; it takes effect on the next launch.`,
      )
    }
  } catch (err) {
    consola.debug("Self-update check failed:", err)
  }
}
