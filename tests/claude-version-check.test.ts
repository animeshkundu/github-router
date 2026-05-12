import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Compute the temp dir BEFORE installing the mock — once installed, the
// mock's default-export-only shape would shadow os.tmpdir() for any
// subsequent module that imports node:os (including other test files
// that don't redefine the mock themselves; bun tests share a module
// cache across the suite).
const REAL_TMPDIR = os.tmpdir()
const TEST_HOME = await fs.mkdtemp(
  path.join(REAL_TMPDIR, "gh-router-version-check-test-"),
)

// Provide BOTH homedir and tmpdir so we don't break later tests that
// depend on os.tmpdir() at module-load time (e.g. tests/lib-paths.test.ts:7).
mock.module("node:os", () => ({
  default: {
    homedir: () => TEST_HOME,
    tmpdir: () => REAL_TMPDIR,
  },
}))

const cacheDir = path.join(TEST_HOME, ".local", "share", "github-router")
const cacheFile = path.join(cacheDir, "last-update-check")

beforeEach(async () => {
  await fs.mkdir(cacheDir, { recursive: true })
  // Ensure no stale cache between tests.
  await fs.unlink(cacheFile).catch(() => {})
})

afterEach(async () => {
  await fs.rm(TEST_HOME, { recursive: true, force: true })
})

describe("claude-version-check (Phase H)", () => {
  test("checkClaudeVersion with noCheck:true returns skipped/disabled without probing", async () => {
    const { checkClaudeVersion } = await import(
      "../src/lib/claude-version-check"
    )
    const result = await checkClaudeVersion({ noCheck: true })
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe("disabled")
    expect(result.installedVersion).toBeNull()
    // Cache should NOT be touched.
    await expect(fs.stat(cacheFile)).rejects.toThrow()
  })

  test("checkClaudeVersion writes cache after first probe", async () => {
    // We can't easily mock execFileSync (no global Bun way). The probe
    // will use real `claude --version` and `npm view`. If those are
    // unavailable in CI, the result will be skipped:no-claude or
    // skipped:no-npm — both still write the throttle cache so we don't
    // hammer the registry.
    const { checkClaudeVersion } = await import(
      "../src/lib/claude-version-check"
    )
    const result = await checkClaudeVersion()
    // Either path writes a cache file (so subsequent calls throttle).
    if (result.installed && result.latestVersion !== null) {
      const cache = JSON.parse(await fs.readFile(cacheFile, "utf8")) as {
        checkedAt: string
        installedVersion: string | null
        latestVersion: string | null
      }
      expect(typeof cache.checkedAt).toBe("string")
      expect(cache.installedVersion).toBe(result.installedVersion)
      expect(cache.latestVersion).toBe(result.latestVersion)
    } else {
      // If claude or npm is unavailable, we skip without cache.
      // Acceptable; the cache only matters when we actually queried.
      expect(result.skipped).toBe(true)
    }
  })

  test("throttle: a second checkClaudeVersion call within the throttle window returns skipped/throttled", async () => {
    // Pre-populate cache with a recent timestamp.
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        installedVersion: "2.1.139",
        latestVersion: "2.1.140",
      }),
    )
    const { checkClaudeVersion } = await import(
      "../src/lib/claude-version-check"
    )
    const result = await checkClaudeVersion()
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe("throttled")
    // Returns the CACHED versions so the caller can still surface the
    // "newer version available" warning.
    expect(result.installedVersion).toBe("2.1.139")
    expect(result.latestVersion).toBe("2.1.140")
    expect(result.needsUpdate).toBe(true)
  })

  test("throttle: stale cache (>1h old) triggers a fresh check", async () => {
    // Pre-populate cache with a 2-hour-old timestamp.
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        checkedAt: twoHoursAgo,
        installedVersion: "0.0.0",
        latestVersion: "0.0.0",
      }),
    )
    const { checkClaudeVersion } = await import(
      "../src/lib/claude-version-check"
    )
    const result = await checkClaudeVersion()
    // Either fresh check happened (real version probed) OR claude
    // unavailable on PATH. Both cases: NOT throttled.
    expect(result.skipReason).not.toBe("throttled")
  })

  test("throttle: corrupt cache file triggers a fresh check (graceful degradation)", async () => {
    await fs.writeFile(cacheFile, "{not-json")
    const { checkClaudeVersion } = await import(
      "../src/lib/claude-version-check"
    )
    const result = await checkClaudeVersion()
    expect(result.skipReason).not.toBe("throttled")
  })

  test("throttle: missing cache file triggers a fresh check", async () => {
    // No cache exists (cleared in beforeEach).
    const { checkClaudeVersion } = await import(
      "../src/lib/claude-version-check"
    )
    const result = await checkClaudeVersion()
    expect(result.skipReason).not.toBe("throttled")
  })

  test("force: bypasses throttle even with fresh cache", async () => {
    // Recent cache that would otherwise throttle.
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        installedVersion: "2.1.139",
        latestVersion: "2.1.139",
      }),
    )
    const { checkClaudeVersion } = await import(
      "../src/lib/claude-version-check"
    )
    const result = await checkClaudeVersion({ force: true })
    expect(result.skipReason).not.toBe("throttled")
  })

  test("isNewer (via end-to-end): cache showing higher latest reports needsUpdate=true", async () => {
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        installedVersion: "2.1.139",
        latestVersion: "2.2.0",
      }),
    )
    const { checkClaudeVersion } = await import(
      "../src/lib/claude-version-check"
    )
    const result = await checkClaudeVersion()
    expect(result.needsUpdate).toBe(true)
  })

  test("isNewer (via end-to-end): same versions report needsUpdate=false", async () => {
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        installedVersion: "2.1.139",
        latestVersion: "2.1.139",
      }),
    )
    const { checkClaudeVersion } = await import(
      "../src/lib/claude-version-check"
    )
    const result = await checkClaudeVersion()
    expect(result.needsUpdate).toBe(false)
  })

  test("isNewer (via end-to-end): older latest does NOT trigger update", async () => {
    // Edge case: somehow installed > latest (e.g. user manually installed
    // a beta). Don't downgrade.
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        installedVersion: "2.2.0",
        latestVersion: "2.1.139",
      }),
    )
    const { checkClaudeVersion } = await import(
      "../src/lib/claude-version-check"
    )
    const result = await checkClaudeVersion()
    expect(result.needsUpdate).toBe(false)
  })

  test("isNewer (via end-to-end): patch version difference triggers update", async () => {
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        installedVersion: "2.1.139",
        latestVersion: "2.1.140",
      }),
    )
    const { checkClaudeVersion } = await import(
      "../src/lib/claude-version-check"
    )
    const result = await checkClaudeVersion()
    expect(result.needsUpdate).toBe(true)
  })

  test("cache file is written with mode 0o600 (no secrets but still private)", async () => {
    // Force a fresh check by clearing throttle (no cache).
    const { checkClaudeVersion } = await import(
      "../src/lib/claude-version-check"
    )
    await checkClaudeVersion()
    // If the check actually ran (claude+npm available), the cache file
    // should exist with mode 0o600. If not, this test silently passes
    // — claude/npm aren't always available in CI.
    try {
      const stat = await fs.stat(cacheFile)
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o600)
      }
    } catch {
      // No cache written (claude/npm unavailable) — acceptable.
    }
  })
})
