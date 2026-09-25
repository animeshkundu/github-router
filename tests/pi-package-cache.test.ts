import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  PI_PACKAGE_CACHE_MAX_AGE_MS,
  piPackageCacheDir,
  piPackageCacheKey,
  piPackageSpecFingerprint,
  savePiPackageCache,
  seedPiPackageCache,
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
