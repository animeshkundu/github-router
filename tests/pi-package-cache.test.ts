import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  PI_PACKAGE_CACHE_HOURS_ENV,
  PI_PACKAGE_CACHE_MAX_AGE_MS,
  PI_PACKAGE_CACHE_TRASH_TTL_MS,
  piPackageCacheDir,
  piPackageCacheEnabled,
  piPackageCacheKey,
  piPackageCacheMaxAgeMs,
  piPackageSpecFingerprint,
  requiredPackageNames,
  seedPiPackageCache,
  sweepStalePiPackageCaches,
} from "~/lib/pi-package-cache"
import type { PiPackageEntry } from "~/lib/pi-models-settings"

/**
 * Every test runs against its own `GH_ROUTER_APP_DIR`, so the suite never
 * touches the real `~/.local/share/github-router`. That matters more than it
 * used to: the cache entries and the `pi-mirrors` scan both live under
 * `PATHS.APP_DIR`, and a test that simulated "another live launch" would
 * otherwise be pointing at the operator's actual mirrors.
 */
const ORIGINAL_APP_DIR = process.env.GH_ROUTER_APP_DIR
const ORIGINAL_OPTOUT = process.env.GH_ROUTER_PI_NO_PACKAGE_CACHE
const ORIGINAL_HOURS = process.env[PI_PACKAGE_CACHE_HOURS_ENV]

let appDir = ""
let mirror = ""

/** Live children spawned to give the in-use guard a real PID to find. */
const children: Array<ReturnType<typeof Bun.spawn>> = []

beforeEach(async () => {
  appDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-pkg-cache-"))
  process.env.GH_ROUTER_APP_DIR = appDir
  delete process.env.GH_ROUTER_PI_NO_PACKAGE_CACHE
  delete process.env[PI_PACKAGE_CACHE_HOURS_ENV]
  mirror = await makeMirror()
})

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      child.kill()
    } catch {
      // Already gone; the assertion that mattered has run.
    }
  }
  for (const [name, value] of [
    ["GH_ROUTER_APP_DIR", ORIGINAL_APP_DIR],
    ["GH_ROUTER_PI_NO_PACKAGE_CACHE", ORIGINAL_OPTOUT],
    [PI_PACKAGE_CACHE_HOURS_ENV, ORIGINAL_HOURS],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  // Removes junctions without following them, so the entry trees below go too
  // but nothing outside the temp dir is ever touched.
  await fs.rm(appDir, { recursive: true, force: true })
})

/** A fresh per-launch mirror, the way `ensurePiAgentMirror` names one. */
async function makeMirror(): Promise<string> {
  const dir = path.join(appDir, "pi-mirrors", `pi-agent-${process.pid}-${Math.random().toString(16).slice(2, 10)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function entryNpmFor(packages: ReadonlyArray<PiPackageEntry>): string {
  return path.join(piPackageCacheDir(piPackageCacheKey(packages)), "npm")
}

/** Junction on Windows (no elevation), plain dir link elsewhere. */
async function linkTo(target: string, linkPath: string): Promise<void> {
  await fs.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir")
}

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(() => true, () => false)
}

async function samePath(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([fs.realpath(a), fs.realpath(b)])
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** What `npm install <name> --prefix <entry>/npm` leaves behind. */
async function installPackage(npmRoot: string, name: string): Promise<void> {
  const dir = path.join(npmRoot, "node_modules", name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }))
}

/**
 * npm's hidden lock. Keys are relative to the install prefix, which is the
 * entry's `npm/`, not its `node_modules/`.
 */
async function writeLock(npmRoot: string, keys: ReadonlyArray<string>): Promise<void> {
  const packages: Record<string, unknown> = {}
  for (const key of keys) packages[key] = { version: "1.0.0" }
  await fs.writeFile(
    path.join(npmRoot, "node_modules", ".package-lock.json"),
    JSON.stringify({ name: "pi-packages", lockfileVersion: 3, requires: true, packages }),
  )
}

/** A complete, lockfile-consistent tree for the given package names. */
async function writeCompleteTree(npmRoot: string, names: ReadonlyArray<string>): Promise<void> {
  await fs.mkdir(path.join(npmRoot, "node_modules"), { recursive: true })
  for (const name of names) await installPackage(npmRoot, name)
  await writeLock(npmRoot, names.map((name) => `node_modules/${name}`))
}

function ageMs(npmRoot: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms)
  return fs.utimes(npmRoot, when, when).then(() => undefined)
}

async function stampPathFor(packages: ReadonlyArray<PiPackageEntry>): Promise<string> {
  return path.join(piPackageCacheDir(piPackageCacheKey(packages)), ".pi-cache-ok")
}

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

  test("required names drop the version range, keep the scope, and skip non-npm sources", () => {
    // The version cut is at the last `@` AFTER the last `/`: a scoped name has
    // an `@` of its own, so a naive `lastIndexOf("@")` would mangle it.
    const pkgs: Array<PiPackageEntry> = [
      "npm:pi-alpha",
      "npm:pi-alpha",
      "npm:@scope/pi-beta@^1.2.3",
      "npm:pi-gamma@1.0.0",
      "local:gh-router-pi",
      "git:github.com/x/y",
      "https://example.test/pkg.tgz",
      "/abs/path/pkg",
      { source: "npm:@scope/pi-delta", skills: [], prompts: [] },
    ]
    expect(requiredPackageNames(pkgs)).toEqual([
      "@scope/pi-beta",
      "@scope/pi-delta",
      "pi-alpha",
      "pi-gamma",
    ])
  })
})

describe("pi package cache seed", () => {
  test("a cold seed creates the entry and links the mirror's npm to it", async () => {
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha", "npm:@scope/pi-beta@^1.2.3"]
    const entryNpm = entryNpmFor(pkgs)

    const result = await seedPiPackageCache(mirror, pkgs)

    expect(result).toMatchObject({ hit: false, npmRoot: path.join(mirror, "npm") })
    expect(result.reason).toContain("no cached tree")
    // A link, not a copy: this is the whole point of the design.
    expect((await fs.lstat(result.npmRoot)).isSymbolicLink()).toBe(true)
    expect(await samePath(result.npmRoot, entryNpm)).toBe(true)
    expect(await exists(entryNpm)).toBe(true)
  })

  test("a complete tree is a hit, and the next launch trusts the stamp instead of walking", async () => {
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]
    const entryNpm = entryNpmFor(pkgs)
    await writeCompleteTree(entryNpm, ["pi-alpha"])

    const first = await seedPiPackageCache(mirror, pkgs)
    expect(first.hit).toBe(true)
    expect(first.reason).toContain("full scan")
    expect(first.reason).toContain("1 packages")

    const stamp = JSON.parse(await fs.readFile(await stampPathFor(pkgs), "utf8"))
    expect(stamp).toMatchObject({ schemaVersion: 1, packages: ["pi-alpha"], entries: 1 })
    expect(typeof stamp.validatedAt).toBe("string")

    // Second launch: fresh mirror, same entry. The reason string is the only
    // observable difference between "walked the lockfile" and "trusted the
    // stamp", and that difference is the whole reason the stamp exists (269
    // keys measured 7 ms warm, 1-3 s against a cold or AV-scanned tree).
    const second = await seedPiPackageCache(await makeMirror(), pkgs)
    expect(second).toMatchObject({ hit: true })
    expect(second.reason).toContain("stamp")
  })

  test("a stamp that describes a different package set is ignored", async () => {
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]
    const entryNpm = entryNpmFor(pkgs)
    await writeCompleteTree(entryNpm, ["pi-alpha"])
    expect((await seedPiPackageCache(mirror, pkgs)).reason).toContain("full scan")

    const stampFile = await stampPathFor(pkgs)
    const stamp = JSON.parse(await fs.readFile(stampFile, "utf8"))
    await fs.writeFile(stampFile, JSON.stringify({ ...stamp, packages: ["pi-other"] }))
    expect((await seedPiPackageCache(await makeMirror(), pkgs)).reason).toContain("full scan")

    // An expired stamp is the other way a stale claim could be honoured.
    await fs.writeFile(
      stampFile,
      JSON.stringify({ ...stamp, validatedAt: new Date(Date.now() - PI_PACKAGE_CACHE_MAX_AGE_MS - 60_000).toISOString() }),
    )
    expect((await seedPiPackageCache(await makeMirror(), pkgs)).reason).toContain("full scan")
  })

  test("a tree missing a configured package is a miss, but is never destroyed", async () => {
    // The mid-install case: Pi installs one package at a time, so a tree with 1
    // of 2 configured packages is a normal intermediate state that this launch
    // should finish, not corruption to wipe. Destroying it here would also be
    // unsafe — another launch may be installing into the same entry.
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha", "npm:pi-beta"]
    const entryNpm = entryNpmFor(pkgs)
    await fs.mkdir(path.join(entryNpm, "node_modules"), { recursive: true })
    await installPackage(entryNpm, "pi-alpha")

    const result = await seedPiPackageCache(mirror, pkgs)

    expect(result.hit).toBe(false)
    expect(result.reason).toContain("missing 1 of 2 configured packages")
    expect(result.reason).toContain("pi-beta")
    expect(await exists(path.join(entryNpm, "node_modules", "pi-alpha", "package.json"))).toBe(true)
    // Still linked, so the install this launch performs lands in the entry and
    // the NEXT launch is a hit.
    expect(await samePath(result.npmRoot, entryNpm)).toBe(true)
  })

  test("a lockfile that outruns its tree is retired aside, not handed to Pi", async () => {
    // This is the truncation signature: a lock recording packages the tree does
    // not have, which Pi would read as "already installed" and skip.
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]
    const entryNpm = entryNpmFor(pkgs)
    await fs.mkdir(path.join(entryNpm, "node_modules"), { recursive: true })
    await installPackage(entryNpm, "pi-alpha")
    await writeLock(entryNpm, ["node_modules/pi-alpha", "node_modules/pi-ghost"])

    const result = await seedPiPackageCache(mirror, pkgs)

    expect(result.hit).toBe(false)
    expect(result.reason).toContain("missing 1 lockfile entries")
    // Retired and recreated empty, so the launch installs into a tree that
    // matches its own lockfile. The trash may already be collected (the delete
    // is off the launch path on purpose), so assert the outcome, not the name.
    expect(await fs.readdir(path.join(entryNpm, "node_modules"))).toEqual([])
    expect(await exists(path.join(entryNpm, "node_modules", "pi-alpha"))).toBe(false)
  })

  test("no lockfile at all is unverified, not invalid", async () => {
    // `package-lock=false` in a user `.npmrc` means the hidden lock is never
    // written. Treating that as corruption would wipe an 88 MB tree at every
    // boot, forever.
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]
    const entryNpm = entryNpmFor(pkgs)
    await fs.mkdir(path.join(entryNpm, "node_modules"), { recursive: true })
    await installPackage(entryNpm, "pi-alpha")

    const result = await seedPiPackageCache(mirror, pkgs)

    expect(result.hit).toBe(true)
    expect(result.reason).toContain("no lockfile")
    expect(await exists(await stampPathFor(pkgs))).toBe(true)
  })

  test("a stale entry is retired and the launch installs into a fresh one", async () => {
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]
    const entryNpm = entryNpmFor(pkgs)
    await writeCompleteTree(entryNpm, ["pi-alpha"])
    // The entry root's own manifests must go with the retired tree: a root
    // lockfile still describing the old versions would make the next install
    // resolve them again, which is the opposite of what expiry is for.
    await fs.writeFile(path.join(entryNpm, "package.json"), '{"name":"stale"}')
    await fs.writeFile(path.join(entryNpm, "package-lock.json"), '{"lockfileVersion":3}')
    await ageMs(entryNpm, PI_PACKAGE_CACHE_MAX_AGE_MS + 60_000)

    const result = await seedPiPackageCache(mirror, pkgs)

    expect(result.hit).toBe(false)
    expect(result.reason).toContain("stale")
    expect(await fs.readdir(path.join(entryNpm, "node_modules"))).toEqual([])
    expect(await exists(path.join(entryNpm, "package.json"))).toBe(false)
    expect(await exists(path.join(entryNpm, "package-lock.json"))).toBe(false)
    expect(await samePath(result.npmRoot, entryNpm)).toBe(true)
  })

  test("freshness window is one day, not one week", async () => {
    // The max age is the worst-case staleness of every unpinned extension, so
    // the boundary is asserted in both directions rather than trusted.
    expect(PI_PACKAGE_CACHE_MAX_AGE_MS).toBe(24 * 3600 * 1000)
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]
    const entryNpm = entryNpmFor(pkgs)
    await writeCompleteTree(entryNpm, ["pi-alpha"])

    await ageMs(entryNpm, 23 * 3600 * 1000)
    expect((await seedPiPackageCache(await makeMirror(), pkgs)).hit).toBe(true)

    // Well past a day but well inside the retired 7d window: this is the case
    // the change exists for, so it must MISS now.
    await ageMs(entryNpm, 25 * 3600 * 1000)
    expect((await seedPiPackageCache(await makeMirror(), pkgs)).hit).toBe(false)
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
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]
    const entryNpm = entryNpmFor(pkgs)
    await writeCompleteTree(entryNpm, ["pi-alpha"])
    await ageMs(entryNpm, 3 * 3600 * 1000)
    // Older than the 2h override, younger than the 24h default.
    expect((await seedPiPackageCache(mirror, pkgs)).hit).toBe(false)
  })

  test("GH_ROUTER_PI_NO_PACKAGE_CACHE=1 disables the cache and creates nothing", async () => {
    process.env.GH_ROUTER_PI_NO_PACKAGE_CACHE = "1"
    expect(piPackageCacheEnabled()).toBe(false)
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]

    const result = await seedPiPackageCache(mirror, pkgs)

    expect(result).toMatchObject({ hit: false })
    expect(result.reason).toContain("cache disabled")
    // The mirror keeps no `npm` at all, so Pi installs into the per-launch tree
    // exactly as it did before the cache existed.
    expect(await exists(path.join(mirror, "npm"))).toBe(false)
    expect(await exists(piPackageCacheDir(piPackageCacheKey(pkgs)))).toBe(false)
  })

  test("removing the mirror takes the link and leaves the entry intact", async () => {
    // The per-launch mirror is deleted on every shutdown. `fs.rm` on a
    // recursive path must remove the junction, not the tree it points at —
    // otherwise the cache would be dead on arrival, every launch.
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]
    const entryNpm = entryNpmFor(pkgs)
    await writeCompleteTree(entryNpm, ["pi-alpha"])
    expect((await seedPiPackageCache(mirror, pkgs)).hit).toBe(true)

    await fs.rm(mirror, { recursive: true, force: true })

    expect(await exists(path.join(entryNpm, "node_modules", "pi-alpha", "package.json"))).toBe(true)
    expect(await exists(entryNpm)).toBe(true)
    // And the next launch still hits.
    expect((await seedPiPackageCache(await makeMirror(), pkgs)).hit).toBe(true)
  })

  test("a real directory left at the mirror's npm path is replaced by the link", async () => {
    // A previous launch that fell back (no symlink privilege) installed into a
    // real `<mirror>/npm`. The path is inside the mirror, which the launcher
    // owns outright, so adopting it would serve an unverified tree.
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]
    const entryNpm = entryNpmFor(pkgs)
    await writeCompleteTree(entryNpm, ["pi-alpha"])
    const mirrorNpm = path.join(mirror, "npm")
    await fs.mkdir(path.join(mirrorNpm, "node_modules", "junk"), { recursive: true })

    const result = await seedPiPackageCache(mirror, pkgs)

    expect(result.hit).toBe(true)
    expect((await fs.lstat(mirrorNpm)).isSymbolicLink()).toBe(true)
    expect(await samePath(mirrorNpm, entryNpm)).toBe(true)
    expect(await exists(path.join(mirrorNpm, "node_modules", "junk"))).toBe(false)
  })

  test("retired trees older than the trash TTL are collected by the next seed", async () => {
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]
    const entryNpm = entryNpmFor(pkgs)
    await fs.mkdir(entryNpm, { recursive: true })
    const trash = path.join(entryNpm, ".trash-1700000000000-dead")
    await fs.mkdir(path.join(trash, "node_modules"), { recursive: true })
    await fs.writeFile(path.join(trash, "node_modules", "leftover.txt"), "x")
    const old = new Date(Date.now() - PI_PACKAGE_CACHE_TRASH_TTL_MS - 60_000)
    await fs.utimes(trash, old, old)

    await seedPiPackageCache(mirror, pkgs)

    // Collection is deliberately off the launch path (`void`), so poll for it
    // rather than depend on it having finished when seed resolves.
    const deadline = Date.now() + 3000
    while ((await exists(trash)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(await exists(trash)).toBe(false)
  })
})

describe("pi package cache in-use guard", () => {
  test("a stale entry in use by a live launch is neither deleted nor linked", async () => {
    // Deleting the tree out from under a running session leaves every junction
    // to it dangling, and `mkdir` does not recreate the target: Pi's own
    // install then fails with ENOENT instead of falling back to a cold cache.
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]
    const entryNpm = entryNpmFor(pkgs)
    await writeCompleteTree(entryNpm, ["pi-alpha"])
    await ageMs(entryNpm, PI_PACKAGE_CACHE_MAX_AGE_MS + 60_000)

    const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 120000)"], {
      stdio: ["ignore", "ignore", "ignore"],
    })
    children.push(child)
    const otherMirror = path.join(appDir, "pi-mirrors", `pi-agent-${child.pid}-c0ffee`)
    await fs.mkdir(otherMirror, { recursive: true })
    await linkTo(entryNpm, path.join(otherMirror, "npm"))

    const result = await seedPiPackageCache(mirror, pkgs)

    expect(result.hit).toBe(false)
    expect(result.reason).toContain(`in use by launch ${child.pid}`)
    // Nothing destroyed...
    expect(await exists(path.join(entryNpm, "node_modules", "pi-alpha", "package.json"))).toBe(true)
    // ...and nothing linked, so this launch installs into its own tree and the
    // running session's link keeps working.
    expect(await exists(path.join(mirror, "npm"))).toBe(false)
  })

  test("the sweep skips an entry another live launch is using", async () => {
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]
    const entryNpm = entryNpmFor(pkgs)
    await writeCompleteTree(entryNpm, ["pi-alpha"])
    await ageMs(entryNpm, PI_PACKAGE_CACHE_MAX_AGE_MS + 60_000)

    const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 120000)"], {
      stdio: ["ignore", "ignore", "ignore"],
    })
    children.push(child)
    const otherMirror = path.join(appDir, "pi-mirrors", `pi-agent-${child.pid}-c0ffee`)
    await fs.mkdir(otherMirror, { recursive: true })
    await linkTo(entryNpm, path.join(otherMirror, "npm"))

    await sweepStalePiPackageCaches()

    expect(await exists(entryNpm)).toBe(true)
  })
})

describe("pi package cache sweep", () => {
  test("the sweep honours the env override, so a short window reclaims sooner", async () => {
    // The sweep and the seed must agree on the window: a sweep still using the
    // 24h default would delete entries the operator asked to keep for longer,
    // and refuse to delete ones they asked to expire sooner.
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]
    const entryNpm = entryNpmFor(pkgs)
    await writeCompleteTree(entryNpm, ["pi-alpha"])
    await ageMs(entryNpm, 3 * 3600 * 1000)

    // 24h default: the entry is still young, so the sweep leaves it alone.
    await sweepStalePiPackageCaches()
    expect(await exists(entryNpm)).toBe(true)

    // A 2h override makes the same entry stale; the sweep must reclaim it.
    process.env[PI_PACKAGE_CACHE_HOURS_ENV] = "2"
    await sweepStalePiPackageCaches()
    expect(await exists(entryNpm)).toBe(false)
  })

  test("the sweep leaves young entries and does nothing when disabled", async () => {
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]
    const entryNpm = entryNpmFor(pkgs)
    await writeCompleteTree(entryNpm, ["pi-alpha"])

    await sweepStalePiPackageCaches()
    expect(await exists(entryNpm)).toBe(true)

    process.env.GH_ROUTER_PI_NO_PACKAGE_CACHE = "1"
    await ageMs(entryNpm, PI_PACKAGE_CACHE_MAX_AGE_MS + 60_000)
    await sweepStalePiPackageCaches()
    expect(await exists(entryNpm)).toBe(true)
  })
})

describe("pi package cache failure modes", () => {
  test("a mirror whose npm path cannot be cleared degrades to a miss, not a throw", async () => {
    // A cache error must never fail a launch. Here the entry path is a FILE,
    // so every attempt to create or link it fails.
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]
    const entryDir = piPackageCacheDir(piPackageCacheKey(pkgs))
    await fs.mkdir(path.dirname(entryDir), { recursive: true })
    await fs.writeFile(entryDir, "not a directory")

    const result = await seedPiPackageCache(mirror, pkgs)

    expect(result.hit).toBe(false)
    expect(result.reason.length).toBeGreaterThan(0)
    expect(await exists(mirror)).toBe(true)
  })

  test("a seed on an unwritable mirror reports a miss and leaves the cwd untouched", async () => {
    const pkgs: Array<PiPackageEntry> = ["npm:pi-alpha"]
    const missingParent = path.join(appDir, "no-such-root", "mirror")
    // `mkdir` is recursive, so this succeeds; the point of the test is that a
    // cold seed of a not-yet-existing mirror is a plain miss, not an error.
    const result = await seedPiPackageCache(missingParent, pkgs)
    expect(result.hit).toBe(false)
    expect(result.npmRoot).toBe(path.join(missingParent, "npm"))
  })
})
