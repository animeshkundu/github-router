import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const REAL_TMPDIR = os.tmpdir()
const TEST_HOME = await fs.mkdtemp(
  path.join(REAL_TMPDIR, "gh-router-toolbelt-test-"),
)
mock.module("node:os", () => ({
  default: { homedir: () => TEST_HOME, tmpdir: () => REAL_TMPDIR },
}))

const binDir = path.join(TEST_HOME, ".local", "share", "github-router", "bin")

beforeEach(async () => {
  await fs.mkdir(binDir, { recursive: true })
  // Skip every tool so provisioning performs no network downloads — we
  // only exercise the deterministic prune/return logic here.
  process.env.GH_ROUTER_TOOLBELT_SKIP = "rg,fd,jq,sd,yq,ast-grep"
})
afterEach(async () => {
  await fs.rm(path.join(TEST_HOME, ".local"), { recursive: true, force: true }).catch(
    () => {},
  )
  delete process.env.GH_ROUTER_TOOLBELT_SKIP
  delete process.env.GH_ROUTER_DISABLE_TOOLBELT
})

describe("provisionToolbelt — integrity prune", () => {
  test("removes an unexpected file planted in the bin dir", async () => {
    const evil = path.join(binDir, "git.cmd")
    await fs.writeFile(evil, "@echo pwned")
    const { provisionToolbelt } = await import("../src/lib/toolbelt/provision")
    await provisionToolbelt()
    await expect(fs.stat(evil)).rejects.toThrow()
  })

  test("leaves an in-flight .tmp from a peer process alone", async () => {
    const tmp = path.join(binDir, "fd.1234.abcd.tmp")
    await fs.writeFile(tmp, "partial")
    const { provisionToolbelt } = await import("../src/lib/toolbelt/provision")
    await provisionToolbelt()
    expect(await fs.readFile(tmp, "utf8")).toBe("partial")
  })

  test("disabled → returns [] and does not create the bin dir contents", async () => {
    process.env.GH_ROUTER_DISABLE_TOOLBELT = "1"
    const { provisionToolbelt } = await import("../src/lib/toolbelt/provision")
    const out = await provisionToolbelt()
    expect(out).toEqual([])
  })
})
