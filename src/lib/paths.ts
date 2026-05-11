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
  // Phase 2.5: also sweep stale peer-* subagent .md files from
  // ~/.claude/agents/ (orphans from prior proxy crashes). The user's
  // own .md files are NOT touched — the regex requires our `peer-`
  // prefix.
  await sweepStalePeerAgentMdFiles().catch((err) => {
    consola.debug("Peer-agent .md sweep skipped:", err)
  })
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
 * Sweep stale peer-* subagent .md files from `~/.claude/agents/`. Phase
 * 2.5 writes one .md per peer agent into the canonical agents directory
 * so they appear in Claude Code's Task `subagent_type` enum. Files are
 * named `peer-<pid>-<rand>-<agentName>.md` so this sweep can drop
 * orphans from crashed prior proxy sessions without touching the user's
 * own .md files.
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
  const dir = path.join(os.homedir(), ".claude", "agents")
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
