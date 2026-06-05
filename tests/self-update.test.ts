import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const REAL_TMPDIR = os.tmpdir()
const TEST_HOME = await fs.mkdtemp(
  path.join(REAL_TMPDIR, "gh-router-self-update-test-"),
)
mock.module("node:os", () => ({
  default: { homedir: () => TEST_HOME, tmpdir: () => REAL_TMPDIR },
}))

const cacheDir = path.join(TEST_HOME, ".local", "share", "github-router")
const cacheFile = path.join(cacheDir, "last-self-update-check")

beforeEach(async () => {
  await fs.mkdir(cacheDir, { recursive: true })
  await fs.unlink(cacheFile).catch(() => {})
  delete process.env.GH_ROUTER_NO_SELF_UPDATE
})
afterEach(async () => {
  await fs.rm(TEST_HOME, { recursive: true, force: true }).catch(() => {})
  delete process.env.GH_ROUTER_NO_SELF_UPDATE
})

describe("runSelfUpdate gating", () => {
  test("selfUpdate:false → no-op (no cache written, no probe)", async () => {
    const { runSelfUpdate } = await import("../src/lib/self-update")
    await runSelfUpdate({ selfUpdate: false })
    await expect(fs.stat(cacheFile)).rejects.toThrow()
  })

  test("GH_ROUTER_NO_SELF_UPDATE=1 → no-op", async () => {
    process.env.GH_ROUTER_NO_SELF_UPDATE = "1"
    const { runSelfUpdate } = await import("../src/lib/self-update")
    await runSelfUpdate({ selfUpdate: true })
    await expect(fs.stat(cacheFile)).rejects.toThrow()
  })

  test("throttle: a recent cache short-circuits before any probe", async () => {
    const sentinel = JSON.stringify({
      checkedAt: new Date().toISOString(),
      installedVersion: "9.9.9",
      latestVersion: "9.9.9",
    })
    await fs.writeFile(cacheFile, sentinel)
    const { runSelfUpdate } = await import("../src/lib/self-update")
    await runSelfUpdate({ selfUpdate: true })
    // Cache must be untouched (it returned before re-probing/writing).
    expect(await fs.readFile(cacheFile, "utf8")).toBe(sentinel)
  })
})

describe("isNewer reuse (shared with claude-version-check)", () => {
  test("multi-patch skew (release loop) is newer", async () => {
    const { isNewer } = await import("../src/lib/claude-version-check")
    expect(isNewer("0.3.68", "0.3.74")).toBe(true)
    expect(isNewer("1.0.0", "1.0.0")).toBe(false)
    expect(isNewer("2.0.0", "1.9.9")).toBe(false) // never downgrade
    expect(isNewer(null, "1.0.0")).toBe(false)
  })
})
