import { afterEach, describe, expect, test } from "bun:test"

import {
  availableToolCommands,
  buildToolbeltAwareness,
} from "../src/lib/toolbelt"
import { assetFor, TOOLBELT_TOOLS } from "../src/lib/toolbelt/manifest"

afterEach(() => {
  delete process.env.GH_ROUTER_TOOLBELT_SKIP
  delete process.env.GH_ROUTER_DISABLE_TOOLBELT
})

describe("availableToolCommands", () => {
  // The awareness set must include curated tools the agent can call —
  // whether already on the system PATH or materialized into the toolbelt
  // bin. On every CI platform (linux-x64, win32-x64) all manifest tools
  // are provisionable, so they are all advertised regardless of whether
  // the host already has them (the key behavior change vs the old
  // gap-fill-only plan).
  test("advertises every curated tool this platform can provide", () => {
    const got = availableToolCommands()
    // Derived from the manifest rather than hardcoded to five names: `sd`
    // and `jq` publish no upstream `win32-arm64` artifact, so on a Windows
    // ARM64 host they are correctly absent and a fixed name list would be
    // asserting something no amount of provisioning can deliver. Deriving
    // it keeps the assertion loud where it matters — on the platforms CI
    // runs, `provisionable` is the whole manifest, so a curated tool that
    // loses its build (or a new one added without an asset) fails here.
    const provisionable = TOOLBELT_TOOLS
      .filter((spec) => assetFor(spec) !== undefined)
      .map((spec) => spec.command)
    for (const t of provisionable) {
      expect(got).toContain(t)
    }
    // Guard the derivation itself: if `assetFor` ever answers undefined for
    // everything, the loop above passes while testing nothing.
    expect(provisionable.length).toBeGreaterThanOrEqual(4)
  })

  test("GH_ROUTER_TOOLBELT_SKIP removes listed tools", () => {
    process.env.GH_ROUTER_TOOLBELT_SKIP = "jq,yq"
    const got = availableToolCommands()
    expect(got).not.toContain("jq")
    expect(got).not.toContain("yq")
    expect(got).toContain("fd")
  })

  test("GH_ROUTER_DISABLE_TOOLBELT=1 → empty list", () => {
    process.env.GH_ROUTER_DISABLE_TOOLBELT = "1"
    expect(availableToolCommands()).toEqual([])
  })
})

describe("buildToolbeltAwareness", () => {
  test("null when no tools available", () => {
    expect(buildToolbeltAwareness([])).toBeNull()
  })

  test("mentions PATH and describes each command (ast-grep → sg)", () => {
    const line = buildToolbeltAwareness(["rg", "ast-grep", "yq"])
    expect(line).toContain("PATH")
    expect(line).toContain("rg")
    expect(line).toContain("sg") // ast-grep description includes the sg alias
    expect(line).toContain("yq")
  })
})
