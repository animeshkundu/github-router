import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  PI_PACKAGE_CACHE_HOURS_ENV,
  PI_PACKAGE_CACHE_MAX_AGE_MS,
  piPackageCacheDir,
  piPackageCacheKey,
  piPackageCacheMaxAgeMs,
  piPackageSpecFingerprint,
  savePiPackageCache,
  seedPiPackageCache,
  sweepStalePiPackageCaches,
} from "~/lib/pi-package-cache"
import type { PiPackageEntry } from "~/lib/pi-models-settings"

const tmpDirs: Array<string> = []
const cacheKeys: Array<string> = []

async function makeTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-pkg-cache-"))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const key of cacheKeys.splice(0)) {
    await fs.rm(piPackageCacheDir(key), { recursive: true, force: true })
  }
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
  delete process.env.GH_ROUTER_PI_NO_PACKAGE_CACHE
  delete process.env[PI_PACKAGE_CACHE_HOURS_ENV]
})

describe("pi package cache keys", () => {
  test("fingerprint is order-independent within a package entry", () => {
    const a: PiPackageEntry = {
      source: "npm:pi-agent-extensions",
      extensions: ["extensions/b/index.ts", "extensions/a/index.ts"],
      skills: [],
      prompts: [],
    }
    const b: PiPackageEntry = {
      source: "npm:pi-agent-extensions",
      extensions: ["extensions/a/index.ts", "extensions/b/index.ts"],
      skills: [],
      prompts: [],
    }
    expect(piPackageSpecFingerprint(a)).toBe(piPackageSpecFingerprint(b))
  })

  test("cache key is order-independent across packages, sensitive to content", () => {
    const pkgs: Array<PiPackageEntry> = [
      "npm:pi-claude-code-ui",
      { source: "npm:pi-mcp-adapter", skills: [], prompts: [] },
      "local:gh-router-pi",
    ]
    const shuffled: Array<PiPackageEntry> = [pkgs[2], pkgs[0], pkgs[1]]
    expect(piPackageCacheKey(shuffled)).toBe(piPackageCacheKey(pkgs))
    const dropped = pkgs.slice(0, 2)
    expect(piPackageCacheKey(dropped)).not.toBe(piPackageCacheKey(pkgs))
  })

  test("bare string and object form fingerprint differently", () => {
    expect(piPackageSpecFingerprint("npm:pi-mcp-adapter")).not.toBe(
      piPackageSpecFingerprint({ source: "npm:pi-mcp-adapter", skills: [], prompts: [] }),
    )
  })
})

describe("pi package cache seed/save", () => {
  test("seed misses on a cold cache", async () => {
    const mirror = await makeTmp()
    const pkgs: Array<PiPackageEntry> = [`npm:pi-cache-probe-${Date.now()}`]
    cacheKeys.push(piPackageCacheKey(pkgs))
    expect(await seedPiPackageCache(mirror, pkgs)).toBe(false)
  })

  test("save then seed round-trips the npm tree", async () => {
    const stamp = `roundtrip-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const pkgs: Array<PiPackageEntry> = [`npm:${stamp}`]
    cacheKeys.push(piPackageCacheKey(pkgs))

    const mirror = await makeTmp()
    await fs.mkdir(path.join(mirror, "npm", "node_modules", stamp), { recursive: true })
    await fs.writeFile(path.join(mirror, "npm", "package.json"), '{"name":"seed"}')
    await fs.writeFile(
      path.join(mirror, "npm", "node_modules", stamp, "package.json"),
      `{"name":"${stamp}"}`,
    )

    await savePiPackageCache(mirror, pkgs)

    const fresh = await makeTmp()
    expect(await seedPiPackageCache(fresh, pkgs)).toBe(true)
    const pkg = await fs.readFile(
      path.join(fresh, "npm", "node_modules", stamp, "package.json"),
      "utf8",
    )
    expect(pkg).toContain(stamp)
  })

  test("save is a no-op without an installed node_modules tree", async () => {
    const stamp = `empty-${Date.now()}`
    const pkgs: Array<PiPackageEntry> = [`npm:${stamp}`]
    cacheKeys.push(piPackageCacheKey(pkgs))
    const mirror = await makeTmp()
    await savePiPackageCache(mirror, pkgs)
    const fresh = await makeTmp()
    expect(await seedPiPackageCache(fresh, pkgs)).toBe(false)
  })

  test("stale entries are treated as a miss", async () => {
    const stamp = `stale-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const pkgs: Array<PiPackageEntry> = [`npm:${stamp}`]
    const key = piPackageCacheKey(pkgs)
    cacheKeys.push(key)

    const mirror = await makeTmp()
    await fs.mkdir(path.join(mirror, "npm", "node_modules", stamp), { recursive: true })
    await savePiPackageCache(mirror, pkgs)

    const old = new Date(Date.now() - PI_PACKAGE_CACHE_MAX_AGE_MS - 1000)
    await fs.utimes(path.join(piPackageCacheDir(key), "npm"), old, old)

    const fresh = await makeTmp()
    expect(await seedPiPackageCache(fresh, pkgs)).toBe(false)
  })

  test("freshness window is one day, not one week", async () => {
    // The max age is the worst-case staleness of every unpinned extension, so
    // the boundary is asserted in both directions rather than trusted.
    expect(PI_PACKAGE_CACHE_MAX_AGE_MS).toBe(24 * 3600 * 1000)
    const stamp = `boundary-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const pkgs: Array<PiPackageEntry> = [`npm:${stamp}`]
    const key = piPackageCacheKey(pkgs)
    cacheKeys.push(key)
    const mirror = await makeTmp()
    await fs.mkdir(path.join(mirror, "npm", "node_modules", stamp), { recursive: true })
    await savePiPackageCache(mirror, pkgs)
    const cachedNpm = path.join(piPackageCacheDir(key), "npm")

    const justInside = new Date(Date.now() - 23 * 3600 * 1000)
    await fs.utimes(cachedNpm, justInside, justInside)
    expect(await seedPiPackageCache(await makeTmp(), pkgs)).toBe(true)

    // Well past a day but well inside the retired 7d window: this is the case
    // the change exists for, so it must MISS now.
    const justOutside = new Date(Date.now() - 25 * 3600 * 1000)
    await fs.utimes(cachedNpm, justOutside, justOutside)
    expect(await seedPiPackageCache(await makeTmp(), pkgs)).toBe(false)
  })

  test(`${PI_PACKAGE_CACHE_HOURS_ENV} overrides the window and rejects junk`, async () => {
    expect(piPackageCacheMaxAgeMs()).toBe(24 * 3600 * 1000)
    process.env[PI_PACKAGE_CACHE_HOURS_ENV] = "2"
    expect(piPackageCacheMaxAgeMs()).toBe(2 * 3600 * 1000)
    // A malformed value must fall back, not produce NaN: `age > NaN` is always
    // false, which would make every entry eternally fresh.
    for (const junk of ["", "  ", "abc", "0", "-3"]) {
      process.env[PI_PACKAGE_CACHE_HOURS_ENV] = junk
      expect(piPackageCacheMaxAgeMs()).toBe(PI_PACKAGE_CACHE_MAX_AGE_MS)
    }

    process.env[PI_PACKAGE_CACHE_HOURS_ENV] = "2"
    const stamp = `env-hours-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const pkgs: Array<PiPackageEntry> = [`npm:${stamp}`]
    const key = piPackageCacheKey(pkgs)
    cacheKeys.push(key)
    const mirror = await makeTmp()
    await fs.mkdir(path.join(mirror, "npm", "node_modules", stamp), { recursive: true })
    await savePiPackageCache(mirror, pkgs)
    const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000)
    await fs.utimes(path.join(piPackageCacheDir(key), "npm"), threeHoursAgo, threeHoursAgo)
    // Older than the 2h override, younger than the 24h default.
    expect(await seedPiPackageCache(await makeTmp(), pkgs)).toBe(false)
  })

  test("the sweep honours the env override, so a short window reclaims sooner", async () => {
    // The sweep and the seed must agree on the window: a sweep still using the
    // 24h default would delete entries the operator asked to keep for longer,
    // and refusing to delete ones they asked to expire sooner.
    const stamp = `sweep-env-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const pkgs: Array<PiPackageEntry> = [`npm:${stamp}`]
    const key = piPackageCacheKey(pkgs)
    cacheKeys.push(key)
    const mirror = await makeTmp()
    await fs.mkdir(path.join(mirror, "npm", "node_modules", stamp), { recursive: true })
    await savePiPackageCache(mirror, pkgs)
    const npmDir = path.join(piPackageCacheDir(key), "npm")
    const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000)
    await fs.utimes(npmDir, threeHoursAgo, threeHoursAgo)

    // 24h default: the entry is still young, so the sweep leaves it alone.
    await sweepStalePiPackageCaches()
    expect(await fs.stat(npmDir).then(() => true, () => false)).toBe(true)

    // A 2h override makes the same entry stale; the sweep must reclaim it.
    process.env[PI_PACKAGE_CACHE_HOURS_ENV] = "2"
    await sweepStalePiPackageCaches()
    expect(await fs.stat(npmDir).then(() => true, () => false)).toBe(false)
  })

  test("GH_ROUTER_PI_NO_PACKAGE_CACHE=1 disables seed and save", async () => {
    process.env.GH_ROUTER_PI_NO_PACKAGE_CACHE = "1"
    const stamp = `disabled-${Date.now()}`
    const pkgs: Array<PiPackageEntry> = [`npm:${stamp}`]
    cacheKeys.push(piPackageCacheKey(pkgs))
    const mirror = await makeTmp()
    await fs.mkdir(path.join(mirror, "npm", "node_modules", stamp), { recursive: true })
    await savePiPackageCache(mirror, pkgs)
    const fresh = await makeTmp()
    expect(await seedPiPackageCache(fresh, pkgs)).toBe(false)
  })
})
