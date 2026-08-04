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

// Mutable so a test can point the pre-flight at a REAL discovery file and
// exercise the healthy path, not just the bridge-not-running one.
let discoveryFile = nonExistentDiscovery

mock.module("~/lib/browser-mcp/bridge-paths", () => ({
  discoveryPath: () => discoveryFile,
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

// Regression test: version-mismatch detection used to fail OPEN.
//
// The check only ran when the loaded extension reported a version via the
// `__hello__` handshake. An extension predating that handshake reports
// nothing, so `typeof loaded === "string"` was false, the check was
// treated as "not applicable", and it silently skipped — forever, for
// exactly the most stale extensions it exists to catch.
//
// Observed consequence on a real machine: an extension months out of date
// kept serving every browser tool call while silently ignoring arguments
// added since (`quality` on browser_screenshot was the one that surfaced
// it — quality:1 and quality:95 returned byte-identical output). Nothing
// warned, because the mechanism designed to warn could not see it.
//
// This predicate had zero coverage, which is how the regression survived.
describe("extension staleness — absence of a version is a staleness signal", () => {
  test("no reported version means stale (the fail-open regression)", async () => {
    const { isExtensionStale } = await import("../../src/lib/browser-mcp/install-check")
    expect(isExtensionStale("0.3.250", undefined)).toBe(true)
  })

  test("differing versions are stale", async () => {
    const { isExtensionStale } = await import("../../src/lib/browser-mcp/install-check")
    expect(isExtensionStale("0.3.250", "0.3.249")).toBe(true)
  })

  test("matching versions are not stale", async () => {
    const { isExtensionStale } = await import("../../src/lib/browser-mcp/install-check")
    expect(isExtensionStale("0.3.250", "0.3.250")).toBe(false)
  })

  test("dev sentinel on either side is exempt — a source checkout is expected to diverge", async () => {
    const { isExtensionStale } = await import("../../src/lib/browser-mcp/install-check")
    // Loaded from a source checkout.
    expect(isExtensionStale("0.3.250", "0.0.0")).toBe(false)
    // Shipped manifest is itself the dev sentinel.
    expect(isExtensionStale("0.0.0", "0.3.249")).toBe(false)
    // Sentinel must win over the undefined-means-stale rule.
    expect(isExtensionStale("0.0.0", undefined)).toBe(false)
  })

  test("an unreadable shipped manifest never reports staleness", async () => {
    const { isExtensionStale } = await import("../../src/lib/browser-mcp/install-check")
    expect(isExtensionStale(undefined, "0.3.249")).toBe(false)
    expect(isExtensionStale(undefined, undefined)).toBe(false)
  })
})

// Perf regression guard: the native-messaging-host install must NOT run when
// the bridge is already healthy.
//
// It used to run unconditionally, before the health probe. `installNativeHostForAll`
// spawns `reg.exe` per browser SYNCHRONOUSLY, so every uncached pre-flight blocked
// the proxy's single event loop — measured at ~45ms per call, recurring every
// READY_CACHE_TTL_MS while browsing, on a process that is concurrently streaming a
// model response. A live bridge is itself proof the manifest is correct, since
// Chrome used it to spawn that process, so on the healthy path the install repairs
// nothing and only costs the stall.
//
// This is exactly the kind of property that regresses silently: moving the call
// back above the probe would still pass every functional test.
describe("NMH install does not run on the healthy path", () => {
  test("a healthy bridge + connected extension installs nothing", async () => {
    const { ensureBridgeReady, __resetEnsureBridgeReadyForTests } =
      await import("../../src/lib/browser-mcp/install-check")

    const liveDiscovery = path.join(tmpdir(), "gh-router-test-live-bridge.json")
    writeFileSync(
      liveDiscovery,
      JSON.stringify({ pid: 1234, port: 65123, token: "t", startedAt: Date.now() }),
      "utf8",
    )
    const realFetch = globalThis.fetch
    // Cast through `unknown`: a bare arrow is not assignable to `typeof fetch`,
    // which also carries `preconnect`. Whether that property is present varies
    // by @types surface, so the direct cast typechecks on some runners and not
    // others — going through `unknown` is stable everywhere.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: true, extension_connected: true, extension_loaded_version: "9.9.9" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch

    discoveryFile = liveDiscovery
    __resetEnsureBridgeReadyForTests()
    installCallCount = 0
    try {
      const result = await ensureBridgeReady()
      expect(result.install_required).toBe(false)
      // The whole point: zero synchronous reg.exe spawns on the hot path.
      expect(installCallCount).toBe(0)
    } finally {
      globalThis.fetch = realFetch
      discoveryFile = nonExistentDiscovery
      __resetEnsureBridgeReadyForTests()
    }
  })

  test("a missing bridge still installs, so a failure payload reports it", async () => {
    const { ensureBridgeReady, __resetEnsureBridgeReadyForTests } =
      await import("../../src/lib/browser-mcp/install-check")

    discoveryFile = nonExistentDiscovery
    __resetEnsureBridgeReadyForTests()
    installCallCount = 0

    const result = await ensureBridgeReady()
    expect(result.install_required).toBe(true)
    // Deferring the install must not lose it: every branch that returns an
    // install_required payload installs first, so auto_installed stays truthful.
    expect(installCallCount).toBe(1)
    if (result.install_required) {
      expect(result.auto_installed).toContain("nmh_manifest_chrome")
    }
    __resetEnsureBridgeReadyForTests()
  })
})
