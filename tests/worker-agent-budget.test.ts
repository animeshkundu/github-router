/**
 * Budget anti-loop guards: the consecutive-identical-call (duplicate-read)
 * guard and the absolute tool-call cap. Pure, deterministic — constructs a
 * `Budget` and drives `checkBeforeCall` directly.
 */

import { describe, expect, test } from "bun:test"

import { Budget } from "../src/lib/worker-agent/budget"

describe("Budget duplicate-call / anti-loop guard", () => {
  test("blocks the (maxRepeatedCalls+1)th consecutive identical call", () => {
    const b = new Budget({ maxRepeatedCalls: 3 })
    const args = { tabId: 1 }
    expect(b.checkBeforeCall("read_page", args).block).toBe(false) // 1
    expect(b.checkBeforeCall("read_page", args).block).toBe(false) // 2
    expect(b.checkBeforeCall("read_page", args).block).toBe(false) // 3
    const v = b.checkBeforeCall("read_page", args) // 4 → blocked
    expect(v.block).toBe(true)
    expect(v.reason).toContain("repeated")
    expect(v.reason).not.toContain("halted") // a per-call block, NOT a run halt
  })

  test("a different call between identical ones resets the streak", () => {
    const b = new Budget({ maxRepeatedCalls: 2 })
    const a = { tabId: 1 }
    b.checkBeforeCall("read_page", a) // 1
    b.checkBeforeCall("read_page", a) // 2 (at the limit, still allowed)
    expect(b.checkBeforeCall("scroll", { tabId: 1 }).block).toBe(false) // different → reset
    expect(b.checkBeforeCall("read_page", a).block).toBe(false) // 1 again
    expect(b.checkBeforeCall("read_page", a).block).toBe(false) // 2 again
    expect(b.checkBeforeCall("read_page", a).block).toBe(true) // 3 > 2 → blocked
  })

  test("distinct args are NOT treated as repeats", () => {
    const b = new Budget({ maxRepeatedCalls: 1 })
    expect(b.checkBeforeCall("read_page", { tabId: 1 }).block).toBe(false)
    expect(b.checkBeforeCall("read_page", { tabId: 2 }).block).toBe(false)
    expect(b.checkBeforeCall("read_page", { tabId: 3 }).block).toBe(false)
  })
})

describe("Budget max-tool-calls cap", () => {
  test("halts once the absolute tool-call cap is exceeded", () => {
    const b = new Budget({ maxToolCalls: 2, maxRepeatedCalls: 99 })
    expect(b.checkBeforeCall("a", {}).block).toBe(false) // 1
    expect(b.checkBeforeCall("b", {}).block).toBe(false) // 2
    const v = b.checkBeforeCall("c", {}) // 3 > 2 → halt
    expect(v.block).toBe(true)
    expect(v.reason).toContain("tool-calls")
  })
})
