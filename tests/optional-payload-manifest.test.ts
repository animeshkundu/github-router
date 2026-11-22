/**
 * The optional-payload manifest must name files the packages actually ship.
 *
 * This is a one-assertion test with a real bug behind it. `OPTIONAL_REQUIRED_FILE`
 * is what proves an on-demand install finished: npm exits 0, then `completeAt()`
 * stats one file and refuses the payload if it is absent. The check runs against
 * the REAL package layout, so a typo does not fail loudly — it fails as an
 * install that succeeds and is then thrown away, with the package state backing
 * off for an hour and structural ranking quietly staying on the regex fallback.
 * That is exactly what happened with `out/typescript.wasm`
 * (`tree-sitter-wasms` ships `out/tree-sitter-typescript.wasm`).
 *
 * The packages are devDependencies of this repo precisely so their real layouts
 * are available here; when they are genuinely not installed (a production
 * install), the assertion is skipped rather than failed.
 */

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import pkgJson from "../package.json"
import {
  OPTIONAL_PACKAGES,
  OPTIONAL_REQUIRED_FILE,
  OPTIONAL_VERSION_RANGE,
} from "~/lib/managed-install/optional"

const require = createRequire(import.meta.url)

function packageRoot(pkg: string): string | null {
  try {
    return path.dirname(require.resolve(`${pkg}/package.json`))
  } catch {
    return null
  }
}

describe("OPTIONAL_REQUIRED_FILE names files the real packages ship", () => {
  for (const pkg of OPTIONAL_PACKAGES) {
    const root = packageRoot(pkg)
    test.skipIf(root === null)(`${pkg} contains ${OPTIONAL_REQUIRED_FILE[pkg]}`, () => {
      expect(existsSync(path.join(root!, OPTIONAL_REQUIRED_FILE[pkg]))).toBe(true)
    })
  }
})

describe("OPTIONAL_VERSION_RANGE matches the peer range we declare", () => {
  // The on-demand installer resolves `npm view <pkg>@<range> version`, so this
  // table IS the compatibility bound. If `package.json` widens to a major the
  // router has never run (transformers 5, say) and the table is not updated, the
  // on-demand path stays on 4.x — silently diverging from what a normal
  // `npm install` of this package would bring in. The reverse (table wider than
  // package.json) installs a runtime nothing has tested. One source of truth is
  // not available here — the range has to be readable at runtime without
  // reading our own package.json from a possibly-reaped npx tree — so pin them.
  for (const pkg of OPTIONAL_PACKAGES) {
    test(`${pkg} range is the declared peer range`, () => {
      expect(OPTIONAL_VERSION_RANGE[pkg]).toBe(
        (pkgJson.peerDependencies as Record<string, string>)[pkg],
      )
    })
  }
})
