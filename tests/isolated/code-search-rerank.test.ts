/**
 * Integration tests for the JIT rerank stage in `searchCode` (Phase 3),
 * with a MOCKED flashrank-js.
 *
 * Real ONNX sessions crash `bun test` at teardown (see
 * tests/rerank.test.ts header), so the reranker here is a deterministic
 * fake that reverses input order — any reorder in the response proves the
 * rerank stage ran. Live-model verification is `bun run
 * scripts/verify-rerank-live.ts`.
 *
 * Isolated (own process): the module mock is process-global.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Deterministic fake: reverses document order. A response in reverse
// BM25F order proves the rerank stage executed.
mock.module("flashrank-js", () => ({
  Reranker: {
    create: async (_opts: { model: string }) => ({
      rerank: async (req: {
        query: string
        documents: Array<string>
        topN: number
      }) => {
        const n = Math.min(req.topN, req.documents.length)
        const out: Array<{ index: number; score: number }> = []
        for (let i = n - 1; i >= 0; i--) out.push({ index: i, score: n - i })
        return out
      },
      dispose: async () => {},
    }),
  },
}))

let searchCode: typeof import("../../src/lib/code-search").searchCode

let root: string

beforeAll(async () => {
  ;({ searchCode } = await import("../../src/lib/code-search"))
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gh-router-rerank-")))
  mkdirSync(path.join(root, "src"))
  // Three files sharing one literal two-word phrase: identical match lines
  // (BM25F order falls back to file,line) so a reversed response is
  // unambiguously the reranker's doing.
  for (const name of ["aaa.ts", "bbb.ts", "ccc.ts"]) {
    writeFileSync(
      path.join(root, "src", name),
      `// retry policy around the upstream fetch\nexport const ${name[0]} = 1\n`,
    )
  }
})

beforeEach(() => {
  delete process.env.GH_ROUTER_RERANK
  delete process.env.GH_ROUTER_RERANK_BUDGET_MS
})

afterEach(() => {
  delete process.env.GH_ROUTER_RERANK
  delete process.env.GH_ROUTER_RERANK_BUDGET_MS
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

// Must appear VERBATIM in the fixture (ranked mode matches literally at
// rg time; the rerank stage only reorders those literal matches).
const NL_QUERY = "retry policy around"

describe("searchCode JIT rerank stage (mocked cross-encoder)", () => {
  test("NL query reranks (reversed fake order) and labels BM25F+FlashRank", async () => {
    const r = await searchCode({
      query: NL_QUERY,
      workspace: root,
      mode: "ranked",
      summary: false,
    })
    expect(r.results.length).toBeGreaterThanOrEqual(3)
    expect(r.ranking.algorithm).toBe("BM25F+FlashRank")
    // Fake reverses the BM25F head: last file first.
    expect(r.results[0].file).toMatch(/ccc\.ts$/)
    expect(r.results[2].file).toMatch(/aaa\.ts$/)
  })

  test("single-identifier query skips rerank (BM25F label, natural order)", async () => {
    const r = await searchCode({
      query: "retry",
      workspace: root,
      mode: "ranked",
      summary: false,
    })
    expect(r.ranking.algorithm).toBe("BM25F")
  })

  test("complete:true skips rerank (exhaustive order preserved)", async () => {
    const r = await searchCode({
      query: NL_QUERY,
      workspace: root,
      mode: "ranked",
      summary: false,
      complete: true,
    })
    expect(r.ranking.algorithm).toBe("BM25F")
  })

  test("GH_ROUTER_RERANK=off skips rerank", async () => {
    process.env.GH_ROUTER_RERANK = "off"
    const r = await searchCode({
      query: NL_QUERY,
      workspace: root,
      mode: "ranked",
      summary: false,
    })
    expect(r.ranking.algorithm).toBe("BM25F")
  })

  test("floor guarantee holds with rerank on (same set, reordered)", async () => {
    const plain = await searchCode({
      query: NL_QUERY,
      workspace: root,
      mode: "literal",
      summary: false,
    })
    process.env.GH_ROUTER_RERANK = "off"
    const off = await searchCode({
      query: NL_QUERY,
      workspace: root,
      mode: "ranked",
      summary: false,
    })
    delete process.env.GH_ROUTER_RERANK
    const on = await searchCode({
      query: NL_QUERY,
      workspace: root,
      mode: "ranked",
      summary: false,
    })
    // Same match SET in all three (rerank only reorders the head).
    const setOf = (rs: Array<{ file: string; line: number }>) =>
      new Set(rs.map((h) => `${h.file}:${h.line}`))
    expect(setOf(on.results)).toEqual(setOf(off.results))
    expect(setOf(off.results).size).toBeGreaterThan(0)
    expect(plain.results.length).toBeGreaterThan(0)
  })
})
