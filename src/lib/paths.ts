import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import consola from "consola"

function appDir(): string {
  return path.join(os.homedir(), ".local", "share", "github-router")
}

export const PATHS = {
  get APP_DIR() {
    return appDir()
  },
  get GITHUB_TOKEN_PATH() {
    return path.join(appDir(), "github_token")
  },
  get ERROR_LOG_PATH() {
    return path.join(appDir(), "error.log")
  },
  /**
   * Isolated CODEX_HOME for the spawned Codex CLI. Masks any cached
   * ChatGPT subscription login (openai/codex#2733 — cached login can
   * override OPENAI_API_KEY) so the proxy's dummy key is authoritative.
   */
  get CODEX_HOME() {
    return path.join(appDir(), "codex-isolated")
  },
  /**
   * Runtime tempfiles for the per-launch peer-MCP wiring (the
   * `--mcp-config` JSON and `--agents` JSON written before spawning
   * Claude Code). Mode 0o700 to match the security review's mandate;
   * cleaned on shutdown via the per-launch `cleanup()`, plus a
   * boot-time sweep of stale files (dead PIDs, >24h old).
   */
  get CLAUDE_RUNTIME_DIR() {
    return path.join(appDir(), "runtime")
  },
  /**
   * Router-owned CLAUDE_CONFIG_DIR. The spawned Claude Code (and any
   * teammates it spawns via the agent-teams primitive) reads its
   * config — including `.credentials.json` — from this dir. We
   * snapshot-copy the user's `~/.claude/` here at startup (excluding
   * `.credentials.json` and volatile state), then write our own
   * synthetic Console OAuth credential. The teammate-spawn allowlist
   * propagates `CLAUDE_CONFIG_DIR` to children, so teammates find the
   * synthetic credential and authenticate instead of falling into the
   * "Not logged in · Run /login" gate that would otherwise leave
   * them mute. See `ensureClaudeConfigMirror` below.
   */
  get CLAUDE_CONFIG_DIR() {
    return path.join(appDir(), "claude-config")
  },
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await fs.mkdir(PATHS.CODEX_HOME, { recursive: true })
  await fs.mkdir(PATHS.CLAUDE_RUNTIME_DIR, { recursive: true })
  // mkdir({recursive: true}) does NOT chmod an existing directory, so
  // explicitly tighten in case the dir was created by an older version.
  await chmodIfPossible(PATHS.CLAUDE_RUNTIME_DIR, 0o700)
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
  await sweepStaleRuntimeFiles().catch((err) => {
    consola.debug("Runtime sweep skipped:", err)
  })
  // Phase 2.5: also sweep stale peer-* subagent .md files from the
  // router-owned CLAUDE_CONFIG_DIR/agents/ (orphans from prior proxy
  // crashes). The user's own .md files are never in this dir — only
  // peer-* files we wrote — so the sweep is conservative by location
  // alone, in addition to the regex's persona-name allowlist.
  await sweepStalePeerAgentMdFiles().catch((err) => {
    consola.debug("Peer-agent .md sweep skipped:", err)
  })
}

/**
 * Top-level entries in the user's `~/.claude/` we deliberately do NOT
 * mirror into the router-owned config dir.
 *
 *   - `.credentials.json` — replaced by our synthetic OAuth blob.
 *   - `.credentials.json.lock`, `.oauth_refresh.lock` — refresh-loop
 *     locks; would couple proxy sessions with the user's real `claude`
 *     sessions.
 *   - `statsig/` — feature-flag cache, write-heavy.
 *   - `projects/`, `transcripts/`, `logs/`, `cache/`, `todos/`,
 *     `shell_snapshots/` — per-session state. Sharing these between
 *     proxy sessions and the user's plain `claude` sessions causes
 *     cross-talk (e.g. one session sees another's session history).
 *   - `agents/` — handled specially: we re-create it as an empty real
 *     dir and copy the user's custom-agent .md files into it, so the
 *     proxy's own `peer-<pid>-...md` files (written at runtime) live
 *     in the same dir without colliding with the user's real agents
 *     during cleanup.
 *
 * Excludes match by exact top-level basename. Sub-paths within
 * non-excluded dirs are mirrored recursively.
 */
const EXCLUDED_MIRROR_TOPLEVEL = new Set([
  ".credentials.json",
  ".credentials.json.lock",
  ".oauth_refresh.lock",
  // Defense-in-depth: don't let a user-side file/symlink with the same
  // name as our marker collide with what we write. The marker write
  // logic also lstat-checks before writing (refuses if a non-regular
  // file exists at the path), but excluding it here removes the
  // attack vector entirely.
  ".github-router-managed",
  "statsig",
  "projects",
  "transcripts",
  "logs",
  "cache",
  "todos",
  "shell_snapshots",
])

/**
 * Marker file written into the router-owned CLAUDE_CONFIG_DIR so users
 * (and our own future sweeps) can identify that the dir is managed by
 * github-router. Content is informational only; no logic depends on
 * its presence.
 */
const MANAGED_MARKER_FILENAME = ".github-router-managed"

/**
 * Synthetic Console OAuth credential the router writes into its own
 * `CLAUDE_CONFIG_DIR/.credentials.json` so spawned Claude Code (and
 * any teammates it spawns) can authenticate without a real user
 * `/login`.
 *
 * Schema verified verbatim from `claude` v2.1.140 binary, function
 * `guH` (the credentials-save mutation). Fields:
 *   - `accessToken` — sent as `Authorization: Bearer ...` to the
 *     proxy. Proxy accepts any bearer (per CLAUDE.md "doesn't enforce
 *     auth").
 *   - `refreshToken` — only used by Claude Code's reactive refresh
 *     path (function `nH8`), which fires on 401 from upstream. The
 *     proxy maintains the no-401 invariant on the Anthropic-shape
 *     boundary, so this is never invoked. Synthetic value is fine.
 *   - `expiresAt` — far-future (2099-01-01 ms epoch). Sidesteps the
 *     proactive refresh path (`R8H(expiresAt)` returns false).
 *   - `scopes` — claude-ai-shaped so `tB(scopes)` returns true,
 *     making `Hq()` true (full feature surface, not "inference only").
 *   - `subscriptionType` — `"max"`. Pure client-side label
 *     (`e7()` / `Zc_()` / `CZ1()`); no server validation since
 *     `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` suppresses
 *     subscription-validation calls. Picks the most-permissive gating.
 */
const SYNTHETIC_CREDENTIAL = {
  claudeAiOauth: {
    accessToken: "github-router-synthetic",
    refreshToken: "github-router-synthetic",
    expiresAt: 4_070_908_800_000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
    rateLimitTier: null,
    clientId: "github-router",
  },
} as const

/**
 * Snapshot-copy the user's `~/.claude/` into the router-owned
 * CLAUDE_CONFIG_DIR (real files, not symlinks — symlinks don't isolate
 * writes), excluding volatile state per `EXCLUDED_MIRROR_TOPLEVEL`.
 * Then write the synthetic `.credentials.json` so spawned Claude Code
 * (and teammates that inherit `CLAUDE_CONFIG_DIR`) authenticate.
 *
 * Idempotent: only re-copies files whose source `mtime` is newer than
 * target. Concurrent-safe: `mkdir({recursive:true})` is idempotent;
 * symlink/copy operations tolerate `EEXIST`; credentials write uses
 * temp-file + atomic rename so Claude Code's `EZ1()` mtime watcher
 * never sees a partial write.
 *
 * Walks with `lstat` (does NOT follow symlinks during traversal — a
 * symlink-into-`/` would otherwise let the walk escape). Symlink leaves
 * in the source tree are recreated as symlinks in the mirror (target
 * preserved verbatim, not dereferenced).
 *
 * Caller is expected to invoke this after `ensurePaths()` and before
 * spawning Claude Code (`launchChild`). The mirror must exist before
 * the child reads it. Currently called from the `claude` subcommand
 * entry point only; `start` and `codex` subcommands don't need it.
 */
export async function ensureClaudeConfigMirror(opts: {
  realHome?: string
} = {}): Promise<void> {
  const realHome = opts.realHome ?? os.homedir()
  const sourceDir = path.join(realHome, ".claude")
  const targetDir = PATHS.CLAUDE_CONFIG_DIR

  // 1. Create our config dir (idempotent, mode 0o700)
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 })
  await chmodIfPossible(targetDir, 0o700)

  // 2. Snapshot-copy from ~/.claude if it exists
  let sourceExists = false
  try {
    const sourceStat = await fs.stat(sourceDir)
    sourceExists = sourceStat.isDirectory()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      consola.debug(`ensureClaudeConfigMirror: cannot stat ${sourceDir}:`, err)
    }
  }
  if (sourceExists) {
    await mirrorDirRecursive(sourceDir, targetDir, "")
  }

  // 3. Always ensure agents/ exists (even if user has none) so the
  //    peer-agent .md emission has a place to write. Empty dir is fine.
  await fs.mkdir(path.join(targetDir, "agents"), { recursive: true })

  // 4. Write synthetic .credentials.json (only if content differs)
  const credentialsPath = path.join(targetDir, ".credentials.json")
  const desiredJson = JSON.stringify(SYNTHETIC_CREDENTIAL, null, 2)
  let needsWrite = true
  try {
    const existing = await fs.readFile(credentialsPath, "utf8")
    needsWrite = existing.trim() !== desiredJson.trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      consola.debug(`ensureClaudeConfigMirror: cannot read existing credentials:`, err)
    }
  }
  if (needsWrite) {
    // Atomic temp-file + rename so EZ1()'s mtime watcher doesn't see
    // a partial write. wx flag ensures we don't clobber a concurrent
    // writer's tempfile.
    const tempPath = `${credentialsPath}.${process.pid}.tmp`
    try {
      await fs.writeFile(tempPath, desiredJson + "\n", { mode: 0o600, flag: "wx" })
      await fs.rename(tempPath, credentialsPath)
    } catch (err) {
      // EEXIST on the tempfile means another concurrent startup is
      // mid-write. Best-effort: skip — the other writer will produce
      // identical content (deterministic constant blob).
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        consola.debug(
          "ensureClaudeConfigMirror: concurrent credentials-write detected, skipping",
        )
      } else {
        await fs.unlink(tempPath).catch(() => {})
        throw err
      }
    }
  }
  await chmodIfPossible(credentialsPath, 0o600)

  // 5. Write/refresh marker file. Use lstat (not access) to detect
  //    symlinks at the marker path — a previously-mirrored or
  //    user-placed symlink could otherwise let our `fs.writeFile`
  //    follow through to an arbitrary target. With the symlink-skip
  //    policy in `mirrorDirRecursive` this is defense-in-depth, but
  //    cheap and definitive.
  const markerPath = path.join(targetDir, MANAGED_MARKER_FILENAME)
  let markerExists = false
  try {
    const markerStat = await fs.lstat(markerPath)
    if (markerStat.isFile()) {
      markerExists = true
    } else {
      // Anything non-regular (symlink, dir, special file) is a red flag —
      // refuse to overwrite, log loudly. The user can investigate.
      consola.warn(
        `ensureClaudeConfigMirror: ${markerPath} exists but is not a regular file (mode=${markerStat.mode.toString(8)}); refusing to overwrite. Inspect and remove manually if safe.`,
      )
      markerExists = true
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      consola.debug(`ensureClaudeConfigMirror: cannot lstat marker:`, err)
      markerExists = true
    }
  }
  if (!markerExists) {
    const body = `Managed by github-router. Created ${new Date().toISOString()}. Safe to delete (will be recreated).\n`
    // wx flag (O_CREAT | O_EXCL) refuses to clobber an existing
    // file or symlink (POSIX O_EXCL behavior) — additional protection
    // against the marker-symlink confused-deputy vector.
    await fs
      .writeFile(markerPath, body, { mode: 0o600, flag: "wx" })
      .catch((err) => {
        consola.debug(`ensureClaudeConfigMirror: marker write skipped:`, err)
      })
  }
}

/**
 * Recursive snapshot-copy helper for `ensureClaudeConfigMirror`. Walks
 * `sourceDir/relPath` and mirrors each entry into `targetDir/relPath`.
 * - Top-level `EXCLUDED_MIRROR_TOPLEVEL` basenames are skipped entirely.
 * - Symlinks are recreated as symlinks (not dereferenced) so the walk
 *   never follows out of `sourceDir`.
 * - Files copy only if source mtime > target mtime (idempotent).
 */
async function mirrorDirRecursive(
  sourceDir: string,
  targetDir: string,
  relPath: string,
): Promise<void> {
  const sourcePath = path.join(sourceDir, relPath)
  let entries: Array<string>
  try {
    entries = await fs.readdir(sourcePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    consola.debug(`mirrorDirRecursive: cannot readdir ${sourcePath}:`, err)
    return
  }
  for (const name of entries) {
    // Top-level exclusion only — sub-paths within included dirs always mirror.
    if (relPath === "" && EXCLUDED_MIRROR_TOPLEVEL.has(name)) continue
    const childRel = relPath === "" ? name : path.join(relPath, name)
    const childSource = path.join(sourceDir, childRel)
    const childTarget = path.join(targetDir, childRel)
    let stats: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stats = await fs.lstat(childSource)
    } catch (err) {
      consola.debug(`mirrorDirRecursive: cannot lstat ${childSource}:`, err)
      continue
    }
    if (stats.isSymbolicLink()) {
      // Skip symlinks during mirror copy. gemini-critic security finding:
      // recreating user symlinks in our mirror creates a confused-deputy
      // vector — a previously prompt-injected process could place
      // `~/.claude/<X>` → `/some/sensitive/file`, our walker would mirror
      // it, and any subsequent write to `<mirror>/<X>` (by us or by
      // Claude Code) would follow the symlink and overwrite the target.
      // Snapshot-copy semantics make symlink preservation moot anyway:
      // a snapshot is a point-in-time content copy, and a symlink
      // recreated in the mirror points at exactly the same target as
      // the original would have — the user-side symlink is sufficient.
      // If a user has a legitimate need for a symlink to be visible
      // through the proxy session, they can create the equivalent
      // symlink in their `~/.claude/` directly and it'll be reachable
      // — they just won't see it in our mirror dir.
      consola.debug(`mirrorDirRecursive: skipping symlink ${childSource} (security policy)`)
      continue
    }
    if (stats.isDirectory()) {
      await fs.mkdir(childTarget, { recursive: true })
      await mirrorDirRecursive(sourceDir, targetDir, childRel)
      continue
    }
    if (stats.isFile()) {
      // mtime-based skip — only copy if source is newer than target.
      let needsCopy = true
      try {
        const targetStat = await fs.lstat(childTarget)
        if (targetStat.isFile() && targetStat.mtimeMs >= stats.mtimeMs) {
          needsCopy = false
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          consola.debug(`mirrorDirRecursive: lstat target ${childTarget}:`, err)
        }
      }
      if (!needsCopy) continue
      try {
        await fs.copyFile(childSource, childTarget, fs.constants.COPYFILE_FICLONE)
      } catch (err) {
        consola.debug(`mirrorDirRecursive: copy ${childSource} → ${childTarget}:`, err)
      }
      continue
    }
    // Skip other inode types (sockets, devices, fifos) silently.
  }
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
  } catch {
    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}

async function chmodIfPossible(target: string, mode: number): Promise<void> {
  if (process.platform === "win32") return // Windows chmod is no-op-ish
  try {
    await fs.chmod(target, mode)
  } catch (err) {
    consola.debug(`chmod ${target} ${mode.toString(8)} failed:`, err)
  }
}

/**
 * Write a runtime tempfile securely.
 *
 *   - Mode `0o600` so other local users (multi-tenant boxes, shared
 *     dev containers) can't read the per-launch nonce or runtime URL.
 *   - `flag: "wx"` (O_CREAT | O_EXCL | O_WRONLY) refuses to overwrite
 *     an existing path. POSIX open(2) with O_EXCL also rejects
 *     pre-placed symlinks, killing the symlink-clobber attack vector.
 *   - The caller's responsibility to pick a path NOT yet in use.
 *     We intentionally do NOT pre-unlink: an `lstat` + `unlink` +
 *     `open(O_EXCL)` sequence still has a TOCTOU window where an
 *     attacker can drop a symlink between unlink and open. Letting
 *     `wx` fail is the safer behavior — surfaces the conflict
 *     instead of silently following.
 */
export async function writeRuntimeFileSecure(
  filePath: string,
  content: string,
): Promise<void> {
  await fs.writeFile(filePath, content, { mode: 0o600, flag: "wx" })
}

/**
 * Sweep stale runtime tempfiles. Removes files whose embedded PID is no
 * longer a live process. A proxy crash (`kill -9`, OS reboot) leaves
 * orphans that would otherwise accumulate forever — and worse, a stale
 * config pointing at a now-recycled port could route MCP traffic to
 * whatever process bound that port next.
 *
 * Naming convention: `peer-mcp-<pid>.json` and `peer-agents-<pid>.json`.
 * Files not matching either pattern are left alone — this directory
 * is shared with future runtime artifacts.
 *
 * We deliberately do NOT age-prune files whose PID is alive. A
 * legitimately long-running proxy can have a tempfile older than any
 * arbitrary threshold; deleting it out from under the live process
 * breaks the spawned Claude Code child's MCP/agent wiring with no clean
 * recovery. PID-wraparound risk is mitigated by (a) PID reuse on Linux
 * being slow under typical loads, and (b) the file is only consulted by
 * github-router itself — an unrelated process that inherits the PID
 * never reads it.
 */
export async function sweepStaleRuntimeFiles(): Promise<void> {
  const dir = PATHS.CLAUDE_RUNTIME_DIR
  let entries: Array<string>
  try {
    entries = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    throw err
  }

  for (const name of entries) {
    // Match both legacy `peer-mcp-<pid>.json` and current
    // `peer-mcp-<pid>-<rand>.json` filenames so we can clean up either.
    const match = /^peer-(?:mcp|agents)-(\d+)(?:-[0-9a-f]+)?\.json$/.exec(name)
    if (!match) continue
    const pid = Number.parseInt(match[1], 10)
    const filePath = path.join(dir, name)

    if (isPidAlive(pid)) continue

    await fs.unlink(filePath).catch(() => {
      // already gone or unreadable, fine
    })
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    // signal 0 = check existence without delivering a signal. EPERM
    // means the process exists but we can't signal it (which is still
    // "alive" for our purposes); ESRCH means it's gone.
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EPERM") return true
    return false
  }
}

/**
 * Sweep stale peer-* subagent .md files from the router-owned
 * `CLAUDE_CONFIG_DIR/agents/`. Phase 2.5 writes one .md per peer agent
 * into Claude Code's agents directory (now our config dir's `agents/`
 * subdir, since `getClaudeCodeEnvVars` points `CLAUDE_CONFIG_DIR` at
 * `PATHS.CLAUDE_CONFIG_DIR`) so they appear in Claude Code's Task
 * `subagent_type` enum. Files are named `peer-<pid>-<rand>-<agentName>.md`
 * so this sweep can drop orphans from crashed prior proxy sessions
 * without touching the user's own .md files (which were copied into
 * the same dir during `ensureClaudeConfigMirror`).
 *
 * Same liveness rule as `sweepStaleRuntimeFiles`: only delete when the
 * file's embedded PID is no longer alive. Live PIDs keep their files —
 * a long-running proxy doesn't lose its agent registrations.
 *
 * Regex tightening (Phase 2.6, codex-critic + gemini-critic 2-lab finding):
 * the original sweep regex `^peer-(\d+)(?:-[0-9a-f]+)?-.+\.md$` was too
 * permissive — a user-authored `peer-12345-meeting-notes.md` matches
 * (`12345` = "PID", `-meeting-notes` = trailing `.+`) and would be
 * silently unlinked when 12345 happens to be a dead PID (overwhelmingly
 * likely). Tightened to require BOTH the 8-hex-char random suffix AND
 * an exact-match persona name suffix, eliminating the risk for any
 * realistic user filename.
 */
export async function sweepStalePeerAgentMdFiles(): Promise<void> {
  const dir = path.join(PATHS.CLAUDE_CONFIG_DIR, "agents")
  let entries: Array<string>
  try {
    entries = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    throw err
  }
  for (const name of entries) {
    const match = PEER_AGENT_MD_FILENAME.exec(name)
    if (!match) continue
    const pid = Number.parseInt(match[1], 10)
    if (isPidAlive(pid)) continue
    await fs.unlink(path.join(dir, name)).catch(() => {
      // already gone or unreadable, fine
    })
  }
}

/**
 * Strict regex matching only files this proxy writes:
 *   peer-<pid>-<8 hex>-<exact persona/coordinator name>.md
 * The persona-name allowlist is the load-bearing protection against
 * deleting user files. Update this list whenever a new persona is added
 * to `PERSONAS_READ` / `PERSONAS_WRITE` in `peer-mcp-personas.ts` or a
 * new coordinator-style agent is added in `codex-mcp-config.ts`.
 */
const PEER_AGENT_MD_FILENAME =
  /^peer-(\d+)-[0-9a-f]{8}-(?:codex-critic|codex-reviewer|gemini-critic|codex-implementer|peer-review-coordinator)\.md$/
