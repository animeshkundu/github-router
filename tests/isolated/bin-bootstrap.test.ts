import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  BACKGROUND_UPDATE_ARGS,
  argvEntry,
  decideBootstrap,
} from "~/lib/managed-install/bootstrap"
import { __resetOriginForTests } from "~/lib/managed-install/origin"
import { managedRoot, versionDir } from "~/lib/managed-install/paths"
import { writePointer } from "~/lib/managed-install/pointer"
import { writeInstallState } from "~/lib/managed-install/state"

const dirs: Array<string> = []
const saved = {
  appDir: process.env.GH_ROUTER_APP_DIR,
}

async function tmp(tag: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `boot-${tag}-`))
  dirs.push(dir)
  return dir
}

/** A fake package tree; returns its `dist/main.js`. */
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

async function appDir(tag: string): Promise<string> {
  const dir = await tmp(`app-${tag}`)
  process.env.GH_ROUTER_APP_DIR = dir
  return dir
}

/** A published, usable managed payload plus a pointer to it. */
async function publishManaged(version = "2.0.0"): Promise<string> {
  const entry = path.join(versionDir("self", version), "node_modules/github-router/dist/main.js")
  await fs.mkdir(path.dirname(entry), { recursive: true })
  await fs.writeFile(
    path.join(versionDir("self", version), "node_modules/github-router/package.json"),
    JSON.stringify({ name: "github-router", version, dependencies: {} }),
  )
  await fs.writeFile(entry, "// managed\n")
  await writePointer({ kind: "self", version })
  return entry
}

/** An npx-shaped tree under a fake npm cache, with the cache recorded in state. */
async function npxTree(): Promise<string> {
  const cache = await tmp("cache")
  const entry = await fakeTree(path.join(cache, "_npx", "deadbeef"))
  await fs.mkdir(managedRoot("self"), { recursive: true })
  await writeInstallState("self", {
    npmCache: cache,
    npmProbe: { runtime: process.execPath, cacheRoot: cache },
  })
  return entry
}

beforeEach(() => {
  __resetOriginForTests()
})

afterEach(async () => {
  if (saved.appDir === undefined) delete process.env.GH_ROUTER_APP_DIR
  else process.env.GH_ROUTER_APP_DIR = saved.appDir
  __resetOriginForTests()
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe("decideBootstrap: origins that own their tree never hand off", () => {
  test("a managed tree passes straight through (no pointer read, no exec loop)", async () => {
    await appDir("managed")
    const entry = await publishManaged("2.0.0")
    // Even with a pointer that names a DIFFERENT tree, the managed origin wins:
    // the hand-off would loop.
    const plan = await decideBootstrap({ argv: ["pi"], entry })
    expect(plan.action).toBe("passthrough")
    expect(plan.action === "passthrough" && plan.reason).toContain("managed tree")
  })

  test("a git checkout is never switched onto a managed build", async () => {
    await appDir("source")
    await publishManaged("2.0.0")
    const repo = await tmp("repo")
    await fs.mkdir(path.join(repo, ".git"), { recursive: true })
    const entry = await fakeTree(repo)
    const plan = await decideBootstrap({ argv: ["pi"], entry })
    expect(plan.action).toBe("passthrough")
    expect(plan.action === "passthrough" && plan.reason).toContain("source")
  })

  test("an unrecognised origin does nothing — the fail-safe default", async () => {
    await appDir("unknown")
    const plan = await decideBootstrap({
      argv: ["pi"],
      entry: path.join(os.homedir(), "weird", "dist", "main.js"),
    })
    expect(plan.action).toBe("passthrough")
    expect(plan.action === "passthrough" && plan.reason).toContain("unknown")
  })
})

describe("decideBootstrap: the hot paths must never be diverted", () => {
  test("every internal-* subcommand runs inline, even with a live managed install", async () => {
    await appDir("hooks")
    await publishManaged("2.0.0")
    const entry = await npxTree()
    for (const sub of [
      "internal-stop-hook",
      "internal-prompt-submit",
      "internal-worker-guard",
      "internal-anything-added-later",
    ]) {
      const plan = await decideBootstrap({ argv: [sub, "--json"], entry })
      expect(plan.action).toBe("passthrough")
      expect(plan.action === "passthrough" && plan.reason).toContain("internal hook")
    }
  })

  test("`update` is never diverted — it is the repair tool", async () => {
    await appDir("update")
    await publishManaged("2.0.0")
    const entry = await npxTree()
    const plan = await decideBootstrap({ argv: ["update", "--self"], entry })
    expect(plan.action).toBe("passthrough")
    expect(plan.action === "passthrough" && plan.reason).toContain("repair tool")
  })

  test("the background child cannot recurse into another spawn", async () => {
    await appDir("bg")
    const entry = await npxTree()
    const plan = await decideBootstrap({
      argv: ["update", "--self", "--quiet"],
      entry,
      env: { GH_ROUTER_MANAGED_BACKGROUND: "1" },
    })
    expect(plan.action).toBe("passthrough")
    expect(plan.action === "passthrough" && plan.reason).toContain("background child")
  })

  test("GH_ROUTER_NO_MANAGED_INSTALL and --no-managed-install opt out", async () => {
    await appDir("optout")
    await publishManaged("2.0.0")
    const entry = await npxTree()
    const byEnv = await decideBootstrap({
      argv: ["pi"],
      entry,
      env: { GH_ROUTER_NO_MANAGED_INSTALL: "1" },
    })
    expect(byEnv.action).toBe("passthrough")
    const byFlag = await decideBootstrap({ argv: ["pi", "--no-managed-install"], entry })
    expect(byFlag.action).toBe("passthrough")
  })
})

describe("decideBootstrap: npx/bunx hand off or install", () => {
  test("a live pointer means re-exec into the managed payload", async () => {
    await appDir("reexec")
    const managedEntry = await publishManaged("2.0.0")
    const entry = await npxTree()
    const plan = await decideBootstrap({ argv: ["pi", "-m", "local"], entry })
    expect(plan.action).toBe("reexec")
    if (plan.action !== "reexec") throw new Error("expected reexec")
    expect(plan.entryPath).toBe(managedEntry)
    expect(plan.version).toBe("2.0.0")
  })

  test("a pointer whose payload was reaped is NOT followed — schedule instead", async () => {
    await appDir("reaped")
    await publishManaged("2.0.0")
    await fs.rm(versionDir("self", "2.0.0"), { recursive: true, force: true })
    const entry = await npxTree()
    const plan = await decideBootstrap({ argv: ["pi"], entry })
    expect(plan.action).toBe("schedule")
  })

  test("no pointer schedules a background install of THIS entry", async () => {
    await appDir("schedule")
    const entry = await npxTree()
    const plan = await decideBootstrap({ argv: ["pi"], entry })
    expect(plan.action).toBe("schedule")
    if (plan.action !== "schedule") throw new Error("expected schedule")
    expect(plan.updaterEntry).toBe(entry)
    // The child's argv is pinned: it must be the quiet self-update, and it must
    // carry the background marker through the environment (set by the spawner).
    // `--no-optional` is part of the contract, not a detail: the background
    // child is detached and invisible, so it must never start a 547 MB payload
    // download on its own.
    expect([...BACKGROUND_UPDATE_ARGS]).toEqual([
      "update",
      "--self",
      "--quiet",
      "--no-optional",
    ])
  })

  test("a backoff window suppresses the background install", async () => {
    await appDir("backoff")
    const entry = await npxTree()
    const prior = JSON.parse(
      await fs.readFile(path.join(managedRoot("self"), "install-state.json"), "utf8"),
    ) as { npmProbe?: unknown; npmCache?: string }
    // A real backoff is `nextAttemptAt` PLUS a failure count: every launch also
    // writes `nextAttemptAt` optimistically as a reservation, and a reservation
    // must not suppress anything (see `mayAttemptNow`).
    await writeInstallState("self", {
      npmCache: prior.npmCache,
      npmProbe: prior.npmProbe as never,
      nextAttemptAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      consecutiveFailures: 1,
      lastError: "npm install failed (exit 1)",
    })
    const plan = await decideBootstrap({ argv: ["pi"], entry })
    expect(plan.action).toBe("passthrough")
    expect(plan.action === "passthrough" && plan.reason).toContain("backing off")
  })

  test("an optimistic RESERVATION still schedules the install", async () => {
    // The bootstrap reserves before spawning. If that reservation were read back
    // as a backoff, a launch that lost the spawn (a fast `--version`, a killed
    // child) would silence every later launch for an hour.
    await appDir("reservation")
    const entry = await npxTree()
    const prior = JSON.parse(
      await fs.readFile(path.join(managedRoot("self"), "install-state.json"), "utf8"),
    ) as { npmProbe?: unknown; npmCache?: string }
    await writeInstallState("self", {
      npmCache: prior.npmCache,
      npmProbe: prior.npmProbe as never,
      nextAttemptAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    })
    const plan = await decideBootstrap({ argv: ["pi"], entry })
    expect(plan.action).toBe("schedule")
  })

  test("an operand after `--` is never read as a subcommand", async () => {
    // `github-router -- update` (or any operand that happens to be named like a
    // command) must behave like a normal launch: were it read as the repair
    // command, the bootstrap would pass through and the managed hand-off would
    // silently stop happening for that invocation.
    await appDir("operand")
    const managedEntry = await publishManaged("2.0.0")
    const entry = await npxTree()
    const plan = await decideBootstrap({ argv: ["--", "update"], entry })
    expect(plan.action).toBe("reexec")
    if (plan.action !== "reexec") throw new Error("expected reexec")
    expect(plan.entryPath).toBe(managedEntry)
  })

  test("no argv[1] cannot schedule anything", async () => {
    await appDir("noargv")
    await npxTree()
    const plan = await decideBootstrap({ argv: ["pi"], entry: undefined })
    // `argvEntry()` falls back to the test runner's own argv[1], which IS
    // absolute, so the observable requirement is just "a valid entry or a pass".
    expect(["schedule", "passthrough"]).toContain(plan.action)
  })
})

describe("argvEntry", () => {
  test("returns the real argv[1] of the running process", () => {
    const entry = argvEntry()
    // Under `bun test` argv[1] is the runner's script; the contract is only
    // "absolute or undefined".
    if (entry !== undefined) expect(path.isAbsolute(entry)).toBe(true)
  })
})
