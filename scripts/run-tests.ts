// Runs the full test suite the same way CI does, in two lanes.
//
// Lane 1 sweeps everything except `tests/isolated/**`.
// Lane 2 runs each isolated file in its OWN process.
//
// The split is load-bearing, not cosmetic. Files under tests/isolated/ use
// `mock.module()`, which bun applies process-globally and which `mock.restore()`
// cannot undo, so sharing one process lets a mock from one file corrupt another.
// The worst case is not a wrong assertion but a deadlock: the `node:child_process`
// spawn mock in tests/isolated/lib-launch-child.test.ts hands back a fake child
// that never emits `close`, and the spawn in src/lib/code-search.ts then awaits
// that `close` forever.
//
// bunfig.toml excludes tests/isolated/** from discovery so a bare `bun test`
// stays safe. A CLI `--path-ignore-patterns` OVERRIDES that bunfig value, which
// is how lane 2 opts the directory back in for an explicit per-file run.

import { readdirSync } from "node:fs"
import path from "node:path"

const TIMEOUT_MS = "15000"

/** Inert override: node_modules is excluded by bun's own defaults anyway. Its
 * only job is to displace the bunfig `pathIgnorePatterns` so an explicitly
 * passed tests/isolated/ file is actually discovered instead of silently
 * matching zero tests. */
const OVERRIDE_IGNORE = "node_modules/**"

const repoRoot = path.resolve(import.meta.dirname, "..")
const isolatedDir = path.join(repoRoot, "tests", "isolated")

function run(args: Array<string>): number {
  const proc = Bun.spawnSync(["bun", "test", ...args], {
    cwd: repoRoot,
    stdio: ["inherit", "inherit", "inherit"],
  })
  return proc.exitCode ?? 1
}

const failures: Array<string> = []

console.log("--- Lane 1: full suite excluding tests/isolated/ ---")
if (
  run(["tests/", "--timeout", TIMEOUT_MS, "--path-ignore-patterns", "tests/isolated/**"])
  !== 0
) {
  failures.push("lane 1 (tests/)")
}

// Recursive on purpose. bunfig hides tests/isolated/** from lane 1, so any
// file this scan misses is run by NEITHER lane — it disappears silently and
// the suite still reports green. A top-level-only scan makes that the fate
// of the first nested isolated test anyone adds.
function findIsolatedTests(dir: string, prefix = ""): Array<string> {
  const out: Array<string> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...findIsolatedTests(path.join(dir, entry.name), rel))
    } else if (entry.name.endsWith(".test.ts")) {
      out.push(rel)
    }
  }
  return out
}

const isolatedFiles = findIsolatedTests(isolatedDir).sort()

if (isolatedFiles.length === 0) {
  console.error("ERROR: No isolated test files found")
  process.exit(1)
}

console.log(
  `\n--- Lane 2: ${isolatedFiles.length} isolated files, one process each ---`,
)
for (const file of isolatedFiles) {
  const rel = `tests/isolated/${file}`
  console.log(`--- Running ${rel} ---`)
  if (
    run([rel, "--timeout", TIMEOUT_MS, "--path-ignore-patterns", OVERRIDE_IGNORE])
    !== 0
  ) {
    failures.push(rel)
  }
}

if (failures.length > 0) {
  console.error(`\nFAILED (${failures.length}):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

console.log("\nAll lanes passed.")
