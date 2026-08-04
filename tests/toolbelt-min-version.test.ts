// Toolbelt gap-fill must consider VERSION, not just presence.
//
// Gap-fill yields to whatever copy of a tool is already on the user's PATH so
// we never shadow a pinned or wrapper install. That is right for a tool we
// merely offer and wrong for one this project's own code depends on.
//
// Observed: a user with ast-grep 0.41.1 installed globally shadowed the
// toolbelt's pinned 0.43.0. `code_search`'s ast_pattern mode runs
// `sg run --json=stream`, which emits NOTHING and exits 0 on 0.41.1 while
// working on 0.43.0 — so structural search silently returned zero results,
// indistinguishable from "no matches". Nothing warned, because presence was
// the only thing ever checked.

import { describe, expect, test } from "bun:test"

import {
  parseVersionTriple,
  satisfiesMinVersion,
  TOOLBELT_TOOLS,
} from "~/lib/toolbelt/manifest"

describe("parseVersionTriple", () => {
  test("pulls the version out of the shapes these tools actually print", () => {
    // Real `--version` output formats from the pinned toolbelt set.
    expect(parseVersionTriple("ast-grep 0.41.1")).toEqual([0, 41, 1])
    expect(parseVersionTriple("fd 10.4.2")).toEqual([10, 4, 2])
    expect(parseVersionTriple("jq-1.7.1")).toEqual([1, 7, 1])
    expect(parseVersionTriple("yq (https://github.com/mikefarah/yq/) version v4.53.2")).toEqual([4, 53, 2])
    expect(parseVersionTriple("ripgrep 14.1.1\n-SIMD -AVX")).toEqual([14, 1, 1])
  })

  test("returns undefined when there is no version to find", () => {
    expect(parseVersionTriple("")).toBeUndefined()
    expect(parseVersionTriple("command not found")).toBeUndefined()
    // Two-part versions are not enough to compare against a triple.
    expect(parseVersionTriple("tool 1.7")).toBeUndefined()
  })
})

describe("satisfiesMinVersion", () => {
  test("the regression that motivated this: 0.41.1 does not satisfy 0.43.0", () => {
    expect(satisfiesMinVersion("ast-grep 0.41.1", "0.43.0")).toBe(false)
  })

  test("equal and newer both satisfy", () => {
    expect(satisfiesMinVersion("ast-grep 0.43.0", "0.43.0")).toBe(true)
    expect(satisfiesMinVersion("ast-grep 0.43.1", "0.43.0")).toBe(true)
    expect(satisfiesMinVersion("ast-grep 1.0.0", "0.43.0")).toBe(true)
  })

  test("compares numerically, not lexically", () => {
    // "0.9.0" > "0.43.0" as strings, but 9 < 43 as numbers.
    expect(satisfiesMinVersion("tool 0.9.0", "0.43.0")).toBe(false)
    expect(satisfiesMinVersion("tool 0.100.0", "0.43.0")).toBe(true)
    expect(satisfiesMinVersion("tool 2.0.0", "10.0.0")).toBe(false)
  })

  test("patch and minor are ordered independently", () => {
    expect(satisfiesMinVersion("tool 0.43.0", "0.43.1")).toBe(false)
    expect(satisfiesMinVersion("tool 0.44.0", "0.43.9")).toBe(true)
  })

  test("unparseable input is UNKNOWN, not false", () => {
    // Load-bearing: the caller treats undefined as "leave the user's tool
    // alone". Returning false here would make an unreadable --version
    // enough to shadow a user's pinned install, which is the exact
    // outcome gap-fill exists to prevent.
    expect(satisfiesMinVersion("", "0.43.0")).toBeUndefined()
    expect(satisfiesMinVersion("some error text", "0.43.0")).toBeUndefined()
    expect(satisfiesMinVersion("ast-grep 0.43.0", "not-a-version")).toBeUndefined()
  })
})

describe("manifest wiring", () => {
  test("ast-grep declares a minVersion matching its pinned asset", () => {
    const astGrep = TOOLBELT_TOOLS.find((t) => t.command === "ast-grep")
    expect(astGrep).toBeDefined()
    expect(astGrep?.minVersion).toBe("0.43.0")

    // The declared floor must not drift above what we actually ship, or
    // every user gets told their tool is too old and then handed one that
    // is also too old.
    for (const asset of Object.values(astGrep?.assets ?? {})) {
      expect(asset.url).toContain(`/${astGrep?.minVersion}/`)
    }
  })

  test("only tools we genuinely depend on carry a floor", () => {
    // A floor means "we will shadow the user's copy", so it should be a
    // deliberate, reviewed choice rather than something sprinkled around.
    const withFloor = TOOLBELT_TOOLS.filter((t) => t.minVersion).map((t) => t.command)
    expect(withFloor).toEqual(["ast-grep"])
  })
})
