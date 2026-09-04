import { describe, expect, test } from "bun:test"

import { assertStandardServeModel } from "~/serve"

describe("serve model profile boundary", () => {
  test("accepts ordinary explicit model ids on the Standard serve surface", () => {
    expect(() => assertStandardServeModel(undefined)).not.toThrow()
    expect(() => assertStandardServeModel("claude-opus-5")).not.toThrow()
    expect(() => assertStandardServeModel("gpt-5.6-luna")).not.toThrow()
  })

  test("rejects fast and max aliases instead of mixing profile surfaces", () => {
    expect(() => assertStandardServeModel(" fast ")).toThrow(
      /claude -m fast.*serve uses the Standard roster, ACL, and model picker/i,
    )
    expect(() => assertStandardServeModel("MAX")).toThrow(
      /claude -m max.*serve uses the Standard roster, ACL, and model picker/i,
    )
  })
})
