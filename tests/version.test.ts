import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { getPackageVersion } from "../src/lib/version"

test("getPackageVersion returns the package.json version (matches repo source of truth)", () => {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
  ) as { version: string }
  expect(getPackageVersion()).toBe(pkg.version)
})

test("getPackageVersion returns a non-empty semver-shaped string", () => {
  const v = getPackageVersion()
  expect(v).not.toBe("unknown")
  expect(v).toMatch(/^\d+\.\d+\.\d+/)
})
