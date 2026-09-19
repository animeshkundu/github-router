/**
 * Regression test for tree sharing between the structural pass and the
 * outline loop (Phase 1, A1).
 *
 * `searchCode`'s structural pass parses the top-N hit files into `_treeCache`;
 * the outline loop must reuse those cached trees via `outlineFromTree`
 * instead of re-reading + re-parsing via `outlineFile`. This test replaces
 * `outlineFile` with a counting stub (empty outline) and asserts the search
 * still returns NON-EMPTY outlines with ZERO stub invocations — proving
 * every outline came from the structural pass's cached trees.
 *
 * Lives in tests/isolated/ (own process) because `mock.module` for
 * tree-sitter-grammars is process-global: sharing a process with the pool
 * tests would route their outline calls through this stub and corrupt them.
 * The stub deliberately does NOT delegate to the real `outlineFile` — a
 * delegating wrapper self-recurses under bun's module mock (the "real"
 * binding resolves to the mock), which previously took down the pool suite
 * with a stack overflow.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"

import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import * as realGrammars from "../../src/lib/tree-sitter-grammars"

let outlineFileCalls = 0

mock.module("../../src/lib/tree-sitter-grammars", () => ({
  ...realGrammars,
  outlineFile: async (_absPath: string, _signal?: AbortSignal) => {
    outlineFileCalls += 1
    return { outline: [], language: "typescript" }
  },
}))

// Import AFTER the mock so code-search binds to the counting stub.
let searchCode: typeof import("../../src/lib/code-search").searchCode

let root: string

beforeAll(async () => {
  ;({ searchCode } = await import("../../src/lib/code-search"))
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gh-router-reuse-")))
  mkdirSync(path.join(root, "src"))
  // Three small TS files: every result file fits comfortably inside the
  // structural top-50, so the outline set is a strict subset of the
  // already-parsed set.
  writeFileSync(
    path.join(root, "src", "alpha.ts"),
    "export function alphaWidget() {\n" +
      "  return alphaWidget\n" +
      "}\n" +
      "export const alphaHelper = () => alphaWidget()\n",
  )
  writeFileSync(
    path.join(root, "src", "beta.ts"),
    "import { alphaWidget } from './alpha'\n" +
      "export function betaWidget() {\n" +
      "  return alphaWidget()\n" +
      "}\n",
  )
  writeFileSync(
    path.join(root, "src", "gamma.ts"),
    "export function gammaWidget() {\n" +
      "  return 42\n" +
      "}\n",
  )
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  mock.restore()
})

describe("structural-pass → outline tree reuse (A1)", () => {
  test("outline loop reuses cached trees; outlineFile stub never fires", async () => {
    // Force the in-process structural path so the _treeCache branch (not
    // the worker-pool outlinesByFile branch) serves the outlines. The
    // pool path ships outlines alongside confirm results and likewise
    // never calls outlineFile for structural files — that path is covered
    // by tests/tree-sitter-pool.test.ts.
    const prev = process.env.GH_ROUTER_DISABLE_TS_POOL
    process.env.GH_ROUTER_DISABLE_TS_POOL = "1"
    try {
      outlineFileCalls = 0
      const resp = await searchCode({
        query: "alphaWidget",
        workspace: root,
        mode: "ranked",
        summary: true,
      })
      expect(resp.results.length).toBeGreaterThan(0)
      expect(resp.outlines).toBeDefined()
      expect(resp.outlines!.length).toBeGreaterThan(0)
      // Non-empty outlines prove they came from the structural pass's
      // cached trees (the stub returns empty). Zero stub calls prove no
      // file was re-read + re-parsed.
      const totalEntries = resp.outlines!.reduce(
        (n, o) => n + o.outline.length,
        0,
      )
      expect(totalEntries).toBeGreaterThan(0)
      expect(outlineFileCalls).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.GH_ROUTER_DISABLE_TS_POOL
      else process.env.GH_ROUTER_DISABLE_TS_POOL = prev
    }
  })
})
