import { describe, expect, test } from "bun:test"

import { retry } from "../src/retry"

describe("retry", () => {
  test("returns after a later attempt succeeds", async () => {
    let calls = 0
    const result = await retry(async () => {
      calls += 1
      if (calls < 3) throw new Error("not yet")
      return "ok"
    }, { attempts: 3, delayMs: 1 })
    expect(result).toBe("ok")
    expect(calls).toBe(3)
  })

  test("throws the final error", async () => {
    await expect(retry(async () => {
      throw new Error("offline")
    }, { attempts: 2, delayMs: 1 })).rejects.toThrow("offline")
  })
})
