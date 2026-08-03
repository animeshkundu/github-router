import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

// Drift guard for a failure mode that damages the DEVELOPER'S MACHINE, not
// just the test run.
//
// `mock.module()` is applied process-globally by bun and `mock.restore()`
// cannot undo it. Lane 1 runs ~200 test files in ONE process, and ten of them
// mock `node:os` to redirect `homedir()` at a temp dir. Whichever installs
// last wins for every other file in that process. A file that both mocks
// `node:os` AND writes files to a homedir-derived path is therefore writing to
// wherever some other file's mock happens to point — including the real home.
//
// This already happened. `tests/isolated/colbert.test.ts` wrote a 6-byte stub over the
// user's real `~/.local/share/github-router/colbert/bin/colgrep.exe`. That
// failed the provisioning smoke test, which removed the `.smoke-ok` marker,
// which flipped the capability gate off — so semantic search reported
// "unavailable on this host" while all three artifacts appeared present. Five
// independent agents reported the search tool as useless before the cause was
// found, because the symptom is indistinguishable from a cold index.
//
// The rule this pins: if a test mocks `node:os`, it belongs in tests/isolated/,
// which runs one process per file. That is precisely why the isolated lane
// exists (see CLAUDE.md "Test lanes"). Lane 1 sharing is what makes the mock a
// cross-file hazard rather than a local convenience.
//
// Scoped to `node:os` deliberately. Other `mock.module` targets are ordinary
// process-global hazards that produce a bad assertion; `node:os` is the one
// that redirects real filesystem WRITES, so it is the one worth a hard rule.

const TESTS_DIR = path.join(import.meta.dirname, "..")
const OS_MOCK = /mock\.module\(\s*["']node:os["']/

test("no lane-1 test mocks node:os (it redirects real filesystem writes)", async () => {
  // Recursive, because the runner discovers recursively: a nested lane-1 test
  // (tests/fleet/x.test.ts) is just as able to install a global node:os mock,
  // and an immediate-children scan would never see it.
  const entries = await fs.readdir(TESTS_DIR, {
    withFileTypes: true,
    recursive: true,
  })
  const laneOneFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
    .map((e) => path.relative(TESTS_DIR, path.join(e.parentPath, e.name)))
    // tests/isolated/** is lane 2: one process per file, so the mock is contained.
    .filter((rel) => !rel.split(path.sep).includes("isolated"))

  // Guard the guard: if the glob ever stops matching, an empty set would make
  // this pass vacuously while the hazard is wide open.
  expect(laneOneFiles.length).toBeGreaterThan(20)

  const offenders: Array<string> = []
  for (const name of laneOneFiles) {
    const text = await fs.readFile(path.join(TESTS_DIR, name), "utf8")
    if (OS_MOCK.test(text)) offenders.push(name)
  }

  expect(offenders).toEqual([])
})
