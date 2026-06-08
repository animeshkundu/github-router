// Unit tests for the runtime resolver split in native-host-installer.ts:
// extensionDir() / bridgeBundlePath() prefer the materialized stable copy
// under <APP_DIR>, falling back to the bundled (dist/src) dir — while the
// stable paths themselves derive purely from <APP_DIR>, so they don't move
// when the npm/npx/bunx package path changes between versions.
//
// Isolated (own process) because it mock.module()s ~/lib/paths to redirect
// APP_DIR at a temp dir.

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const appDir = mkdtempSync(path.join(tmpdir(), "gh-resolver-app-"))

mock.module("~/lib/paths", () => ({
  PATHS: { APP_DIR: appDir },
}))

// Dynamic import AFTER the mock so native-host-installer binds the mocked
// PATHS (a static import would be hoisted above mock.module).
const {
  extensionDir,
  bridgeBundlePath,
  bundledExtensionDir,
  bundledBridgeBundlePath,
  stableExtensionDir,
  stableBridgeBundlePath,
} = await import("../../src/lib/browser-mcp/native-host-installer")

const stableExtDir = path.join(appDir, "browser-ext")
const stableBridge = path.join(appDir, "browser-bridge", "index.js")

function clearStable(): void {
  rmSync(stableExtDir, { recursive: true, force: true })
  rmSync(path.dirname(stableBridge), { recursive: true, force: true })
}

beforeEach(() => {
  delete process.env.GH_ROUTER_BROWSER_EXT_DIR
  clearStable()
})

afterAll(() => rmSync(appDir, { recursive: true, force: true }))

describe("stable-path helpers", () => {
  test("derive from APP_DIR, independent of the package path", () => {
    expect(stableExtensionDir()).toBe(stableExtDir)
    expect(stableBridgeBundlePath()).toBe(stableBridge)
  })
})

describe("extensionDir() resolution", () => {
  test("the GH_ROUTER_BROWSER_EXT_DIR override wins", () => {
    process.env.GH_ROUTER_BROWSER_EXT_DIR = "/override/ext"
    expect(extensionDir()).toBe("/override/ext")
  })

  test("prefers the stable copy when materialized", () => {
    mkdirSync(stableExtDir, { recursive: true })
    writeFileSync(
      path.join(stableExtDir, "manifest.json"),
      JSON.stringify({ version: "1.2.3", key: "K" }),
    )
    expect(extensionDir()).toBe(stableExtDir)
  })

  test("falls back to the bundled dir when no stable copy exists", () => {
    expect(existsSync(path.join(stableExtDir, "manifest.json"))).toBe(false)
    expect(extensionDir()).toBe(bundledExtensionDir())
  })
})

describe("bridgeBundlePath() resolution", () => {
  test("prefers the stable bridge when materialized", () => {
    mkdirSync(path.dirname(stableBridge), { recursive: true })
    writeFileSync(stableBridge, "// stable bridge")
    expect(bridgeBundlePath()).toBe(stableBridge)
  })

  test("falls back to the bundled bridge when no stable copy exists", () => {
    expect(existsSync(stableBridge)).toBe(false)
    expect(bridgeBundlePath()).toBe(bundledBridgeBundlePath())
  })
})
