/**
 * Tests for `src/lib/search-concurrency.ts` (Phase 1, A8).
 *
 * Weight-based FIFO semaphore bounding ACTIVE search weight, plus
 * `recommendedRgThreads()` for spawn-time ripgrep thread sizing (A5).
 * Env-driven (`GH_ROUTER_SEARCH_MAX_WEIGHT`) so tests pin exact
 * capacities without depending on the host's core count.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  __resetSearchConcurrencyForTests,
  acquireSearchSlot,
  currentSearchWeight,
  maxSearchWeight,
  queuedSearchCount,
  recommendedRgThreads,
} from "../src/lib/search-concurrency"

beforeEach(() => {
  __resetSearchConcurrencyForTests()
  delete process.env.GH_ROUTER_SEARCH_MAX_WEIGHT
  delete process.env.GH_ROUTER_SEARCH_NO_LIMIT
})

afterEach(() => {
  __resetSearchConcurrencyForTests()
  delete process.env.GH_ROUTER_SEARCH_MAX_WEIGHT
  delete process.env.GH_ROUTER_SEARCH_NO_LIMIT
})

describe("acquireSearchSlot", () => {
  test("fast path: under capacity resolves immediately", async () => {
    process.env.GH_ROUTER_SEARCH_MAX_WEIGHT = "10"
    const release = await acquireSearchSlot("ranked")
    expect(currentSearchWeight()).toBe(1.0)
    release()
    expect(currentSearchWeight()).toBe(0)
  })

  test("release is idempotent", async () => {
    process.env.GH_ROUTER_SEARCH_MAX_WEIGHT = "10"
    const release = await acquireSearchSlot("ranked")
    release()
    release()
    expect(currentSearchWeight()).toBe(0)
  })

  test("over capacity queues FIFO; release drains in order", async () => {
    process.env.GH_ROUTER_SEARCH_MAX_WEIGHT = "1"
    const order: Array<string> = []
    const r1 = await acquireSearchSlot("ranked") // holds the 1.0
    expect(currentSearchWeight()).toBe(1.0)

    const p2 = acquireSearchSlot("literal").then((rel) => {
      order.push("second")
      return rel
    })
    const p3 = acquireSearchSlot("literal").then((rel) => {
      order.push("third")
      return rel
    })
    // Let the queue settle.
    await Bun.sleep(10)
    expect(queuedSearchCount()).toBe(2)

    r1() // frees 1.0 → both 0.5 waiters fit
    const [rel2, rel3] = await Promise.all([p2, p3])
    expect(order).toEqual(["second", "third"])
    rel2()
    rel3()
    expect(currentSearchWeight()).toBe(0)
  })

  test("small waiter fits into partial capacity while large waits", async () => {
    process.env.GH_ROUTER_SEARCH_MAX_WEIGHT = "1"
    const r1 = await acquireSearchSlot("ranked") // 1.0 held
    let smallRan = false
    const pSmall = acquireSearchSlot("literal").then((rel) => {
      smallRan = true
      return rel
    })
    await Bun.sleep(10)
    expect(queuedSearchCount()).toBe(1)
    expect(smallRan).toBe(false)
    r1()
    const relSmall = await pSmall
    expect(smallRan).toBe(true)
    expect(currentSearchWeight()).toBe(0.5)
    relSmall()
  })

  test("pre-aborted signal rejects immediately", async () => {
    process.env.GH_ROUTER_SEARCH_MAX_WEIGHT = "10"
    const ac = new AbortController()
    ac.abort()
    await expect(acquireSearchSlot("ranked", ac.signal)).rejects.toThrow(
      /aborted before dispatch/,
    )
    expect(currentSearchWeight()).toBe(0)
  })

  test("abort while queued removes waiter and rejects", async () => {
    process.env.GH_ROUTER_SEARCH_MAX_WEIGHT = "1"
    const r1 = await acquireSearchSlot("ranked")
    const ac = new AbortController()
    const p = acquireSearchSlot("ranked", ac.signal)
    await Bun.sleep(10)
    expect(queuedSearchCount()).toBe(1)
    ac.abort()
    await expect(p).rejects.toThrow(/aborted while queued/)
    expect(queuedSearchCount()).toBe(0)
    // The held slot is unaffected.
    expect(currentSearchWeight()).toBe(1.0)
    r1()
    expect(currentSearchWeight()).toBe(0)
  })

  test("bypass switch makes acquisition a no-op", async () => {
    process.env.GH_ROUTER_SEARCH_NO_LIMIT = "1"
    process.env.GH_ROUTER_SEARCH_MAX_WEIGHT = "0.001"
    const release = await acquireSearchSlot("ranked")
    expect(currentSearchWeight()).toBe(0)
    release()
  })
})

describe("maxSearchWeight", () => {
  test("env override wins; invalid falls back to cpus*1.5", async () => {
    process.env.GH_ROUTER_SEARCH_MAX_WEIGHT = "7.5"
    expect(maxSearchWeight()).toBe(7.5)
    process.env.GH_ROUTER_SEARCH_MAX_WEIGHT = "bogus"
    expect(maxSearchWeight()).toBeGreaterThan(0)
    delete process.env.GH_ROUTER_SEARCH_MAX_WEIGHT
    expect(maxSearchWeight()).toBeGreaterThan(0)
  })
})

describe("recommendedRgThreads", () => {
  test("sole searcher gets a full share; load divides it", async () => {
    process.env.GH_ROUTER_SEARCH_MAX_WEIGHT = "100"
    // No active searches → full cores.
    const solo = recommendedRgThreads()
    expect(solo).toBeGreaterThanOrEqual(1)

    // Simulate 6 concurrent ranked searches via the real semaphore.
    const releases: Array<() => void> = []
    for (let i = 0; i < 6; i++) releases.push(await acquireSearchSlot("ranked"))
    const loaded = recommendedRgThreads()
    expect(loaded).toBeLessThanOrEqual(solo)
    expect(loaded).toBeGreaterThanOrEqual(1)
    for (const rel of releases) rel()
    expect(recommendedRgThreads()).toBe(solo)
  })
})
