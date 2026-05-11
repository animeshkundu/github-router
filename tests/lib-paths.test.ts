import { test, expect, mock } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "github-router-paths-"),
)

mock.module("node:os", () => ({
  default: {
    homedir: () => tempDir,
  },
}))

const { ensurePaths, PATHS, sweepStaleRuntimeFiles, sweepStalePeerAgentMdFiles, writeRuntimeFileSecure } =
  await import("../src/lib/paths")

test("ensurePaths creates token file with permissions", async () => {
  await ensurePaths()
  const tokenStats = await fs.stat(PATHS.GITHUB_TOKEN_PATH)
  expect(tokenStats.isFile()).toBe(true)
  // Windows doesn't enforce Unix permission bits; only check on Unix
  if (process.platform !== "win32") {
    expect(tokenStats.mode & 0o777).toBe(0o600)
  }
  expect(PATHS.APP_DIR).toBe(path.join(tempDir, ".local", "share", "github-router"))
})

test("ensurePaths creates CLAUDE_RUNTIME_DIR with mode 0o700", async () => {
  await ensurePaths()
  const dirStats = await fs.stat(PATHS.CLAUDE_RUNTIME_DIR)
  expect(dirStats.isDirectory()).toBe(true)
  if (process.platform !== "win32") {
    expect(dirStats.mode & 0o777).toBe(0o700)
  }
  expect(PATHS.CLAUDE_RUNTIME_DIR).toBe(
    path.join(tempDir, ".local", "share", "github-router", "runtime"),
  )
})

test("writeRuntimeFileSecure writes 0o600 with O_EXCL semantics", async () => {
  await ensurePaths()
  const target = path.join(PATHS.CLAUDE_RUNTIME_DIR, `excl-${Date.now()}.json`)
  await writeRuntimeFileSecure(target, '{"hello":"world"}')

  const stat = await fs.stat(target)
  expect(stat.isFile()).toBe(true)
  if (process.platform !== "win32") {
    expect(stat.mode & 0o777).toBe(0o600)
  }
  const body = await fs.readFile(target, "utf8")
  expect(body).toBe('{"hello":"world"}')

  // Second write to same path must fail (O_EXCL).
  await expect(writeRuntimeFileSecure(target, "x")).rejects.toThrow()

  await fs.unlink(target)
})

test("writeRuntimeFileSecure refuses to follow a pre-placed symlink", async () => {
  if (process.platform === "win32") return // symlinks need admin on Windows

  await ensurePaths()
  const symlinkPath = path.join(
    PATHS.CLAUDE_RUNTIME_DIR,
    `symlink-${Date.now()}.json`,
  )
  const decoyPath = path.join(tempDir, `decoy-${Date.now()}.json`)
  await fs.writeFile(decoyPath, "decoy")
  await fs.symlink(decoyPath, symlinkPath)

  // O_EXCL rejects existing files INCLUDING symlinks (regardless of
  // target). The decoy file must remain untouched.
  await expect(writeRuntimeFileSecure(symlinkPath, "attacker")).rejects.toThrow()
  const decoyAfter = await fs.readFile(decoyPath, "utf8")
  expect(decoyAfter).toBe("decoy")

  await fs.unlink(symlinkPath)
  await fs.unlink(decoyPath)
})

test("sweepStaleRuntimeFiles removes dead-PID files but keeps live-PID files", async () => {
  await ensurePaths()
  const dir = PATHS.CLAUDE_RUNTIME_DIR

  // Live: this process's PID
  const livePath = path.join(dir, `peer-mcp-${process.pid}.json`)
  await fs.writeFile(livePath, "{}", { mode: 0o600 })

  // Dead: a PID that almost certainly doesn't exist (max signed int -1)
  const deadPid = 2_147_483_646
  const deadPath = path.join(dir, `peer-mcp-${deadPid}.json`)
  await fs.writeFile(deadPath, "{}", { mode: 0o600 })

  // Unrelated file — should not be touched even though the dir matches.
  const unrelatedPath = path.join(dir, "not-a-peer-config.txt")
  await fs.writeFile(unrelatedPath, "leave me alone", { mode: 0o600 })

  await sweepStaleRuntimeFiles()

  await expect(fs.stat(livePath)).resolves.toBeDefined()
  await expect(fs.stat(deadPath)).rejects.toThrow()
  await expect(fs.stat(unrelatedPath)).resolves.toBeDefined()

  await fs.unlink(livePath)
  await fs.unlink(unrelatedPath)
})

test("sweepStaleRuntimeFiles also removes peer-agents-* dead-PID files", async () => {
  await ensurePaths()
  const dir = PATHS.CLAUDE_RUNTIME_DIR

  const deadPid = 2_147_483_645
  const deadAgentsPath = path.join(dir, `peer-agents-${deadPid}.json`)
  await fs.writeFile(deadAgentsPath, "{}", { mode: 0o600 })

  await sweepStaleRuntimeFiles()
  await expect(fs.stat(deadAgentsPath)).rejects.toThrow()
})

test("sweepStaleRuntimeFiles tolerates missing dir without throwing", async () => {
  // Drop the dir, then call sweep — should be a no-op.
  await fs.rm(PATHS.CLAUDE_RUNTIME_DIR, { recursive: true, force: true })
  await expect(sweepStaleRuntimeFiles()).resolves.toBeUndefined()
})

test("sweepStaleRuntimeFiles does NOT delete a live-PID file even if it is older than 24h", async () => {
  // Regression for codex_reviewer batch7 finding: the previous sweep
  // age-pruned files older than 24h regardless of liveness, which would
  // delete a long-running proxy's active tempfiles out from under it.
  // Now: only dead-PID files are removed; age is irrelevant for live PIDs.
  await ensurePaths()
  const dir = PATHS.CLAUDE_RUNTIME_DIR

  const livePath = path.join(dir, `peer-mcp-${process.pid}-deadbeef.json`)
  await fs.writeFile(livePath, "{}", { mode: 0o600 })

  // Backdate to 7 days ago — well past any 24h "stale" threshold.
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  await fs.utimes(livePath, sevenDaysAgo / 1000, sevenDaysAgo / 1000)

  await sweepStaleRuntimeFiles()

  await expect(fs.stat(livePath)).resolves.toBeDefined()
  await fs.unlink(livePath)
})

test("sweepStaleRuntimeFiles handles both legacy peer-mcp-<pid>.json and new peer-mcp-<pid>-<rand>.json", async () => {
  // Regression: filenames now carry a random suffix to avoid in-process
  // collisions. The sweep regex must match BOTH the legacy and current
  // shapes so we can clean up after either.
  await ensurePaths()
  const dir = PATHS.CLAUDE_RUNTIME_DIR

  const deadPidA = 2_147_483_644
  const deadPidB = 2_147_483_643
  const legacyDead = path.join(dir, `peer-mcp-${deadPidA}.json`)
  const suffixedDead = path.join(dir, `peer-agents-${deadPidB}-cafef00d.json`)
  await fs.writeFile(legacyDead, "{}", { mode: 0o600 })
  await fs.writeFile(suffixedDead, "{}", { mode: 0o600 })

  await sweepStaleRuntimeFiles()

  await expect(fs.stat(legacyDead)).rejects.toThrow()
  await expect(fs.stat(suffixedDead)).rejects.toThrow()
})

test("sweepStalePeerAgentMdFiles deletes dead-PID peer-*.md but keeps live-PID and unrelated user files", async () => {
  // Phase 2.5: per-launch .md subagent files written to ~/.claude/agents/
  // need a corresponding sweep for orphans from crashed prior proxies.
  // The sweep MUST NOT touch the user's own .md files (they don't match
  // the `peer-<numeric-pid>-` prefix).
  const agentsDir = path.join(tempDir, ".claude", "agents")
  await fs.mkdir(agentsDir, { recursive: true })

  const livePath = path.join(agentsDir, `peer-${process.pid}-abcd1234-codex-critic.md`)
  const deadPid = 2_147_483_642
  const deadPath = path.join(agentsDir, `peer-${deadPid}-deadbeef-codex-critic.md`)
  // User's own subagent — completely unrelated naming, must NOT be touched.
  const userOwn = path.join(agentsDir, "my-personal-helper.md")
  // Edge case: user's file that *starts* with "peer" but isn't ours
  // (e.g., the user named their own subagent "peer-reviewer"). MUST NOT
  // be touched because the digit-PID segment isn't there.
  const userPeerLike = path.join(agentsDir, "peer-reviewer.md")

  await fs.writeFile(livePath, "---\nname: codex-critic\n---\n", { mode: 0o600 })
  await fs.writeFile(deadPath, "---\nname: codex-critic\n---\n", { mode: 0o600 })
  await fs.writeFile(userOwn, "---\nname: my-personal-helper\n---\n", { mode: 0o600 })
  await fs.writeFile(userPeerLike, "---\nname: peer-reviewer\n---\n", { mode: 0o600 })

  await sweepStalePeerAgentMdFiles()

  await expect(fs.stat(livePath)).resolves.toBeDefined()
  await expect(fs.stat(deadPath)).rejects.toThrow()
  await expect(fs.stat(userOwn)).resolves.toBeDefined()
  await expect(fs.stat(userPeerLike)).resolves.toBeDefined()

  // Cleanup
  await fs.unlink(livePath)
  await fs.unlink(userOwn)
  await fs.unlink(userPeerLike)
})

test("sweepStalePeerAgentMdFiles tolerates missing ~/.claude/agents dir", async () => {
  await fs.rm(path.join(tempDir, ".claude", "agents"), { recursive: true, force: true })
  await expect(sweepStalePeerAgentMdFiles()).resolves.toBeUndefined()
})
