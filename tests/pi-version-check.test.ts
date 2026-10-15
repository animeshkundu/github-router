import { describe, expect, test } from "bun:test"

import {
  isPiNewer,
  meetsPiMinVersion,
  PI_MIN_VERSION,
  refreshPiInBackground,
} from "~/lib/pi-version-check"

describe("pi version comparison", () => {
  test("isPiNewer compares semver triples strictly", () => {
    expect(isPiNewer("0.87.1", "0.87.2")).toBe(true)
    expect(isPiNewer("0.87.2", "0.87.1")).toBe(false)
    expect(isPiNewer("0.87.1", "0.87.1")).toBe(false)
    expect(isPiNewer(null, "0.87.1")).toBe(false)
    expect(isPiNewer("0.87.1", null)).toBe(false)
  })

  test("meetsPiMinVersion enforces PI_MIN_VERSION exactly at its boundary", () => {
    // Asserted against the constant rather than a literal: the floor moves with
    // the vendored pin, and a hardcoded version here would silently keep
    // passing after a deliberate raise. The exact floor VALUE is pinned in
    // tests/isolated/pi-version-registry.test.ts.
    expect(meetsPiMinVersion(PI_MIN_VERSION)).toBe(true)
    const [major, minor, patch] = PI_MIN_VERSION.split(".").map((n) => parseInt(n, 10))
    expect(meetsPiMinVersion(`${major}.${minor}.${patch - 1}`)).toBe(false)
    expect(meetsPiMinVersion(`${major}.${Math.max(0, minor - 1)}.999`)).toBe(false)
    expect(meetsPiMinVersion(`${major}.${minor + 1}.0`)).toBe(true)
    expect(meetsPiMinVersion(null)).toBe(false)
  })
})

describe("pi background refresh", () => {
  test("autoUpdate:false is a synchronous no-op (no npm, no fs, never throws)", () => {
    expect(refreshPiInBackground({ autoUpdate: false })).toBeUndefined()
  })
})
