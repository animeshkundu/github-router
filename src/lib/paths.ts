import { randomBytes } from "node:crypto"
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
   *
   * Per-launch dir: `<appDir>/claude-config/<pid>-<8 hex>`. Two
   * concurrent `github-router claude` launches each get their own
   * isolated mirror, so per-launch state (synthetic credential,
   * snapshot copy of `~/.claude/`, future per-launch `.claude.json`
   * mutation with the peer-MCP entry) cannot cross-talk. The
   * per-launch suffix is cached on first access (see
   * `claudeConfigDirSuffix()`) so all callers within a single proxy
   * lifetime see the same value. Boot-time `sweepStaleClaudeConfigMirrors`
   * reaps mirrors from crashed prior PIDs.
   */
  get CLAUDE_CONFIG_DIR() {
    return path.join(appDir(), "claude-config", claudeConfigDirSuffix())
  },
}

/**
 * Per-launch suffix for `PATHS.CLAUDE_CONFIG_DIR`. Lazily generated on
 * first access and cached for the lifetime of the process so every
 * caller (env-var injection in `getClaudeCodeEnvVars`,
 * `ensureClaudeConfigMirror` provisioning, peer-agent `.md` writes
 * under `<dir>/agents/`, the shutdown cleanup) resolves the same path.
 *
 * Shape: `<pid>-<8 hex>`. The PID prefix is what
 * `sweepStaleClaudeConfigMirrors` keys off to drop orphans from
 * crashed prior sessions; the 8-hex random suffix prevents collision
 * if a future caller (tests, internal relaunch) ever clears the cache
 * within a single PID lifetime.
 *
 * NOT exported — every consumer should go through `PATHS.CLAUDE_CONFIG_DIR`
 * so the homedir-mock pattern used in the test suite keeps working.
 */
let _claudeConfigDirSuffix: string | undefined
function claudeConfigDirSuffix(): string {
  if (_claudeConfigDirSuffix === undefined) {
    _claudeConfigDirSuffix = `${process.pid}-${randomBytes(4).toString("hex")}`
  }
  return _claudeConfigDirSuffix
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
  // Sweep stale per-launch CLAUDE_CONFIG_DIR mirrors left behind by
  // crashed prior proxy sessions BEFORE peer-agent .md sweep, since
  // the .md sweep is scoped to THIS launch's mirror and the per-launch
  // dir sweep is the parent cleanup for the same orphan class.
  await sweepStaleClaudeConfigMirrors().catch((err) => {
    consola.debug("Per-launch claude-config sweep skipped:", err)
  })
  // Phase 2.5: also sweep stale peer-* subagent .md files from this
  // launch's CLAUDE_CONFIG_DIR/agents/ (defense-in-depth — should be
  // a no-op since the per-launch dir didn't exist before this PID
  // started; keeps the safety net in case a future change ever shares
  // an agents/ dir across launches).
  await sweepStalePeerAgentMdFiles().catch((err) => {
    consola.debug("Peer-agent .md sweep skipped:", err)
  })
  // Worker-agent boot-time PID+instance safety net. Walks the
  // worker-repos.json ledger and removes any worktree dir whose
  // <pid> is dead OR whose <instance> UUID doesn't match this proxy.
  // Catches SIGKILL/OOM/host-crash escapees from prior sessions.
  // Lazy-imported so the worker-agent module doesn't get loaded by
  // every consumer of `paths.ts`.
  await (async () => {
    const mod = await import("./worker-agent/lifecycle")
    await mod.sweepStaleWorktreesAtBoot()
  })().catch((err) => {
    consola.debug("Worker worktree boot sweep skipped:", err)
  })
}

/**
 * Per-entry mirror policy. Every top-level entry under `~/.claude/` falls
 * into exactly one bucket; unlisted names default to `MIRRORED` so a future
 * Claude-Code-side addition flows through as a snapshot copy rather than
 * being silently lost.
 *
 * Three policies:
 *
 *   - `ISOLATED` — not present in the mirror at all. The proxy owns its
 *     own copy (synthetic `.credentials.json`, the `.github-router-managed`
 *     marker) or the entry has no place in a proxy session
 *     (`.credentials.json.lock`, `.oauth_refresh.lock` couple refresh loops
 *     across sessions; `statsig/` is write-heavy and would constantly
 *     re-copy; `cache/` and `logs/` are ephemeral; `paste-cache/` holds
 *     sensitive clipboard extracts and shouldn't leak across sessions —
 *     gemini-critic finding).
 *
 *   - `SHARED` — symlink `<mirror>/<X>` → `~/.claude/<X>` so writes made
 *     during the proxy session land in the user's real `~/.claude/` and
 *     chat history is visible in both proxy and plain-`claude` sessions.
 *     **Directories only.** Never use this for individual files: Claude
 *     Code's atomic-write pattern (`fs.writeFile(temp); fs.rename(temp,
 *     target)`) does NOT follow symlinks — a `rename` over the symlink
 *     replaces it with a regular file, silently severing the connection
 *     to `~/.claude/<X>`. Gemini-critic finding from the 3-lab review.
 *
 *   - `MIRRORED` (default) — snapshot-copy with mtime skip. Use for static
 *     or settings-shaped state where proxy-session writes should NOT flow
 *     back to `~/.claude/` (e.g. `settings.json`, `.claude.json`,
 *     `teams/`, `session-env/`) and for `agents/` — the proxy itself
 *     writes per-launch `peer-<pid>-*.md` files into the mirror's `agents/`
 *     and `sweepStalePeerAgentMdFiles` deletes them; a symlink would route
 *     those writes/deletes into the user's real `~/.claude/agents/` and
 *     destroy the user's own subagent files. **Hard regression test**:
 *     `policyFor("agents") === "MIRRORED"` is asserted in
 *     `tests/lib-paths.test.ts` to prevent accidental reclassification.
 *
 * Sub-paths within MIRRORED dirs cascade recursively (existing behavior).
 */
type MirrorPolicy = "ISOLATED" | "SHARED" | "MIRRORED"

const CLAUDE_HOME_POLICY: ReadonlyMap<string, MirrorPolicy> = new Map<
  string,
  MirrorPolicy
>([
  // ISOLATED
  [".credentials.json", "ISOLATED"],
  [".credentials.json.lock", "ISOLATED"],
  [".oauth_refresh.lock", "ISOLATED"],
  // Defense-in-depth: don't let a user-side file/symlink with the same
  // name as our marker collide with what we write. The marker write
  // logic also lstat-checks before writing (refuses if a non-regular
  // file exists at the path), but excluding it here removes the
  // attack vector entirely.
  [".github-router-managed", "ISOLATED"],
  ["statsig", "ISOLATED"],
  ["cache", "ISOLATED"],
  ["logs", "ISOLATED"],
  ["paste-cache", "ISOLATED"],
  ["jobs", "ISOLATED"],
  ["daemon", "ISOLATED"],
  ["daemon.log", "ISOLATED"],
  // SHARED — directories only (see policy doc above)
  ["projects", "SHARED"],
  ["sessions", "SHARED"],
  ["tasks", "SHARED"],
  ["todos", "SHARED"],
  ["transcripts", "SHARED"],
  ["shell-snapshots", "SHARED"],
  // The underscored variant is the historical exclude-list name; some
  // Claude Code versions may still use it. Classify SHARED so either
  // spelling resolves correctly.
  ["shell_snapshots", "SHARED"],
  ["plans", "SHARED"],
  ["file-history", "SHARED"],
  ["backups", "SHARED"],
])

function policyFor(name: string): MirrorPolicy {
  return CLAUDE_HOME_POLICY.get(name) ?? "MIRRORED"
}

/**
 * Test-only export: lets the test suite assert hard regression guards
 * such as `policyFor("agents") === "MIRRORED"` (preventing accidental
 * reclassification that would let `sweepStalePeerAgentMdFiles` delete
 * files in the user's real `~/.claude/agents/`).
 */
export const __testing = { policyFor, ensureSharedSymlink }

/**
 * Names with `SHARED` policy, materialized once for iteration in
 * `ensureClaudeConfigMirror`'s post-copy phase.
 */
const SHARED_TOPLEVEL_NAMES: ReadonlyArray<string> = Array.from(
  CLAUDE_HOME_POLICY.entries(),
)
  .filter(([, kind]) => kind === "SHARED")
  .map(([name]) => name)

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
 *   - `rateLimitTier` — `"default_claude_max_20x"`. Paired with
 *     `subscriptionType:"max"` this is the real Max-20x tier, so the
 *     credential is internally consistent (vs the prior odd `max`+`null`).
 *     Verified live (claude v2.1.158) call-sites are cosmetic billing /
 *     upsell-suppression UI plus the `getPlanModeV2AgentCount` (`bGK`)
 *     `max && 20x → 3` branch — which `CLAUDE_CODE_PLAN_V2_AGENT_COUNT`
 *     (set to 7 in server-setup) already overrides, so this is
 *     belt-and-suspenders for the natural code path. No client-side quota
 *     enforcement keys off the tier (rate-limit UI reads server
 *     `x-ratelimit-*` headers; the proxy holds the no-429 invariant).
 */
const SYNTHETIC_CREDENTIAL = {
  claudeAiOauth: {
    accessToken: "github-router-synthetic",
    refreshToken: "github-router-synthetic",
    expiresAt: 4_070_908_800_000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    clientId: "github-router",
  },
} as const

/**
 * Router-owned fields injected into `<CLAUDE_CONFIG_DIR>/.claude.json` so
 * Claude Code skips its first-launch onboarding wizard. The synthetic
 * `.credentials.json` covers the OAuth *token*, but on a fresh machine
 * the wizard runs anyway — and one of its steps is the browser-OAuth
 * "Sign in to your Anthropic account" prompt that the user sees today.
 *
 * Schema verified against `claude` v2.1.158 binary strings:
 *
 *   - `hasCompletedOnboarding: true` — single load-bearing gate.
 *     Binary code path: `if (!E_().hasCompletedOnboarding) { ... await
 *     Onboarding.default(...) }`. Setting true causes the wizard
 *     (including the OAuth login step) to be skipped entirely.
 *
 *   - `bypassPermissionsModeAccepted: true` — skips the
 *     `--dangerously-skip-permissions` trust disclaimer. Binary gate:
 *     `K = Ip() || Boolean(E_().bypassPermissionsModeAccepted)`. The
 *     proxy passes `--dangerously-skip-permissions` so `Ip()` typically
 *     suffices, but pinning the field covers edge code paths (e.g.
 *     `--bg --dangerously-skip-permissions`) that still consult it
 *     directly and would otherwise throw "requires accepting the
 *     disclaimer first."
 *
 *   - `oauthAccount` — nice-to-have for UI consistency. Claude Code
 *     reads sub-fields with optional chaining (`oauthAccount?.accountUuid`,
 *     `oauthAccount?.organizationUuid`, `oauthAccount?.organizationRole`)
 *     so undefined doesn't trigger login — but populating gives any
 *     "logged in as X" / status-line UI something deterministic and
 *     obviously-synthetic to display. Values are intentionally
 *     non-credible (`github-router@local`, all-zero UUIDs) so any
 *     leak into logs is self-documenting, not impersonation.
 *
 * Merge semantics: the two boolean gates are **force-overridden** —
 * even an existing `false` is flipped to `true`. (A user logging out
 * via the Claude Code UI cannot defeat the proxy-session bypass.)
 * `oauthAccount` is overwritten only when the existing value isn't a
 * *structurally usable* one (presence-only would preserve `{}` or
 * `{foo:1}` shapes that defeat the fix); a real OAuth identity with
 * non-empty `accountUuid` and `organizationUuid` is preserved as-is.
 * Every OTHER top-level field the user brought in via the mirror walk
 * (settings, project history, user-side MCP entries, etc.) is preserved
 * verbatim. The mirror is a router-controlled view, not a faithful
 * copy — same trade-off the synthetic credential already makes.
 */
const SYNTHETIC_CLAUDE_JSON_FIELDS = {
  hasCompletedOnboarding: true,
  bypassPermissionsModeAccepted: true,
  oauthAccount: {
    accountUuid: "00000000-0000-0000-0000-000000000000",
    organizationUuid: "00000000-0000-0000-0000-000000000000",
    organizationRole: "member",
    emailAddress: "github-router@local",
    organizationName: "github-router",
  },
} as const

/**
 * Snapshot-copy the user's `~/.claude/` into the router-owned
 * CLAUDE_CONFIG_DIR (real files, not symlinks — symlinks don't isolate
 * writes), classifying each top-level entry per `CLAUDE_HOME_POLICY`:
 * ISOLATED entries are skipped, MIRRORED entries are copied, and
 * SHARED entries become directory symlinks back to `~/.claude/<X>` so
 * chat history (in `projects/<cwd-hash>/<session-uuid>.jsonl`) and
 * other durable user state flow between proxy and plain-`claude`
 * sessions. Then writes the synthetic `.credentials.json` so spawned
 * Claude Code (and teammates that inherit `CLAUDE_CONFIG_DIR`)
 * authenticate.
 *
 * Idempotent: only re-copies files whose source `mtime` is newer than
 * target; SHARED-symlink creation no-ops when the symlink already
 * points at the right target. Concurrent-safe: `mkdir({recursive:true})`
 * is idempotent; symlinks are created via atomic temp+rename so two
 * parallel github-router-claude startups can't race to EEXIST; the
 * credentials write uses temp-file + atomic rename so Claude Code's
 * `EZ1()` mtime watcher never sees a partial write.
 *
 * Walks with `lstat` (does NOT follow symlinks during traversal — a
 * symlink-into-`/` would otherwise let the walk escape). Symlink leaves
 * in the source tree are skipped during the MIRRORED copy walk (per the
 * symlink-confused-deputy security finding); SHARED symlinks are
 * created on the mirror side only, pointing at predetermined targets
 * inside the user's real `~/.claude/`.
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

  // 2. Snapshot-copy from ~/.claude if it exists. Only MIRRORED entries
  //    flow through this walk; ISOLATED and SHARED entries are filtered
  //    in `mirrorDirRecursive` and handled separately.
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
  //    agents/ is MIRRORED, not SHARED — the proxy writes per-launch
  //    `peer-<pid>-*.md` files here and `sweepStalePeerAgentMdFiles`
  //    deletes them; routing those operations into the user's real
  //    `~/.claude/agents/` would destroy their custom subagent files.
  await fs.mkdir(path.join(targetDir, "agents"), { recursive: true })

  // 4. Create symlinks for SHARED entries so chat history (and other
  //    durable user state) is visible in both proxy and plain-`claude`.
  for (const name of SHARED_TOPLEVEL_NAMES) {
    await ensureSharedSymlink(name, sourceDir, targetDir).catch((err) => {
      consola.debug(
        `ensureClaudeConfigMirror: SHARED symlink for ${name} skipped:`,
        err,
      )
    })
  }

  // 5. Write synthetic .credentials.json (only if content differs)
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

  // 6. Inject onboarding-skip fields into <CLAUDE_CONFIG_DIR>/.claude.json.
  //    Runs AFTER the mirror walk (step 2) so a user's existing
  //    .claude.json content (settings, projects, user-side mcpServers)
  //    is preserved, and BEFORE `injectPeerMcpIntoMirror` (called later
  //    from `src/claude.ts`) which read-merge-writes the same file and
  //    will preserve our fields naturally.
  //
  //    Without this step, on a brand-new machine where ~/.claude/.claude.json
  //    doesn't exist, nothing lands in the mirror, Claude Code's
  //    `hasCompletedOnboarding` gate defaults to falsy, and the
  //    first-launch wizard runs — including the "Sign in to your
  //    Anthropic account" OAuth step that defeats the synthetic
  //    credential. See SYNTHETIC_CLAUDE_JSON_FIELDS for the gate
  //    rationale + binary-verified field shape.
  await injectSyntheticClaudeJsonFields(targetDir, sourceDir, realHome)

  // 6a. Postcondition: verify the gate fields actually landed in the
  //     mirror's .claude.json. The helper has several "warn and
  //     return" branches (non-regular target, non-ENOENT read failure)
  //     where falling through silently would let Claude Code's
  //     first-launch wizard fire — the exact bug this whole
  //     subsystem exists to prevent. Re-reading the file and
  //     asserting the booleans converts every silent-fail path into a
  //     fail-loud launch error, which `src/claude.ts` surfaces to the
  //     user with `process.exit(1)`. Cheap (one extra readFile +
  //     JSON.parse on a small file we just wrote) and gives the
  //     no-silent-degradation invariant teeth even if a future
  //     contributor adds a new bail-out branch.
  await assertOnboardingGateInjected(targetDir)

  // 7. Write/refresh marker file. Use lstat (not access) to detect
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
 * Read-merge-atomic-write the router-required onboarding-skip fields
 * (see `SYNTHETIC_CLAUDE_JSON_FIELDS`) into `<targetDir>/.claude.json`.
 *
 * Inputs:
 *   - `targetDir` — the per-launch mirror dir we own.
 *   - `sourceDir` — the user's `~/.claude/` (subdir-level legacy path).
 *   - `realHome` — the user's `$HOME`. Used to locate the **canonical**
 *     `~/.claude.json` (HOME level), which is what Claude Code's path
 *     resolver `qG` actually reads when `CLAUDE_CONFIG_DIR` is unset:
 *     `path.join(process.env.CLAUDE_CONFIG_DIR || homedir(),
 *     ".claude.json")`. The mirror walk operates on `~/.claude/` and
 *     thus can only see the subdir-level `~/.claude/.claude.json`
 *     (often a stale shadow); the canonical HOME-level file — where
 *     `claude mcp add` writes and Claude Code reads on default
 *     invocations — would otherwise be invisible to the proxy session.
 *
 * Behaviour:
 *   - Mirror's `.claude.json` is a non-regular file (symlink, dir,
 *     etc.) → log warn, refuse to touch. The postcondition check in
 *     `ensureClaudeConfigMirror` then throws, blocking launch — the
 *     user investigates the warn-flagged path rather than landing in
 *     the OAuth wizard.
 *   - Read existing content from the first VALID source, in priority
 *     order:
 *       (a) `~/.claude.json` HOME-level (canonical Claude Code path)
 *       (b) The mirror file itself (snapshot-walk's product; only
 *           consulted if it's a regular file per step 1)
 *       (c) `~/.claude/.claude.json` subdir-level (legacy)
 *     A candidate that's missing (ENOENT), too large (> 50 MiB cap),
 *     or fails to parse as a non-empty object is **skipped** — the
 *     loop falls through to the next candidate, so a malformed
 *     higher-priority source can't drop valid lower-priority content
 *     on the floor. HOME-level non-ENOENT read failures warn
 *     (user-visible — corp perms / OneDrive). All other failures
 *     debug-log. `fs.readFile` follows symlinks; reading user-owned
 *     content into a per-launch user-owned dir is not a privilege
 *     escalation (same uid).
 *   - Merge: **force-override** all three synthetic fields
 *     unconditionally — `hasCompletedOnboarding`,
 *     `bypassPermissionsModeAccepted`, AND `oauthAccount`. A
 *     within-proxy "log out" is impossible by design. `oauthAccount`
 *     is overwritten even when the user has a real one, because
 *     pairing the synthetic OAuth token (from `.credentials.json`)
 *     with a real-user identity blob creates a split-brain auth
 *     state that Claude Code's identity-vs-token cross-checks may
 *     treat as session corruption (triggering re-login → defeats
 *     the fix). The user's real identity remains intact in their
 *     own `~/.claude.json`; only the proxy session sees synthetic.
 *     `Object.assign(Object.create(null), existing)` instead of spread
 *     defuses the `__proto__` prototype-pollution sink from JSON.parse.
 *   - Idempotency: skip the write IFF the source we read FROM is the
 *     mirror itself AND the current mirror content is byte-equivalent
 *     to what we'd write. Bytes-on-disk comparison is robust against
 *     filesystem mtime resolution (FAT/exFAT 2 s buckets) and the
 *     source-presence-vs-mirror-presence conflation that broke
 *     round-2's `needsWrite = !hadExisting` heuristic.
 *
 * Atomic write: tempfile (per-PID + 4-byte random suffix matching
 * `injectPeerMcpIntoMirror`'s pattern, so collision is effectively
 * impossible) + rename, mode 0o600. Pre-chmod the destination before
 * rename to defuse Windows read-only attribute issues. Any write
 * error throws to the caller — `src/claude.ts` fails the launch
 * loudly. Combined with the postcondition check, every silent-
 * degradation path is converted to a fail-loud launch error.
 */
async function injectSyntheticClaudeJsonFields(
  targetDir: string,
  sourceDir: string,
  realHome: string,
): Promise<void> {
  const claudeJsonPath = path.join(targetDir, ".claude.json")

  // 1. lstat the mirror path before touching it (defense-in-depth,
  //    matching the marker-write at step 7). If something other than a
  //    regular file occupies the slot, refuse — `fs.readFile` /
  //    `chmodIfPossible` / `fs.rename` would otherwise follow / clobber
  //    in surprising ways. The postcondition then throws.
  let mirrorIsRegularFile = false
  try {
    const mirrorStat = await fs.lstat(claudeJsonPath)
    if (mirrorStat.isFile()) {
      mirrorIsRegularFile = true
    } else {
      consola.warn(
        `ensureClaudeConfigMirror: ${claudeJsonPath} exists but is not a regular file (mode=${mirrorStat.mode.toString(8)}); refusing to inject synthetic fields. Inspect and remove manually if safe.`,
      )
      return
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      consola.warn(
        `ensureClaudeConfigMirror: cannot lstat ${claudeJsonPath}; refusing to inject synthetic fields (overwriting an unreadable file would risk destroying user content):`,
        err,
      )
      return
    }
    // ENOENT: mirror file doesn't exist yet — fine; step 2 skips the
    // mirror candidate and step 4 creates a new file.
  }

  // 2. Read existing content from the first VALID source. Priority:
  //      (a) `~/.claude.json` HOME-level (canonical Claude Code path)
  //      (b) Mirror file (the snapshot-walk's product; only if regular)
  //      (c) `~/.claude/.claude.json` subdir-level (legacy)
  //    A candidate that's missing (ENOENT) or fails to parse as a
  //    non-empty object is SKIPPED — the loop falls through to the
  //    next candidate. This is the load-bearing fix for "corrupt HOME
  //    blocks valid subdir": a zero-byte or malformed HOME file no
  //    longer drops the user's good subdir content on the floor.
  //    Size cap (`MAX_CLAUDE_JSON_BYTES`) skips absurdly large files
  //    that would risk OOM. HOME read failures (non-ENOENT) warn
  //    loudly — the canonical path failing is user-visible. Mirror /
  //    subdir read failures debug-log and fall through.
  //    `fs.readFile` follows symlinks; reading user-owned content
  //    into a per-launch user-owned dir is not a privilege escalation.
  let existing: Record<string, unknown> = {}
  let selectedSource: string | null = null
  const homeLevelClaudeJson = path.join(realHome, ".claude.json")
  const subdirClaudeJson = path.join(sourceDir, ".claude.json")
  const sourceCandidates: Array<string | null> = [
    homeLevelClaudeJson,
    mirrorIsRegularFile ? claudeJsonPath : null,
    subdirClaudeJson,
  ]
  for (const sourceCandidate of sourceCandidates) {
    if (sourceCandidate === null) continue
    try {
      const stat = await fs.stat(sourceCandidate)
      if (stat.size > MAX_CLAUDE_JSON_BYTES) {
        consola.warn(
          `ensureClaudeConfigMirror: ${sourceCandidate} is ${stat.size} bytes (> ${MAX_CLAUDE_JSON_BYTES} cap); skipping this source to avoid OOM. Inspect for accidental log/state accumulation.`,
        )
        continue
      }
      const raw = await fs.readFile(sourceCandidate, "utf8")
      const parsed = parseExistingClaudeJson(raw, sourceCandidate)
      if (parsed === null) {
        // Malformed (parse failure or non-object). Skip; try next candidate.
        continue
      }
      existing = parsed
      selectedSource = sourceCandidate
      consola.debug(
        `ensureClaudeConfigMirror: read .claude.json content from ${sourceCandidate}`,
      )
      break
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        // Normal case — skip silently.
        continue
      }
      // Non-ENOENT read/stat failure. Severity depends on which source:
      //   - HOME-level (canonical): warn (user-visible — corp perms,
      //     OneDrive cloud-only, EACCES, etc.). Fall through, since
      //     the gate-injection still needs to happen.
      //   - Mirror / subdir: debug. Mirror failures used to abort,
      //     but that locked out the still-valid subdir-level fallback;
      //     we can always re-create the mirror from any valid source.
      if (sourceCandidate === homeLevelClaudeJson) {
        consola.warn(
          `ensureClaudeConfigMirror: cannot read canonical ${homeLevelClaudeJson}; falling back to other sources. User-scope MCPs added via 'claude mcp add' may be invisible to the proxy session:`,
          err,
        )
      } else {
        consola.debug(
          `ensureClaudeConfigMirror: cannot read source ${sourceCandidate}:`,
          err,
        )
      }
      // Fall through to next candidate. If all miss/fail, proceed
      // with synthetic-only content (existing stays {}).
    }
  }

  // 3. Build merged content. `Object.assign(Object.create(null), ...)`
  //    instead of `{...existing}` avoids the `__proto__` prototype-
  //    pollution sink (`JSON.parse('{"__proto__":{...}}')` sets the
  //    object's prototype via defineProperty; spreading then triggers
  //    the standard `__proto__` setter and mutates merged's prototype
  //    chain. Cheap defense, prevents the entire class.
  //
  //    All three gate fields are FORCE-OVERRIDDEN regardless of
  //    existing value:
  //      - `hasCompletedOnboarding` and `bypassPermissionsModeAccepted`
  //        are the load-bearing gates we exist to set; a within-proxy
  //        "log out" is impossible by design.
  //      - `oauthAccount` is overwritten unconditionally with the
  //        synthetic identity (NOT preserved even when real). Pairing
  //        the synthetic OAuth token (from `.credentials.json`) with
  //        a real-user `accountUuid` / `organizationUuid` creates a
  //        split-brain auth state where Claude Code's identity-vs-
  //        token cross-checks (binary `oauthAccount?.accountUuid`
  //        consumers) may treat the mismatch as session corruption
  //        and trigger re-login — the exact bug we're preventing.
  //        The user's real identity remains intact in their own
  //        `~/.claude.json`; only the proxy session sees synthetic.
  const merged: Record<string, unknown> = Object.assign(
    Object.create(null) as Record<string, unknown>,
    existing,
  )
  merged.hasCompletedOnboarding = SYNTHETIC_CLAUDE_JSON_FIELDS.hasCompletedOnboarding
  merged.bypassPermissionsModeAccepted = SYNTHETIC_CLAUDE_JSON_FIELDS.bypassPermissionsModeAccepted
  merged.oauthAccount = SYNTHETIC_CLAUDE_JSON_FIELDS.oauthAccount

  // 4. Decide if a write is needed. Idempotency contract: skip the
  //    write IFF we read FROM the mirror itself AND the current mirror
  //    content is byte-equivalent to what we'd write. Bytes-on-disk
  //    comparison (vs. inferring from source state) is robust against:
  //      - source-presence ≠ mirror-presence (a fully-onboarded HOME
  //        file with no mirror yet must still trigger a mirror write)
  //      - HOME content newer than mirror (HOME wins → mirror is
  //        always rewritten when source was HOME)
  //      - filesystem mtime resolution (FAT/exFAT 2s buckets)
  const desiredJson = JSON.stringify(merged, null, 2) + "\n"
  if (selectedSource === claudeJsonPath) {
    try {
      const currentMirrorJson = await fs.readFile(claudeJsonPath, "utf8")
      if (currentMirrorJson === desiredJson) {
        await chmodIfPossible(claudeJsonPath, 0o600).catch(() => {})
        return
      }
    } catch {
      // Mirror read failed between step 2's success and now — fall
      // through to write. Worst case we rewrite identical content.
    }
  }

  // 5. Atomic temp + rename. Mode 0o600. Per-PID + 4-byte random
  //    suffix matches `injectPeerMcpIntoMirror`'s pattern. Any write
  //    error throws to the caller — `src/claude.ts` exits the launch
  //    with a loud error message rather than silently degrading to
  //    the OAuth wizard.
  //
  //    Pre-chmod the destination before rename to defuse Windows
  //    read-only attribute issues (FAT/exFAT volumes, corp-managed
  //    perms): `fs.rename` over a read-only file can fail with EPERM
  //    on Windows even though POSIX would silently succeed.
  //
  //    Concurrent-racer tolerance: when multiple `ensureClaudeConfigMirror()`
  //    calls run in parallel (e.g., from tests, or a future caller),
  //    Windows `fs.rename` can fail with EBUSY/EPERM/EACCES if
  //    another racer has the destination open or mid-write. The
  //    write content is fully deterministic (same SYNTHETIC fields,
  //    same force-override merge of the same source-priority list),
  //    so a successful rename by ANY racer produces the same bytes
  //    we'd produce. On rename failure, verify the on-disk content
  //    matches `desiredJson` — if so, accept silently (another
  //    racer won the race; the file is correct).
  const tempPath = `${claudeJsonPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    await fs.writeFile(tempPath, desiredJson, { mode: 0o600, flag: "wx" })
    if (mirrorIsRegularFile) {
      await chmodIfPossible(claudeJsonPath, 0o600).catch(() => {})
    }
    await fs.rename(tempPath, claudeJsonPath)
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {})
    try {
      const observed = await fs.readFile(claudeJsonPath, "utf8")
      if (observed === desiredJson) {
        consola.debug(
          `ensureClaudeConfigMirror: rename failed but mirror already holds expected content (concurrent racer won the race):`,
          err,
        )
        await chmodIfPossible(claudeJsonPath, 0o600).catch(() => {})
        return
      }
    } catch {
      // Fall through to rethrow the original error.
    }
    throw err
  }
  await chmodIfPossible(claudeJsonPath, 0o600).catch(() => {})
}

/**
 * Size cap on candidate `.claude.json` reads in
 * `injectSyntheticClaudeJsonFields`. Real-world files are KB-MB scale;
 * if a `.claude.json` has grown to hundreds of MB (corruption, runaway
 * project history accumulation, accidental log redirect) reading it
 * blocks the event loop and risks OOM. 50 MiB is comfortably above
 * any legitimate Claude Code state and well below typical RSS budgets.
 */
const MAX_CLAUDE_JSON_BYTES = 50 * 1024 * 1024

/**
 * Structural check for `oauthAccount`: must be a non-null, non-array
 * object whose `accountUuid` AND `organizationUuid` are non-empty
 * strings. Empty objects / partial blobs (missing UUIDs) do NOT count
 * as "usable" — preserving them would let Claude Code's various
 * "logged in as X" UIs read undefined sub-fields and (in some flows)
 * fall back to a re-login prompt that defeats the synthetic-credential
 * fix. Field names match the binary's optional-chain reads
 * (`oauthAccount?.accountUuid`, `oauthAccount?.organizationUuid`).
 */
function isUsableOauthAccount(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  const accountUuid = obj.accountUuid
  const organizationUuid = obj.organizationUuid
  return (
    typeof accountUuid === "string"
    && accountUuid.length > 0
    && typeof organizationUuid === "string"
    && organizationUuid.length > 0
  )
}

/**
 * Parse a JSON blob expected to be an object. Returns `null` on parse
 * failure or non-object/array value (so callers can SKIP this source
 * rather than treating an empty object as a successful read — a
 * round-1 finding from gemini-critic). Logs a warn so the user can
 * investigate. Used in `injectSyntheticClaudeJsonFields`'s source-
 * priority loop: a malformed HOME-level file falls through to the
 * mirror or subdir candidate instead of dropping valid lower-priority
 * content on the floor.
 */
function parseExistingClaudeJson(
  raw: string,
  contextPath: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    consola.warn(
      `ensureClaudeConfigMirror: ${contextPath} parsed to non-object `
        + `(typeof=${typeof parsed}); skipping this source.`,
    )
    return null
  } catch (err) {
    consola.warn(
      `ensureClaudeConfigMirror: cannot parse ${contextPath} as JSON; `
        + `skipping this source:`,
      err,
    )
    return null
  }
}

/**
 * Postcondition for `ensureClaudeConfigMirror`: re-reads the mirror's
 * `.claude.json` and verifies that both boolean gate fields actually
 * landed. Converts every "warn and return" branch in
 * `injectSyntheticClaudeJsonFields` (non-regular target, non-ENOENT
 * read failure, postcondition lstat race) into a launch-failing
 * throw — `src/claude.ts:197`'s catch path turns it into a clear
 * `process.exit(1)` rather than silently spawning Claude Code into
 * the OAuth wizard. The whole point of this subsystem is preventing
 * that silent degradation; a warn that scrolls by in the launch log
 * is not enough.
 *
 * Cheap (one extra readFile + JSON.parse on a small file we just
 * wrote) and load-bearing: every future contributor who adds a new
 * bail-out branch in the helper above automatically gets fail-loud
 * for free instead of having to remember to thread the failure
 * upward by hand.
 */
async function assertOnboardingGateInjected(targetDir: string): Promise<void> {
  const claudeJsonPath = path.join(targetDir, ".claude.json")

  // 1. lstat first — never follow a symlink. A planted symlink at the
  //    mirror path pointing at an attacker-controlled file with valid
  //    gate fields would otherwise pass a plain readFile check and let
  //    the helper's "non-regular target" warn-and-return slip through.
  let lst: import("node:fs").Stats
  try {
    lst = await fs.lstat(claudeJsonPath)
  } catch (err) {
    throw new Error(
      `ensureClaudeConfigMirror: postcondition failed — cannot lstat ${claudeJsonPath} after injection (synthetic onboarding-skip fields are required to prevent Claude Code's first-launch wizard, which would defeat the synthetic credential): ${(err as Error).message}`,
    )
  }
  if (!lst.isFile()) {
    throw new Error(
      `ensureClaudeConfigMirror: postcondition failed — ${claudeJsonPath} exists but is not a regular file (mode=${lst.mode.toString(8)}). Check the preceding warn-level log lines for the underlying cause; without a regular file holding the gate fields, Claude Code's first-launch wizard fires and defeats the synthetic credential.`,
    )
  }

  let raw: string
  try {
    raw = await fs.readFile(claudeJsonPath, "utf8")
  } catch (err) {
    throw new Error(
      `ensureClaudeConfigMirror: postcondition failed — cannot read ${claudeJsonPath} after injection: ${(err as Error).message}`,
    )
  }
  let parsed: Record<string, unknown>
  try {
    const json = JSON.parse(raw) as unknown
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new Error(`parsed to non-object (typeof=${typeof json})`)
    }
    parsed = json as Record<string, unknown>
  } catch (err) {
    throw new Error(
      `ensureClaudeConfigMirror: postcondition failed — ${claudeJsonPath} is not a valid JSON object after injection: ${(err as Error).message}`,
    )
  }
  if (
    parsed.hasCompletedOnboarding !== true
    || parsed.bypassPermissionsModeAccepted !== true
  ) {
    throw new Error(
      `ensureClaudeConfigMirror: postcondition failed — ${claudeJsonPath} is missing required gate fields after injection (hasCompletedOnboarding=${String(parsed.hasCompletedOnboarding)}, bypassPermissionsModeAccepted=${String(parsed.bypassPermissionsModeAccepted)}). Check the preceding warn-level log lines for the underlying cause; without these fields Claude Code's first-launch wizard fires and defeats the synthetic credential.`,
    )
  }
  // Reuse `isUsableOauthAccount` so a future change to the structural
  // definition stays consistent across helper write-decision and
  // postcondition. The synthetic blob we always write satisfies this
  // by construction; a regression that drops oauthAccount during the
  // merge would otherwise slip past (per the round-2 codex/opus/
  // gemini-3-lab finding).
  if (!isUsableOauthAccount(parsed.oauthAccount)) {
    throw new Error(
      `ensureClaudeConfigMirror: postcondition failed — ${claudeJsonPath} has invalid oauthAccount after injection (got ${JSON.stringify(parsed.oauthAccount)}). The synthetic identity blob is required so Claude Code's identity-vs-token cross-checks don't trigger a re-login that defeats the synthetic credential.`,
    )
  }
}

/**
 * Recursive snapshot-copy helper for `ensureClaudeConfigMirror`. Walks
 * `sourceDir/relPath` and mirrors each entry into `targetDir/relPath`.
 * - Top-level entries are dispatched on `policyFor(name)`:
 *     - `ISOLATED` → skipped entirely (no presence in mirror).
 *     - `SHARED`   → skipped from the copy walk; handled by
 *                    `ensureSharedSymlink` in the post-copy phase.
 *     - `MIRRORED` → copied as today.
 * - Symlinks are skipped (not recreated) so the walk never follows out
 *   of `sourceDir` and we don't reintroduce a confused-deputy vector.
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
    // Policy dispatch at top-level only. Sub-paths within MIRRORED
    // dirs always cascade as MIRRORED.
    if (relPath === "") {
      const policy = policyFor(name)
      if (policy === "ISOLATED" || policy === "SHARED") continue
    }
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

/**
 * Create or refresh a directory symlink `<mirrorDir>/<name>` →
 * `<sourceDir>/<name>` (i.e. `~/.local/share/github-router/claude-config/<X>`
 * → `~/.claude/<X>`). Idempotent and concurrent-safe.
 *
 * Behavior depending on what's already at `<mirrorDir>/<name>`:
 *   - Symlink with the correct target → no-op.
 *   - Symlink with the wrong target → replace atomically.
 *   - Empty real directory (legacy mirror leftover with no proxy-session
 *     writes accumulated yet) → `rmdir` and replace with the symlink.
 *     Safe by definition: `fs.rmdir` only succeeds on empty dirs (POSIX),
 *     so there is nothing to lose. Smooths the upgrade path for users
 *     whose legacy mirror dirs were never written to.
 *   - Non-empty real directory or regular file → loud-warn and skip.
 *     Auto-deleting would destroy proxy-session writes from the prior
 *     version. The user is told the exact path and remediation.
 *   - ENOENT → create symlink atomically.
 *
 * Atomic-creation: symlinks are first written at a unique side-path
 * (`<mirrorDir>/<name>.tmp.<pid>.<8 hex>`) and then `fs.rename()`d into
 * place. POSIX `rename` is atomic and replaces an existing symlink in
 * a single step, so two concurrent `github-router claude` startups can't
 * race to `EEXIST` — the loser's rename just overwrites the winner's
 * symlink with an identical one. Gemini-critic 3-lab-review finding.
 *
 * Pre-creates `~/.claude/<name>/` as a real directory if missing so
 * Claude Code's writes through the symlink don't fail with ENOENT.
 */
async function ensureSharedSymlink(
  name: string,
  sourceDir: string,
  mirrorDir: string,
): Promise<void> {
  const sourcePath = path.join(sourceDir, name)
  const mirrorPath = path.join(mirrorDir, name)

  // 1. Ensure the source directory exists. Without this, Claude Code's
  //    writes through the symlink (e.g. `projects/<hash>/foo.jsonl`)
  //    fail with ENOENT on the parent dir.
  try {
    await fs.mkdir(sourcePath, { recursive: true })
  } catch (err) {
    // Escalated from debug → warn per the CLAUDE.md "smoking gun"
    // rule (consistent with the symlink and rename catches below):
    // if the source dir cannot be created (e.g. a stray regular file
    // sitting at `~/.claude/projects`, perms blocking mkdir on a
    // corp-managed Windows box, OneDrive cloud-only reparse point),
    // ensureSharedSymlink returns without creating a junction. The
    // spawned Claude Code child then writes to the REAL `~/.claude`
    // while the proxy reads from the mirror — exactly the split-brain
    // pattern this whole function exists to prevent. Silent debug-log
    // hid this from us once already; warn so the user sees the cause.
    consola.warn(
      `ensureSharedSymlink(${name}): cannot mkdir source ${sourcePath}:`,
      err,
    )
    return
  }

  // 2. Inspect the mirror-side slot.
  let existing: Awaited<ReturnType<typeof fs.lstat>> | null = null
  try {
    existing = await fs.lstat(mirrorPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Escalated from debug → warn per the CLAUDE.md "smoking gun"
      // rule (consistent with the other fs catches in this function):
      // ENOENT is the only expected-and-benign failure mode here
      // (slot doesn't exist yet — falls through to create). Any other
      // lstat failure (EACCES, ELOOP, EIO from a sketchy reparse
      // point) means we bail without creating the junction, which
      // silently leaves the proxy and child diverged. A visible warn
      // surfaces the root cause instead of a mysteriously missing
      // junction.
      consola.warn(
        `ensureSharedSymlink(${name}): cannot lstat ${mirrorPath}:`,
        err,
      )
      return
    }
  }

  if (existing?.isSymbolicLink()) {
    // Resolve both sides to their canonical absolute paths and compare.
    // We use `fs.realpath` rather than the raw `fs.readlink()` output
    // because Windows junctions resolve via readlink to `\\?\`-prefixed
    // device-namespace paths (e.g. `\\?\C:\Users\foo\.claude\projects`)
    // while we wrote the plain absolute `sourcePath` (e.g.
    // `C:\Users\foo\.claude\projects`) with `fs.symlink`. A literal
    // `===` on the raw readlink output never matched on Windows, so
    // the fast path silently failed and every startup tore down +
    // recreated all 9 SHARED junctions — masked locally because NTFS
    // File System Tunneling forges the creation timestamp for a name
    // deleted and recreated within 15 s (the per-startup churn was
    // real, the ctime-stable assertion was a false negative). The
    // realpath comparison canonicalizes both forms to the same string
    // on POSIX and Windows alike, and as a bonus handles drive-letter
    // casing / trailing-slash differences too. The extra two syscalls
    // per slot are negligible at proxy startup (runs once per launch).
    //
    // CRITICAL: sourceReal and currentReal are NOT treated symmetrically.
    // If `sourceReal` is null (we just mkdir'd it above, but realpath
    // failed — OneDrive cloud-only reparse point, EACCES on parent,
    // EXDEV mount oddity), we WARN AND RETURN rather than fall through.
    // Falling through would do unlink+symlink+rename with the same
    // failing realpath next launch — silent every-startup churn, the
    // exact bug class round-3 G2 fixed in a different code path.
    // `currentReal === null` is benign (broken/wrong slot — replace).
    const sourceReal = await fs.realpath(sourcePath).catch(() => null)
    if (sourceReal === null) {
      consola.warn(
        `ensureSharedSymlink(${name}): cannot resolve source ${sourcePath} ` +
          `— skipping junction creation to avoid silent every-startup churn. ` +
          `Inspect the source dir's permissions / OneDrive sync state and re-launch.`,
      )
      return
    }
    const currentReal = await fs.realpath(mirrorPath).catch(() => null)
    if (currentReal !== null && currentReal === sourceReal) {
      return
    }
    // Wrong target (or unresolvable mirror) — fall through to the
    // atomic-rename replace path.
  } else if (existing?.isDirectory()) {
    // Legacy real directory at the slot. Try `fs.rmdir` — on POSIX it
    // succeeds ONLY if the directory is empty, so there's nothing to
    // lose. If it's non-empty (ENOTEMPTY) or any other failure occurs,
    // fall back to the warn-and-skip path so we never auto-clobber
    // user data.
    try {
      await fs.rmdir(mirrorPath)
      // Empty dir reaped — fall through to the atomic-rename create path.
    } catch (err) {
      consola.warn(
        `ensureClaudeConfigMirror: ${mirrorPath} is a non-empty real directory ` +
          `from an older github-router version; refusing to clobber. ` +
          `If you want chat-history continuity for "${name}", move its ` +
          `contents into ${sourcePath}/ then delete ${mirrorPath}; the ` +
          `mirror will create a symlink (junction on Windows) on next launch. ` +
          `(rmdir error: ${(err as NodeJS.ErrnoException).code ?? "unknown"})`,
      )
      return
    }
  } else if (existing) {
    // Regular file (or special inode like a socket) — never auto-clobber.
    consola.warn(
      `ensureClaudeConfigMirror: ${mirrorPath} is a regular file at a ` +
        `SHARED symlink slot; refusing to clobber. Inspect and remove ` +
        `manually if safe; the mirror will create a symlink on next launch.`,
    )
    return
  }

  // 3. Atomic-rename creation: symlink to a unique temp path, then
  //    rename over the slot. `fs.rename` replaces existing symlinks
  //    atomically on POSIX and is safe against concurrent racers.
  //    On Windows, MoveFileEx with MOVEFILE_REPLACE_EXISTING does NOT
  //    replace an existing directory or junction destination
  //    (npm/cli#9021), so when the slot already holds a wrong-target
  //    junction we must explicitly unlink it first. The sub-millisecond
  //    window of no-link is acceptable: ensureClaudeConfigMirror is
  //    idempotent under concurrency and only runs at proxy startup,
  //    before any spawned Claude Code child has been launched.
  const tempPath = `${mirrorPath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`
  try {
    await fs.symlink(
      sourcePath,
      tempPath,
      process.platform === "win32" ? "junction" : "dir",
    )
  } catch (err) {
    // Escalated from debug → warn per the CLAUDE.md "smoking gun" rule:
    // the rule applies to ALL fs catches in this function, not just the
    // rename one. The temp path is per-pid + 8-hex random so EEXIST is
    // essentially impossible — any failure here (EPERM on Windows
    // without DevMode, EXDEV cross-volume, ENOSPC, …) is a real
    // operational problem the user needs to see.
    consola.warn(
      `ensureSharedSymlink(${name}): symlink ${tempPath} failed:`,
      err,
    )
    return
  }
  if (process.platform === "win32" && existing?.isSymbolicLink()) {
    // Windows-only: clear the wrong-target junction so the rename
    // below can land. Best-effort — if a concurrent racer already
    // unlinked it, the rename succeeds as a CREATE; if a concurrent
    // racer already replaced it with a fresh junction, the rename
    // hits the catch below and we surface a warn.
    await fs.unlink(mirrorPath).catch(() => {})
  }
  try {
    await fs.rename(tempPath, mirrorPath)
  } catch (err) {
    // Escalated from debug → warn per the CLAUDE.md "smoking gun"
    // rule (consistent with the fs.symlink catch above): a silent
    // debug log here previously hid the Windows rename-replace bug
    // (junction-over-junction MoveFileEx EPERM). Post-fix, rename
    // failures should be rare and visible.
    consola.warn(
      `ensureSharedSymlink(${name}): rename ${tempPath} → ${mirrorPath} failed:`,
      err,
    )
    await fs.unlink(tempPath).catch(() => {})
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

/**
 * Strict regex matching only per-launch claude-config mirror dirs this
 * proxy creates: `<pid>-<8 hex>`. Anchored to the entire entry name so
 * user-authored siblings under `<appDir>/claude-config/` (if any) are
 * untouchable. The PID prefix is what `sweepStaleClaudeConfigMirrors`
 * keys off; the 8-hex random suffix matches `randomBytes(4)` exactly
 * (no `?` — files created by a different shape are not ours).
 */
const CLAUDE_CONFIG_MIRROR_DIR = /^(\d+)-[0-9a-f]{8}$/

/**
 * Sweep stale per-launch CLAUDE_CONFIG_DIR mirrors left behind by
 * crashed prior proxy sessions. Symmetric to `sweepStalePeerAgentMdFiles`
 * — same liveness rule (only delete when the embedded PID is dead),
 * same strict regex (the dir-name allowlist is the load-bearing
 * protection against deleting user-authored siblings).
 *
 * Scans `<appDir>/claude-config/` (the parent of the per-launch dirs).
 * Each entry whose name matches `<pid>-<8 hex>` AND whose PID is no
 * longer alive is removed recursively. `fs.rm({recursive: true})`
 * walks the tree calling `unlink` on symlinks/junctions rather than
 * following them, so the SHARED junctions back to `~/.claude/<X>`
 * are removed without touching their targets.
 *
 * Tolerates missing parent dir (first-ever launch, or user wiped it).
 */
export async function sweepStaleClaudeConfigMirrors(): Promise<void> {
  const parent = path.join(appDir(), "claude-config")
  let entries: Array<string>
  try {
    entries = await fs.readdir(parent)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    throw err
  }
  for (const name of entries) {
    const match = CLAUDE_CONFIG_MIRROR_DIR.exec(name)
    if (!match) continue
    const pid = Number.parseInt(match[1], 10)
    if (isPidAlive(pid)) continue
    await fs
      .rm(path.join(parent, name), { recursive: true, force: true })
      .catch((err) => {
        // Best-effort: stale-dir cleanup must never block startup.
        // Common failure modes (worth surviving silently): an EBUSY/EPERM
        // on Windows if a leftover handle is still open, or a stray
        // root-owned file inside the dir from a previous run with
        // different permissions.
        consola.debug(
          `sweepStaleClaudeConfigMirrors: cannot rm ${name}:`,
          err,
        )
      })
  }
}

/**
 * Remove THIS launch's per-launch CLAUDE_CONFIG_DIR on shutdown.
 * Best-effort: a failure here must not block process exit (the caller
 * wraps this in a `.catch`-equivalent via `launchChild`'s onShutdown
 * try/catch). Symmetric to `writePeerMcpRuntimeFiles`'s `cleanup()`:
 * we own this dir for the lifetime of the proxy, so removing it on
 * normal shutdown is correct; the boot-time sweep handles the
 * abnormal-exit case.
 *
 * `fs.rm({recursive: true})` removes SHARED junctions via unlink
 * (does NOT follow them into the user's real `~/.claude/<X>`).
 */
export async function removeOwnClaudeConfigMirror(): Promise<void> {
  const dir = PATHS.CLAUDE_CONFIG_DIR
  await fs.rm(dir, { recursive: true, force: true }).catch((err) => {
    consola.debug(`removeOwnClaudeConfigMirror: rm ${dir} skipped:`, err)
  })
}
