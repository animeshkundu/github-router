import { test, expect, mock } from "bun:test"
import { spawnSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Per-file tempDir + os.homedir() override. Same pattern as
// tests/lib-paths.test.ts: spread the real `os` namespace so that other
// callers of os.tmpdir() / os.platform() inside paths.ts still work, then
// override only `homedir()` so that PATHS.CLAUDE_CONFIG_DIR resolves
// under tempDir instead of the user's real ~/. This file lives in
// tests/isolated/ so it runs in its own bun-test invocation with a
// fresh global mock.module registry (per the CI matrix isolated step).
const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "github-router-e2e-mirror-"),
)
mock.module("node:os", () => ({
  default: { ...os, homedir: () => tempDir },
  ...os,
  homedir: () => tempDir,
}))

const { PATHS, ensureClaudeConfigMirror } = await import("../../src/lib/paths")

// E2E coverage for the user-visible chain that no unit test exercises:
//
//   `github-router claude` boots
//     → ensureClaudeConfigMirror() places a SHARED junction (Windows) /
//       symlink (POSIX) at <mirror>/projects → <claudeHome>/projects
//     → spawned child process inherits CLAUDE_CONFIG_DIR=<mirror>
//     → child writes <mirror>/projects/<uuid>.jsonl
//     → write traverses the junction and lands at <claudeHome>/projects/
//
// The original bug class this catches: junction creation silently failed
// (EPERM swallowed to consola.debug), so <mirror>/projects stayed as a
// real empty directory; child writes landed there as real files; and the
// user's ~/.claude/projects never saw the session — chat history split-
// brain. Three peer critics flagged that unit-only coverage cannot detect
// this end-to-end class because it asserts in-process round-trips, not
// the actual spawn boundary that production runs across.
//
// Cross-platform on purpose: POSIX symlinks and Windows junctions present
// the same behavioral surface (write-via-link lands at target), so the
// same assertions hold without platform branching.
test("e2e: spawned child writes through SHARED junction land at real ~/.claude on the host", async () => {
  // 1. Fresh real ~/.claude (= <tempDir>/.claude) and wiped mirror dir
  //    so we exercise the create path, not idempotent re-run.
  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })

  // 2. Bootstrap the mirror — creates the SHARED junction at
  //    <mirror>/projects → <claudeHome>/projects (and the other SHARED
  //    slots; we only assert on `projects` because it's the one Claude
  //    Code writes session JSONLs to).
  await ensureClaudeConfigMirror()

  const mirrorProjects = path.join(PATHS.CLAUDE_CONFIG_DIR, "projects")
  const sourceProjects = path.join(claudeHome, "projects")

  // Sanity: the slot is traversable as a directory regardless of underlying
  // link type. (Windows junctions report isDirectory()=true via stat().)
  const slotStat = await fs.stat(mirrorProjects)
  expect(slotStat.isDirectory()).toBe(true)

  // 3. Compose a sentinel and a child script that writes it. The child
  //    sees ONLY the env we hand it — no in-process mock.module leaks
  //    into the subprocess, exactly like the real proxy → claude
  //    relationship.
  const sentinelUuid = randomUUID()
  const sentinelName = `${sentinelUuid}.jsonl`
  const sentinelBody = JSON.stringify({
    e2e: "spawn-child-junction-traverse",
    nonce: randomBytes(8).toString("hex"),
    ts: Date.now(),
  })

  // Plain ESM .mjs — runs identically on Bun and Node, no transform.
  // Written to tempDir so cleanup happens with the rest of the test
  // artifacts. JSON.stringify of the constants handles Windows
  // backslash and quoting concerns inside the embedded literal.
  const childScriptPath = path.join(tempDir, `e2e-child-${randomUUID()}.mjs`)
  const childScript = `
import fs from "node:fs/promises"
import path from "node:path"
const dir = process.env.CLAUDE_CONFIG_DIR
if (!dir) { console.error("CLAUDE_CONFIG_DIR missing in child env"); process.exit(2) }
const target = path.join(dir, "projects", ${JSON.stringify(sentinelName)})
await fs.writeFile(target, ${JSON.stringify(sentinelBody)})
process.exit(0)
`
  await fs.writeFile(childScriptPath, childScript)

  // 4. Spawn the child with the SAME runtime that's executing the test
  //    (process.execPath is the bun.exe / node binary the harness booted
  //    under). spawnSync with an args array sidesteps Windows shell-
  //    quoting concerns entirely — no cmd.exe or PowerShell in the chain.
  const result = spawnSync(process.execPath, [childScriptPath], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: PATHS.CLAUDE_CONFIG_DIR },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(
      `child exited with status=${result.status} signal=${result.signal ?? "none"} ` +
        `stdout=${result.stdout ?? ""} stderr=${result.stderr ?? ""}`,
    )
  }

  // 5. PRIMARY assertion: the sentinel exists at the REAL source path
  //    (<claudeHome>/projects/). The child wrote to <mirror>/projects/.
  //    If the junction wasn't created (or was created broken), the write
  //    would have landed in a real <mirror>/projects/ dir and this read
  //    would fail with ENOENT — exactly the original-bug failure mode.
  const sourceSentinelPath = path.join(sourceProjects, sentinelName)
  const sourceBody = await fs.readFile(sourceSentinelPath, "utf8")
  expect(sourceBody).toBe(sentinelBody)

  // 6. The mirror-side path resolves to the SAME byte stream (proves the
  //    junction is bidirectional, not a one-way copy).
  const mirrorBody = await fs.readFile(
    path.join(mirrorProjects, sentinelName),
    "utf8",
  )
  expect(mirrorBody).toBe(sentinelBody)

  // 7. Negative control — same-file invariant, not twin independent
  //    files. Delete via the source path; the mirror view must then
  //    report ENOENT. If the implementation were ever silently rewritten
  //    to copy-on-mirror (instead of link-on-mirror), the mirror view
  //    would still resolve and this assertion would fail.
  await fs.unlink(sourceSentinelPath)
  await expect(
    fs.stat(path.join(mirrorProjects, sentinelName)),
  ).rejects.toThrow()
})
