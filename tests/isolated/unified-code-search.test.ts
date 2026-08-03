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

  test("zero-hit multi-word lexical query returns a recovery notice, not a bare empty", async () => {
    // The behaviour this pins was found by a blind capability audit: a
    // natural-language lookup returned `results: []` with no notice while a plain
    // Grep answered the same question instantly. An empty result reads as "not in
    // this repository" rather than "that query shape did not work", and this
    // project's guidance steers callers here before Grep, so the empty case has
    // to say something.
    const r = await runUnifiedCodeSearch({
      query: "no such phrase anywhere in this fixture",
      workspace: root,
      mode: "lexical",
    })
    expect(r.results.length).toBe(0)
    expect(r.notice).toBeDefined()
    expect(r.notice).toContain("do NOT read this as")
  })

  test("the suggested retry term is identifier-like, never punctuation noise", async () => {
    // Naively suggesting the last token recommends `sized?` for
    // "where is the timeout sized?" — punctuation that would produce a SECOND
    // false negative, which is the failure this hint exists to prevent.
    const r = await runUnifiedCodeSearch({
      query: "where is the refreshAuthToken sized?",
      workspace: root,
      mode: "lexical",
    })
    if (r.results.length === 0) {
      expect(r.notice).toBeDefined()
      expect(r.notice).not.toContain("sized?")
      // Prefers the longest identifier-like token in the query.
      expect(r.notice).toContain("refreshAuthToken")
    }
  })

  test("a query with no identifier-like token omits the example rather than inventing one", async () => {
    const r = await runUnifiedCodeSearch({
      query: "?? !! ..",
      workspace: root,
      mode: "lexical",
    })
    expect(r.results.length).toBe(0)
    expect(r.notice).toBeDefined()
    expect(r.notice).not.toContain("e.g.")
  })

  test("a single-word miss gets NO hint (a lone symbol not found is a real absence)", async () => {
    const r = await runUnifiedCodeSearch({
      query: "zzzNotARealSymbolAnywhere",
      workspace: root,
      mode: "lexical",
    })
    expect(r.results.length).toBe(0)
    expect(r.notice ?? "").not.toContain("do NOT read this as")
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
    expect(r.outlines).toHaveLength(1)
    expect(r.outlines?.[0]?.file).toBe("src/auth.ts")
    expect(r.outlines?.[0]?.outline.map((entry) => entry.name)).toContain(
      "refreshAuthToken",
    )
    expect(r.notice).toBeUndefined()
  })

  test("status 'ready' skips an out-of-workspace semantic result outline", async () => {
    semanticEnabled = true
    semanticResult = {
      status: "ready",
      source: "semantic",
      results: [
        {
          file: "../outside.ts",
          line: 1,
          score: 0.5,
          snippet: "export const outside = true",
        },
      ],
    }
    const r = await runUnifiedCodeSearch({
      query: "outside",
      workspace: root,
    })
    expect(r.results).toHaveLength(1)
    expect(r.outlines).toEqual([])
  })

  test("status 'ready' honors summary:false", async () => {
    semanticEnabled = true
    semanticResult = {
      status: "ready",
      source: "semantic",
      results: [
        {
          file: "src/auth.ts",
          line: 1,
          score: 0.91,
          snippet: "export function refreshAuthToken()",
        },
      ],
    }
    const r = await runUnifiedCodeSearch({
      query: "where do we refresh auth tokens",
      workspace: root,
      summary: false,
    })
    expect(r.outlines).toBeUndefined()
  })

  test.each(["building", "stale", "unavailable", "failed"] as const)(
    "status '%s' with a terse runner notice keeps actionable guidance",
    async (status) => {
      semanticEnabled = true
      semanticResult = {
        status,
        ...(status === "failed" ? { isError: true } : {}),
        notice: status,
      }
      const r = await runUnifiedCodeSearch({
        query: "refreshAuthToken",
        workspace: root,
      })
      expect(r.source).toBe("lexical-fallback")
      expect(r.results.length).toBeGreaterThan(0)
      expect(r.notice).toContain(status)
      expect(r.notice).toContain('retry mode:"semantic"')
      expect(r.notice).toMatch(/symbol/i)
    },
  )

  // "retry shortly" was too vague and cost a real recovery. An index build
  // takes MINUTES on a large repo (observed: ~5 on this one), so a caller who
  // retried seconds later saw a second fallback and concluded the tool was
  // dead rather than mid-repair. The notice has to name the timescale, or the
  // self-healing it describes is invisible.
  test.each(["building", "stale", "unavailable", "failed"] as const)(
    "status '%s' names the timescale so a retry is not attempted too early",
    async (status) => {
      semanticEnabled = true
      semanticResult = {
        status,
        ...(status === "failed" ? { isError: true } : {}),
        notice: status,
      }
      const r = await runUnifiedCodeSearch({
        query: "refreshAuthToken",
        workspace: root,
      })
      expect(r.notice).toMatch(/minute/i)
      // "shortly" invites an immediate retry, which is the failure mode.
      expect(r.notice).not.toMatch(/shortly/i)
    },
  )

  test("a failed index says THIS query started the rebuild", async () => {
    // The recovery path most likely to be misread as a dead tool: after a
    // failed build, the first query is consumed scheduling the re-kick and
    // therefore cannot return semantic results itself. Unless the notice says
    // so, the fallback it returns reads as "no progress" rather than "repair
    // has begun" — which is exactly how this went unnoticed for a whole
    // session.
    // No runner notice: this is the path where OUR wording is what the caller
    // reads. When the runner supplies its own notice it already says a
    // re-index was started, and `semanticFallbackNotice` preserves that text
    // rather than replacing it.
    semanticEnabled = true
    semanticResult = { status: "failed", isError: true }
    const r = await runUnifiedCodeSearch({
      query: "refreshAuthToken",
      workspace: root,
    })
    expect(r.notice).toMatch(/started a background rebuild/i)
  })

  test("corrupt quarantine wording survives with actionable guidance", async () => {
    semanticEnabled = true
    semanticResult = {
      status: "failed",
      isError: true,
      notice: "semantic index was found corrupt and quarantined; a clean rebuild was started",
    }
    const r = await runUnifiedCodeSearch({
      query: "refreshAuthToken",
      workspace: root,
    })
    expect(r.notice).toMatch(/corrupt and quarantined/i)
    expect(r.notice).toContain('retry mode:"semantic"')
  })

  test("runner notice that already has guidance does not duplicate it", async () => {
    semanticEnabled = true
    semanticResult = {
      status: "failed",
      isError: true,
      notice: 'corrupt index rebuilding — retry mode:"semantic" shortly',
    }
    const r = await runUnifiedCodeSearch({
      query: "refreshAuthToken",
      workspace: root,
    })
    expect(r.notice?.match(/retry mode:"semantic"/g)).toHaveLength(1)
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
