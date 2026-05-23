/**
 * Tests for `src/lib/code-search.ts`.
 *
 * Covers happy-path + security-relevant probes from the plan.
 * The earlier allow-set / secret-shape-denylist tests were dropped
 * along with the gating itself: the threat model is symmetric (the
 * model has Bash and Read tools that reach the same paths), so
 * gating one tool wasn't actually defense, just inconsistency.
 *
 * Plan file:
 *   ~/.local/share/.../plans/what-are-the-following-wild-tarjan.md
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  searchCode,
  tokenize,
  validateWorkspace,
  resolveRipgrep,
} from "../src/lib/code-search"

// ============================================================
// Test fixture management
// ============================================================

interface Fixture {
  root: string
  cleanup: () => void
}

function makeFixture(setup: (root: string) => void): Fixture {
  // realpathSync because macOS's mkdtempSync may return a symlinked
  // path (e.g. /var/folders/... vs /private/var/folders/...).
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "gh-router-cs-")),
  )
  setup(root)
  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    },
  }
}

// ============================================================
// Tokenizer (Vasilescu, Ray, Mockus ESEC/FSE 2021)
// ============================================================

describe("tokenize (FSE 2021 rule-based identifier splitter)", () => {
  test("camelCase splits", () => {
    expect(tokenize("getClaudeCodeEnvVars")).toEqual([
      "get",
      "claude",
      "code",
      "env",
      "vars",
    ])
  })

  test("snake_case splits", () => {
    expect(tokenize("MY_CONST")).toEqual(["my", "const"])
  })

  test("acronym-run lookahead (HTTPS in HTTPSConnection)", () => {
    expect(tokenize("HTTPSConnection")).toEqual(["https", "connection"])
  })

  test("digit boundaries attach trailing digits to letters", () => {
    expect(tokenize("parseV2Handler")).toEqual(["parse", "v2", "handler"])
    expect(tokenize("version3")).toEqual(["version3"])
  })

  test("drops length-1 tokens", () => {
    expect(tokenize("a an b bc")).toEqual(["an", "bc"])
  })

  test("multi-segment with mixed separators", () => {
    expect(tokenize("HTTP_request-handlerV2.ts")).toEqual([
      "http",
      "request",
      "handler",
      "v2",
      "ts",
    ])
  })

  test("empty input", () => {
    expect(tokenize("")).toEqual([])
  })
})

// ============================================================
// Ripgrep resolution
// ============================================================

describe("resolveRipgrep", () => {
  test("resolves to an extant rg binary", () => {
    const r = resolveRipgrep()
    expect(["system", "bundled"]).toContain(r.source)
    expect(r.rgPath.length).toBeGreaterThan(0)
  })

  test("bundled @vscode/ripgrep is reachable", () => {
    let bundledPath: string | undefined
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("@vscode/ripgrep") as { rgPath: string }
      bundledPath = mod.rgPath
    } catch {
      // package not resolvable — fail the test below
    }
    expect(bundledPath).toBeDefined()
    expect(existsSync(bundledPath!)).toBe(true)
  })
})

// ============================================================
// Workspace validation (input hygiene only — no allow-set)
// ============================================================

describe("validateWorkspace", () => {
  test("rejects non-absolute paths", () => {
    const r = validateWorkspace("relative/path")
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/absolute/i)
  })

  test("rejects non-existent path (no path echo)", () => {
    const fake = path.join(os.tmpdir(), "gh-router-cs-nonexistent-" + Date.now())
    const r = validateWorkspace(fake)
    expect(r.ok).toBe(false)
    expect(r.error).toBeDefined()
    expect(r.error).not.toContain(fake)
  })

  test("rejects file path (must be a directory)", () => {
    const fx = makeFixture((root) => {
      writeFileSync(path.join(root, "a-file.txt"), "hi\n")
    })
    try {
      const r = validateWorkspace(path.join(fx.root, "a-file.txt"))
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/directory/i)
    } finally {
      fx.cleanup()
    }
  })

  test("accepts any absolute directory the proxy can stat", () => {
    const fx = makeFixture((root) => {
      writeFileSync(path.join(root, "a.ts"), "export const x = 1\n")
    })
    try {
      const r = validateWorkspace(fx.root)
      expect(r.ok).toBe(true)
      expect(r.canonical).toBeDefined()
    } finally {
      fx.cleanup()
    }
  })
})

// ============================================================
// searchCode integration tests
// ============================================================

describe("searchCode integration", () => {
  let fx: Fixture

  beforeAll(() => {
    fx = makeFixture((root) => {
      mkdirSync(path.join(root, "src"))
      mkdirSync(path.join(root, "src", "lib"))
      mkdirSync(path.join(root, "tests"))

      writeFileSync(
        path.join(root, "src", "lib", "parser.ts"),
        [
          "// parser implementation",
          "export function parseModel(input: string): string {",
          "  return input.trim()",
          "}",
          "",
          "export const PARSE_VERSION = '1.0'",
        ].join("\n"),
      )
      writeFileSync(
        path.join(root, "src", "lib", "utils.ts"),
        [
          "import { parseModel } from './parser'",
          "// utility wrapper around parseModel",
          "export function useModel(x: string) {",
          "  return parseModel(x)",
          "}",
        ].join("\n"),
      )
      writeFileSync(
        path.join(root, "tests", "parser.test.ts"),
        [
          "import { parseModel } from '../src/lib/parser'",
          "test('parseModel works', () => {",
          "  expect(parseModel('x')).toBe('x')",
          "})",
        ].join("\n"),
      )
    })
  })

  afterAll(() => {
    fx.cleanup()
  })

  test("happy path: ranked search returns definition first", async () => {
    const r = await searchCode({
      query: "parseModel",
      workspace: fx.root,
      mode: "ranked",
      limit: 10,
    })
    expect(r.results.length).toBeGreaterThan(0)
    expect(r.ranking.algorithm).toBe("BM25F")
    expect(r.ranking.citation).toBe("Robertson, Zaragoza, Taylor 2004")
    expect(r.ranking.k1).toBe(1.2)

    // Top hit should be the definition site (function parseModel in
    // parser.ts) — symbol_context fires there.
    expect(r.results[0].file).toContain("parser.ts")
    expect(r.results[0].field_contributions?.symbol_context).toBeGreaterThan(0)
  })

  test("paths returned are relative to workspace", async () => {
    const r = await searchCode({
      query: "parseModel",
      workspace: fx.root,
      mode: "literal",
      limit: 10,
    })
    for (const hit of r.results) {
      expect(path.isAbsolute(hit.file)).toBe(false)
      expect(hit.file).not.toMatch(/^\.\//)
      expect(hit.file).not.toMatch(/^\.\\/)
    }
  })

  test("leading-hyphen argv injection treated as literal", async () => {
    // Query "--no-ignore" should search for that literal string, NOT
    // toggle ripgrep's --no-ignore flag. The fixture doesn't contain
    // the literal string, so 0 hits is the expected outcome — and
    // most importantly, the call succeeds without rg arg-parse error.
    const r = await searchCode({
      query: "--no-ignore",
      workspace: fx.root,
      mode: "literal",
      limit: 50,
    })
    expect(r.results.length).toBe(0)
  })

  test("abort signal propagates as a clean error", async () => {
    const ac = new AbortController()
    ac.abort("test")
    await expect(
      searchCode(
        { query: "parseModel", workspace: fx.root, mode: "literal" },
        ac.signal,
      ),
    ).rejects.toThrow()
  })

  test("file_glob with null byte is rejected at input validation", async () => {
    await expect(
      searchCode({
        query: "parseModel",
        workspace: fx.root,
        file_glob: "**/*\0",
      }),
    ).rejects.toThrow(/null byte|newline/)
  })

  test("global limit enforcement is NOT per-file", async () => {
    // 3 files contain "parseModel". With limit=1, exactly ONE result.
    const r = await searchCode({
      query: "parseModel",
      workspace: fx.root,
      mode: "literal",
      limit: 1,
    })
    expect(r.results.length).toBe(1)
    expect(r.truncated).toBe(true)
  })

  test("query with null byte is rejected", async () => {
    await expect(
      searchCode({ query: "\0", workspace: fx.root }),
    ).rejects.toThrow(/null byte|newline/)
  })

  test("query exceeding length cap is rejected", async () => {
    await expect(
      searchCode({ query: "x".repeat(2000), workspace: fx.root }),
    ).rejects.toThrow(/1024|exceed/)
  })

  test("query with newline is rejected", async () => {
    await expect(
      searchCode({ query: "foo\nbar", workspace: fx.root }),
    ).rejects.toThrow(/null byte|newline/)
  })

  test("literal/regex modes omit score and BM25F metadata", async () => {
    const r = await searchCode({
      query: "parseModel",
      workspace: fx.root,
      mode: "literal",
      limit: 5,
    })
    expect(r.ranking.algorithm).toBe("ripgrep_document_order")
    expect(r.ranking.k1).toBeUndefined()
    expect(r.ranking.citation).toBeUndefined()
    for (const hit of r.results) {
      expect(hit.score).toBeUndefined()
      expect(hit.field_contributions).toBeNull()
    }
  })
})

// ============================================================
// BM25F ranking
// ============================================================

describe("BM25F ranking", () => {
  let fx: Fixture

  beforeAll(() => {
    fx = makeFixture((root) => {
      mkdirSync(path.join(root, "src"))
      mkdirSync(path.join(root, "tests"))

      writeFileSync(
        path.join(root, "src", "core.ts"),
        [
          "// public API",
          "export function strongSignal(arg: string): string {",
          "  return arg",
          "}",
        ].join("\n"),
      )
      writeFileSync(
        path.join(root, "tests", "core.test.ts"),
        [
          "// uses strongSignal in a test",
          "import { strongSignal } from '../src/core'",
          "test('strongSignal returns input', () => {",
          "  expect(strongSignal('x')).toBe('x')",
          "})",
        ].join("\n"),
      )

      writeFileSync(
        path.join(root, "src", "tiebreak_b.ts"),
        "// references strongSignal in a comment\n",
      )
      writeFileSync(
        path.join(root, "src", "tiebreak_a.ts"),
        "// references strongSignal in a comment\n",
      )
    })
  })

  afterAll(() => {
    fx.cleanup()
  })

  test("determinism — 5 consecutive runs produce identical output", async () => {
    const runs: Array<string> = []
    for (let i = 0; i < 5; i++) {
      const r = await searchCode({
        query: "strongSignal",
        workspace: fx.root,
        mode: "ranked",
        limit: 20,
      })
      // Strip elapsed_ms (variable) before comparison
      const stable = {
        results: r.results,
        truncated: r.truncated,
        pruned_below_shoulder: r.pruned_below_shoulder,
        scanned_files: r.scanned_files,
        ranking: r.ranking,
      }
      runs.push(JSON.stringify(stable))
    }
    expect(new Set(runs).size).toBe(1)
  })

  test("field_contributions sum to total score (within epsilon)", async () => {
    const r = await searchCode({
      query: "strongSignal",
      workspace: fx.root,
      mode: "ranked",
      limit: 20,
    })
    for (const hit of r.results) {
      expect(hit.score).toBeDefined()
      const c = hit.field_contributions!
      const sum =
        c.match_line + c.context + c.file_path + c.symbol_context
      expect(Math.abs(sum - hit.score!)).toBeLessThan(0.01)
    }
  })

  test("strong-signal query puts definition first", async () => {
    const r = await searchCode({
      query: "strongSignal",
      workspace: fx.root,
      mode: "ranked",
      limit: 20,
    })
    // The strong-signal hit (definition with symbol_context boost)
    // should rank first.
    expect(r.results[0].file).toContain("core.ts")
    expect(r.results[0].file).not.toContain("test")
    expect(r.results[0].field_contributions?.symbol_context).toBeGreaterThan(
      0,
    )
  })

  test("tie-break order: (score DESC, file ASC, line ASC)", async () => {
    const r = await searchCode({
      query: "strongSignal",
      workspace: fx.root,
      mode: "ranked",
      limit: 20,
    })
    for (let i = 1; i < r.results.length; i++) {
      const a = r.results[i - 1]
      const b = r.results[i]
      if (a.score === b.score && a.file !== b.file) {
        expect(a.file < b.file).toBe(true)
      }
      if (a.score === b.score && a.file === b.file) {
        expect(a.line <= b.line).toBe(true)
      }
    }
  })

  test("algorithm metadata always includes citation + k1 in ranked mode", async () => {
    const r = await searchCode({
      query: "strongSignal",
      workspace: fx.root,
      mode: "ranked",
    })
    expect(r.ranking).toEqual({
      algorithm: "BM25F",
      citation: "Robertson, Zaragoza, Taylor 2004",
      k1: 1.2,
    })
  })
})

// ============================================================
// Symlink escape behavior
// ============================================================

describe("symlink behavior", () => {
  test("--no-follow blocks rg from traversing a symlink that escapes the workspace", async () => {
    // Skip on Windows: symlink creation requires admin/developer mode.
    if (process.platform === "win32") return

    const outside = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "gh-router-cs-outside-")),
    )
    const inside = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "gh-router-cs-inside-")),
    )
    try {
      writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE_marker\n")
      writeFileSync(path.join(inside, "normal.ts"), "const x = 1\n")
      symlinkSync(outside, path.join(inside, "escape"))

      const r = await searchCode({
        query: "OUTSIDE_marker",
        workspace: inside,
        mode: "literal",
        limit: 10,
      })
      // The symlink should NOT have been traversed (default rg
      // behavior — we don't pass -L).
      expect(r.results.length).toBe(0)
    } finally {
      rmSync(outside, { recursive: true, force: true })
      rmSync(inside, { recursive: true, force: true })
    }
  })
})
