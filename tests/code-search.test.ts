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

  test("invalid regex in mode='regex' surfaces ripgrep's error to the caller", async () => {
    // Without exit-code surfacing this would silently return [] and
    // the model couldn't distinguish "your regex is broken" from
    // "no matches." The error message should include ripgrep's own
    // diagnostic (e.g. "regex parse error" / "unclosed character class").
    await expect(
      searchCode({
        query: "[unterminated",
        workspace: fx.root,
        mode: "regex",
        limit: 5,
      }),
    ).rejects.toThrow(/regex parse error|unclosed/)
  })

  test("caller-supplied limit > 100 is respected (no internal clamp)", async () => {
    // Build a fixture with 150 hits in one file so the model can
    // verify limit=120 returns 120 results (the old MAX_LIMIT=100
    // would have silently clipped to 100).
    const wideFx = makeFixture((root) => {
      const lines = Array.from({ length: 150 }, (_, i) => `// HIT_LINE_${i}`)
      writeFileSync(path.join(root, "wide.ts"), lines.join("\n") + "\n")
    })
    try {
      const r = await searchCode({
        query: "HIT_LINE_",
        workspace: wideFx.root,
        mode: "literal",
        limit: 120,
      })
      expect(r.results.length).toBe(120)
      expect(r.truncated).toBe(true)
    } finally {
      wideFx.cleanup()
    }
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
// Cross-skeleton query expansion (the live audit-confirmed bug)
// ============================================================

describe("query expansion (cross-skeleton)", () => {
  let fx: Fixture

  beforeAll(() => {
    fx = makeFixture((root) => {
      // Four files with the SAME identifier expressed in different
      // skeletons. Pre-expansion, searching for any one form returned
      // only its own file. After expansion, all four come back.
      writeFileSync(
        path.join(root, "camel.ts"),
        "function getUserName() { return 'x' }\n",
      )
      writeFileSync(
        path.join(root, "snake.py"),
        "def get_user_name(): return 'x'\n",
      )
      writeFileSync(
        path.join(root, "pascal.ts"),
        "class GetUserName {}\n",
      )
      writeFileSync(
        path.join(root, "screaming.py"),
        "GET_USER_NAME = 'x'\n",
      )
    })
  })

  afterAll(() => {
    fx.cleanup()
  })

  test("ranked mode finds all four skeleton variants from a camelCase query", async () => {
    const r = await searchCode({
      query: "getUserName",
      workspace: fx.root,
      mode: "ranked",
      limit: 10,
    })
    const files = r.results.map((h) => h.file).sort()
    expect(files).toEqual(["camel.ts", "pascal.ts", "screaming.py", "snake.py"])
  })

  test("literal mode also expands", async () => {
    const r = await searchCode({
      query: "get_user_name",
      workspace: fx.root,
      mode: "literal",
      limit: 10,
    })
    const files = r.results.map((h) => h.file).sort()
    expect(files).toContain("camel.ts")
    expect(files).toContain("snake.py")
  })

  test("regex mode does NOT expand (user is explicit about regex semantics)", async () => {
    const r = await searchCode({
      query: "getUserName",
      workspace: fx.root,
      mode: "regex",
      limit: 10,
    })
    // Regex mode searches the literal string only.
    const files = r.results.map((h) => h.file).sort()
    expect(files).toEqual(["camel.ts"])
  })

  test("multi-token / non-identifier query falls through to literal search", async () => {
    // Query with spaces (or other identifier-breaking characters)
    // is not a single identifier — expansion is skipped.
    const r = await searchCode({
      query: "function getUserName",
      workspace: fx.root,
      mode: "literal",
      limit: 10,
    })
    expect(r.results.length).toBe(1)
    expect(r.results[0].file).toBe("camel.ts")
  })
})

// ============================================================
// Structural ranking (tree-sitter)
// ============================================================

describe("structural ranking (tree-sitter)", () => {
  let fx: Fixture

  beforeAll(() => {
    fx = makeFixture((root) => {
      mkdirSync(path.join(root, "src"))
      mkdirSync(path.join(root, "tests"))

      // The definition site (function declaration).
      writeFileSync(
        path.join(root, "src", "parser.ts"),
        [
          "export function parseModel(input: string): string {",
          "  return input.trim()",
          "}",
        ].join("\n"),
      )
      // Multiple call sites in different files.
      writeFileSync(
        path.join(root, "src", "consumer_a.ts"),
        [
          "import { parseModel } from './parser'",
          "export function a(x: string) {",
          "  return parseModel(x)",
          "}",
        ].join("\n"),
      )
      writeFileSync(
        path.join(root, "src", "consumer_b.ts"),
        [
          "import { parseModel } from './parser'",
          "export function b(x: string) {",
          "  return parseModel(x).toUpperCase()",
          "}",
        ].join("\n"),
      )
    })
  })

  afterAll(() => {
    fx.cleanup()
  })

  test("'full' mode ranks the AST-confirmed definition site above call sites", async () => {
    const r = await searchCode({
      query: "parseModel",
      workspace: fx.root,
      mode: "ranked",
      structural: "full",
      limit: 10,
    })
    expect(r.results.length).toBeGreaterThan(0)
    // The definition should rank first.
    expect(r.results[0].file).toBe("src/parser.ts")
    // The definition's symbol_context contribution should be strictly
    // greater than zero (AST boost fired) AND strictly greater than
    // any call-site hit's symbol_context (which is the actual signal
    // that ranks definitions above call sites).
    const top = r.results[0]
    expect(top.field_contributions!.symbol_context).toBeGreaterThan(0)
    const callSites = r.results.filter((h) => h.file !== "src/parser.ts")
    for (const call of callSites) {
      expect(top.field_contributions!.symbol_context).toBeGreaterThan(
        call.field_contributions!.symbol_context,
      )
    }
    // No fallback on this small fixture — well within the 200ms budget.
    expect(r.notice).toBeNull()
  })

  test("'topN' mode also runs (just parses fewer files)", async () => {
    const r = await searchCode({
      query: "parseModel",
      workspace: fx.root,
      mode: "ranked",
      structural: "topN",
      limit: 10,
    })
    // Same fixture is small enough that 'topN' (10 files) and 'full'
    // (50 files) both parse everything; the contract is just that
    // 'topN' is a legal value and returns sensibly ranked results.
    expect(r.results.length).toBeGreaterThan(0)
    expect(r.results[0].file).toBe("src/parser.ts")
  })

  test("default structural is 'full' (omitted param accepted)", async () => {
    const r = await searchCode({
      query: "parseModel",
      workspace: fx.root,
      mode: "ranked",
      limit: 10,
    })
    // Without specifying structural, the AST boost still fires.
    expect(r.results[0].file).toBe("src/parser.ts")
  })

  test("notice is null on a normal call", async () => {
    const r = await searchCode({
      query: "parseModel",
      workspace: fx.root,
      mode: "ranked",
      limit: 10,
    })
    expect(r.notice).toBeNull()
  })
})

// ============================================================
// MCP handler boundary — minimal response shape
// ============================================================

describe("MCP handler trims the response per the minimality principle", () => {
  let fx: Fixture

  beforeAll(() => {
    fx = makeFixture((root) => {
      writeFileSync(
        path.join(root, "a.ts"),
        "function findMe() { return 1 }\n",
      )
    })
  })

  afterAll(() => {
    fx.cleanup()
  })

  test("response contains only file/line/snippet per hit; no score/field_contributions/match_byte_range", async () => {
    // Drive the handler the way the MCP client does — call the
    // registered tool's handler directly and parse its content.
    const { NON_PERSONA_MCP_TOOLS } = await import(
      "../src/lib/peer-mcp-personas"
    )
    const tool = NON_PERSONA_MCP_TOOLS.find(
      (t) => t.toolNameHttp === "code",
    )!
    const result = await tool.handler({
      query: "findMe",
      workspace: fx.root,
      mode: "literal",
      limit: 5,
    })
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>

    // Top-level shape — only these keys allowed:
    const allowedTopKeys = new Set([
      "results",
      "truncated",
      "notice",
    ])
    for (const k of Object.keys(body)) {
      expect(allowedTopKeys.has(k)).toBe(true)
    }

    // No internals leaked:
    expect(body).not.toHaveProperty("scanned_files")
    expect(body).not.toHaveProperty("elapsed_ms")
    expect(body).not.toHaveProperty("pruned_below_shoulder")
    expect(body).not.toHaveProperty("ranking")
    expect(body).not.toHaveProperty("structuralFallback")
    expect(body).not.toHaveProperty("ranking_fallback")

    // Per-hit shape — exactly these three keys:
    const results = body.results as Array<Record<string, unknown>>
    expect(results.length).toBeGreaterThan(0)
    for (const hit of results) {
      expect(Object.keys(hit).sort()).toEqual(["file", "line", "snippet"])
    }
  })

  test("notice is OMITTED (not null) on success", async () => {
    const { NON_PERSONA_MCP_TOOLS } = await import(
      "../src/lib/peer-mcp-personas"
    )
    const tool = NON_PERSONA_MCP_TOOLS.find(
      (t) => t.toolNameHttp === "code",
    )!
    const result = await tool.handler({
      query: "findMe",
      workspace: fx.root,
      mode: "literal",
      limit: 5,
    })
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>
    expect("notice" in body).toBe(false)
  })

  test("structural param accepted via the MCP handler", async () => {
    const { NON_PERSONA_MCP_TOOLS } = await import(
      "../src/lib/peer-mcp-personas"
    )
    const tool = NON_PERSONA_MCP_TOOLS.find(
      (t) => t.toolNameHttp === "code",
    )!
    for (const structural of ["full", "topN"]) {
      const result = await tool.handler({
        query: "findMe",
        workspace: fx.root,
        mode: "ranked",
        structural,
        limit: 5,
      })
      expect(result.isError).toBeUndefined()
      const body = JSON.parse(result.content[0].text) as Record<string, unknown>
      expect((body.results as Array<unknown>).length).toBeGreaterThan(0)
    }
  })

  test("context_lines param is no longer accepted in the schema", async () => {
    const { NON_PERSONA_MCP_TOOLS } = await import(
      "../src/lib/peer-mcp-personas"
    )
    const tool = NON_PERSONA_MCP_TOOLS.find(
      (t) => t.toolNameHttp === "code",
    )!
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>
      additionalProperties: boolean
    }
    expect(schema.properties).not.toHaveProperty("context_lines")
    // And additionalProperties is still false (no escape hatch).
    expect(schema.additionalProperties).toBe(false)
    // While we're here: structural IS in the schema.
    expect(schema.properties).toHaveProperty("structural")
  })

  test("response size cap (256KB) truncates and emits an actionable notice", async () => {
    // Build a fixture with enough fat hits that the assembled JSON
    // response would exceed the 256KB cap. ~600 lines of ~1KB-ish
    // content each → ~600KB raw, well over the cap. We ask for
    // limit=5000 so internal limit-truncation doesn't fire first.
    const fatFx = makeFixture((root) => {
      const filler = "X".repeat(900) // ~900 chars per line
      const lines = Array.from(
        { length: 600 },
        (_, i) => `// HIT_LINE_${i} ${filler}`,
      )
      writeFileSync(path.join(root, "wide.ts"), lines.join("\n") + "\n")
    })
    try {
      const { NON_PERSONA_MCP_TOOLS } = await import(
        "../src/lib/peer-mcp-personas"
      )
      const tool = NON_PERSONA_MCP_TOOLS.find(
        (t) => t.toolNameHttp === "code",
      )!
      const result = await tool.handler({
        query: "HIT_LINE_",
        workspace: fatFx.root,
        mode: "literal",
        limit: 5000,
      })
      expect(result.isError).toBeUndefined()
      const body = JSON.parse(result.content[0].text) as {
        results: Array<unknown>
        truncated: boolean
        notice?: string
      }
      // Cap fired: response stays under ~300KB (256KB cap + slack).
      expect(Buffer.byteLength(result.content[0].text, "utf8")).toBeLessThan(
        300 * 1024,
      )
      // Truncated and notice both set.
      expect(body.truncated).toBe(true)
      expect(body.notice).toBeDefined()
      expect(body.notice).toContain("size limit")
      // We still returned a useful number of hits, not zero.
      expect(body.results.length).toBeGreaterThan(10)
    } finally {
      fatFx.cleanup()
    }
  })

  test("notice priority: size cap message overrides structural notice when both could fire", async () => {
    // Hard to make structural-budget fire on a tiny fixture, so this
    // test just verifies the field-naming contract: notice is the
    // single unified field that surfaces any actionable degradation.
    const { NON_PERSONA_MCP_TOOLS } = await import(
      "../src/lib/peer-mcp-personas"
    )
    const tool = NON_PERSONA_MCP_TOOLS.find(
      (t) => t.toolNameHttp === "code",
    )!
    const result = await tool.handler({
      query: "findMe",
      workspace: fx.root,
      mode: "ranked",
      limit: 5,
    })
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>
    // No legacy field names leaked:
    expect(body).not.toHaveProperty("ranking_fallback")
    expect(body).not.toHaveProperty("structuralFallback")
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

// ============================================================
// Binary file handling (NUL-byte defense)
// ============================================================

describe("binary file handling (NUL-byte defense)", () => {
  let fx: Fixture

  beforeAll(() => {
    fx = makeFixture((root) => {
      mkdirSync(path.join(root, "src"))

      // Normal source file — should be found
      writeFileSync(
        path.join(root, "src", "clean.ts"),
        "export const binaryTestMarker = 42\n",
      )

      // Binary file — contains the same query but with NUL bytes.
      // Use Buffer.from to construct the payload (cross-platform).
      const binaryContent = Buffer.from(
        "binaryTestMarker\0\0\0 some binary junk\0\n",
      )
      writeFileSync(path.join(root, "src", "data.bin"), binaryContent)
    })
  })

  afterAll(() => {
    fx.cleanup()
  })

  test("results include source file and skip binary file", async () => {
    const r = await searchCode({
      query: "binaryTestMarker",
      workspace: fx.root,
      mode: "literal",
      limit: 10,
    })
    // Must find the clean source file
    expect(r.results.length).toBeGreaterThan(0)
    expect(r.results.some((h) => h.file.includes("clean.ts"))).toBe(true)
    // Must NOT include the binary file
    expect(r.results.some((h) => h.file.includes("data.bin"))).toBe(false)
  })

  test("no NUL bytes leak into ranked response", async () => {
    const r = await searchCode({
      query: "binaryTestMarker",
      workspace: fx.root,
      mode: "ranked",
      limit: 10,
    })
    // Serialize entire result and check for NUL
    const serialized = JSON.stringify(r)
    expect(serialized).not.toContain("\0")
    // Should still find the clean file
    expect(r.results.some((h) => h.file.includes("clean.ts"))).toBe(true)
  })
})
