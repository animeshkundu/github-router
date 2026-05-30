import { test, expect, mock } from "bun:test"
import consola from "consola"
import { randomBytes } from "node:crypto"
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

const { ensurePaths, PATHS, sweepStaleRuntimeFiles, sweepStalePeerAgentMdFiles, sweepStaleClaudeConfigMirrors, removeOwnClaudeConfigMirror, writeRuntimeFileSecure, ensureClaudeConfigMirror, __testing } =
  await import("../src/lib/paths")

// Round-4 #4: verify that monkey-patching `fs.<name>` / `consola.<name>`
// is actually intercepted by the library-side imports of those
// modules. Both the library and these tests use `import X from "..."`
// (default-import form) — so the load-bearing invariant is that
// `(await import(...)).default` is the SAME object we monkey-patched.
// We assert that explicitly. ESM/CJS interop in Bun gives every
// default-import consumer the same singleton object, but a future
// loader change could silently break that and our spy-based tests
// would then pass vacuously (no spy invocations recorded ⇒
// "spy NOT called for X" trivially true). This sanity check fails
// loud before we draw any inference from `spy.mock.calls`.
//
// Note: we check `mod.default[prop]`, not `mod[prop]`. The
// re-import's named-export binding (`mod.realpath`) is a separate
// reference from the default object and is NOT what the library
// sees through its default import — so checking the named binding
// would be the wrong test.
async function expectFsSpyInstalled(
  prop: string,
  spy: unknown,
): Promise<void> {
  const fsModule = await import("node:fs/promises")
  expect(
    (fsModule.default as unknown as Record<string, unknown>)[prop],
  ).toBe(spy)
}
async function expectConsolaSpyInstalled(
  prop: string,
  spy: unknown,
): Promise<void> {
  const consolaModule = await import("consola")
  expect(
    (consolaModule.default as unknown as Record<string, unknown>)[prop],
  ).toBe(spy)
}

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
  // Skipped on Windows: the test setup deliberately creates a FILE-typed
  // symlink (`fs.symlink(decoyPath, symlinkPath)` where decoy is a file),
  // which on Windows requires admin or Developer Mode. The Windows symlink
  // fix in src/lib/paths.ts uses `'junction'` for directory targets only;
  // file-typed symlinks remain admin-gated by the OS and are unrelated to
  // the SHARED-mirror fix.
  if (process.platform === "win32") return

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
// Per-launch CLAUDE_CONFIG_DIR tests (Part 1: holistic subagent MCP
// inheritance — see plans/in-this-code-base-cryptic-dove.md)
// ============================================================

test("PATHS.CLAUDE_CONFIG_DIR ends with <pid>-<8 hex> and is stable across calls within the process", () => {
  const first = PATHS.CLAUDE_CONFIG_DIR
  // Shape check — leaf is the per-launch suffix, parent is "claude-config"
  const leaf = path.basename(first)
  const parent = path.basename(path.dirname(first))
  expect(parent).toBe("claude-config")
  expect(leaf).toMatch(new RegExp(`^${process.pid}-[0-9a-f]{8}$`))
  // Stability — every access returns the same value
  const second = PATHS.CLAUDE_CONFIG_DIR
  const third = PATHS.CLAUDE_CONFIG_DIR
  expect(second).toBe(first)
  expect(third).toBe(first)
})

test("sweepStaleClaudeConfigMirrors deletes dead-PID dirs but keeps live-PID dirs and unrelated siblings", async () => {
  await ensurePaths()
  const parent = path.join(PATHS.APP_DIR, "claude-config")
  await fs.mkdir(parent, { recursive: true })

  // Live: this process's PID (matches the strict <pid>-<8 hex> shape)
  const livePath = path.join(parent, `${process.pid}-cafef00d`)
  await fs.mkdir(livePath, { recursive: true })
  await fs.writeFile(path.join(livePath, "sentinel"), "live")

  // Dead: a PID that almost certainly doesn't exist
  const deadPid = 2_147_483_641
  const deadPath = path.join(parent, `${deadPid}-deadbeef`)
  await fs.mkdir(deadPath, { recursive: true })
  await fs.writeFile(path.join(deadPath, "sentinel"), "dead")

  // Unrelated user-authored sibling — must NOT be touched. Picks names
  // that DON'T match the <pid>-<8 hex> shape (no underscore-vs-dash
  // wiggle: the regex requires lowercase 8-char hex, anchored).
  const userOwn = path.join(parent, "my-backup-dir")
  await fs.mkdir(userOwn, { recursive: true })
  await fs.writeFile(path.join(userOwn, "user-file"), "leave-me")
  // Even nastier: a sibling that's <digits>-<not-quite-8-hex>, which
  // the regex must reject (wrong suffix length).
  const userPidShape = path.join(parent, `${deadPid}-deadbef`)
  await fs.mkdir(userPidShape, { recursive: true })
  await fs.writeFile(path.join(userPidShape, "user-file"), "leave-me-too")
  // And a sibling with the right hex length but non-hex chars.
  const userBadHex = path.join(parent, `${deadPid}-zzzzzzzz`)
  await fs.mkdir(userBadHex, { recursive: true })
  await fs.writeFile(path.join(userBadHex, "user-file"), "leave-me-three")

  await sweepStaleClaudeConfigMirrors()

  await expect(fs.stat(livePath)).resolves.toBeDefined()
  await expect(fs.stat(deadPath)).rejects.toThrow()
  await expect(fs.stat(userOwn)).resolves.toBeDefined()
  await expect(fs.stat(userPidShape)).resolves.toBeDefined()
  await expect(fs.stat(userBadHex)).resolves.toBeDefined()

  // Cleanup
  await fs.rm(livePath, { recursive: true, force: true })
  await fs.rm(userOwn, { recursive: true, force: true })
  await fs.rm(userPidShape, { recursive: true, force: true })
  await fs.rm(userBadHex, { recursive: true, force: true })
})

test("sweepStaleClaudeConfigMirrors tolerates missing parent dir", async () => {
  // No claude-config/ at all (e.g. first-ever launch, or user wiped).
  // Sweep must no-op rather than throw.
  await fs.rm(path.join(PATHS.APP_DIR, "claude-config"), { recursive: true, force: true })
  await expect(sweepStaleClaudeConfigMirrors()).resolves.toBeUndefined()
})

test("removeOwnClaudeConfigMirror deletes this launch's mirror dir and does NOT follow SHARED junctions", async () => {
  // Establish a mirror with a SHARED junction inside it.
  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })
  await ensureClaudeConfigMirror()

  // Plant a sentinel in the SHARED source so we can prove removal of
  // the mirror dir does not destroy it.
  const sentinelName = `sentinel-${randomBytes(8).toString("hex")}.txt`
  const sentinelBody = `survives-removal-${Date.now()}`
  await fs.writeFile(
    path.join(claudeHome, "projects", sentinelName),
    sentinelBody,
  )

  // Sanity: mirror dir exists, SHARED slot is reachable via mirror.
  await expect(fs.stat(PATHS.CLAUDE_CONFIG_DIR)).resolves.toBeDefined()
  await expect(
    fs.stat(path.join(PATHS.CLAUDE_CONFIG_DIR, "projects", sentinelName)),
  ).resolves.toBeDefined()

  await removeOwnClaudeConfigMirror()

  // Mirror dir gone.
  await expect(fs.stat(PATHS.CLAUDE_CONFIG_DIR)).rejects.toThrow()
  // SHARED source dir + sentinel content untouched (fs.rm did NOT
  // follow the junction into ~/.claude/projects/).
  const survived = await fs.readFile(
    path.join(claudeHome, "projects", sentinelName),
    "utf8",
  )
  expect(survived).toBe(sentinelBody)

  // Re-provision the mirror for downstream tests that expect it to exist.
  await ensureClaudeConfigMirror()
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
  // rateLimitTier paired with subscriptionType:"max" is the real Max-20x
  // tier (internally consistent vs the prior `max`+`null`); makes the
  // natural getPlanModeV2AgentCount path also yield 3 (CLAUDE_CODE_PLAN_V2_
  // AGENT_COUNT=7 in server-setup overrides this regardless).
  expect(parsed.claudeAiOauth.rateLimitTier).toBe("default_claude_max_20x")
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

  // SHARED entries resolve to the source directory. We additionally
  // assert `isSymbolicLink()` + exact `readlink()` ONLY on POSIX —
  // Windows uses junctions (lstat reports them as directories, and
  // readlink may return `\\?\` device-namespace prefixed paths).
  for (const shared of ["projects", "transcripts", "todos", "shell_snapshots"]) {
    const linkPath = path.join(PATHS.CLAUDE_CONFIG_DIR, shared)
    // Cross-platform: stat resolves through the link to the source dir.
    const resolved = await fs.stat(linkPath)
    expect(resolved.isDirectory()).toBe(true)
    if (process.platform !== "win32") {
      const lst = await fs.lstat(linkPath)
      expect(lst.isSymbolicLink()).toBe(true)
      const target = await fs.readlink(linkPath)
      expect(target).toBe(path.join(claudeHome, shared))
    }
  }
  // And reading through the link returns the source's content
  // (behavioral round-trip — works on POSIX symlinks and Windows
  // junctions identically).
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
  // Start with NO ~/.claude at all
  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })

  await ensureClaudeConfigMirror()

  // The SHARED source dir was auto-created so the link isn't dangling
  const sourceProjects = await fs.stat(path.join(claudeHome, "projects"))
  expect(sourceProjects.isDirectory()).toBe(true)

  // And the mirror entry resolves to it. We don't assert
  // `isSymbolicLink()` / exact `readlink()` here because Windows uses
  // junctions (lstat reports junctions as directories, and readlink may
  // return `\\?\`-prefixed device-namespace paths). Behavioral round-trip
  // proves the link works regardless of the underlying mechanism.
  const mirrorProjects = path.join(PATHS.CLAUDE_CONFIG_DIR, "projects")
  const mirrorStat = await fs.stat(mirrorProjects)
  expect(mirrorStat.isDirectory()).toBe(true)

  const sentinelName = `sentinel-${randomBytes(8).toString("hex")}.txt`
  const sentinelBody = `roundtrip-${Date.now()}`
  await fs.writeFile(path.join(mirrorProjects, sentinelName), sentinelBody)
  const readback = await fs.readFile(
    path.join(claudeHome, "projects", sentinelName),
    "utf8",
  )
  expect(readback).toBe(sentinelBody)
})

test("ensureClaudeConfigMirror re-points a SHARED symlink whose target is wrong", async () => {
  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })
  await fs.mkdir(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 })

  // Pre-place a directory link pointing somewhere else. Use `'junction'`
  // on Windows (no admin needed); `'dir'` on POSIX.
  const wrongTarget = path.join(tempDir, "decoy-projects")
  await fs.mkdir(wrongTarget, { recursive: true })
  await fs.writeFile(path.join(wrongTarget, "decoy.txt"), "decoy-content")
  await fs.symlink(
    wrongTarget,
    path.join(PATHS.CLAUDE_CONFIG_DIR, "projects"),
    process.platform === "win32" ? "junction" : "dir",
  )

  await ensureClaudeConfigMirror()

  // After: writing a sentinel through the mirror lands in the correct
  // source dir (not the decoy). We don't compare `readlink()` strings
  // because Windows junctions may return `\\?\`-prefixed device paths.
  const sentinelName = `sentinel-${randomBytes(8).toString("hex")}.txt`
  const sentinelBody = `repoint-${Date.now()}`
  await fs.writeFile(
    path.join(PATHS.CLAUDE_CONFIG_DIR, "projects", sentinelName),
    sentinelBody,
  )
  const readback = await fs.readFile(
    path.join(claudeHome, "projects", sentinelName),
    "utf8",
  )
  expect(readback).toBe(sentinelBody)
  // The decoy must NOT have received the sentinel (proves the link was
  // re-pointed away from it).
  await expect(
    fs.stat(path.join(wrongTarget, sentinelName)),
  ).rejects.toThrow()
})

test("ensureClaudeConfigMirror auto-rmdirs an EMPTY real dir at a SHARED slot, then symlinks (smooth migration path)", async () => {
  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })
  await fs.mkdir(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 })

  // Empty real dir from a prior github-router snapshot. Safe to reap
  // since it holds no proxy-session writes.
  const slotPath = path.join(PATHS.CLAUDE_CONFIG_DIR, "projects")
  await fs.mkdir(slotPath, { recursive: true })

  await ensureClaudeConfigMirror()

  // Real dir was rmdir'd and replaced with a directory link to the
  // source dir. Behavioral check: stat resolves through, and a sentinel
  // written through the slot appears in the source dir. We don't assert
  // `isSymbolicLink()` because Windows junctions are reported by `lstat`
  // as directories, not symlinks.
  const slotStat = await fs.stat(slotPath)
  expect(slotStat.isDirectory()).toBe(true)

  const sentinelName = `sentinel-${randomBytes(8).toString("hex")}.txt`
  const sentinelBody = `empty-rmdir-${Date.now()}`
  await fs.writeFile(path.join(slotPath, sentinelName), sentinelBody)
  const readback = await fs.readFile(
    path.join(claudeHome, "projects", sentinelName),
    "utf8",
  )
  expect(readback).toBe(sentinelBody)
})

test("ensureClaudeConfigMirror refuses to clobber a NON-EMPTY real dir at a SHARED slot (migration safety)", async () => {
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

  // Real dir + content must survive untouched. Content preservation is
  // the load-bearing cross-platform check (a successful clobber would
  // either replace the dir with a link to an empty source dir, or empty
  // out the slot). On POSIX we additionally assert "still NOT a
  // symbolic link" since a clobber would create one; on Windows
  // junctions are reported by `lstat` as directories, so that specific
  // check is meaningless and skipped.
  const lst = await fs.lstat(stalePath)
  expect(lst.isDirectory()).toBe(true)
  if (process.platform !== "win32") {
    expect(lst.isSymbolicLink()).toBe(false)
  }
  const survived = await fs.readFile(
    path.join(stalePath, "old-session.jsonl"),
    "utf8",
  )
  expect(survived).toBe("old-proxy-session-data")
})

test("ensureClaudeConfigMirror refuses to clobber a regular FILE at a SHARED slot", async () => {
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
  // The "not a symbolic link" assertion is only meaningful on POSIX —
  // on Windows a successful clobber would create a junction (which
  // `lstat` reports as a directory, never a symlink), so the assertion
  // would always pass vacuously and provides no signal.
  if (process.platform !== "win32") {
    expect(lst.isSymbolicLink()).toBe(false)
  }
  const survived = await fs.readFile(filePath, "utf8")
  expect(survived).toBe("user-placed-content")
})

test("ensureClaudeConfigMirror SHARED-symlink idempotent: re-running does not change ctime", async () => {
  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })

  await ensureClaudeConfigMirror()
  const linkPath = path.join(PATHS.CLAUDE_CONFIG_DIR, "projects")
  // `lstat` returns the link's own metadata on POSIX symlinks AND on
  // Windows junctions (both expose ctime tracking the slot's creation
  // / replacement). If the no-op branch fires, no rename happens and
  // ctime is unchanged across invocations.
  const before = await fs.lstat(linkPath)

  await new Promise((r) => setTimeout(r, 20))
  await ensureClaudeConfigMirror()

  const after = await fs.lstat(linkPath)
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
  // Background-session supervisor state (Claude Code v2.1.139+) — must
  // stay ISOLATED so a real-user `claude --bg` session never surfaces
  // in a proxy session under the synthetic credential. Crossing the
  // credential domain would route follow-up calls to dispatched bg
  // jobs through the proxy bearer.
  expect(__testing.policyFor("jobs")).toBe("ISOLATED")
  expect(__testing.policyFor("daemon")).toBe("ISOLATED")
  expect(__testing.policyFor("daemon.log")).toBe("ISOLATED")
  // Unknown name defaults to MIRRORED (safe — flows through as snapshot)
  expect(__testing.policyFor("some-future-claude-dir")).toBe("MIRRORED")
  // Files NEVER go in SHARED (Node's fs.rename severs file symlinks
  // silently — gemini-critic finding). Spot-check the two known file
  // names that were considered for SHARED and rejected.
  expect(__testing.policyFor("history.jsonl")).toBe("MIRRORED")
  expect(__testing.policyFor(".claude.json")).toBe("MIRRORED")
})

test("ensureClaudeConfigMirror SHARED-symlink concurrent: parallel calls don't EEXIST", async () => {
  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })

  // Two parallel invocations — atomic rename means the loser silently
  // overwrites the winner's link with an identical one.
  await expect(
    Promise.all([ensureClaudeConfigMirror(), ensureClaudeConfigMirror()]),
  ).resolves.toBeDefined()

  // Final state: the link resolves to the source dir. Behavioral
  // round-trip rather than `readlink()` comparison so Windows junctions
  // (which may return `\\?\`-prefixed device paths) are accepted.
  const mirrorProjects = path.join(PATHS.CLAUDE_CONFIG_DIR, "projects")
  const sentinelName = `sentinel-${randomBytes(8).toString("hex")}.txt`
  const sentinelBody = `concurrent-${Date.now()}`
  await fs.writeFile(path.join(mirrorProjects, sentinelName), sentinelBody)
  const readback = await fs.readFile(
    path.join(claudeHome, "projects", sentinelName),
    "utf8",
  )
  expect(readback).toBe(sentinelBody)

  // G6: no `.tmp.<pid>.<hex>` leftovers from the racing rename. The
  // catch-and-cleanup branch must reap its own temp; if a regression
  // skips the cleanup we'd see litter accumulating in the mirror dir
  // across every concurrent invocation.
  const mirrorEntries = await fs.readdir(PATHS.CLAUDE_CONFIG_DIR)
  const tempLitter = mirrorEntries.filter((name) => name.includes(".tmp."))
  expect(tempLitter).toEqual([])

  // G6: every SHARED entry — not just the spot-checked `projects` —
  // resolves to its source dir behaviorally. Earlier the loop only
  // verified `projects`; if a regression broke one of the others
  // (e.g. trailing-slash drift in the sourcePath construction for a
  // specific name) the spot-check would have missed it.
  for (const sharedName of [
    "projects",
    "transcripts",
    "todos",
    "shell-snapshots",
    "sessions",
    "tasks",
    "plans",
    "file-history",
    "backups",
  ]) {
    const slot = path.join(PATHS.CLAUDE_CONFIG_DIR, sharedName)
    const source = path.join(claudeHome, sharedName)
    const perEntrySentinel = `sentinel-${randomBytes(8).toString("hex")}.txt`
    const perEntryBody = `roundtrip-${sharedName}-${Date.now()}`
    await fs.writeFile(path.join(slot, perEntrySentinel), perEntryBody)
    const back = await fs.readFile(
      path.join(source, perEntrySentinel),
      "utf8",
    )
    expect(back).toBe(perEntryBody)
  }
})

test("ensureClaudeConfigMirror SHARED-symlink concurrent wrong-target replace: parallel re-points converge correctly (G6)", async () => {
  // Pre-place a wrong-target junction at the slot, then run N=4
  // parallel `ensureClaudeConfigMirror` calls. On Windows this
  // exercises the unlink-then-rename branch under contention — every
  // call's lstat sees a symlink, every call enters the replace path.
  // The end-state contract: the slot resolves to the correct source,
  // the decoy is untouched, no temp files are left behind.
  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })
  await fs.mkdir(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 })

  const slotPath = path.join(PATHS.CLAUDE_CONFIG_DIR, "projects")
  const sourcePath = path.join(claudeHome, "projects")
  const decoyTarget = path.join(
    tempDir,
    `decoy-concurrent-${randomBytes(4).toString("hex")}`,
  )
  await fs.mkdir(decoyTarget, { recursive: true })
  await fs.symlink(
    decoyTarget,
    slotPath,
    process.platform === "win32" ? "junction" : "dir",
  )

  // N=4 parallel ensures, all of which see the wrong-target slot.
  await expect(
    Promise.all([
      ensureClaudeConfigMirror(),
      ensureClaudeConfigMirror(),
      ensureClaudeConfigMirror(),
      ensureClaudeConfigMirror(),
    ]),
  ).resolves.toBeDefined()

  // 1. Slot now resolves to the correct source via sentinel round-trip.
  const sentinelName = `sentinel-${randomBytes(8).toString("hex")}.txt`
  const sentinelBody = `repoint-parallel-${Date.now()}`
  await fs.writeFile(path.join(slotPath, sentinelName), sentinelBody)
  const back = await fs.readFile(
    path.join(sourcePath, sentinelName),
    "utf8",
  )
  expect(back).toBe(sentinelBody)

  // 2. Decoy untouched — the sentinel must NOT have landed there
  // (proves all 4 calls re-pointed correctly, not just the first).
  await expect(
    fs.stat(path.join(decoyTarget, sentinelName)),
  ).rejects.toThrow()

  // 3. No temp-file litter from the concurrent rename catches.
  const mirrorEntries = await fs.readdir(PATHS.CLAUDE_CONFIG_DIR)
  const tempLitter = mirrorEntries.filter((name) => name.includes(".tmp."))
  expect(tempLitter).toEqual([])
})

// ============================================================
// Round-3 G2: diagnostic test for the SHARED-symlink fast path
// ============================================================
//
// Adversarial-review finding (3 critics, 3 different labs): the fast
// path at `ensureSharedSymlink` did `currentTarget === sourcePath` on
// the raw `readlink()` output. On Windows, junctions resolve via
// readlink to `\\?\`-prefixed device-namespace paths (e.g.
// `\\?\C:\Users\foo\.claude\projects` vs the plain `C:\Users\foo\
// .claude\projects` we wrote with `fs.symlink`). The literal `===`
// always returned false → fast path never fired → every startup did
// unlink + rename per SHARED entry (×9). Test #7 (`idempotent ...
// does not change ctime`) passed anyway because NTFS File System
// Tunneling forges the creation timestamp for a name deleted and
// recreated within 15 s — the dir WAS being torn down/rebuilt, the
// ctime was just being faked by the OS.
//
// This diagnostic test is a MECHANISM test, not an outcome test:
// it spies on fs.symlink/fs.rename/fs.unlink and asserts ZERO
// SHARED-slot calls on a steady-state re-invocation. On POSIX this
// passes pre-fix (readlink returns the verbatim value we wrote);
// on Windows it FAILS pre-fix and passes post-fix (realpath
// canonicalizes both sides to the same form).
test("ensureClaudeConfigMirror fast-path: re-running does NOT churn SHARED junctions (no fs.symlink/rename/unlink for shared slots)", async () => {
  // Fresh state so the first call does the create.
  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.rm(PATHS.CLAUDE_CONFIG_DIR, { recursive: true, force: true })

  // Warm up: establishes the SHARED links in steady state.
  await ensureClaudeConfigMirror()

  // Snapshot of which paths count as SHARED slots for our spy filter.
  // Anything that targets one of these (or a `<slot>.tmp.<pid>.<hex>`
  // variant) is a SHARED-slot mutation we want to count.
  const sharedSlots = [
    "projects",
    "transcripts",
    "todos",
    "shell_snapshots",
    "shell-snapshots",
    "sessions",
    "tasks",
    "plans",
    "file-history",
    "backups",
  ].map((n) => path.join(PATHS.CLAUDE_CONFIG_DIR, n))
  const touchesShared = (arg: unknown): boolean =>
    typeof arg === "string" &&
    sharedSlots.some(
      (slot) => arg === slot || arg.startsWith(`${slot}.tmp.`),
    )

  // Spy by monkey-patching the imported fs object. `import fs from
  // "node:fs/promises"` is a singleton namespace; mutating its
  // properties is visible inside `src/lib/paths.ts` too.
  const originalSymlink = fs.symlink
  const originalRename = fs.rename
  const originalUnlink = fs.unlink
  const symlinkSpy = mock(originalSymlink.bind(fs))
  const renameSpy = mock(originalRename.bind(fs))
  const unlinkSpy = mock(originalUnlink.bind(fs))
  ;(fs as unknown as { symlink: typeof fs.symlink }).symlink = symlinkSpy
  ;(fs as unknown as { rename: typeof fs.rename }).rename = renameSpy
  ;(fs as unknown as { unlink: typeof fs.unlink }).unlink = unlinkSpy
  try {
    // Round-4 #4 sanity: prove the monkey-patch is visible to the
    // library-side `import fs from "node:fs/promises"`. Without
    // this guard, a silent intercept failure would make the
    // "zero SHARED-slot calls" assertion trivially true and we'd
    // ship a Windows churn regression undetected.
    await expectFsSpyInstalled("symlink", symlinkSpy)
    await expectFsSpyInstalled("rename", renameSpy)
    await expectFsSpyInstalled("unlink", unlinkSpy)

    // Steady-state re-invocation. Expectation: no SHARED slot is
    // touched by any of the three mutation syscalls.
    await ensureClaudeConfigMirror()

    const sharedSymlinkCalls = symlinkSpy.mock.calls.filter((call) =>
      (call as unknown[]).some(touchesShared),
    )
    const sharedRenameCalls = renameSpy.mock.calls.filter((call) =>
      (call as unknown[]).some(touchesShared),
    )
    const sharedUnlinkCalls = unlinkSpy.mock.calls.filter((call) =>
      (call as unknown[]).some(touchesShared),
    )

    expect(sharedSymlinkCalls).toEqual([])
    expect(sharedRenameCalls).toEqual([])
    expect(sharedUnlinkCalls).toEqual([])
  } finally {
    ;(fs as unknown as { symlink: typeof fs.symlink }).symlink =
      originalSymlink
    ;(fs as unknown as { rename: typeof fs.rename }).rename = originalRename
    ;(fs as unknown as { unlink: typeof fs.unlink }).unlink = originalUnlink
  }
})

// ============================================================
// Round-3 G1 / G5: smoking-gun warn coverage for fs catches
// ============================================================
//
// Both `fs.symlink` and `fs.rename` failure paths in ensureSharedSymlink
// now warn (formerly debug). These tests pin both to consola.warn
// so a future contributor doesn't silently downgrade them again
// (which is exactly what hid the round-1 EPERM and round-2
// rename-replace bugs through entire releases).

test("ensureSharedSymlink: rename failure surfaces a consola.warn and cleans up temp (G5)", async () => {
  // Fresh state — we want the rename branch to actually run.
  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })
  const mirrorDir = path.join(
    tempDir,
    `mirror-rename-warn-${randomBytes(4).toString("hex")}`,
  )
  await fs.mkdir(mirrorDir, { recursive: true })

  const originalRename = fs.rename
  const originalUnlink = fs.unlink
  const originalWarn = consola.warn
  const renameSpy = mock(async () => {
    const err = new Error("simulated rename failure") as NodeJS.ErrnoException
    err.code = "EPERM"
    throw err
  })
  const unlinkSpy = mock(originalUnlink.bind(fs))
  const warnSpy = mock(originalWarn.bind(consola))
  ;(fs as unknown as { rename: unknown }).rename = renameSpy
  ;(fs as unknown as { unlink: unknown }).unlink = unlinkSpy
  ;(consola as unknown as { warn: unknown }).warn = warnSpy
  try {
    // Round-4 #4 sanity: intercept is live on both modules.
    await expectFsSpyInstalled("rename", renameSpy)
    await expectFsSpyInstalled("unlink", unlinkSpy)
    await expectConsolaSpyInstalled("warn", warnSpy)

    await __testing.ensureSharedSymlink("projects", claudeHome, mirrorDir)

    // Warn fired with a message identifying the failing call.
    const warnedAboutRename = warnSpy.mock.calls.some((call) => {
      const msg = call[0]
      return (
        typeof msg === "string" &&
        msg.includes("rename") &&
        msg.includes("failed")
      )
    })
    expect(warnedAboutRename).toBe(true)

    // Temp was unlinked so we don't leave `<mirror>/projects.tmp.<pid>.<hex>`
    // litter behind. The exact temp path is randomised, so we match by
    // the `<slot>.tmp.` prefix.
    const slotPath = path.join(mirrorDir, "projects")
    const unlinkedTemp = unlinkSpy.mock.calls.some((call) => {
      const arg = call[0]
      return typeof arg === "string" && arg.startsWith(`${slotPath}.tmp.`)
    })
    expect(unlinkedTemp).toBe(true)
  } finally {
    ;(fs as unknown as { rename: typeof fs.rename }).rename = originalRename
    ;(fs as unknown as { unlink: typeof fs.unlink }).unlink = originalUnlink
    ;(consola as unknown as { warn: typeof consola.warn }).warn = originalWarn
  }
})

test("ensureSharedSymlink: symlink failure surfaces a consola.warn (G1 regression)", async () => {
  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })
  const mirrorDir = path.join(
    tempDir,
    `mirror-symlink-warn-${randomBytes(4).toString("hex")}`,
  )
  await fs.mkdir(mirrorDir, { recursive: true })

  const originalSymlink = fs.symlink
  const originalWarn = consola.warn

  // Case 1: EPERM (the original round-1 failure mode — pre-fix
  // Windows users hit this every launch and the silent debug log
  // hid it).
  for (const code of ["EPERM", "EXDEV"] as const) {
    const symlinkSpy = mock(async () => {
      const err = new Error(
        `simulated symlink failure (${code})`,
      ) as NodeJS.ErrnoException
      err.code = code
      throw err
    })
    const warnSpy = mock(originalWarn.bind(consola))
    ;(fs as unknown as { symlink: unknown }).symlink = symlinkSpy
    ;(consola as unknown as { warn: unknown }).warn = warnSpy
    try {
      // Round-4 #4 sanity: intercept is live on both modules.
      await expectFsSpyInstalled("symlink", symlinkSpy)
      await expectConsolaSpyInstalled("warn", warnSpy)

      await __testing.ensureSharedSymlink("projects", claudeHome, mirrorDir)
      const warnedAboutSymlink = warnSpy.mock.calls.some((call) => {
        const msg = call[0]
        return (
          typeof msg === "string" &&
          msg.includes("symlink") &&
          msg.includes("failed")
        )
      })
      expect(warnedAboutSymlink).toBe(true)
    } finally {
      ;(fs as unknown as { symlink: typeof fs.symlink }).symlink =
        originalSymlink
      ;(consola as unknown as { warn: typeof consola.warn }).warn =
        originalWarn
    }
  }
})

// ============================================================
// Round-3 G3: spy test for unlink-before-rename ordering on Windows
// ============================================================
//
// The round-2 fix added a Windows-only `fs.unlink(mirrorPath)` before
// `fs.rename(tempPath, mirrorPath)` because MoveFileEx can't replace
// a directory/junction destination. This test asserts the MECHANISM
// (call order), not just the outcome (sentinel round-trip works).
// Skipped on POSIX because there the ordering doesn't matter —
// `fs.rename` atomically replaces symlinks without a prior unlink.

test("ensureSharedSymlink: Windows unlink-before-rename call ordering (G3 mechanism)", async () => {
  // Only meaningful on Windows; the unlink branch is platform-gated.
  if (process.platform !== "win32") return

  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })
  const mirrorDir = path.join(
    tempDir,
    `mirror-order-${randomBytes(4).toString("hex")}`,
  )
  await fs.mkdir(mirrorDir, { recursive: true })

  // Pre-place a wrong-target junction at the slot. Use the
  // cross-platform `junction` type so this works on Windows.
  const slotPath = path.join(mirrorDir, "projects")
  const decoyTarget = path.join(
    tempDir,
    `decoy-${randomBytes(4).toString("hex")}`,
  )
  await fs.mkdir(decoyTarget, { recursive: true })
  await fs.symlink(decoyTarget, slotPath, "junction")

  // Shared event log so we can compare call order across spies.
  const events: Array<{ name: "unlink" | "rename"; arg0: string }> = []
  const originalUnlink = fs.unlink
  const originalRename = fs.rename
  const unlinkSpy = mock(async (...args: unknown[]) => {
    if (typeof args[0] === "string") {
      events.push({ name: "unlink", arg0: args[0] })
    }
    return (originalUnlink as (...a: unknown[]) => Promise<void>).apply(
      fs,
      args,
    )
  })
  const renameSpy = mock(async (...args: unknown[]) => {
    if (typeof args[1] === "string") {
      events.push({ name: "rename", arg0: args[1] })
    }
    return (originalRename as (...a: unknown[]) => Promise<void>).apply(
      fs,
      args,
    )
  })
  ;(fs as unknown as { unlink: unknown }).unlink = unlinkSpy
  ;(fs as unknown as { rename: unknown }).rename = renameSpy
  try {
    // Round-4 #4 sanity: intercept is live on fs/promises.
    await expectFsSpyInstalled("unlink", unlinkSpy)
    await expectFsSpyInstalled("rename", renameSpy)

    await __testing.ensureSharedSymlink("projects", claudeHome, mirrorDir)

    const unlinkIdx = events.findIndex(
      (e) => e.name === "unlink" && e.arg0 === slotPath,
    )
    const renameIdx = events.findIndex(
      (e) => e.name === "rename" && e.arg0 === slotPath,
    )
    expect(unlinkIdx).toBeGreaterThanOrEqual(0)
    expect(renameIdx).toBeGreaterThanOrEqual(0)
    // The contract: unlink the wrong-target junction BEFORE renaming
    // the new temp into the slot. If a future refactor reverses these
    // (or drops the unlink), MoveFileEx fails silently and the slot
    // continues to point at the decoy.
    expect(unlinkIdx).toBeLessThan(renameIdx)
  } finally {
    ;(fs as unknown as { unlink: typeof fs.unlink }).unlink = originalUnlink
    ;(fs as unknown as { rename: typeof fs.rename }).rename = originalRename
  }
})

test("ensureSharedSymlink: Windows rename observes an EMPTY slot (G3 effect)", async () => {
  // Companion to the ordering test above: asserts the unlink actually
  // cleared the slot, observed at the moment fs.rename is invoked.
  // If the unlink were somehow skipped or no-op'd, the slot would
  // still hold the wrong-target junction when rename runs and we'd
  // observe `isSymbolicLink() === true`.
  if (process.platform !== "win32") return

  const claudeHome = path.join(tempDir, ".claude")
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.mkdir(claudeHome, { recursive: true })
  const mirrorDir = path.join(
    tempDir,
    `mirror-empty-at-rename-${randomBytes(4).toString("hex")}`,
  )
  await fs.mkdir(mirrorDir, { recursive: true })

  const slotPath = path.join(mirrorDir, "projects")
  const decoyTarget = path.join(
    tempDir,
    `decoy-${randomBytes(4).toString("hex")}`,
  )
  await fs.mkdir(decoyTarget, { recursive: true })
  await fs.symlink(decoyTarget, slotPath, "junction")

  // Capture the lstat result at the exact moment rename is invoked on
  // the slot. lstat is NOT monkey-patched so it reflects real fs state.
  // Wrapped in an object so TS doesn't narrow the closure-mutated
  // value to its initial `null`.
  const observed: { state: "missing" | "symlink" | "other" | null } = {
    state: null,
  }
  const originalRename = fs.rename
  const renameSpy = mock(async (...args: unknown[]) => {
    if (args[1] === slotPath) {
      try {
        const stat = await fs.lstat(slotPath)
        observed.state = stat.isSymbolicLink() ? "symlink" : "other"
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          observed.state = "missing"
        } else {
          throw err
        }
      }
    }
    return (originalRename as (...a: unknown[]) => Promise<void>).apply(
      fs,
      args,
    )
  })
  ;(fs as unknown as { rename: unknown }).rename = renameSpy
  try {
    // Round-4 #4 sanity: intercept is live on fs/promises.
    await expectFsSpyInstalled("rename", renameSpy)

    await __testing.ensureSharedSymlink("projects", claudeHome, mirrorDir)
    // At the moment of rename, the wrong-target junction must already
    // be unlinked (slot missing → rename is a CREATE rather than a
    // doomed REPLACE).
    expect(observed.state).toBe("missing")
  } finally {
    ;(fs as unknown as { rename: typeof fs.rename }).rename = originalRename
  }
})

// ============================================================
// Round-4 G1/G2/G7 regression: smoking-gun rule for the remaining
// fs catches (mkdir source, lstat mirror, realpath sourcePath).
// ============================================================
//
// Three-lab adversarial review flagged that round-3 only escalated
// the symlink/rename catches; the mkdir-source, lstat-mirror, and
// realpath-source-failure paths were still silent. Each is a
// different incarnation of the same smoking-gun pattern, exposed
// by different production conditions (OneDrive cloud-only
// reparse points, corp-managed Windows perm policies, stray files
// at SHARED slot paths from prior versions, EXDEV from cross-volume
// junctions). The fix is uniform: warn rather than debug; the test
// for each pins the catch with a consola.warn spy so a future
// contributor can't silently re-introduce the debug-log shape.

test("ensureSharedSymlink: mkdir(source) failure surfaces a consola.warn (Round-4 #2)", async () => {
  // Pre-place a REGULAR FILE at `<claudeHome>/projects`. mkdir
  // (recursive: true) on a path occupied by a file fails with
  // ENOTDIR / EEXIST and we must surface that loudly — otherwise
  // the child writes through to ~/.claude (which lacks the dir we
  // failed to create) while the proxy quietly skips.
  const claudeHome = path.join(
    tempDir,
    `.claude-mkdir-fail-${randomBytes(4).toString("hex")}`,
  )
  await fs.mkdir(claudeHome, { recursive: true })
  // Plant the obstructing file at the SHARED slot name.
  await fs.writeFile(
    path.join(claudeHome, "projects"),
    "stray-file-shouldnt-be-here",
  )
  const mirrorDir = path.join(
    tempDir,
    `mirror-mkdir-fail-${randomBytes(4).toString("hex")}`,
  )
  await fs.mkdir(mirrorDir, { recursive: true })

  const originalWarn = consola.warn
  const warnSpy = mock(originalWarn.bind(consola))
  ;(consola as unknown as { warn: unknown }).warn = warnSpy
  try {
    // Round-4 #4 sanity: intercept is live on consola.
    await expectConsolaSpyInstalled("warn", warnSpy)

    await __testing.ensureSharedSymlink("projects", claudeHome, mirrorDir)
    const warnedAboutMkdir = warnSpy.mock.calls.some((call) => {
      const msg = call[0]
      return (
        typeof msg === "string" &&
        msg.includes("cannot mkdir source") &&
        msg.includes("projects")
      )
    })
    expect(warnedAboutMkdir).toBe(true)
    // And the mirror slot was NOT touched (no junction half-created).
    await expect(
      fs.lstat(path.join(mirrorDir, "projects")),
    ).rejects.toThrow()
  } finally {
    ;(consola as unknown as { warn: typeof consola.warn }).warn = originalWarn
  }
})

test("ensureSharedSymlink: lstat(mirror) non-ENOENT failure surfaces a consola.warn (Round-4 #7)", async () => {
  // Mock fs.lstat to throw a non-ENOENT error (e.g. EACCES on a corp
  // box that locks down %APPDATA%, ELOOP on a sketchy reparse-point).
  // Pre-fix this was debug-logged and the function returned silently
  // — no junction created, child diverges from proxy state.
  const claudeHome = path.join(
    tempDir,
    `.claude-lstat-fail-${randomBytes(4).toString("hex")}`,
  )
  await fs.mkdir(claudeHome, { recursive: true })
  const mirrorDir = path.join(
    tempDir,
    `mirror-lstat-fail-${randomBytes(4).toString("hex")}`,
  )
  await fs.mkdir(mirrorDir, { recursive: true })
  const slotPath = path.join(mirrorDir, "projects")

  const originalLstat = fs.lstat
  const originalSymlink = fs.symlink
  const originalWarn = consola.warn
  const lstatSpy = mock(async (...args: unknown[]) => {
    // Only intercept the specific path we're targeting; let everything
    // else through to the real lstat so unrelated bookkeeping doesn't
    // explode.
    if (args[0] === slotPath) {
      const err = new Error("simulated EACCES") as NodeJS.ErrnoException
      err.code = "EACCES"
      throw err
    }
    return (originalLstat as (...a: unknown[]) => Promise<unknown>).apply(
      fs,
      args,
    )
  })
  const symlinkSpy = mock(originalSymlink.bind(fs))
  const warnSpy = mock(originalWarn.bind(consola))
  ;(fs as unknown as { lstat: unknown }).lstat = lstatSpy
  ;(fs as unknown as { symlink: unknown }).symlink = symlinkSpy
  ;(consola as unknown as { warn: unknown }).warn = warnSpy
  try {
    // Round-4 #4 sanity: intercept is live on both modules.
    await expectFsSpyInstalled("lstat", lstatSpy)
    await expectFsSpyInstalled("symlink", symlinkSpy)
    await expectConsolaSpyInstalled("warn", warnSpy)

    await __testing.ensureSharedSymlink("projects", claudeHome, mirrorDir)
    const warnedAboutLstat = warnSpy.mock.calls.some((call) => {
      const msg = call[0]
      return (
        typeof msg === "string" &&
        msg.includes("cannot lstat") &&
        msg.includes("projects")
      )
    })
    expect(warnedAboutLstat).toBe(true)
    // And no junction was created (we returned before the symlink call).
    const symlinkAtSlot = symlinkSpy.mock.calls.some((call) => {
      return (
        Array.isArray(call) &&
        call.length >= 2 &&
        typeof call[1] === "string" &&
        call[1].startsWith(slotPath)
      )
    })
    expect(symlinkAtSlot).toBe(false)
  } finally {
    ;(fs as unknown as { lstat: typeof fs.lstat }).lstat = originalLstat
    ;(fs as unknown as { symlink: typeof fs.symlink }).symlink =
      originalSymlink
    ;(consola as unknown as { warn: typeof consola.warn }).warn = originalWarn
  }
})

test("ensureSharedSymlink: realpath(sourcePath) failure surfaces a consola.warn and SKIPS junction creation (Round-4 #1)", async () => {
  // The G2 realpath comparison treats sourceReal and currentReal
  // ASYMMETRICALLY: sourceReal === null means we bail (warn+return)
  // rather than fall through to symlink+rename. Falling through with
  // a failing realpath would re-fire the same realpath next launch
  // — silent every-startup churn, the exact bug class round-3 G2
  // fixed in a different code path. This test pins that behavior.
  //
  // Production trigger: OneDrive / Dropbox cloud-only reparse point
  // at ~/.claude/projects (common on corp Win11 boxes), or EACCES on
  // a parent dir, or EXDEV on a cross-volume mount.
  const claudeHome = path.join(
    tempDir,
    `.claude-realpath-fail-${randomBytes(4).toString("hex")}`,
  )
  await fs.mkdir(path.join(claudeHome, "projects"), { recursive: true })
  const mirrorDir = path.join(
    tempDir,
    `mirror-realpath-fail-${randomBytes(4).toString("hex")}`,
  )
  await fs.mkdir(mirrorDir, { recursive: true })
  const sourcePath = path.join(claudeHome, "projects")
  const slotPath = path.join(mirrorDir, "projects")
  // Pre-place a valid junction at the slot so lstat sees a symbolic
  // link and we enter the realpath-comparison branch (rather than
  // the empty-slot create path which doesn't realpath the source).
  await fs.symlink(
    sourcePath,
    slotPath,
    process.platform === "win32" ? "junction" : "dir",
  )

  const originalRealpath = fs.realpath
  const originalSymlink = fs.symlink
  const originalRename = fs.rename
  const originalUnlink = fs.unlink
  const originalWarn = consola.warn
  const realpathSpy = mock(async (...args: unknown[]) => {
    if (args[0] === sourcePath) {
      const err = new Error(
        "simulated OneDrive cloud-only reparse failure",
      ) as NodeJS.ErrnoException
      err.code = "EIO"
      throw err
    }
    return (originalRealpath as (...a: unknown[]) => Promise<string>).apply(
      fs,
      args,
    )
  })
  const symlinkSpy = mock(originalSymlink.bind(fs))
  const renameSpy = mock(originalRename.bind(fs))
  const unlinkSpy = mock(originalUnlink.bind(fs))
  const warnSpy = mock(originalWarn.bind(consola))
  ;(fs as unknown as { realpath: unknown }).realpath = realpathSpy
  ;(fs as unknown as { symlink: unknown }).symlink = symlinkSpy
  ;(fs as unknown as { rename: unknown }).rename = renameSpy
  ;(fs as unknown as { unlink: unknown }).unlink = unlinkSpy
  ;(consola as unknown as { warn: unknown }).warn = warnSpy
  try {
    // Round-4 #4 sanity: intercept is live on both modules.
    await expectFsSpyInstalled("realpath", realpathSpy)
    await expectFsSpyInstalled("symlink", symlinkSpy)
    await expectFsSpyInstalled("rename", renameSpy)
    await expectFsSpyInstalled("unlink", unlinkSpy)
    await expectConsolaSpyInstalled("warn", warnSpy)

    await __testing.ensureSharedSymlink("projects", claudeHome, mirrorDir)

    // 1. A warn was surfaced about the unresolvable source.
    const warnedAboutSource = warnSpy.mock.calls.some((call) => {
      const msg = call[0]
      return (
        typeof msg === "string" &&
        msg.includes("cannot resolve source") &&
        msg.includes("projects") &&
        msg.includes("churn")
      )
    })
    expect(warnedAboutSource).toBe(true)

    // 2. The replace path was NOT entered (no symlink, no rename, no
    //    unlink of the slot). This is the load-bearing assertion:
    //    falling through would silently churn the junction every
    //    startup, masked by NTFS tunneling.
    const replacedSlot = symlinkSpy.mock.calls.some((call) => {
      return (
        Array.isArray(call) &&
        call.length >= 2 &&
        typeof call[1] === "string" &&
        call[1].startsWith(`${slotPath}.tmp.`)
      )
    })
    expect(replacedSlot).toBe(false)
    expect(renameSpy.mock.calls.length).toBe(0)
    const unlinkedSlot = unlinkSpy.mock.calls.some((call) => {
      return (
        Array.isArray(call) &&
        typeof call[0] === "string" &&
        call[0] === slotPath
      )
    })
    expect(unlinkedSlot).toBe(false)
  } finally {
    ;(fs as unknown as { realpath: typeof fs.realpath }).realpath =
      originalRealpath
    ;(fs as unknown as { symlink: typeof fs.symlink }).symlink =
      originalSymlink
    ;(fs as unknown as { rename: typeof fs.rename }).rename = originalRename
    ;(fs as unknown as { unlink: typeof fs.unlink }).unlink = originalUnlink
    ;(consola as unknown as { warn: typeof consola.warn }).warn = originalWarn
  }
})
