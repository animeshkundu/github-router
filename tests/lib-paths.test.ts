import { test, expect, mock } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "github-router-paths-"),
)

// Preserve every real `os` export and only override `homedir`. Bun's
// mock.module is global for the rest of the test run — a stripped-down
// mock here would shadow os.tmpdir(), os.platform(), etc. for any
// later test file that imports node:os (e.g. claude-version-check.test
// .ts:11 calls os.tmpdir() at module-load time and would crash with
// "os.tmpdir is not a function" if run after this file).
mock.module("node:os", () => ({
  default: { ...os, homedir: () => tempDir },
  ...os,
  homedir: () => tempDir,
}))

const { ensurePaths, PATHS, sweepStaleRuntimeFiles, sweepStalePeerAgentMdFiles, writeRuntimeFileSecure, ensureClaudeConfigMirror, __testing } =
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
  // Phase 2.5: per-launch .md subagent files written to
  // `PATHS.CLAUDE_CONFIG_DIR/agents/` need a corresponding sweep for
  // orphans from crashed prior proxies. The sweep MUST NOT touch the
  // user's own .md files (which live in the same dir after
  // `ensureClaudeConfigMirror` snapshot-copies them).
  //
  // Phase 2.6 (codex-critic + gemini-critic 2-lab finding): the original
  // permissive regex (`^peer-(\d+)(?:-[0-9a-f]+)?-.+\.md$`) would have
  // matched user files like `peer-12345-meeting-notes.md` and silently
  // unlinked them. The tightened regex requires BOTH the 8-hex-char
  // random suffix AND an exact persona-name suffix. This test exercises
  // BOTH the easy cases AND the user-file-with-PID-shape case the prior
  // version would have silently broken.
  const agentsDir = path.join(PATHS.CLAUDE_CONFIG_DIR, "agents")
  await fs.mkdir(agentsDir, { recursive: true })

  const livePath = path.join(agentsDir, `peer-${process.pid}-abcd1234-codex-critic.md`)
  const deadPid = 2_147_483_642
  const deadPath = path.join(agentsDir, `peer-${deadPid}-deadbeef-codex-critic.md`)
  // User's own subagent — completely unrelated naming, must NOT be touched.
  const userOwn = path.join(agentsDir, "my-personal-helper.md")
  // User's file that *starts* with "peer" but isn't ours.
  const userPeerLike = path.join(agentsDir, "peer-reviewer.md")
  // CRITICAL: user file with PID-shape prefix that the OLD regex matched
  // and the NEW regex must reject (no 8-hex-char segment, no allowlisted
  // persona suffix). Picking deadPid explicitly so isPidAlive=false —
  // any false-positive match would unlink it.
  const userPidLike = path.join(agentsDir, `peer-${deadPid}-meeting-notes.md`)
  // Even nastier: user file matching the PID-and-hex shape but a
  // non-persona suffix. Must still be rejected by the persona allowlist.
  const userPidHexLike = path.join(agentsDir, `peer-${deadPid}-deadbeef-meeting.md`)

  await fs.writeFile(livePath, "---\nname: codex-critic\n---\n", { mode: 0o600 })
  await fs.writeFile(deadPath, "---\nname: codex-critic\n---\n", { mode: 0o600 })
  await fs.writeFile(userOwn, "---\nname: my-personal-helper\n---\n", { mode: 0o600 })
  await fs.writeFile(userPeerLike, "---\nname: peer-reviewer\n---\n", { mode: 0o600 })
  await fs.writeFile(userPidLike, "---\nname: meeting-notes\n---\n", { mode: 0o600 })
  await fs.writeFile(userPidHexLike, "---\nname: meeting\n---\n", { mode: 0o600 })

  await sweepStalePeerAgentMdFiles()

  await expect(fs.stat(livePath)).resolves.toBeDefined()
  await expect(fs.stat(deadPath)).rejects.toThrow()
  await expect(fs.stat(userOwn)).resolves.toBeDefined()
  await expect(fs.stat(userPeerLike)).resolves.toBeDefined()
  // The two PID-shape user files MUST survive the sweep — the prior
  // version's permissive regex would have silently deleted them.
  await expect(fs.stat(userPidLike)).resolves.toBeDefined()
  await expect(fs.stat(userPidHexLike)).resolves.toBeDefined()

  // Cleanup
  await fs.unlink(livePath)
  await fs.unlink(userOwn)
  await fs.unlink(userPeerLike)
  await fs.unlink(userPidLike)
  await fs.unlink(userPidHexLike)
})

test("sweepStalePeerAgentMdFiles tolerates missing CLAUDE_CONFIG_DIR/agents dir", async () => {
  await fs.rm(path.join(PATHS.CLAUDE_CONFIG_DIR, "agents"), { recursive: true, force: true })
  await expect(sweepStalePeerAgentMdFiles()).resolves.toBeUndefined()
})

// ============================================================
// ensureClaudeConfigMirror tests
// ============================================================

test("ensureClaudeConfigMirror creates CLAUDE_CONFIG_DIR with mode 0o700 even when ~/.claude does not exist", async () => {
  // Wipe both source and target before the test
  await fs.rm(path.join(tempDir, ".claude"), { recursive: true, force: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })

  await ensureClaudeConfigMirror()

  const stat = await fs.stat(PATHS.CLAUDE_CONFIG_DIR)
  expect(stat.isDirectory()).toBe(true)
  if (process.platform !== "win32") {
    expect(stat.mode & 0o777).toBe(0o700)
  }
  // Synthetic credential file MUST exist even with no source dir
  const creds = await fs.stat(path.join(PATHS.CLAUDE_CONFIG_DIR, ".credentials.json"))
  expect(creds.isFile()).toBe(true)
  if (process.platform !== "win32") {
    expect(creds.mode & 0o777).toBe(0o600)
  }
  // Marker file MUST exist
  const marker = await fs.stat(path.join(PATHS.CLAUDE_CONFIG_DIR, ".github-router-managed"))
  expect(marker.isFile()).toBe(true)
  // agents/ subdir MUST exist (peer-agent .md emission writes here)
  const agents = await fs.stat(path.join(PATHS.CLAUDE_CONFIG_DIR, "agents"))
  expect(agents.isDirectory()).toBe(true)
})

test("ensureClaudeConfigMirror writes synthetic credential matching the documented schema", async () => {
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })
  await ensureClaudeConfigMirror()

  const body = await fs.readFile(
    path.join(PATHS.CLAUDE_CONFIG_DIR, ".credentials.json"),
    "utf8",
  )
  const parsed = JSON.parse(body)
  // Schema verbatim from claude v2.1.140 binary function `guH`
  expect(parsed.claudeAiOauth).toBeDefined()
  expect(typeof parsed.claudeAiOauth.accessToken).toBe("string")
  expect(typeof parsed.claudeAiOauth.refreshToken).toBe("string")
  expect(typeof parsed.claudeAiOauth.expiresAt).toBe("number")
  expect(Array.isArray(parsed.claudeAiOauth.scopes)).toBe(true)
  expect(parsed.claudeAiOauth.scopes.length).toBeGreaterThan(0)
  expect(parsed.claudeAiOauth.subscriptionType).toBe("max")
  // expiresAt must be far-future (post-2050) to sidestep proactive
  // refresh — Claude Code's `R8H()` returns false for unexpired tokens.
  expect(parsed.claudeAiOauth.expiresAt).toBeGreaterThan(
    new Date("2050-01-01").getTime(),
  )
})

test("ensureClaudeConfigMirror copies user's ~/.claude entries (snapshot, not symlink)", async () => {
  // Set up a fake ~/.claude with various entries
  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(path.join(claudeHome, "agents"), { recursive: true })
  await fs.mkdir(path.join(claudeHome, "skills"), { recursive: true })
  await fs.writeFile(path.join(claudeHome, "settings.json"), '{"theme":"dark"}')
  await fs.writeFile(
    path.join(claudeHome, "agents", "my-helper.md"),
    "---\nname: my-helper\n---\nbody",
  )
  await fs.writeFile(path.join(claudeHome, "skills", "thing.md"), "skill body")
  await fs.writeFile(path.join(claudeHome, "CLAUDE.md"), "global memory")

  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })
  await ensureClaudeConfigMirror()

  // Each entry exists in mirror as a real file (not a symlink)
  for (const rel of [
    "settings.json",
    "agents/my-helper.md",
    "skills/thing.md",
    "CLAUDE.md",
  ]) {
    const target = path.join(PATHS.CLAUDE_CONFIG_DIR, rel)
    const stat = await fs.lstat(target)
    expect(stat.isFile()).toBe(true)
    expect(stat.isSymbolicLink()).toBe(false)
  }
  // Content matches source
  const settings = await fs.readFile(
    path.join(PATHS.CLAUDE_CONFIG_DIR, "settings.json"),
    "utf8",
  )
  expect(settings).toBe('{"theme":"dark"}')
})

test("ensureClaudeConfigMirror: ISOLATED entries absent, SHARED entries become symlinks to ~/.claude/<name>", async () => {
  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })

  // ISOLATED — must NOT appear in mirror
  await fs.writeFile(path.join(claudeHome, ".credentials.json"), '{"real":"creds"}')
  await fs.writeFile(path.join(claudeHome, ".credentials.json.lock"), "lock")
  await fs.writeFile(path.join(claudeHome, ".oauth_refresh.lock"), "lock")
  await fs.mkdir(path.join(claudeHome, "statsig"), { recursive: true })
  await fs.writeFile(path.join(claudeHome, "statsig", "cache.json"), "cache")
  await fs.mkdir(path.join(claudeHome, "logs"), { recursive: true })
  await fs.mkdir(path.join(claudeHome, "cache"), { recursive: true })
  await fs.mkdir(path.join(claudeHome, "paste-cache"), { recursive: true })
  await fs.writeFile(path.join(claudeHome, "paste-cache", "clip.txt"), "secret")

  // SHARED — must become symlinks back to ~/.claude/<name>
  await fs.mkdir(path.join(claudeHome, "projects"), { recursive: true })
  await fs.writeFile(path.join(claudeHome, "projects", "session.jsonl"), "session")
  await fs.mkdir(path.join(claudeHome, "transcripts"), { recursive: true })
  await fs.mkdir(path.join(claudeHome, "todos"), { recursive: true })
  await fs.mkdir(path.join(claudeHome, "shell_snapshots"), { recursive: true })

  // MIRRORED control — present in mirror, real file
  await fs.writeFile(path.join(claudeHome, "settings.json"), "{}")

  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })
  await ensureClaudeConfigMirror()

  // ISOLATED entries must NOT exist in mirror
  for (const isolated of [
    ".credentials.json.lock",
    ".oauth_refresh.lock",
    "statsig",
    "logs",
    "cache",
    "paste-cache",
  ]) {
    await expect(
      fs.stat(path.join(PATHS.CLAUDE_CONFIG_DIR, isolated)),
    ).rejects.toThrow()
  }

  // SHARED entries exist as symlinks pointing at ~/.claude/<name>
  for (const shared of ["projects", "transcripts", "todos", "shell_snapshots"]) {
    const linkPath = path.join(PATHS.CLAUDE_CONFIG_DIR, shared)
    const lst = await fs.lstat(linkPath)
    expect(lst.isSymbolicLink()).toBe(true)
    const target = await fs.readlink(linkPath)
    expect(target).toBe(path.join(claudeHome, shared))
  }
  // And reading through the symlink returns the source's content
  const sessionViaMirror = await fs.readFile(
    path.join(PATHS.CLAUDE_CONFIG_DIR, "projects", "session.jsonl"),
    "utf8",
  )
  expect(sessionViaMirror).toBe("session")

  // .credentials.json IS present in mirror, but with our synthetic content
  // (not the user's "real":"creds" body). This is the load-bearing
  // isolation: the user's credential is never visible to the proxy session.
  const creds = await fs.readFile(
    path.join(PATHS.CLAUDE_CONFIG_DIR, ".credentials.json"),
    "utf8",
  )
  expect(creds).not.toContain("real")
  expect(creds).toContain("claudeAiOauth")

  // MIRRORED control: included entry is present as a real file (not a symlink)
  const settingsStat = await fs.lstat(
    path.join(PATHS.CLAUDE_CONFIG_DIR, "settings.json"),
  )
  expect(settingsStat.isFile()).toBe(true)
  expect(settingsStat.isSymbolicLink()).toBe(false)
})

test("ensureClaudeConfigMirror is idempotent — re-running does not change credential mtime", async () => {
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })
  await ensureClaudeConfigMirror()
  const credsPath = path.join(PATHS.CLAUDE_CONFIG_DIR, ".credentials.json")
  const beforeStat = await fs.stat(credsPath)

  // Wait briefly to ensure any rewrite would change mtime measurably
  await new Promise((r) => setTimeout(r, 20))
  await ensureClaudeConfigMirror()

  const afterStat = await fs.stat(credsPath)
  // Same mtime (file not rewritten — content was identical)
  expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs)
})

test("ensureClaudeConfigMirror tolerates concurrent invocations without EEXIST errors", async () => {
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })
  // Two parallel calls — neither should reject
  await expect(
    Promise.all([ensureClaudeConfigMirror(), ensureClaudeConfigMirror()]),
  ).resolves.toBeDefined()
})

test("ensureClaudeConfigMirror SKIPS symlinks in source (gemini-critic security finding — symlink confused-deputy attack)", async () => {
  if (process.platform === "win32") return // symlinks need admin on Windows

  // Threat model: a previously prompt-injected process (or careless
  // dotfile install) places a symlink at `~/.claude/<X>` →
  // `/some/sensitive/file`. Pre-fix, our walker recreated the symlink in
  // the mirror, and any subsequent write to `<mirror>/<X>` followed the
  // symlink to overwrite the sensitive target. Post-fix, symlinks are
  // skipped entirely — they don't appear in the mirror.
  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })

  // Symlink in source pointing to an arbitrary "sensitive" target
  const sensitiveTarget = path.join(tempDir, "sensitive-target.txt")
  await fs.writeFile(sensitiveTarget, "PRE-FIX-CONTENT")
  await fs.symlink(sensitiveTarget, path.join(claudeHome, "settings.json"))

  // Control: a real file IS still mirrored
  await fs.writeFile(path.join(claudeHome, "CLAUDE.md"), "real content")

  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })
  await ensureClaudeConfigMirror()

  // Post-fix: symlink NOT in mirror at all
  await expect(
    fs.lstat(path.join(PATHS.CLAUDE_CONFIG_DIR, "settings.json")),
  ).rejects.toThrow()
  // Sensitive target file content unchanged (no follow happened)
  const sensitiveAfter = await fs.readFile(sensitiveTarget, "utf8")
  expect(sensitiveAfter).toBe("PRE-FIX-CONTENT")
  // Control: real file IS in mirror
  await expect(
    fs.stat(path.join(PATHS.CLAUDE_CONFIG_DIR, "CLAUDE.md")),
  ).resolves.toBeDefined()
})

test("ensureClaudeConfigMirror marker-write refuses to clobber an existing symlink at .github-router-managed (defense-in-depth)", async () => {
  if (process.platform === "win32") return // symlinks need admin

  // .github-router-managed is ISOLATED in CLAUDE_HOME_POLICY so a user-side
  // symlink at ~/.claude/.github-router-managed wouldn't be mirrored.
  // But this test exercises the defense-in-depth: if a symlink somehow
  // ends up at <mirror>/.github-router-managed (e.g. placed manually by
  // a confused user, or by some process running as the user), the
  // marker write must NOT follow the symlink.
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })
  await fs.mkdir(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 })

  // Plant a malicious symlink at the marker path
  const sensitive = path.join(tempDir, "marker-sensitive.txt")
  await fs.writeFile(sensitive, "DO-NOT-OVERWRITE")
  await fs.symlink(
    sensitive,
    path.join(PATHS.CLAUDE_CONFIG_DIR, ".github-router-managed"),
  )

  await ensureClaudeConfigMirror()

  // Sensitive file content unchanged (symlink not followed)
  const after = await fs.readFile(sensitive, "utf8")
  expect(after).toBe("DO-NOT-OVERWRITE")
})

// ============================================================
// SHARED-symlink phase (3-lab review: chat-history continuity)
// ============================================================

test("ensureClaudeConfigMirror auto-creates ~/.claude/<X> when missing (so symlink target resolves)", async () => {
  if (process.platform === "win32") return // symlinks need admin

  // Start with NO ~/.claude at all
  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })

  await ensureClaudeConfigMirror()

  // The SHARED source dir was auto-created so the symlink isn't dangling
  const sourceProjects = await fs.stat(path.join(claudeHome, "projects"))
  expect(sourceProjects.isDirectory()).toBe(true)

  // And the mirror entry is a symlink resolving to it
  const mirrorProjects = path.join(PATHS.CLAUDE_CONFIG_DIR, "projects")
  const lst = await fs.lstat(mirrorProjects)
  expect(lst.isSymbolicLink()).toBe(true)
  const target = await fs.readlink(mirrorProjects)
  expect(target).toBe(path.join(claudeHome, "projects"))
})

test("ensureClaudeConfigMirror re-points a SHARED symlink whose target is wrong", async () => {
  if (process.platform === "win32") return

  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })
  await fs.mkdir(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 })

  // Pre-place a symlink pointing somewhere else
  const wrongTarget = path.join(tempDir, "decoy-projects")
  await fs.mkdir(wrongTarget, { recursive: true })
  await fs.symlink(
    wrongTarget,
    path.join(PATHS.CLAUDE_CONFIG_DIR, "projects"),
  )

  await ensureClaudeConfigMirror()

  const after = await fs.readlink(
    path.join(PATHS.CLAUDE_CONFIG_DIR, "projects"),
  )
  expect(after).toBe(path.join(claudeHome, "projects"))
})

test("ensureClaudeConfigMirror auto-rmdirs an EMPTY real dir at a SHARED slot, then symlinks (smooth migration path)", async () => {
  if (process.platform === "win32") return

  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })
  await fs.mkdir(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 })

  // Empty real dir from a prior github-router snapshot. Safe to reap
  // since it holds no proxy-session writes.
  const stalePath = path.join(PATHS.CLAUDE_CONFIG_DIR, "projects")
  await fs.mkdir(stalePath, { recursive: true })

  await ensureClaudeConfigMirror()

  // Real dir was rmdir'd and replaced with a symlink to the source dir
  const lst = await fs.lstat(stalePath)
  expect(lst.isSymbolicLink()).toBe(true)
  const target = await fs.readlink(stalePath)
  expect(target).toBe(path.join(claudeHome, "projects"))
})

test("ensureClaudeConfigMirror refuses to clobber a NON-EMPTY real dir at a SHARED slot (migration safety)", async () => {
  if (process.platform === "win32") return

  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })
  await fs.mkdir(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 })

  // Simulate a stale mirror from a prior github-router version: a real
  // dir at <mirror>/projects containing data. Auto-deleting would lose
  // that data — the migration story is warn-and-skip for non-empty dirs.
  const stalePath = path.join(PATHS.CLAUDE_CONFIG_DIR, "projects")
  await fs.mkdir(stalePath, { recursive: true })
  await fs.writeFile(
    path.join(stalePath, "old-session.jsonl"),
    "old-proxy-session-data",
  )

  await ensureClaudeConfigMirror()

  // Real dir + content must survive untouched
  const lst = await fs.lstat(stalePath)
  expect(lst.isDirectory()).toBe(true)
  expect(lst.isSymbolicLink()).toBe(false)
  const survived = await fs.readFile(
    path.join(stalePath, "old-session.jsonl"),
    "utf8",
  )
  expect(survived).toBe("old-proxy-session-data")
})

test("ensureClaudeConfigMirror refuses to clobber a regular FILE at a SHARED slot", async () => {
  if (process.platform === "win32") return

  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })
  await fs.mkdir(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 })

  // Defense-in-depth: if a regular file somehow occupies a SHARED slot
  // (shouldn't happen in practice — only dirs are SHARED — but the path
  // exists in code), warn and skip rather than auto-clobber.
  const filePath = path.join(PATHS.CLAUDE_CONFIG_DIR, "projects")
  await fs.writeFile(filePath, "user-placed-content")

  await ensureClaudeConfigMirror()

  const lst = await fs.lstat(filePath)
  expect(lst.isFile()).toBe(true)
  expect(lst.isSymbolicLink()).toBe(false)
  const survived = await fs.readFile(filePath, "utf8")
  expect(survived).toBe("user-placed-content")
})

test("ensureClaudeConfigMirror SHARED-symlink idempotent: re-running does not change ctime", async () => {
  if (process.platform === "win32") return

  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })

  await ensureClaudeConfigMirror()
  const linkPath = path.join(PATHS.CLAUDE_CONFIG_DIR, "projects")
  const before = await fs.lstat(linkPath)

  await new Promise((r) => setTimeout(r, 20))
  await ensureClaudeConfigMirror()

  const after = await fs.lstat(linkPath)
  // ctime tracks symlink replacement (rename). If the no-op branch is
  // working, ctime is unchanged across invocations.
  expect(after.ctimeMs).toBe(before.ctimeMs)
})

test("policyFor regression guard: agents/ MUST stay MIRRORED (sweep deletes inside it)", () => {
  // sweepStalePeerAgentMdFiles unlinks `peer-<pid>-*.md` files inside
  // <mirror>/agents/. If `agents/` were ever reclassified to SHARED,
  // that sweep would delete files in the user's REAL ~/.claude/agents/
  // including any custom subagent files. Hard-pin to MIRRORED.
  expect(__testing.policyFor("agents")).toBe("MIRRORED")

  // Companion guards for the other isolation-critical names.
  expect(__testing.policyFor(".credentials.json")).toBe("ISOLATED")
  expect(__testing.policyFor("statsig")).toBe("ISOLATED")
  expect(__testing.policyFor("paste-cache")).toBe("ISOLATED")
  // Unknown name defaults to MIRRORED (safe — flows through as snapshot)
  expect(__testing.policyFor("some-future-claude-dir")).toBe("MIRRORED")
  // Files NEVER go in SHARED (Node's fs.rename severs file symlinks
  // silently — gemini-critic finding). Spot-check the two known file
  // names that were considered for SHARED and rejected.
  expect(__testing.policyFor("history.jsonl")).toBe("MIRRORED")
  expect(__testing.policyFor(".claude.json")).toBe("MIRRORED")
})

test("ensureClaudeConfigMirror SHARED-symlink concurrent: parallel calls don't EEXIST", async () => {
  if (process.platform === "win32") return

  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })

  // Two parallel invocations — atomic rename means the loser silently
  // overwrites the winner's symlink with an identical one.
  await expect(
    Promise.all([ensureClaudeConfigMirror(), ensureClaudeConfigMirror()]),
  ).resolves.toBeDefined()

  // Final state: symlink resolves correctly
  const link = await fs.readlink(
    path.join(PATHS.CLAUDE_CONFIG_DIR, "projects"),
  )
  expect(link).toBe(path.join(claudeHome, "projects"))
})
