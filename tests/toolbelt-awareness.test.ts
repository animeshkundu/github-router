import { afterEach, describe, expect, test } from "bun:test"

import {
  availableToolCommands,
  buildToolbeltAwareness,
} from "../src/lib/toolbelt"

afterEach(() => {
  delete process.env.GH_ROUTER_TOOLBELT_SKIP
  delete process.env.GH_ROUTER_DISABLE_TOOLBELT
})

describe("availableToolCommands", () => {
  // The awareness set must include curated tools the agent can call —
  // whether already on the system PATH or materialized into the toolbelt
  // bin. On every CI/dev platform (linux-x64, win32-x64) all manifest
  // tools are provisionable, so they are all advertised regardless of
  // whether the host already has them (the key behavior change vs the
  // old gap-fill-only plan).
  test("advertises all curated manifest tools on a supported platform", () => {
    const got = availableToolCommands()
    for (const t of ["fd", "jq", "sd", "yq", "ast-grep"]) {
      expect(got).toContain(t)
    }
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
