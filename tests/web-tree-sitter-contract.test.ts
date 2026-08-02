import { test, expect } from "bun:test"
import path from "node:path"

import {
  GRAMMAR_FILES,
  getGrammarBundle,
  outlineFile,
} from "~/lib/tree-sitter-grammars"

// Contract between OUR import sites and whichever web-tree-sitter is actually
// installed. Both halves of this contract have already broken once.
//
// 0.25 moved to named exports and renamed SyntaxNode -> Node, so the source
// imports `{ Language, Node, Parser, Tree }`. Against an older installed copy
// that import is a hard ESM SyntaxError at module-load time — the process dies
// on startup before anything runs, with a stack pointing at a bundled chunk
// rather than at the version mismatch that caused it.
//
// 0.26 is worse, because it fails QUIETLY. It breaks the grammar ABI: every
// grammar wasm fails to load, and `loadGrammars` treats a load failure as a
// per-language soft failure by design, so structural ranking and outlines
// silently degrade to the regex heuristic. Nothing throws. Nothing logs to the
// terminal (`enableFileLogging` has already nulled it by then). The only
// visible symptom is that outlines come back empty, which reads as "this file
// has no symbols" rather than "tree-sitter is dead". `tree-sitter-wasms` is at
// its latest release and ships ABI-incompatible grammars for 0.26, so this is
// not a "wait for an update" situation — a bump to 0.26 must fail loudly here.
//
// Deliberately NOT mocked. A mock would assert that our code calls an API we
// invented, which is precisely the thing that was already true when both of
// these broke. The whole value is touching the real installed package.

test("web-tree-sitter exposes the named exports the source imports", async () => {
  const mod = await import("web-tree-sitter")

  // Mirrors the import lists in tree-sitter-grammars.ts, code-search.ts and
  // tree-sitter-pool/worker.ts. A missing name here is the startup SyntaxError.
  for (const name of ["Parser", "Language", "Node", "Tree"]) {
    expect(mod).toHaveProperty(name)
  }
})

test("every grammar actually loads (guards the grammar-ABI break)", async () => {
  // Asserted through the module's OWN loader rather than a fresh
  // Parser.init() + Language.load(). Two reasons. It is the path production
  // uses, so it proves the thing that matters instead of a parallel setup
  // that happens to work. And `Parser.init()` is process-global: calling it
  // from a test poisons this module's lazy init, so a hand-rolled check
  // silently empties the outlines of every test that runs after it — which is
  // exactly the symptom this file exists to catch.
  const grammars = await getGrammarBundle().ready

  expect(grammars.size).toBeGreaterThan(0)
  // typescript is the one this repo's own outline path depends on most.
  expect(grammars.has("typescript")).toBe(true)

  // Under an ABI mismatch `loadGrammars` swallows each failure per language,
  // so a partial load is the realistic failure shape, not a clean throw.
  const expected = Object.keys(GRAMMAR_FILES)
  const missing = expected.filter((key) => !grammars.has(key))
  expect(missing).toEqual([])
})

test("outlineFile finds real symbols in a real source file", async () => {
  // End-to-end through the code path the `code` tool actually uses, against a
  // checked-in file whose exports are stable. This is the assertion that fails
  // when grammars silently stop loading: `outline` goes empty instead of
  // throwing, so an emptiness check is the only thing that catches it.
  const target = path.join(import.meta.dir, "..", "src", "lib", "port.ts")
  const outlined = await outlineFile(target)

  expect(outlined.outline.length).toBeGreaterThan(0)
  expect(outlined.outline.map((entry) => entry.name)).toContain(
    "pickClaudeDefault",
  )
})
