/**
 * Tests for `src/lib/rerank.ts` (Phase 3: JIT cross-encoder rerank).
 *
 * NATIVE-FREE BY CONSTRUCTION: real ONNX Runtime sessions crash `bun test`
 * at process teardown (SIGABRT after a green run; reproduced with a minimal
 * load+inference+dispose case, while identical `bun run` scripts exit
 * cleanly). Every test here returns before the dynamic `flashrank-js`
 * import — no native code ever loads. Loader behavior (budget race,
 * failure fallback, model selection) is covered with a mocked
 * `flashrank-js` in tests/isolated/rerank-loader.test.ts (own process);
 * end-to-end integration in tests/isolated/code-search-rerank.test.ts;
 * live-model verification via `bun run scripts/verify-rerank-live.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { isNaturalLanguageQuery, rerankDocuments } from "../src/lib/rerank"

afterEach(() => {
  delete process.env.GH_ROUTER_RERANK
  delete process.env.GH_ROUTER_RERANK_BUDGET_MS
})

describe("isNaturalLanguageQuery", () => {
  test("single identifiers are not NL (rerank skipped)", () => {
    expect(isNaturalLanguageQuery("getUserName")).toBe(false)
    expect(isNaturalLanguageQuery("refreshAuthToken")).toBe(false)
    expect(isNaturalLanguageQuery("x")).toBe(false)
  })

  test("multi-word queries are NL (rerank eligible)", () => {
    expect(isNaturalLanguageQuery("auth token refresh")).toBe(true)
    expect(isNaturalLanguageQuery("retry around the upstream fetch")).toBe(true)
    expect(isNaturalLanguageQuery("  padded   spacing  ")).toBe(true)
  })

  test("empty / whitespace is not NL", () => {
    expect(isNaturalLanguageQuery("")).toBe(false)
    expect(isNaturalLanguageQuery("   ")).toBe(false)
  })
})

describe("rerankDocuments — offline paths", () => {
  test("GH_ROUTER_RERANK=off → null (BM25F order stands)", async () => {
    process.env.GH_ROUTER_RERANK = "off"
    const out = await rerankDocuments("auth token", ["doc a", "doc b"], 2)
    expect(out).toBeNull()
  })

  test("empty documents / non-positive topN → null", async () => {
    const out = await rerankDocuments("auth token", [], 5)
    expect(out).toBeNull()
    const out2 = await rerankDocuments("auth token", ["doc"], 0)
    expect(out2).toBeNull()
  })

  test("pre-aborted signal → null", async () => {
    const ac = new AbortController()
    ac.abort()
    const out = await rerankDocuments("auth token", ["doc a"], 1, ac.signal)
    expect(out).toBeNull()
  })

  test("off switch wins even with a tiny budget set", async () => {
    // No loader involvement at all: mode check precedes everything.
    process.env.GH_ROUTER_RERANK = "off"
    process.env.GH_ROUTER_RERANK_BUDGET_MS = "1"
    const out = await rerankDocuments(
      "auth token",
      ["doc a", "doc b", "doc c"],
      3,
    )
    expect(out).toBeNull()
  })
})


