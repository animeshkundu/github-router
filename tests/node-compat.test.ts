import { test, expect, describe, beforeAll } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const DIST_PATH = path.resolve(import.meta.dir, "../dist/main.js")

let bundleContent: string
let bundleLines: string[]
let bundleExists: boolean

beforeAll(() => {
  bundleExists = fs.existsSync(DIST_PATH)
  if (!bundleExists) return
  bundleContent = fs.readFileSync(DIST_PATH, "utf8")
  bundleLines = bundleContent.split("\n")
})

describe("node-compat: dist/main.js", () => {
  test("shebang is present on first line", () => {
    if (!bundleExists) return // skip when build not run
    expect(bundleLines[0]).toBe("#!/usr/bin/env node")
  })

  test("no unguarded Bun. references (3-line context check)", () => {
    if (!bundleExists) return
    const issues: Array<{ line: number; text: string }> = []
    for (let i = 0; i < bundleLines.length; i++) {
      if (/Bun\./.test(bundleLines[i]) && !/typeof Bun/.test(bundleLines[i])) {
        const ctx = bundleLines
          .slice(Math.max(0, i - 3), i + 1)
          .join("\n")
        if (!/typeof Bun/.test(ctx)) {
          issues.push({ line: i + 1, text: bundleLines[i].trim() })
        }
      }
    }
    expect(issues).toEqual([])
  })

  test("bundle parses without syntax errors", () => {
    if (!bundleExists) return
    // Strip shebang before parsing — Node strips it at runtime but
    // new Function / eval would choke on it.
    const code = bundleContent.replace(/^#!.*\n/, "")
    // If the bundle has top-level await or import/export we can't use
    // new Function, so we just verify no SyntaxError from a module parse.
    // Bun's parser handles ESM natively.
    expect(() => {
      // Use Bun's transpiler to check for syntax errors without executing
      const transpiler = new Bun.Transpiler({ loader: "js" })
      transpiler.transformSync(code)
    }).not.toThrow()
  })

  test("no bun: module imports in bundle", () => {
    if (!bundleExists) return
    const bunImportPattern = /(?:from\s+["']bun:|require\s*\(\s*["']bun:)/g
    const matches: Array<{ line: number; text: string }> = []
    for (let i = 0; i < bundleLines.length; i++) {
      if (bunImportPattern.test(bundleLines[i])) {
        matches.push({ line: i + 1, text: bundleLines[i].trim() })
      }
      // Reset lastIndex since we reuse the regex
      bunImportPattern.lastIndex = 0
    }
    expect(matches).toEqual([])
  })

  test("dist/main.js file exists (build must run before tests)", () => {
    expect(bundleExists).toBe(true)
  })
})
