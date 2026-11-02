import { describe, expect, test } from "bun:test"

import { assertStandardServeModel } from "~/serve"

describe("serve model profile boundary", () => {
  test("accepts ordinary explicit model ids on the Standard serve surface", () => {
    expect(() => assertStandardServeModel(undefined)).not.toThrow()
    expect(() => assertStandardServeModel("claude-opus-5.5")).not.toThrow()
    expect(() => assertStandardServeModel("gpt-6-luna")).not.toThrow()
  })

  test("rejects fast and max aliases instead of mixing profile surfaces", () => {
    expect(() => assertStandardServeModel(" fast ")).toThrow(
      /claude -m fast.*serve uses the Standard roster, ACL, and model picker/i,
    )
    expect(() => assertStandardServeModel("MAX")).toThrow(
      /claude -m max.*serve uses the Standard roster, ACL, and model picker/i,
    )
  })

  test("rejects every fixed-profile alias, local included", () => {
    // `serve` is a Standard-profile surface by construction: its roster, ACL
    // and picker are the Standard ones, so launching it with any other
    // profile's lead model would ship a mismatched session. The guard keys on
    // `resolveLaunchProfile`, so a new alias is covered the moment the
    // resolver knows it — this pins that it stays that way.
    for (const alias of [
      "fast",
      "max",
      "cheap",
      "cheap1m",
      "cheapest",
      "cheapest2",
      "balanced",
      "balanced2",
      "local",
      "local2",
    ]) {
      expect(() => assertStandardServeModel(alias)).toThrow(
        new RegExp(`claude -m ${alias}.*Standard roster`, "i"),
      )
    }
  })

  test("an explicit model id still passes, so serve remains usable", () => {
    expect(() => assertStandardServeModel("opus")).not.toThrow()
    expect(() => assertStandardServeModel("claude-sonnet-5")).not.toThrow()
  })
})
