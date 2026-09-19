/**
 * Loader-behavior tests for `src/lib/rerank.ts` with a MOCKED flashrank-js.
 *
 * Real ONNX sessions crash `bun test` at teardown (SIGABRT after a green
 * run; see tests/rerank.test.ts header), so every loader interaction here
 * goes through this deterministic fake — no native code, no network, no
 * model downloads. Live-model verification is `bun run
 * scripts/verify-rerank-live.ts` (manual/CI script lane, not `bun test`).
 *
 * Isolated (own process): the module mock is process-global.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

// ---- Controllable fake (hoisted consts read by the factory) ----
let fakeLatencyMs = 0
let fakeShouldThrow = false
let fakeOrder: ((n: number) => Array<number>) | null = null
const requestedModels: Array<string> = []

mock.module("flashrank-js", () => ({
  Reranker: {
    create: async (opts: { model: string }) => {
      requestedModels.push(opts.model)
      if (fakeLatencyMs > 0) await Bun.sleep(fakeLatencyMs)
      if (fakeShouldThrow) throw new Error("fake load failure")
      return {
        rerank: async (req: {
          query: string
          documents: Array<string>
          topN: number
        }) => {
          const n = Math.min(req.topN, req.documents.length)
          const order = fakeOrder
            ? fakeOrder(req.documents.length)
            : req.documents.map((_, i) => i)
          return order.slice(0, n).map((index) => ({ index, score: 1 - index * 0.1 }))
        },
        dispose: async () => {},
      }
    },
  },
}))

// Import AFTER the mock so rerank.ts binds to the fake.
let rerankModule: typeof import("../../src/lib/rerank")
let concurrency: typeof import("../../src/lib/search-concurrency")

beforeEach(async () => {
  rerankModule = await import("../../src/lib/rerank")
  concurrency = await import("../../src/lib/search-concurrency")
  fakeLatencyMs = 0
  fakeShouldThrow = false
  fakeOrder = null
  requestedModels.length = 0
  rerankModule.__resetRerankerForTests()
  concurrency.__resetSearchConcurrencyForTests()
  delete process.env.GH_ROUTER_RERANK
  delete process.env.GH_ROUTER_RERANK_BUDGET_MS
  delete process.env.GH_ROUTER_SEARCH_MAX_WEIGHT
})

afterEach(() => {
  rerankModule.__resetRerankerForTests()
  concurrency.__resetSearchConcurrencyForTests()
  delete process.env.GH_ROUTER_RERANK
  delete process.env.GH_ROUTER_RERANK_BUDGET_MS
  delete process.env.GH_ROUTER_SEARCH_MAX_WEIGHT
})

describe("loader behavior (mocked flashrank-js)", () => {
  test("fast loader returns the fake order", async () => {
    fakeOrder = (n) => [...Array(n).keys()].reverse()
    const out = await rerankModule.rerankDocuments("q q", ["a", "b", "c"], 3)
    expect(out).toEqual([2, 1, 0])
    expect(requestedModels).toEqual(["mini"]) // idle → mini
  })

  test("slow loader loses the budget race → null, BM25F stands", async () => {
    fakeLatencyMs = 500
    process.env.GH_ROUTER_RERANK_BUDGET_MS = "50"
    const out = await rerankModule.rerankDocuments("q q", ["a", "b"], 2)
    expect(out).toBeNull()
    // Drain the orphaned load: it blocks the serialization chain, and
    // without this every later test's load queues behind 500ms of dead
    // time (plus pushes landing in the wrong test's window).
    await rerankModule.drainRerankerLoads()
  })

  test("throwing loader → null (never throws to the caller)", async () => {
    fakeShouldThrow = true
    const out = await rerankModule.rerankDocuments("q q", ["a"], 1)
    expect(out).toBeNull()
  })

  test("queued searches select tiny; idle selects mini", async () => {
    process.env.GH_ROUTER_SEARCH_MAX_WEIGHT = "1"
    // Saturate the semaphore, then park a REAL waiter so the queue is
    // non-empty when rerankDocuments reads it. (rerankDocuments itself
    // never acquires — it only observes queue pressure.)
    const holder = await concurrency.acquireSearchSlot("ranked")
    try {
      const waiter = concurrency.acquireSearchSlot("ranked")
      await Bun.sleep(10)
      expect(concurrency.queuedSearchCount()).toBeGreaterThan(0)
      const out = await rerankModule.rerankDocuments("q q", ["a", "b"], 2)
      expect(out).not.toBeNull()
      expect(requestedModels).toEqual(["tiny"])
      holder()
      const waiterRelease = await waiter
      waiterRelease()
    } finally {
      holder()
    }
  })

  test("forced model env wins over load-adaptive selection", async () => {
    process.env.GH_ROUTER_RERANK = "tiny"
    process.env.GH_ROUTER_SEARCH_MAX_WEIGHT = "1"
    const holder = await concurrency.acquireSearchSlot("ranked")
    try {
      const out = await rerankModule.rerankDocuments("q q", ["a"], 1)
      expect(out).not.toBeNull()
      expect(requestedModels).toEqual(["tiny"])
    } finally {
      holder()
    }
  })

  test("instances are cached: second call reuses, no second create", async () => {
    await rerankModule.rerankDocuments("q q", ["a"], 1)
    await rerankModule.rerankDocuments("q q", ["b"], 1)
    expect(requestedModels).toEqual(["mini"])
  })
})
