/**
 * Tests for `runUnifiedCodeSearch` (src/lib/unified-code-search.ts) — the
 * semantic-first router shared by the MCP `code` tool and the worker
 * `code_search` tool.
 *
 * The colbert module is mocked so we control `colbertSearchEnabled()` and
 * `runSemanticSearch()` deterministically (no real colgrep needed); the
 * lexical backend (`searchCode`) is REAL and runs against a temp fixture,
 * so the fallback path is exercised end-to-end.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { SemanticSearchResult } from "../../src/lib/colbert/runner"

// Real module captured BEFORE the mock (static imports are hoisted), so the
// mock is a COMPLETE replacement — every other export (provisionAndIndexColbert,
// semanticSearchOptedIn, …) keeps its real implementation. Only the two
// functions the helper reads are overridden. This is load-bearing: an
// incomplete mock would leak `undefined` exports into other test files that
// share the process (e.g. cli-claude.test.ts calls provisionAndIndexColbert).
import * as realColbert from "../../src/lib/colbert"

// Mutable knobs the mock reads — set per test.
let semanticEnabled = false
let semanticResult: SemanticSearchResult = { status: "unavailable" }
let semanticThrows = false

mock.module("../../src/lib/colbert", () => ({
  ...realColbert,
  colbertSearchEnabled: () => semanticEnabled,
  runSemanticSearch: async () => {
    if (semanticThrows) throw new Error("colgrep transport error")
    return semanticResult
  },
}))

// Import AFTER the mock so the helper binds to the mocked colbert exports.
let runUnifiedCodeSearch: typeof import("../../src/lib/unified-code-search").runUnifiedCodeSearch

let root: string

beforeAll(async () => {
  ;({ runUnifiedCodeSearch } = await import("../../src/lib/unified-code-search"))
  root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "ucs-")))
  mkdirSync(path.join(root, "src"))
  writeFileSync(
    path.join(root, "src", "auth.ts"),
    "export function refreshAuthToken() { return 'tok' }\n" +
      "// retry with backoff around the upstream fetch\n",
  )
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  mock.restore()
})

describe("forced lexical family (never touches colgrep)", () => {
  beforeAll(() => {
    // Even with semantic enabled, forced modes must not call the runner.
    semanticEnabled = true
    semanticResult = { status: "ready", source: "semantic", results: [] }
  })

  test("mode:'lexical' → source 'lexical', finds the symbol", async () => {
    const r = await runUnifiedCodeSearch({
      query: "refreshAuthToken",
      workspace: root,
      mode: "lexical",
    })
    expect(r.source).toBe("lexical")
    expect(r.results.length).toBeGreaterThan(0)
  })

  test("mode:'exact' → source 'lexical' (fixed-string)", async () => {
    const r = await runUnifiedCodeSearch({
      query: "refreshAuthToken",
      workspace: root,
      mode: "exact",
    })
    expect(r.source).toBe("lexical")
    expect(r.results.length).toBeGreaterThan(0)
  })

  test("mode:'regex' → source 'lexical'", async () => {
    const r = await runUnifiedCodeSearch({
      query: "refresh.*Token",
      workspace: root,
      mode: "regex",
    })
    expect(r.source).toBe("lexical")
    expect(r.results.length).toBeGreaterThan(0)
  })
})

describe("semantic / default mode", () => {
  test("colgrep unavailable → transparent lexical-fallback + notice", async () => {
    semanticEnabled = false
    const r = await runUnifiedCodeSearch({
      query: "refreshAuthToken",
      workspace: root,
    })
    expect(r.source).toBe("lexical-fallback")
    expect(r.results.length).toBeGreaterThan(0)
    expect(r.notice).toBeDefined()
    expect(r.notice).toMatch(/semantic/i)
  })

  test("status 'ready' → source 'semantic', forwards rows incl. score", async () => {
    semanticEnabled = true
    semanticResult = {
      status: "ready",
      source: "semantic",
      results: [
        {
          file: "src/auth.ts",
          line: 1,
          endLine: 1,
          name: "refreshAuthToken",
          score: 0.91,
          snippet: "export function refreshAuthToken()",
        },
      ],
    }
    const r = await runUnifiedCodeSearch({
      query: "where do we refresh auth tokens",
      workspace: root,
    })
    expect(r.source).toBe("semantic")
    expect(r.results.length).toBe(1)
    expect(r.results[0]!.score).toBe(0.91)
    expect(r.results[0]!.name).toBe("refreshAuthToken")
    expect(r.notice).toBeUndefined()
  })

  test("status 'building' → lexical-fallback with a retry notice", async () => {
    semanticEnabled = true
    semanticResult = { status: "building", notice: "building" }
    const r = await runUnifiedCodeSearch({
      query: "refreshAuthToken",
      workspace: root,
    })
    expect(r.source).toBe("lexical-fallback")
    expect(r.results.length).toBeGreaterThan(0)
    expect(r.notice).toMatch(/building|retry/i)
  })

  test("status 'stale' → lexical-fallback", async () => {
    semanticEnabled = true
    semanticResult = { status: "stale", notice: "stale" }
    const r = await runUnifiedCodeSearch({
      query: "refreshAuthToken",
      workspace: root,
    })
    expect(r.source).toBe("lexical-fallback")
    expect(r.notice).toMatch(/stale|re-index|retry/i)
  })

  test("status 'failed' → lexical-fallback with actionable guidance", async () => {
    semanticEnabled = true
    semanticResult = { status: "failed", isError: true, notice: "failed" }
    const r = await runUnifiedCodeSearch({
      query: "refreshAuthToken",
      workspace: root,
    })
    expect(r.source).toBe("lexical-fallback")
    // The model-facing notice guides it: retry semantic OR use symbols.
    expect(r.notice).toMatch(/retry mode:"semantic"|symbol/i)
  })

  test("runSemanticSearch THROWS → transparent lexical-fallback (never rejects)", async () => {
    semanticEnabled = true
    semanticThrows = true
    try {
      const r = await runUnifiedCodeSearch({
        query: "refreshAuthToken",
        workspace: root,
      })
      expect(r.source).toBe("lexical-fallback")
      expect(r.results.length).toBeGreaterThan(0)
      expect(r.notice).toMatch(/errored|lexical/i)
    } finally {
      semanticThrows = false
    }
  })

  test("explicit mode:'semantic' behaves like the default", async () => {
    semanticEnabled = false
    const r = await runUnifiedCodeSearch({
      query: "refreshAuthToken",
      workspace: root,
      mode: "semantic",
    })
    expect(r.source).toBe("lexical-fallback")
  })
})
