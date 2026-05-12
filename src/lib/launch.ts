import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import process from "node:process"

import consola from "consola"

import type { Server } from "srvx"

import { DEFAULT_CODEX_MODEL } from "./port"

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
  const cmd: string[] =
    target.kind === "claude-code"
      ? ["claude", "--dangerously-skip-permissions", ...target.extraArgs]
      : buildCodexCmd(target)

  return {
    cmd,
    env: { ...sanitizeParentEnv(process.env), ...target.envVars },
  }
}

export function launchChild(
  target: LaunchTarget,
  server: Server,
  options: { onShutdown?: () => Promise<void> | void } = {},
): void {
  const { cmd, env } = buildLaunchCommand(target)

  const executable = cmd[0]
  if (!commandExists(executable)) {
    const msg = `"${executable}" not found on PATH. Install it first, then try again.`
    consola.error(msg)
    process.stderr.write(msg + "\n")
    process.exit(1)
  }

  let child: ChildProcess
  try {
    if (process.platform === "win32") {
      // On Windows, npm-installed binaries are .cmd scripts that need
      // shell execution. Use the full command as a single string to
      // avoid DEP0190 deprecation warning about shell + args.
      const quoted = cmd.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")
      child = spawn(quoted, [], {
        env,
        stdio: "inherit",
        shell: true,
      })
    } else {
      child = spawn(cmd[0], cmd.slice(1), {
        env,
        stdio: "inherit",
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

  let cleaned = false
  let exiting = false
  async function cleanup(): Promise<void> {
    if (cleaned) return
    cleaned = true

    try {
      child.kill()
    } catch {
      // Already exited
    }

    const timeout = setTimeout(() => process.exit(1), 5000)
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

  const onSignal = () => {
    cleanup().then(() => exit(130)).catch(() => exit(1))
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  child.on("exit", (exitCode, signal) => {
    // When killed by a signal, exitCode is null — derive from signal number
    const code = exitCode ?? (signal ? 128 : 1)
    cleanup().then(() => exit(code)).catch(() => exit(1))
  })
  child.on("error", () => {
    cleanup().then(() => exit(1)).catch(() => exit(1))
  })
}
