import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import path from "node:path"

import {
  MAX_OUTLINE_ENTRIES_PER_FILE,
  searchCode,
} from "~/lib/code-search"
import { outlineFile } from "~/lib/tree-sitter-grammars"
import { runUnifiedCodeSearch } from "~/lib/unified-code-search"

// `outlines` is orientation attached to files the caller did NOT ask about, so
// its size is pure context cost. `outlineFile`'s own cap is 1000 symbols —
// correct when someone deliberately outlines one file, far too high when up to
// 10 files ride along with every search. One symbol-dense test file can
// contribute hundreds of entries and bury the hits it was meant to annotate.
//
// This is a regression test in the literal sense: the cap shipped applied to
// only ONE of the two response builders. The semantic path in
// unified-code-search.ts was capped; the lexical builder in code-search.ts was
// not — and lexical is both a forced mode AND the fallback that every
// cold-index query lands on, so in practice the uncapped path was the common
// one. Nothing failed, because an over-large outline is still a valid outline.
// Only reading a live response caught it.
//
// Both paths are asserted here for that reason. Capping one and trusting the
// other to match is precisely what already went wrong.
//
// The fixture is built here rather than taken from the repo. The claim is about
// the cap, and the corpus it is measured in is irrelevant to it, but running the
// search over this checkout is not: the old version spent 12.6 s scanning the
// repo and 20.2 s with outlines, against lane 1's 15 s per-test budget.
//
// The declarations deliberately do NOT match the query, with one exception that
// does. The outline lists every top-level declaration in the matched file, so
// the cap is measured by the file's density, while cost is driven by the MATCH
// count: the structural pass runs per hit, so a fixture whose 200 declarations
// all matched had the parse run over the same file fifty times (measured: 14.1 s
// for the match-dense fixture against 110 ms for this one, both capped at 60).
//
// Both searches still carry an explicit budget. The search is 110 ms here; what
// a wall clock measures is the worker-backed outline pass starting cold, which
// is 5.0 s and 3.9 s standalone for the two below. That is a runner measurement
// against bun's 5 s default, so the budget states it.

const DENSE_QUERY = "getRunFn"

// Comfortably past the 60-entry cap, so a capped outline is provably a cap and
// not just a small file.
const DENSE_DECLARATIONS = 200

const root = realpathSync(
  mkdtempSync(path.join(os.tmpdir(), "gh-router-outline-cap-")),
)
const denseFile = path.join(root, "dense.ts")
writeFileSync(
  denseFile,
  Array.from(
    { length: DENSE_DECLARATIONS },
    (_, i) =>
      `export function helper${i}(input: string): string {\n  return input.trim()\n}\n`,
  ).join("\n") +
    `export function ${DENSE_QUERY}(input: string): string {\n  return input.trim()\n}\n`,
)

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

// Guard the guard, once: the fixture must genuinely hold more symbols than the
// cap, or every assertion below would pass on a small file and prove nothing
// about capping. `outlineFile` is the uncapped parser (cap 1000), so this also
// pins that the cap under test lives in the response builders, not the parser.
test("the fixture is denser than the cap", async () => {
  const o = await outlineFile(denseFile, new AbortController().signal)
  // The 200 non-matching helpers plus the one matching declaration.
  expect(o.outline.length).toBe(DENSE_DECLARATIONS + 1)
  expect(o.outline.length).toBeGreaterThan(MAX_OUTLINE_ENTRIES_PER_FILE)
})

test("lexical search caps outline entries per file", async () => {
  const r = await searchCode({
    query: DENSE_QUERY,
    workspace: root,
    mode: "ranked",
    limit: 3,
    summary: true,
  })

  // Guard the guard: if the query stops matching, an absent outline would
  // make the cap assertion vacuous.
  expect(r.outlines?.length).toBeGreaterThan(0)

  for (const entry of r.outlines ?? []) {
    // Exactly the cap, not merely under it: the whole 201 is what the uncapped
    // builder shipped, so an under-assertion would still pass on the bug.
    expect(entry.outline.length).toBe(MAX_OUTLINE_ENTRIES_PER_FILE)
  }
}, 20_000)

test("unified search caps outline entries per file on the lexical path", async () => {
  // Forced lexical: deterministic, and does not depend on whether a semantic
  // index happens to exist on the machine running the suite.
  const r = await runUnifiedCodeSearch({
    query: DENSE_QUERY,
    workspace: root,
    mode: "lexical",
    limit: 3,
    summary: true,
  })

  expect(r.outlines?.length).toBeGreaterThan(0)

  for (const entry of r.outlines ?? []) {
    expect(entry.outline.length).toBe(MAX_OUTLINE_ENTRIES_PER_FILE)
  }
}, 20_000)
