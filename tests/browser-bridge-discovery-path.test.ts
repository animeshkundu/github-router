// Regression test for the bridge.json path mismatch that made the
// browser-control MCP `install_required: bridge_not_running` on Windows
// even when the bridge was fully healthy. The bridge used to special-case
// win32 to `%LOCALAPPDATA%\github-router` while the install-check used
// the canonical XDG-style `~/.local/share/github-router` from
// `src/lib/paths.ts`. On Windows the writer and reader never met.
//
// Pin: `discoveryPath()` MUST resolve to `~/.local/share/github-router/
// browser-mcp/bridge.json` on every platform, matching `PATHS.APP_DIR`
// in `src/lib/paths.ts`. The bridge bundles this same module via tsdown,
// so a single source of truth governs both write and read sides.
//
// IMPORTANT: do not mock `os.homedir()`. Mocking masks the original bug
// because it aligns both sides accidentally. Use the real homedir and
// just assert the computed string matches the canonical formula.

import { test, expect } from "bun:test"
import os from "node:os"
import path from "node:path"

import { discoveryPath } from "../src/lib/browser-mcp/bridge-paths"
import { PATHS } from "../src/lib/paths"

test("discoveryPath() resolves under ~/.local/share/github-router on every platform", () => {
  const expected = path.join(
    os.homedir(),
    ".local",
    "share",
    "github-router",
    "browser-mcp",
    "bridge.json",
  )
  expect(discoveryPath()).toBe(expected)
})

test("discoveryPath() matches PATHS.APP_DIR + browser-mcp/bridge.json (canonical install-check formula)", () => {
  const installCheckExpected = path.join(
    PATHS.APP_DIR,
    "browser-mcp",
    "bridge.json",
  )
  expect(discoveryPath()).toBe(installCheckExpected)
})

test("discoveryPath() never resolves under %LOCALAPPDATA% on Windows (regression guard)", () => {
  // Even when the env var is set (which it is on Windows), the path must
  // not anchor on it. The historical bridge code used to branch on win32
  // and pick `%LOCALAPPDATA%\github-router` here; this test fails if that
  // branch is ever reintroduced.
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return // POSIX — env var absent, nothing to assert.
  expect(discoveryPath().startsWith(localAppData)).toBe(false)
})
