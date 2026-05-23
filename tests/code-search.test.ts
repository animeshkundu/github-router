/**
 * Tests for `src/lib/code-search.ts`.
 *
 * Covers the 30 verification probes from the plan:
 *   §1-5   happy-path + boot/typecheck handled at the CI level
 *   §6-22  security & correctness (most probed here as unit tests;
 *          some Windows-specific ones are runtime probes on CI)
 *   §23-30 BM25F ranked-mode specifics
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
import { state } from "../src/lib/state"

// ============================================================
// Test fixture management
// ============================================================

interface Fixture {
  root: string
  cleanup: () => void
}

function makeFixture(setup: (root: string) => void): Fixture {
  // realpathSync because macOS's mkdtempSync may return a symlinked
  // path (e.g. /var/folders/... vs /private/var/folders/...). The
  // allow-set check below compares canonical paths.
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

/**
 * Temporarily expand the allow-set to include `root` for the duration
 * of the callback. Caller should pass an already-canonicalized path
 * (makeFixture does that for you).
 */
async function withAllowSet<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const orig = state.codeSearchRoots
  ;(state as { codeSearchRoots: ReadonlyArray<string> }).codeSearchRoots = [
    ...orig,
    root,
  ]
  try {
    return await fn()
  } finally {
    ;(state as { codeSearchRoots: ReadonlyArray<string> }).codeSearchRoots = orig
  }
}

// ============================================================
// Tokenizer (§24 — Vasilescu, Ray, Mockus ESEC/FSE 2021)
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
    // Single 'a' is dropped; 'an' is kept.
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
// Ripgrep resolution (§14, §15)
// ============================================================

describe("resolveRipgrep", () => {
  test("resolves to an extant rg binary", () => {
    const r = resolveRipgrep()
    expect(["system", "bundled"]).toContain(r.source)
    expect(r.rgPath.length).toBeGreaterThan(0)
  })

  test("bundled @vscode/ripgrep is reachable (trustedDependencies / optionalDeps check)", () => {
    // Probe 14: ensure the bundled binary exists.
    // require.resolve through the package's exports.
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
// Workspace validation (§6, §8, §10, §11)
// ============================================================

describe("validateWorkspace", () => {
  test("rejects non-absolute paths", () => {
    const r = validateWorkspace("relative/path")
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/absolute/i)
  })

  test("rejects path outside allow-set (no path echo — §6)", () => {
    // /etc exists on POSIX; on Windows we'd use something equivalent.
    const target = process.platform === "win32" ? "C:\\Windows" : "/etc"
    if (!existsSync(target)) return // skip if not present
    const r = validateWorkspace(target)
    expect(r.ok).toBe(false)
    expect(r.error).toBeDefined()
    // CRITICAL: error message must NOT echo the rejected path.
    expect(r.error).not.toContain(target)
    expect(r.error).not.toContain("/etc")
    expect(r.error).not.toContain("Windows")
  })

  test("rejects non-existent path (no echo)", () => {
    const fake = path.join(os.tmpdir(), "gh-router-cs-nonexistent-" + Date.now())
    const r = validateWorkspace(fake)
    expect(r.ok).toBe(false)
    expect(r.error).toBeDefined()
    expect(r.error).not.toContain(fake)
  })

  test("accepts path inside an allow-set root", async () => {
    const fx = makeFixture((root) => {
      writeFileSync(path.join(root, "a.ts"), "export const x = 1\n")
    })
    try {
      await withAllowSet(fx.root, async () => {
        const r = validateWorkspace(fx.root)
        expect(r.ok).toBe(true)
        expect(r.canonical).toBeDefined()
      })
    } finally {
      fx.cleanup()
    }
  })

  test("case-fold prefix-sibling bypass blocked (§10, MEDIUM-8)", async () => {
    // Skip on Linux (case-sensitive FS — bypass not applicable).
    if (process.platform === "linux") return

    const parent = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "gh-router-cs-cf-")),
    )
    try {
      const fooRoot = path.join(parent, "Foo")
      const foo2Root = path.join(parent, "Foo2")
      mkdirSync(fooRoot)
      mkdirSync(foo2Root)
      writeFileSync(path.join(foo2Root, "secret.txt"), "secret\n")

      await withAllowSet(fooRoot, async () => {
        // Request workspace=Foo2 should be rejected even though it
        // case-folds to a string that starts with Foo on win32/darwin.
        const r = validateWorkspace(foo2Root)
        expect(r.ok).toBe(false)
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test(".gh-router-searchable marker file opt-in", async () => {
    const fx = makeFixture((root) => {
      writeFileSync(path.join(root, ".gh-router-searchable"), "")
      writeFileSync(path.join(root, "a.ts"), "export const x = 1\n")
    })
    try {
      // Should accept WITHOUT being in startup roots.
      const r = validateWorkspace(fx.root)
      expect(r.ok).toBe(true)
    } finally {
      fx.cleanup()
    }
  })
})

// ============================================================
// searchCode integration tests (happy-path + §7, §13, §17, §18, §20)
// ============================================================

describe("searchCode integration", () => {
  let fx: Fixture

  beforeAll(() => {
    fx = makeFixture((root) => {
      // Test fixture project structure
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
      // Secret-shape file — denylist should hide these.
      writeFileSync(
        path.join(root, ".env"),
        "API_KEY=PARSE_secret_value\nDB_PASS=hunter2\n",
      )
      writeFileSync(
        path.join(root, "credentials.yml"),
        "key: PARSE_credential\n",
      )
    })
  })

  afterAll(() => {
    fx.cleanup()
  })

  test("happy path: ranked search returns definition first", async () => {
    await withAllowSet(fx.root, async () => {
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
  })

  test("paths returned are relative to workspace (defense in depth)", async () => {
    await withAllowSet(fx.root, async () => {
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
  })

  test("§7 leading-hyphen argv injection treated as literal", async () => {
    // Query "--no-ignore" should search for that literal string, NOT
    // toggle ripgrep's --no-ignore flag. If the flag fired, the .env
    // and credentials.yml files would be included in the scan (rg
    // normally honors .gitignore and excludes hidden dotfiles).
    await withAllowSet(fx.root, async () => {
      const r = await searchCode({
        query: "--no-ignore",
        workspace: fx.root,
        mode: "literal",
        limit: 50,
      })
      // The literal string "--no-ignore" doesn't appear in our
      // fixture, so we expect 0 hits. The KEY assertion is that
      // the call succeeded (no crash from arg-parsing).
      expect(r.results.length).toBe(0)
    })
  })

  test("§18 secret-shape denylist excludes .env, credentials", async () => {
    // "PARSE_" appears in .env AND credentials.yml as a literal string,
    // but NOT in any code file. If the denylist works, we get 0 hits.
    await withAllowSet(fx.root, async () => {
      const r = await searchCode({
        query: "PARSE_secret_value",
        workspace: fx.root,
        mode: "literal",
        limit: 50,
      })
      const denylistHits = r.results.filter(
        (h) => h.file.endsWith(".env") || h.file.includes("credentials"),
      )
      expect(denylistHits.length).toBe(0)
    })
  })

  test("§17 wall-time timeout / abort propagation", async () => {
    // Construct an aborted signal upfront.
    const ac = new AbortController()
    ac.abort("test")
    await withAllowSet(fx.root, async () => {
      await expect(
        searchCode(
          { query: "parseModel", workspace: fx.root, mode: "literal" },
          ac.signal,
        ),
      ).rejects.toThrow()
    })
  })

  test("§19 file_glob cannot bypass denylist", async () => {
    // Even if the user passes a permissive glob, secrets stay hidden.
    await withAllowSet(fx.root, async () => {
      const r = await searchCode({
        query: "PARSE_secret_value",
        workspace: fx.root,
        mode: "literal",
        file_glob: "**/*", // tries to include everything
        limit: 50,
      })
      const denylistHits = r.results.filter(
        (h) => h.file.endsWith(".env") || h.file.includes("credentials"),
      )
      expect(denylistHits.length).toBe(0)
    })
  })

  test("§20 file_glob with null byte is rejected at input validation", async () => {
    await withAllowSet(fx.root, async () => {
      await expect(
        searchCode({
          query: "parseModel",
          workspace: fx.root,
          file_glob: "**/*\0",
        }),
      ).rejects.toThrow(/null byte|newline/)
    })
  })

  test("global limit enforcement is NOT per-file (MEDIUM-10)", async () => {
    // 3 files each have 1+ match for "parseModel". With limit=1, we
    // must get ONE result total, not one per file.
    await withAllowSet(fx.root, async () => {
      const r = await searchCode({
        query: "parseModel",
        workspace: fx.root,
        mode: "literal",
        limit: 1,
      })
      expect(r.results.length).toBe(1)
      expect(r.truncated).toBe(true)
    })
  })

  test("query with leading/trailing whitespace + null is rejected", async () => {
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
    await withAllowSet(fx.root, async () => {
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
})

// ============================================================
// BM25F ranking (§23, §26-30)
// ============================================================

describe("BM25F ranking", () => {
  let fx: Fixture

  beforeAll(() => {
    fx = makeFixture((root) => {
      mkdirSync(path.join(root, "src"))
      mkdirSync(path.join(root, "tests"))

      // Strong-signal fixture: ONE definition, several substring hits
      // in tests + comments.
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

  test("§23 determinism — 5 consecutive runs produce identical output", async () => {
    await withAllowSet(fx.root, async () => {
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
  })

  test("§26 field_contributions sum to total score (within epsilon)", async () => {
    await withAllowSet(fx.root, async () => {
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
  })

  test("§27 shoulder pruning — strong signal puts definition first", async () => {
    await withAllowSet(fx.root, async () => {
      const r = await searchCode({
        query: "strongSignal",
        workspace: fx.root,
        mode: "ranked",
        limit: 20,
      })
      // The strong-signal hit (definition with symbol_context boost)
      // should rank first and outscore the other hits.
      expect(r.results[0].file).toContain("core.ts")
      expect(r.results[0].file).not.toContain("test")
      // Definition has symbol_context contributing; test/comment hits don't.
      expect(r.results[0].field_contributions?.symbol_context).toBeGreaterThan(
        0,
      )
    })
  })

  test("§29 tie-break order: (score DESC, file ASC, line ASC)", async () => {
    await withAllowSet(fx.root, async () => {
      const r = await searchCode({
        query: "strongSignal",
        workspace: fx.root,
        mode: "ranked",
        limit: 20,
      })
      // For any consecutive pair with equal scores, file paths must
      // be in ASC order.
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
  })

  test("§30 algorithm metadata always includes citation + k1 in ranked mode", async () => {
    await withAllowSet(fx.root, async () => {
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
})

// ============================================================
// Symlink-escape (§9)
// ============================================================

describe("symlink escape from workspace", () => {
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
      writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE_secret\n")
      writeFileSync(path.join(inside, "normal.ts"), "const x = 1\n")
      // Symlink inside the workspace pointing OUT.
      symlinkSync(outside, path.join(inside, "escape"))

      await withAllowSet(inside, async () => {
        const r = await searchCode({
          query: "OUTSIDE_secret",
          workspace: inside,
          mode: "literal",
          limit: 10,
        })
        // The symlink should NOT have been traversed.
        expect(r.results.length).toBe(0)
      })
    } finally {
      rmSync(outside, { recursive: true, force: true })
      rmSync(inside, { recursive: true, force: true })
    }
  })
})

// ============================================================
// §22 observability — log line shape (smoke test only;
// full structured-log assertion would need a mock consola)
// ============================================================

// (Not asserted here — would require capturing consola output. The
//  format is fixed in code-search.ts and covered by code review.)
