/**
 * Tests for `src/lib/colbert/units.ts` (Phase 2b: semantic unit pipeline).
 *
 * No mocks: tree-sitter grammars load for real (fast, cached). Fixtures
 * are temp files removed after each case.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  buildUnitText,
  extractUnits,
  leadingDocComment,
  normalizePathForEmbedding,
  type CodeUnit,
} from "../src/lib/colbert/units"

let dirs: Array<string> = []

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function fixture(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gh-router-units-")))
  dirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

function byName(units: Array<CodeUnit>): Map<string, CodeUnit> {
  return new Map(units.map((u) => [u.name, u]))
}

describe("normalizePathForEmbedding", () => {
  test("splits separators, case boundaries, and digits", () => {
    expect(normalizePathForEmbedding("src/utils/HttpClient.ts")).toBe(
      "src utils Http Client ts",
    )
    expect(normalizePathForEmbedding("pkg/retry_backoff.py")).toBe(
      "pkg retry backoff py",
    )
  })
})

describe("leadingDocComment", () => {
  const lines = [
    "import x",
    "",
    "// Fetches with retry.",
    "// Second line.",
    "def fetch():",
    "    pass",
  ]
  test("collects contiguous comment lines above", () => {
    expect(leadingDocComment(lines, 5)).toBe(
      "// Fetches with retry.\n// Second line.",
    )
  })
  test("blank line terminates", () => {
    expect(leadingDocComment(lines, 2)).toBeUndefined()
  })
  test("non-comment line terminates", () => {
    expect(leadingDocComment(["code()", "// comment", "def f():"], 3)).toBe(
      "// comment",
    )
  })
})

describe("extractUnits — TypeScript", () => {
  test("functions, classes, methods with ranges and signatures", async () => {
    const root = fixture({
      "src/auth.ts": [
        "export function refreshAuthToken() {",
        "  return 'tok'",
        "}",
        "export class Store {",
        "  get(key: string) {",
        "    return key",
        "  }",
        "}",
        "",
      ].join("\n"),
    })
    const r = await extractUnits(path.join(root, "src/auth.ts"), "src/auth.ts")
    expect(r.notice).toBeUndefined()
    expect(r.language).toBe("typescript")
    const m = byName(r.units)
    expect(m.get("refreshAuthToken")).toMatchObject({ line: 1, end_line: 3, kind: "function_declaration" })
    expect(m.get("Store")).toMatchObject({ line: 4, kind: "class_declaration" })
    expect(m.get("get")).toMatchObject({ line: 5, kind: "method_definition" })
    // Signature is the declaration first line; code is the full body.
    expect(m.get("refreshAuthToken")?.signature).toContain("refreshAuthToken()")
    expect(m.get("refreshAuthToken")?.code).toContain("return 'tok'")
    // Deterministic line order.
    const lines = r.units.map((u) => u.line)
    expect([...lines].sort((a, b) => a - b)).toEqual(lines)
    // unit_id is stable and file-scoped.
    expect(m.get("Store")?.unit_id).toBe("src/auth.ts:4:Store")
  })
})

describe("extractUnits — C# (new grammar)", () => {
  test("namespace/class/method/property/field with roles", async () => {
    const root = fixture({
      "Billing/Invoice.cs": [
        "namespace Acme.Billing;",
        "public class Invoice {",
        "  private readonly string _id;",
        "  public decimal Amount { get; private set; }",
        "  public void Charge() { }",
        "}",
        "",
      ].join("\n"),
    })
    const r = await extractUnits(
      path.join(root, "Billing/Invoice.cs"),
      "Billing/Invoice.cs",
    )
    expect(r.notice).toBeUndefined()
    expect(r.language).toBe("csharp")
    const m = byName(r.units)
    expect(m.get("Acme.Billing")?.kind).toBe("file_scoped_namespace_declaration")
    expect(m.get("Invoice")?.kind).toBe("class_declaration")
    expect(m.get("Charge")?.kind).toBe("method_declaration")
    expect(m.get("Amount")?.kind).toBe("property_declaration")
    // Field via the declarator-position rule (no name field in grammar).
    expect(m.get("_id")?.kind).toBe("field_declaration")
    expect(m.get("_id")?.line).toBe(3)
  })
})

describe("extractUnits — Python", () => {
  test("functions and classes", async () => {
    const root = fixture({
      "app/db.py": [
        '"""Pool module."""',
        "def connect(url):",
        '    """Connect."""',
        "    return url",
        "",
        "class Pool:",
        "    def get(self):",
        "        return 1",
        "",
      ].join("\n"),
    })
    const r = await extractUnits(path.join(root, "app/db.py"), "app/db.py")
    expect(r.language).toBe("python")
    const m = byName(r.units)
    expect(m.get("connect")?.kind).toBe("function_definition")
    expect(m.get("Pool")?.kind).toBe("class_definition")
    expect(m.get("get")?.kind).toBe("function_definition")
  })
})

describe("extractUnits — unsupported / unreadable", () => {
  test("unknown extension → notice + empty", async () => {
    const root = fixture({ "notes.md": "# hi\n" })
    const r = await extractUnits(path.join(root, "notes.md"), "notes.md")
    expect(r.units).toEqual([])
    expect(r.notice).toBeDefined()
  })

  test("missing file → notice + empty (never throws)", async () => {
    const r = await extractUnits("/no/such/file.ts", "file.ts")
    expect(r.units).toEqual([])
    expect(r.notice).toBeDefined()
  })
})

describe("buildUnitText", () => {
  test("structured text carries name/signature/path/code", () => {
    const unit: CodeUnit = {
      unit_id: "src/a.ts:1:fetch",
      file: "src/a.ts",
      name: "fetch",
      kind: "function_declaration",
      line: 1,
      end_line: 3,
      signature: "export function fetch(url: string) {",
      code: "export function fetch(url: string) {\n  return url\n}",
      docstring: "Fetches.",
    }
    const text = buildUnitText(unit, "src/a.ts")
    expect(text).toContain("Function: fetch")
    expect(text).toContain("Signature: export function fetch")
    expect(text).toContain("Description: Fetches.")
    expect(text).toContain("File:")
    expect(text).toContain("fetch")
    expect(text).toContain("Code:")
  })
})
