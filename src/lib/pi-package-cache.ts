import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import consola from "consola"

import { PATHS } from "./paths"
import type { PiPackageEntry } from "./pi-models-settings"

/**
 * Persistent npm-package cache for Pi launches.
 *
 * Pi installs the mirror's `packages[]` into `<agentDir>/npm` on every
 * boot, and the agent dir is a fresh per-launch mirror
 * (`pi-agent-<pid>-<rand>`) — so every launch pays a full registry
 * install (~5s + `added N packages` noise that bypasses
 * `npm_config_loglevel=error`). Pi skips the install when the package
 * dir already exists and the installed version satisfies the configured
 * range — and unpinned `npm:name` specs match ANY installed version —
 * so pre-seeding `<mirror>/npm` from a durable cache makes repeat
 * launches install nothing: faster AND silent.
 *
 * Keyed by the exact package set (sorted spec fingerprints), so flag
 * combinations (`--helpers`/`--ui`/`--search`/`--browse`) each get
 * their own entry and can never cross-contaminate. Entries older than
 * `PI_PACKAGE_CACHE_MAX_AGE_MS` (default 7d) are treated as a miss so
 * unpinned packages periodically refresh to upstream latest; the fresh
 * install is then saved back over the entry. Opt out entirely with
 * `GH_ROUTER_PI_NO_PACKAGE_CACHE=1`.
 */

export const PI_PACKAGE_CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000

function cacheDisabled(): boolean {
  return process.env.GH_ROUTER_PI_NO_PACKAGE_CACHE === "1"
}

/** Stable fingerprint of one `packages[]` entry (order-independent). */
export function piPackageSpecFingerprint(entry: PiPackageEntry): string {
  if (typeof entry === "string") return entry
  const join = (v: ReadonlyArray<string> | undefined): string => [...(v ?? [])].sort().join(",")
  return [
    entry.source,
    `ext:${join(entry.extensions)}`,
    `skills:${join(entry.skills)}`,
    `prompts:${join(entry.prompts)}`,
    `themes:${join(entry.themes)}`,
  ].join("::")
}

/** Order-independent cache key for a launch's full `packages[]` slice. */
export function piPackageCacheKey(packages: ReadonlyArray<PiPackageEntry>): string {
  const specs = packages.map(piPackageSpecFingerprint).sort()
  return createHash("sha256").update(specs.join("\n")).digest("hex").slice(0, 16)
}

export function piPackageCacheDir(key: string): string {
  return path.join(PATHS.APP_DIR, "pi-packages", key)
}

function npmDirOf(root: string): string {
  return path.join(root, "npm")
}

async function mtimeMsOf(dir: string): Promise<number | null> {
  try {
    const stat = await fs.stat(dir)
    return stat.mtimeMs
  } catch {
    return null
  }
}

/**
 * Copy the cached `<key>/npm` tree into a fresh mirror before Pi boots.
 * Returns true on a hit (mirror pre-seeded; Pi should install nothing).
 * Stale entries (older than the max age) are a miss so the launch
 * refreshes to upstream latest. Never throws.
 */
export async function seedPiPackageCache(
  mirrorDir: string,
  packages: ReadonlyArray<PiPackageEntry>,
): Promise<boolean> {
  if (cacheDisabled()) return false
  const key = piPackageCacheKey(packages)
  const cachedNpm = npmDirOf(piPackageCacheDir(key))
  const mtime = await mtimeMsOf(cachedNpm)
  if (mtime === null) return false
  if (Date.now() - mtime > PI_PACKAGE_CACHE_MAX_AGE_MS) {
    consola.debug(`Pi package cache ${key} is stale; refreshing from registry.`)
    return false
  }
  try {
    await fs.cp(cachedNpm, npmDirOf(mirrorDir), { recursive: true })
    return true
  } catch (err) {
    consola.debug("Pi package cache seed skipped:", err)
    return false
  }
}

/**
 * Persist a mirror's installed `<mirror>/npm` tree back to the cache
 * (call on shutdown, BEFORE the mirror is removed). Overwrites the
 * entry, refreshing its mtime. Never throws.
 */
export async function savePiPackageCache(
  mirrorDir: string,
  packages: ReadonlyArray<PiPackageEntry>,
): Promise<void> {
  if (cacheDisabled()) return
  const mirrorNpm = npmDirOf(mirrorDir)
  const marker = await mtimeMsOf(path.join(mirrorNpm, "node_modules"))
  if (marker === null) return
  const dest = npmDirOf(piPackageCacheDir(piPackageCacheKey(packages)))
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.rm(dest, { recursive: true, force: true })
    await fs.cp(mirrorNpm, dest, { recursive: true })
  } catch (err) {
    consola.debug("Pi package cache save skipped:", err)
  }
}

/**
 * Sweep cache entries whose `npm/` tree is older than the max age.
 * Best-effort, never throws. Runs opportunistically at boot.
 */
export async function sweepStalePiPackageCaches(): Promise<void> {
  if (cacheDisabled()) return
  const root = path.join(PATHS.APP_DIR, "pi-packages")
  let entries: Array<string>
  try {
    entries = await fs.readdir(root)
  } catch {
    return
  }
  await Promise.all(
    entries.map(async (entry) => {
      const npmDir = npmDirOf(path.join(root, entry))
      try {
        const mtime = await mtimeMsOf(npmDir)
        if (mtime === null || Date.now() - mtime > PI_PACKAGE_CACHE_MAX_AGE_MS) {
          await fs.rm(path.join(root, entry), { recursive: true, force: true })
        }
      } catch (err) {
        consola.debug(`Pi package cache sweep: skipping ${entry}:`, err)
      }
    }),
  )
}
