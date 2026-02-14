import { test, expect, mock } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "github-router-paths-"),
)

mock.module("node:os", () => ({
  default: {
    homedir: () => tempDir,
  },
}))

const { ensurePaths, PATHS } = await import("../src/lib/paths")

test("ensurePaths creates token file with permissions", async () => {
  await ensurePaths()
  const tokenStats = await fs.stat(PATHS.GITHUB_TOKEN_PATH)
  expect(tokenStats.isFile()).toBe(true)
  // Windows doesn't enforce Unix permission bits; only check on Unix
  if (process.platform !== "win32") {
    expect(tokenStats.mode & 0o777).toBe(0o600)
  }
  expect(PATHS.APP_DIR).toBe(path.join(tempDir, ".local", "share", "github-router"))
})
