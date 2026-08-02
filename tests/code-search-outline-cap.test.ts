import { test, expect } from "bun:test"
import path from "node:path"

import {
  MAX_OUTLINE_ENTRIES_PER_FILE,
  searchCode,
} from "~/lib/code-search"
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

const REPO_ROOT = path.join(import.meta.dirname, "..")

// A deliberately symbol-dense file: >100 top-level declarations, so an
// uncapped outline is unmistakably over the limit rather than borderline.
const DENSE_QUERY = "getRunFn"
const DENSE_GLOB = "tests/isolated/cli-claude.test.ts"

test("lexical search caps outline entries per file", async () => {
  const r = await searchCode({
    query: DENSE_QUERY,
    workspace: REPO_ROOT,
    mode: "ranked",
    file_glob: DENSE_GLOB,
    limit: 3,
  })

  // Guard the guard: if the query stops matching, an absent outline would
  // make the cap assertion vacuous.
  expect(r.outlines?.length).toBeGreaterThan(0)

  for (const entry of r.outlines ?? []) {
    expect(entry.outline.length).toBeLessThanOrEqual(MAX_OUTLINE_ENTRIES_PER_FILE)
  }
})

test("unified search caps outline entries per file on the lexical path", async () => {
  // Forced lexical: deterministic, and does not depend on whether a semantic
  // index happens to exist on the machine running the suite.
  const r = await runUnifiedCodeSearch({
    query: DENSE_QUERY,
    workspace: REPO_ROOT,
    mode: "lexical",
    file_glob: DENSE_GLOB,
    limit: 3,
  })

  expect(r.outlines?.length).toBeGreaterThan(0)

  for (const entry of r.outlines ?? []) {
    expect(entry.outline.length).toBeLessThanOrEqual(MAX_OUTLINE_ENTRIES_PER_FILE)
  }
})
