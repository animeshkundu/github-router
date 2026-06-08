// Regression test for Bug #6: "ensureBridgeReady thundering herd"
//
// The bug: per the CLAUDE.md architecture invariant, ensureBridgeReady()
// runs BEFORE acquireInFlightSlot() — meaning concurrent browser_* tool calls
// all race directly on installNativeHostForAll(browsers), which does
// writeFileSync(manifestPath) for every detected browser, and on Windows
// spawns reg.exe per browser. File-locking conflicts on Windows, redundant
// reg.exe spawns, CPU spike.
//
// Fix: module-level single-flight Promise in ensureBridgeReady() so only
// one install attempt is in flight at a time. Concurrent callers share the
// in-flight result; installNativeHostForAll is called exactly once per cycle.
//
// Test isolation note: this file lives in tests/isolated/ because it uses
// mock.module() for native-host-installer and bridge-paths, which are shared
// with browser-mcp-gate.test.ts. The isolated/ directory signals to the test
// runner (and maintainers) that this file has module-scope mocks that must
// not bleed into sibling files.

import { afterEach, describe, expect, mock, test } from "bun:test"

import { tmpdir } from "node:os"
import { writeFileSync } from "node:fs"
import path from "node:path"

// Use a real temp file for the bridge bundle so bridgeBundleExists() = true
// without needing to patch node:fs.
const tmpBridgeBundle = path.join(tmpdir(), "gh-router-test-bridge-isolated.js")
writeFileSync(tmpBridgeBundle, "// fake bundle", "utf8")

// Non-existent path for discovery file so bridge_not_running fires.
const nonExistentDiscovery = path.join(
  tmpdir(),
  "gh-router-test-no-bridge-isolated.json",
)

let installCallCount = 0

mock.module("~/lib/browser-mcp/browser-detect", () => ({
  detectSupportedBrowsers: () => ["chrome"] as ["chrome"],
  _resetSupportedBrowserCache: () => undefined,
  hasSupportedBrowserInstalled: () => true,
}))

mock.module("~/lib/browser-mcp/native-host-installer", () => ({
  bridgeBundlePath: () => tmpBridgeBundle, // real file → bridgeBundleExists() = true
  extensionDir: () => "/fake-isolated/ext",
  computeExtensionIdFromKey: () => "a".repeat(32),
  installNativeHostForAll: (_browsers: string[]) => {
    installCallCount++
    return [{ browser: "chrome", manifestPath: "/fake-isolated/manifest.json" }]
  },
  __NMH_HOST_ID_FOR_TESTS: "com.githubrouter.browser",
}))

mock.module("~/lib/browser-mcp/bridge-paths", () => ({
  discoveryPath: () => nonExistentDiscovery,
}))

// Stub the stable-dir provisioning that ensureBridgeReady() now awaits, so
// the single-flight install count below reflects only the install-check
// path (and provision never touches the real filesystem).
mock.module("~/lib/browser-mcp/provision", () => ({
  provisionBrowserAssets: async () => {},
  __resetProvisionForTests: () => undefined,
}))

afterEach(() => {
  installCallCount = 0
})

describe("Bug #6 — ensureBridgeReady thundering herd", () => {
  test("8 concurrent calls invoke installNativeHostForAll exactly once", async () => {
    const { ensureBridgeReady, __resetEnsureBridgeReadyForTests } =
      await import("../../src/lib/browser-mcp/install-check")

    __resetEnsureBridgeReadyForTests()

    // Fire 8 concurrent calls — the concurrency count matches
    // MAX_INFLIGHT_TOOLS_CALL cap so this is a realistic thundering-herd
    // scenario during a busy Claude Code session.
    const N = 8
    const results = await Promise.all(
      Array.from({ length: N }, () => ensureBridgeReady()),
    )

    // All calls must return the same install_required payload.
    for (const r of results) {
      expect(r.install_required).toBe(true)
      const ir = r as { install_required: true; reason: string }
      expect(ir.reason).toBe("bridge_not_running")
    }

    // CRITICAL: installNativeHostForAll must have been called exactly once,
    // not 8 times. Without the single-flight guard the old code calls it N
    // times — one per concurrent ensureBridgeReady() invocation.
    expect(installCallCount).toBe(1)
  })

  test("second call after first settles runs a fresh install (not cached forever)", async () => {
    const { ensureBridgeReady, __resetEnsureBridgeReadyForTests } =
      await import("../../src/lib/browser-mcp/install-check")

    __resetEnsureBridgeReadyForTests()

    // First wave.
    await ensureBridgeReady()
    const afterFirst = installCallCount

    // After the Promise settles, _inFlightReady is cleared. A second call
    // should run a new impl invocation (not return a stale cached value).
    await ensureBridgeReady()
    expect(installCallCount).toBe(afterFirst + 1)
  })
})
