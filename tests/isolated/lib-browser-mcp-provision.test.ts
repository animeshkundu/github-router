// Unit tests for provisionBrowserAssets() — the stable-dir materialization
// that makes a one-time Chrome "Load unpacked" survive npx/bunx upgrades.
//
// Isolated (own process) because it mock.module()s native-host-installer +
// browser-detect to redirect the bundled/stable paths at controlled temp
// dirs, so the test never touches the real package dist or the user's
// <APP_DIR>.

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { getPackageVersion } from "../../src/lib/version"

const root = mkdtempSync(path.join(tmpdir(), "gh-provision-"))
const bundledExt = path.join(root, "bundled", "browser-ext")
const bundledBridge = path.join(root, "bundled", "browser-bridge", "index.js")
const stableExt = path.join(root, "stable", "browser-ext")
const stableBridge = path.join(root, "stable", "browser-bridge", "index.js")

let installCalls = 0

mock.module("~/lib/browser-mcp/native-host-installer", () => ({
  bundledExtensionDir: () => bundledExt,
  bundledBridgeBundlePath: () => bundledBridge,
  stableExtensionDir: () => stableExt,
  stableBridgeBundlePath: () => stableBridge,
  installNativeHostForAll: () => {
    installCalls++
    return [{ browser: "chrome", manifestPath: "/fake/manifest.json" }]
  },
}))

mock.module("~/lib/browser-mcp/browser-detect", () => ({
  detectSupportedBrowsers: () => ["chrome"] as ["chrome"],
}))

function seedBundled(bgContent: string): void {
  rmSync(path.dirname(bundledBridge), { recursive: true, force: true })
  mkdirSync(bundledExt, { recursive: true })
  mkdirSync(path.dirname(bundledBridge), { recursive: true })
  writeFileSync(
    path.join(bundledExt, "manifest.json"),
    `${JSON.stringify(
      { manifest_version: 3, name: "x", version: "0.0.0", key: "FAKEKEY" },
      null,
      2,
    )}\n`,
  )
  writeFileSync(path.join(bundledExt, "background.js"), bgContent)
  writeFileSync(path.join(bundledExt, "snapshot.js"), "// snap")
  writeFileSync(path.join(bundledExt, "snapshot-cdp.js"), "// snap-cdp")
  writeFileSync(path.join(bundledExt, "README.md"), "dev readme")
  writeFileSync(bundledBridge, "// v1 bridge")
}

beforeEach(async () => {
  installCalls = 0
  rmSync(path.join(root, "stable"), { recursive: true, force: true })
  seedBundled("// v1 background")
  const { __resetProvisionForTests } = await import(
    "../../src/lib/browser-mcp/provision"
  )
  __resetProvisionForTests()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("provisionBrowserAssets", () => {
  test("materializes the extension + bridge and stamps the running version", async () => {
    const { provisionBrowserAssets } = await import(
      "../../src/lib/browser-mcp/provision"
    )
    await provisionBrowserAssets()

    expect(existsSync(path.join(stableExt, "manifest.json"))).toBe(true)
    expect(existsSync(stableBridge)).toBe(true)

    const manifest = JSON.parse(
      readFileSync(path.join(stableExt, "manifest.json"), "utf8"),
    ) as { version: string }
    // The single-place version stamp: the materialized manifest carries
    // the running proxy version, not the bundled sentinel.
    expect(manifest.version).toBe(getPackageVersion())

    expect(readFileSync(path.join(stableExt, "background.js"), "utf8")).toBe(
      "// v1 background",
    )
    expect(readFileSync(stableBridge, "utf8")).toBe("// v1 bridge")
    // README is dev-only context and must not ship to the load-unpacked dir.
    expect(existsSync(path.join(stableExt, "README.md"))).toBe(false)
    // The launcher / NMH manifests are (re)pointed at the stable bridge.
    expect(installCalls).toBeGreaterThanOrEqual(1)
  })

  test("is a no-op when the content signature is unchanged", async () => {
    const { provisionBrowserAssets, __resetProvisionForTests } = await import(
      "../../src/lib/browser-mcp/provision"
    )
    await provisionBrowserAssets()

    // Tamper with the materialized file, then re-provision with the SAME
    // source. An unchanged signature must short-circuit the copy, so the
    // sentinel survives.
    writeFileSync(path.join(stableExt, "background.js"), "// SENTINEL")
    __resetProvisionForTests()
    await provisionBrowserAssets()

    expect(readFileSync(path.join(stableExt, "background.js"), "utf8")).toBe(
      "// SENTINEL",
    )
  })

  test("replaces stale materialized files when the source changes", async () => {
    const { provisionBrowserAssets, __resetProvisionForTests } = await import(
      "../../src/lib/browser-mcp/provision"
    )
    await provisionBrowserAssets()
    expect(readFileSync(path.join(stableExt, "background.js"), "utf8")).toBe(
      "// v1 background",
    )

    // New shipped content (e.g. a package upgrade) → signature changes →
    // the stable copy is refreshed.
    seedBundled("// v2 background")
    __resetProvisionForTests()
    await provisionBrowserAssets()

    expect(readFileSync(path.join(stableExt, "background.js"), "utf8")).toBe(
      "// v2 background",
    )
    const manifest = JSON.parse(
      readFileSync(path.join(stableExt, "manifest.json"), "utf8"),
    ) as { version: string }
    expect(manifest.version).toBe(getPackageVersion())
  })

  test("re-copies when a new (unlisted) source file appears", async () => {
    const { provisionBrowserAssets, __resetProvisionForTests } = await import(
      "../../src/lib/browser-mcp/provision"
    )
    await provisionBrowserAssets()

    // A new asset added to the bundled extension (not in any hardcoded
    // list) must change the content signature and re-copy.
    writeFileSync(path.join(bundledExt, "content.js"), "// new asset")
    __resetProvisionForTests()
    await provisionBrowserAssets()

    expect(readFileSync(path.join(stableExt, "content.js"), "utf8")).toBe(
      "// new asset",
    )
  })

  test("is a clean no-op when the bundled bridge bundle is absent", async () => {
    const { provisionBrowserAssets } = await import(
      "../../src/lib/browser-mcp/provision"
    )
    // Fresh source checkout that hasn't run `bun run build`.
    rmSync(bundledBridge, { force: true })
    await provisionBrowserAssets()

    expect(existsSync(path.join(stableExt, "manifest.json"))).toBe(false)
    expect(existsSync(stableBridge)).toBe(false)
    expect(installCalls).toBe(0)
  })

  test("honors the GH_ROUTER_DISABLE_BROWSER_PROVISION opt-out", async () => {
    const { provisionBrowserAssets } = await import(
      "../../src/lib/browser-mcp/provision"
    )
    const prev = process.env.GH_ROUTER_DISABLE_BROWSER_PROVISION
    process.env.GH_ROUTER_DISABLE_BROWSER_PROVISION = "1"
    try {
      await provisionBrowserAssets()
      expect(existsSync(path.join(stableExt, "manifest.json"))).toBe(false)
      expect(installCalls).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.GH_ROUTER_DISABLE_BROWSER_PROVISION
      else process.env.GH_ROUTER_DISABLE_BROWSER_PROVISION = prev
    }
  })
})
