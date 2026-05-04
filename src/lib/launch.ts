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

export interface LaunchTarget {
  kind: "claude-code" | "codex"
  envVars: Record<string, string>
  extraArgs: string[]
  model?: string
}

export function buildLaunchCommand(target: LaunchTarget): {
  cmd: string[]
  env: Record<string, string | undefined>
} {
  const cmd: string[] =
    target.kind === "claude-code"
      ? ["claude", "--dangerously-skip-permissions", ...target.extraArgs]
      : ["codex", "--full-auto", "-m", target.model ?? DEFAULT_CODEX_MODEL, ...target.extraArgs]

  return {
    cmd,
    env: { ...sanitizeParentEnv(process.env), ...target.envVars },
  }
}

export function launchChild(target: LaunchTarget, server: Server): void {
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
