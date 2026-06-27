import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import process from "node:process"

import consola from "consola"

import type { Server } from "srvx"

import { resolveExecutable, killChildProcessTree } from "./exec"
import { DEFAULT_CODEX_MODEL } from "./port"
import { startProcessGuard } from "./process-guard"
import { collapsePathKeys } from "./toolbelt/path-inject"
import { sweepRegistry } from "./worker-agent/lifecycle"

/**
 * Auth-related env keys we strip from the parent before spawning the
 * child CLI. The proxy provides its own values for everything we care
 * about (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, OPENAI_BASE_URL,
 * OPENAI_API_KEY, CODEX_HOME, ANTHROPIC_MODEL); for the rest, we want
 * the child to behave as if the user had no parent-env auth at all.
 *
 * Why strip rather than override-with-empty-string:
 *   - Claude Code emits "Auth conflict" warnings whenever both
 *     ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY are present (regardless
 *     of value, even when both are "dummy"). Stripping API_KEY entirely
 *     suppresses the warning AND prevents an inherited real shell key
 *     from leaking via x-api-key.
 *   - Cloud-provider toggles (CLAUDE_CODE_USE_*) and OAUTH_TOKEN, etc.
 *     are simpler dropped than overridden — a missing env var is
 *     unambiguously falsy/absent in every code path that reads it.
 */
const STRIPPED_PARENT_ENV_KEYS = [
  // Claude Code auth surface
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // Per binary-grep of v2.1.140 (function QuH): Claude Code recognizes
  // CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR as an alternate auth source
  // (loads OAuth from an open file descriptor). Stripping this prevents
  // a user-exported FD reference from leaking into the proxy session
  // and creating a third auth source alongside the synthetic
  // .credentials.json (potential auth-conflict warning).
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  // Defense-in-depth: prevent a parent-set CLAUDE_CONFIG_DIR (e.g. an
  // alternate test profile) from silently leaking into the proxy session.
  // The proxy sets its own value to activate per-config-dir keychain
  // isolation (see `getClaudeCodeEnvVars` doc comment).
  "CLAUDE_CONFIG_DIR",
  // Claude Code Bridge / IDE remote-session surface. Any of these set in
  // the parent shell would activate Claude Code's remote-session code path
  // — which makes many additional API calls (POST /v1/code/sessions,
  // POST /v1/environments/bridge, etc.) that this proxy does not implement
  // (Copilot has no equivalent). Stripping forces the spawned child to
  // run as a local-only session, which is what the proxy supports.
  // (Verified surface in cc-backup src/bridge/*, src/utils/managedEnv.ts;
  // empirical check 2026-05-11.)
  "CLAUDE_BRIDGE_OAUTH_TOKEN",
  "CLAUDE_BRIDGE_BASE_URL",
  "CLAUDE_BRIDGE_SESSION_INGRESS_URL",
  "SESSION_INGRESS_URL",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_CONTAINER_ID",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  // CLAUDE_CODE_ADDITIONAL_PROTECTION makes Claude Code emit
  // `x-anthropic-additional-protection: true` on every /v1/messages request.
  // Copilot ignores it today (verified 2026-05-11) but the header is pure
  // wire-fingerprint noise that breaks the VS Code stealth posture.
  "CLAUDE_CODE_ADDITIONAL_PROTECTION",
  // NOT stripped: ANTHROPIC_SMALL_FAST_MODEL. Users with custom Copilot
  // mappings legitimately rely on this to route the haiku-tier "small fast"
  // model. Stripping would be an unforced error (gemini-critic finding) —
  // we trust resolveModel's dated-slug-retry / family-fallback to translate
  // unrecognized values, and surface unsupported-model failures via consola.
  // Codex CLI auth surface
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_HOME",
  // ai-or-die session-bind / artifact-review surface. ai-or-die sets
  // AIORDIE_CLAUDE_BIND (a per-tab sidecar path) on the Terminal shell so THIS
  // github-router registers the SessionStart/SessionEnd bind hook. The hook
  // receives the path baked into its command, so it does NOT need the env — and
  // stripping it here means a nested `github-router claude` (a teammate/tool
  // re-invocation) can't inherit it and hijack the parent tab's sidecar.
  // AIORDIE_TOKEN is similarly tab-scoped for Artifact review; nested launches
  // must not inherit the parent tab's bearer token.
  "AIORDIE_CLAUDE_BIND",
  "AIORDIE_TOKEN",
] as const

/**
 * Strip auth-related keys from a parent-process env object. The result
 * is suitable to spread into a spawned child's env BEFORE the proxy's
 * explicit overrides, so the proxy is the only source of truth for
 * auth — and stale shell exports can't leak through.
 */
export function sanitizeParentEnv(
  parent: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...parent }
  for (const key of STRIPPED_PARENT_ENV_KEYS) {
    delete sanitized[key]
  }
  return sanitized
}

function commandExists(name: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where.exe" : "which", [name], {
      stdio: "ignore",
    })
    return true
  } catch {
    return false
  }
}

/**
 * Whether the launcher can execute `executable`.
 *
 * `buildLaunchCommand` resolves the CLI to an ABSOLUTE path (anti-shadow).
 * `where.exe` (and POSIX `which`) reject a full path argument — `where`
 * returns "Could not find files for the given pattern(s)" for an absolute
 * path even when the file exists — so the where/which probe is only valid
 * for bare command names. For an absolute path (already resolved against
 * PATH and existence-checked by `resolveExecutable`), check the
 * filesystem directly. Without this split, every launch where the CLI is
 * installed fails with a spurious "not found on PATH".
 */
export function isExecutableAvailable(executable: string): boolean {
  if (path.isAbsolute(executable)) return existsSync(executable)
  return commandExists(executable)
}

/**
 * Provider-config flags (`-c model_providers.github_router=...`) that
 * point Codex at our proxy. Extracted from `buildCodexCmd` so the new
 * `codex mcp-server` MCP-config builder can reuse the exact same
 * provider definition — drift between the two paths would silently
 * break the MCP wiring.
 */
export function buildCodexProviderConfigFlags(serverUrl: string): Array<string> {
  return [
    "-c",
    `model_providers.github_router={name="github-router",base_url="${serverUrl}/v1",wire_api="responses",env_key="OPENAI_API_KEY"}`,
    "-c",
    "model_provider=github_router",
  ]
}

/**
 * Inspect the installed `codex` binary. Used by the codex-MCP wiring
 * in `claude.ts` to gate `--codex-cli`. Codex 0.129.0 introduced the
 * `mcp-server` subcommand; older versions don't expose it, so we
 * downgrade to the HTTP backend with a warning.
 */
export function getCodexVersion(): { ok: boolean; version?: string } {
  if (!commandExists("codex")) return { ok: false }
  let raw: string
  try {
    raw = execFileSync("codex", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return { ok: false }
  }
  // Output examples: "codex-cli 0.129.0", "codex 0.130.1-dev"
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw)
  if (!m) return { ok: false, version: raw }
  const major = Number.parseInt(m[1], 10)
  const minor = Number.parseInt(m[2], 10)
  const version = `${m[1]}.${m[2]}.${m[3]}`
  // mcp-server requires codex >= 0.129.0
  const ok = major > 0 || (major === 0 && minor >= 129)
  return { ok, version }
}

export interface LaunchTarget {
  kind: "claude-code" | "codex"
  envVars: Record<string, string>
  extraArgs: string[]
  model?: string
  /**
   * Proxy URL the spawned child should target. Required for Codex 0.129+
   * which stopped honoring OPENAI_BASE_URL and now needs an explicit
   * `-c model_providers.<name>.base_url=...` argument. Set by the codex
   * subcommand from the same `serverUrl` it computed for env vars.
   */
  serverUrl?: string
}

/**
 * Codex 0.129.0 broke two things the launcher had been relying on:
 *   (1) `--full-auto` was removed in favor of `--sandbox` + `--ask-for-approval`;
 *       passing it now exits the child immediately with
 *       `error: unexpected argument '--full-auto' found`.
 *   (2) `OPENAI_BASE_URL` is silently ignored — Codex hardcodes
 *       `https://api.openai.com/v1/responses` and 401s out without an
 *       explicit `-c model_providers.<name>.base_url` override.
 *
 * `buildCodexCmd` builds the launch argv that works on Codex 0.129+ while
 * still being compatible with older versions that accept the same flags.
 */
function buildCodexCmd(target: LaunchTarget): string[] {
  const cmd: string[] = ["codex"]
  if (target.serverUrl) {
    cmd.push(...buildCodexProviderConfigFlags(target.serverUrl))
  }
  cmd.push(
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "on-request",
    "-m",
    target.model ?? DEFAULT_CODEX_MODEL,
    ...target.extraArgs,
  )
  return cmd
}

export function buildLaunchCommand(target: LaunchTarget): {
  cmd: string[]
  env: Record<string, string | undefined>
} {
  // F10: don't force `--dangerously-skip-permissions` when the caller already
  // requested an explicit `--permission-mode` (e.g. ai-or-die's claude-bridge
  // appends one for a fleet create_session with permissionMode). The two flags
  // conflict — claude rejects them together — and the explicit mode must win.
  const wantsPermissionMode =
    target.kind === "claude-code" &&
    target.extraArgs.some((arg) => arg === "--permission-mode" || arg.startsWith("--permission-mode="))
  const cmd: string[] =
    target.kind === "claude-code"
      ? wantsPermissionMode
        ? ["claude", ...target.extraArgs]
        : ["claude", "--dangerously-skip-permissions", ...target.extraArgs]
      : buildCodexCmd(target)

  // Anti-shadow: resolve the top-level CLI to an ABSOLUTE path against
  // the clean parent PATH (excluding the cwd). The spawned child's env
  // prepends the toolbelt bin dir to PATH; without this, a stray
  // `claude.cmd`/`codex.cmd` in that dir — or in an untrusted repo's cwd
  // (Windows resolves cwd before PATH under shell:true) — could shadow
  // the real CLI. Resolving here means the toolbelt PATH only affects
  // the agent's OWN tool lookups, never which CLI we launch.
  const resolved = resolveExecutable(cmd[0], { env: process.env })
  if (resolved) cmd[0] = resolved

  const env = collapsePathKeys({
    ...sanitizeParentEnv(process.env),
    ...target.envVars,
  })
  return { cmd, env }
}

/**
 * Whether a resolved Windows executable must be launched through cmd.exe
 * (`shell:true`). Only batch shims (`.cmd`/`.bat`) need it — and even then
 * cmd.exe stays alive as the CLI's parent, so `taskkill /T` reaps the
 * whole tree. A real `.exe` (e.g. the native-installer `claude.exe`) is
 * spawned DIRECTLY so the CLI is the direct child, with no cmd.exe
 * intermediary to orphan its node/MCP grandchildren on a kill.
 */
export function windowsLaunchNeedsShell(executable: string): boolean {
  const ext = path.extname(executable).toLowerCase()
  return ext === ".cmd" || ext === ".bat"
}

export function launchChild(
  target: LaunchTarget,
  server: Server,
  options: { onShutdown?: () => Promise<void> | void } = {},
): void {
  const { cmd, env } = buildLaunchCommand(target)

  const executable = cmd[0]
  if (!isExecutableAvailable(executable)) {
    const msg = `"${executable}" not found on PATH. Install it first, then try again.`
    consola.error(msg)
    process.stderr.write(msg + "\n")
    process.exit(1)
  }

  let child: ChildProcess
  try {
    if (process.platform === "win32") {
      if (windowsLaunchNeedsShell(cmd[0])) {
        // A batch shim genuinely needs cmd.exe. cmd.exe stays alive as the
        // CLI's parent for the shim's lifetime, so the tree-kill (taskkill
        // /T) and the crash guard both reap the whole tree through it. Use
        // the full command as a single string to avoid the DEP0190
        // deprecation warning about shell + args.
        const quoted = cmd.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")
        child = spawn(quoted, [], {
          env,
          stdio: "inherit",
          shell: true,
        })
      } else {
        // A real .exe (e.g. the native-installer claude.exe) needs no
        // shell. Spawning it directly makes the CLI the DIRECT child, so
        // child.kill()/taskkill and the crash guard target the real
        // process instead of a cmd.exe wrapper that would orphan its
        // node/MCP grandchildren.
        child = spawn(cmd[0], cmd.slice(1), {
          env,
          stdio: "inherit",
        })
      }
    } else {
      // detached:true → the CLI leads its OWN process group, so cleanup()
      // can kill(-pgid) the whole tree (grandchildren included). We still
      // await its exit, so we do NOT unref(). Terminal Ctrl-C no longer
      // reaches the child directly — the signal handlers below forward it.
      child = spawn(cmd[0], cmd.slice(1), {
        env,
        stdio: "inherit",
        detached: true,
      })
    }
  } catch (error) {
    const msg = `Failed to launch ${executable}: ${error instanceof Error ? error.message : String(error)}`
    consola.error(msg)
    process.stderr.write(msg + "\n")
    server.close(true).catch(() => {})
    if (options.onShutdown) {
      void Promise.resolve(options.onShutdown()).catch(() => {})
    }
    process.exit(1)
  }

  // Crash-safe net: if the proxy dies WITHOUT running cleanup() (hard
  // crash, SIGKILL/taskkill, OOM). On Windows this is the OS's job —
  // Node's KILL_ON_JOB_CLOSE job object reaps the tree — so this is a
  // no-op there. On POSIX (no such mechanism) it spawns a detached reaper
  // that sees the proxy's stdin-pipe EOF, re-verifies the child's
  // identity, and reaps the group (also backstopping a graceful shutdown
  // where the child ignores SIGTERM and the proxy exits before the
  // escalation lands). Fire-and-forget; self-acts and self-exits.
  startProcessGuard(child)

  let cleaned = false
  let exiting = false
  async function cleanup(): Promise<void> {
    if (cleaned) return
    cleaned = true

    // Arm the hard fail-safe FIRST, before any (potentially blocking) kill
    // or async teardown, so a wedged taskkill / server.close can't hang
    // shutdown indefinitely.
    const timeout = setTimeout(() => process.exit(1), 5000)

    // Tree-kill the whole CLI subtree, not just the direct child. On
    // Windows taskkill /T reaps grandchildren; on POSIX kill(-pgid) reaps
    // the detached process group. (Replaces a plain child.kill() that
    // orphaned node/MCP grandchildren on Windows.) A SIGTERM-ignoring
    // survivor that outlives our exit is caught by the crash guard above.
    try {
      killChildProcessTree(child, {
        detachedGroup: process.platform !== "win32",
      })
    } catch {
      // Already exited / best-effort.
    }

    try {
      await server.close(true)
    } catch {
      // Server already closed
    }
    if (options.onShutdown) {
      try {
        await options.onShutdown()
      } catch {
        // Best-effort cleanup; shutdown must not be blocked by it.
      }
    }
    clearTimeout(timeout)
  }

  function exit(code: number): void {
    if (exiting) return
    exiting = true
    process.exit(code)
  }

  // On POSIX the CLI is in its own process group (detached), so terminal
  // Ctrl-C reaches only the proxy. Forward the signal to the child group
  // so the CLI's own interactive handler runs (e.g. Claude's "press
  // Ctrl-C again to exit"); let its natural exit drive shutdown and
  // escalate to a hard tree-kill only if it ignores us past a grace.
  let forwardGrace: NodeJS.Timeout | null = null
  const lastForwardAt: Record<"SIGINT" | "SIGTERM", number> = {
    SIGINT: 0,
    SIGTERM: 0,
  }
  const onSignal = (sig: "SIGINT" | "SIGTERM") => {
    if (process.platform !== "win32" && child.pid && !cleaned) {
      // Debounce PER SIGNAL a sub-second burst into ONE forward. The other
      // subsystem signal handlers (keep-awake/colbert/worker/browser)
      // re-raise the SAME signal to restore default-terminate, which
      // re-invokes us several times within milliseconds — without this the
      // child would receive a volley and Claude's "press Ctrl-C again"
      // guard would never see a single press. Per-signal so a SIGTERM right
      // after a SIGINT still forwards. A genuine second human Ctrl-C
      // (seconds later) falls outside the window and forwards again.
      const now = Date.now()
      if (now - lastForwardAt[sig] > 250) {
        lastForwardAt[sig] = now
        try {
          process.kill(-child.pid, sig)
        } catch {
          // group already gone — fall through to the grace escalation
        }
      }
      const graceMs = sig === "SIGINT" ? 10000 : 3000
      if (!forwardGrace) {
        forwardGrace = setTimeout(() => {
          cleanup().then(() => exit(130)).catch(() => exit(1))
        }, graceMs)
        forwardGrace.unref?.()
      }
      return
    }
    // Windows: the console already delivered Ctrl-C to the direct child;
    // cleanup()'s taskkill /T is the escalation hammer.
    cleanup().then(() => exit(130)).catch(() => exit(1))
  }
  process.on("SIGINT", () => onSignal("SIGINT"))
  process.on("SIGTERM", () => onSignal("SIGTERM"))

  child.on("exit", (exitCode, signal) => {
    // When the spawned CLI exits we may be holding worker-agent
    // worktrees that the proxy will never get a chance to clean up
    // through the per-call finally (the proxy itself is about to
    // shut down). Drain them synchronously here — same sweep the
    // SIGINT/SIGTERM handlers use. No-op if no worker tools were
    // ever invoked (registry is null).
    try {
      sweepRegistry()
    } catch {
      // best-effort; don't let cleanup failures override the exit code
    }
    // When killed by a signal, exitCode is null — derive from signal number
    const code = exitCode ?? (signal ? 128 : 1)
    cleanup().then(() => exit(code)).catch(() => exit(1))
  })
  child.on("error", () => {
    cleanup().then(() => exit(1)).catch(() => exit(1))
  })
}
