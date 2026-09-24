import { describe, expect, test } from "bun:test"

import {
  isPiNewer,
  meetsPiMinVersion,
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

  test("meetsPiMinVersion enforces the 0.87.1 floor", () => {
    expect(meetsPiMinVersion("0.87.1")).toBe(true)
    expect(meetsPiMinVersion("0.99.0")).toBe(true)
    expect(meetsPiMinVersion("0.87.0")).toBe(false)
    expect(meetsPiMinVersion("0.80.10")).toBe(false)
    expect(meetsPiMinVersion(null)).toBe(false)
  })
})

describe("pi background refresh", () => {
  test("autoUpdate:false is a synchronous no-op (no npm, no fs, never throws)", () => {
    expect(refreshPiInBackground({ autoUpdate: false })).toBeUndefined()
  })
})
