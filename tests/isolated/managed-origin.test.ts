import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  __resetOriginForTests,
  classifyEntry,
  describeOrigin,
  findPackageRoot,
  shouldAdoptFor,
  shouldInstallFor,
} from "~/lib/managed-install/origin"
import { managedRoot, versionDir } from "~/lib/managed-install/paths"
import { writeInstallState } from "~/lib/managed-install/state"

const dirs: Array<string> = []
const saved = {
  appDir: process.env.GH_ROUTER_APP_DIR,
  path: process.env.PATH,
}

async function tmpApp(tag: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `origin-${tag}-`))
  dirs.push(dir)
  return dir
}

/** Lay down a fake package tree and return its `dist/main.js` entry. */
async function fakeTree(root: string, name = "github-router"): Promise<string> {
  const pkgDir = path.join(root, "node_modules", ...name.split("/"))
  await fs.mkdir(path.join(pkgDir, "dist"), { recursive: true })
  await fs.writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", dependencies: {} }),
  )
  const entry = path.join(pkgDir, "dist", "main.js")
  await fs.writeFile(entry, "// payload\n")
  return entry
}

beforeEach(async () => {
  __resetOriginForTests()
  // Classifying an entry runs the npm probes, which MEMOISE into
  // `<APP_DIR>/m/<kind>/install-state.json`. Without this the tests write into the
  // developer's real app dir — a shared, GC-managed tree that other suites and a
  // running server read. Every test that needs a specific app dir overwrites this.
  process.env.GH_ROUTER_APP_DIR = await tmpApp("state")
})

afterEach(async () => {
  if (saved.appDir === undefined) delete process.env.GH_ROUTER_APP_DIR
  else process.env.GH_ROUTER_APP_DIR = saved.appDir
  if (saved.path === undefined) delete process.env.PATH
  else process.env.PATH = saved.path
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe("findPackageRoot", () => {
  /**
   * Compare two paths as "same directory" without depending on which SPELLING a
   * platform hands back.
   *
   * `fs.realpath` on Windows returns the 8.3 short name (`C:\Users\RUNNER~1\…`)
   * where the fixture was built under the long one (`C:\Users\runneradmin\…`),
   * and the filesystem is case-insensitive on top of that. macOS answers
   * `/private/var/…` for a tree built under `/var/…`. `findPackageRoot` returns that
   * resolved spelling BY DESIGN (it realpaths the entry before walking up), so
   * comparing it to an unresolved literal tests the platform's path renderer
   * instead of the function. Realpath both sides, then case-fold.
   *
   * Not circular: if the walk returned the wrong directory, the realpaths differ.
   */
  async function expectSameDir(actual: string | undefined, expected: string): Promise<void> {
    expect(actual).toBeDefined()
    expect(existsSync(actual!)).toBe(true)
    expect((await fs.realpath(actual!)).toLowerCase()).toBe(
      (await fs.realpath(expected)).toLowerCase(),
    )
  }

  test("walks up to the github-router package.json", async () => {
    const root = await tmpApp("pkg")
    const entry = await fakeTree(root)
    await expectSameDir(findPackageRoot(entry), path.join(root, "node_modules", "github-router"))
  })

  test("a look-alike package name is not this package", async () => {
    for (const name of ["not-github-router", "github-router-helper", "@someone/github-router"]) {
      const root = await tmpApp("pkg2")
      const entry = await fakeTree(root, name)
      expect(findPackageRoot(entry)).toBeUndefined()
    }
  })

  test("the scoped alias counts as this package", async () => {
    const root = await tmpApp("pkg3")
    const entry = await fakeTree(root, "@animeshkundu/github-router")
    await expectSameDir(
      findPackageRoot(entry),
      path.join(root, "node_modules", "@animeshkundu", "github-router"),
    )
  })

  test("no argv[1] → undefined rather than a guess", () => {
    expect(findPackageRoot(undefined)).toBeUndefined()
    expect(findPackageRoot("")).toBeUndefined()
  })
})

describe("classifyEntry", () => {
  test("a tree under <APP_DIR>/m/self/ is managed — and wins over every other root", async () => {
    const app = await tmpApp("app")
    process.env.GH_ROUTER_APP_DIR = app
    const entry = await fakeTree(versionDir("self", "1.2.3"))
    const info = await classifyEntry(entry)
    expect(info.origin).toBe("managed")
    expect(info.detail).toContain("managed tree")
  })

  test("pi payloads are managed too (the bootstrap must not adopt itself)", async () => {
    const app = await tmpApp("app-pi")
    process.env.GH_ROUTER_APP_DIR = app
    const entry = await fakeTree(versionDir("pi", "1.6.0"), "@earendil-works/pi-coding-agent")
    // The package name does not contain "github-router", so the walk finds no
    // root; classification must still land on `managed` via the path.
    const info = await classifyEntry(entry)
    expect(info.origin).toBe("managed")
  })

  test("a tree under the npx cache is npx", async () => {
    const cache = await tmpApp("npmcache")
    const entry = await fakeTree(path.join(cache, "_npx", "abc123"))
    // Point the npm probe at our fake cache by caching it in install-state.
    process.env.GH_ROUTER_APP_DIR = await tmpApp("app-npx")
    await fs.mkdir(managedRoot("self"), { recursive: true })
    await writeInstallState("self", {
    npmCache: cache,
    npmProbe: { runtime: process.execPath, cacheRoot: cache },
  })
    const info = await classifyEntry(entry)
    expect(info.origin).toBe("npx")
    expect(info.detail).toContain("_npx")
  })

  test("a .bunx- tree is bunx", async () => {
    process.env.GH_ROUTER_APP_DIR = await tmpApp("app-bunx")
    const entry = await fakeTree(`/tmp/.bunx-501/github-router@latest`)
    const info = await classifyEntry(entry)
    expect(info.origin).toBe("bunx")
  })

  test("the modern bun cache is bunx (bun no longer materialises .bunx-* trees)", async () => {
    // Current bun resolves `bunx` into its shared cache under $HOME, not into a
    // temp dir. `isUnderVolatileRoot` cannot see that (it is not the temp dir), so
    // without an explicit check the most common `bunx github-router` classified as
    // `unknown` — which means "never adopt, never install", i.e. the managed layer
    // silently never engaged for bun users.
    const file = path.join(os.homedir(), ".bun", "install", "cache", "github-router@0.3.379@@@1", "dist", "bin.js")
    const result = await classifyEntry(file)
    expect(result.origin).toBe("bunx")
  })

  test("a BUN_INSTALL override is honoured", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "bun-install-"))
    dirs.push(base)
    const file = path.join(base, "cache", "github-router@1.0.0@@@1", "dist", "bin.js")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "")
    const saved = process.env.BUN_INSTALL
    process.env.BUN_INSTALL = base
    try {
      const result = await classifyEntry(file)
      expect(result.origin).toBe("bunx")
    } finally {
      if (saved === undefined) delete process.env.BUN_INSTALL
      else process.env.BUN_INSTALL = saved
    }
  })

  test("bun's GLOBAL install is NOT bunx — it owns itself", async () => {
    // User decision 4: a global install is never duplicated. `bun add -g` lives
    // under ~/.bun/install/global, one level away from the cache, so a cache-root
    // prefix test that were one path segment too wide would silently replace a
    // binary the user installed themselves.
    const file = path.join(os.homedir(), ".bun", "install", "global", "node_modules", "x", "index.js")
    const result = await classifyEntry(file)
    expect(result.origin).not.toBe("bunx")
  })

  test("a temp-dir tree is bunx even without the .bunx- marker", async () => {
    process.env.GH_ROUTER_APP_DIR = await tmpApp("app-tmp")
    const entry = await fakeTree(path.join(os.tmpdir(), "some-extraction"))
    const info = await classifyEntry(entry)
    expect(info.origin).toBe("bunx")
  })

  test("a git checkout is source — even when it lives in a temp dir", async () => {
    const app = await tmpApp("app-src")
    process.env.GH_ROUTER_APP_DIR = app
    const repo = await tmpApp("repo")
    await fs.mkdir(path.join(repo, ".git"), { recursive: true })
    const entry = await fakeTree(repo)
    const info = await classifyEntry(entry)
    expect(info.origin).toBe("source")
  })

  test("a workspace package inside a repo is source (git above the package root)", async () => {
    process.env.GH_ROUTER_APP_DIR = await tmpApp("app-ws")
    const repo = await tmpApp("monorepo")
    await fs.mkdir(path.join(repo, ".git"), { recursive: true })
    const entry = await fakeTree(path.join(repo, "packages", "host"))
    const info = await classifyEntry(entry)
    expect(info.origin).toBe("source")
  })

  test("an unplaceable tree is unknown — never npx, never source-with-behaviour", async () => {
    process.env.GH_ROUTER_APP_DIR = await tmpApp("app-unk")
    // Outside the temp root (so not "bunx") and with no package.json to find
    // (so no package root to inspect). Nothing here needs to exist.
    const entry = path.join(os.homedir(), "elsewhere", "dist", "main.js")
    const info = await classifyEntry(entry)
    expect(info.origin).toBe("unknown")
  })

  test("no argv[1] is unknown, not a crash", async () => {
    const info = await classifyEntry(undefined)
    expect(info.origin).toBe("unknown")
    expect(info.detail).toContain("no argv[1]")
  })
})

describe("policy", () => {
  test("only the disposable origins adopt or install", () => {
    for (const origin of ["npx", "bunx"] as const) {
      expect(shouldAdoptFor(origin)).toBe(true)
      expect(shouldInstallFor(origin)).toBe(true)
    }
    for (const origin of ["managed", "npm-global", "source", "unknown"] as const) {
      expect(shouldAdoptFor(origin)).toBe(false)
      expect(shouldInstallFor(origin)).toBe(false)
    }
  })

  test("every origin has a human name", () => {
    for (const origin of ["managed", "npm-global", "npx", "bunx", "source", "unknown"] as const) {
      expect(describeOrigin(origin).length).toBeGreaterThan(3)
    }
  })
})
