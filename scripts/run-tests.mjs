#!/usr/bin/env bun
/**
 * Two-phase test runner — the single source of truth for BOTH `bun run test`
 * and CI (.github/workflows/ci.yml).
 *
 * Why this exists: bare `bun test` HANGS. bun runs every test file in ONE
 * shared process, and the files under `tests/isolated/` use global
 * `mock.module(...)` on core modules (node:child_process, node:process, …).
 * bun's `mock.module` is process-global and is NOT restored between files, so
 * an isolated file's mocked `spawn` leaks into a later file that shells out for
 * real (e.g. the ripgrep-backed code search) — the real child is replaced by a
 * fake that never emits `close`, and the awaiting test wedges forever. bun's
 * per-test `--timeout` cannot cancel that un-settling spawn promise, so the run
 * hangs with no failure printed.
 *
 * The fix (mirrored by CI): run the main suite with `tests/isolated/**`
 * EXCLUDED, then run each isolated file in its OWN process.
 *
 * Usage:
 *   bun run scripts/run-tests.mjs            # both phases (default)
 *   bun run scripts/run-tests.mjs main       # main suite only (excl. isolated)
 *   bun run scripts/run-tests.mjs isolated   # isolated files, one per process
 */

import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import process from "node:process"

const TIMEOUT = "15000"
const ISOLATED_DIR = "tests/isolated"

// Use the bun that's running THIS script (so there's no PATH/`.exe` ambiguity
// on Windows); fall back to `bun` on PATH if invoked under a non-bun runtime.
const BUN = /bun(\.exe)?$/i.test(process.execPath) ? process.execPath : "bun"

/** Run `bun test <args>` inheriting stdio; return the child's exit code. */
function bunTest(args) {
  const r = spawnSync(BUN, ["test", ...args], { stdio: "inherit" })
  if (r.error) {
    console.error(r.error)
    return 1
  }
  return r.status ?? 1
}

const mode = process.argv[2] // undefined | "main" | "isolated"
let failed = 0

if (mode !== "isolated") {
  console.log("=== Test (main suite — tests/isolated/** excluded) ===")
  if (
    bunTest([
      "tests/",
      "--timeout",
      TIMEOUT,
      "--path-ignore-patterns",
      `${ISOLATED_DIR}/**`,
    ]) !== 0
  ) {
    failed = 1
  }
}

if (mode !== "main") {
  console.log("=== Test (isolated — one file per process) ===")
  const files = readdirSync(ISOLATED_DIR)
    .filter((f) => f.endsWith(".test.ts"))
    .sort()
    .map((f) => `${ISOLATED_DIR}/${f}`) // forward slashes: bun globs the same on Windows
  if (files.length === 0) {
    console.error(`ERROR: No isolated test files found in ${ISOLATED_DIR}`)
    process.exit(1)
  }
  for (const f of files) {
    console.log(`--- Running ${f} ---`)
    if (bunTest([f, "--timeout", TIMEOUT]) !== 0) failed = 1
  }
}

process.exit(failed)
