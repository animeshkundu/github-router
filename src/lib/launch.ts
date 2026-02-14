import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import process from "node:process"

import consola from "consola"

import type { Server } from "srvx"

import { DEFAULT_CODEX_MODEL } from "./port"

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
      : ["codex", "-m", target.model ?? DEFAULT_CODEX_MODEL, ...target.extraArgs]

  return {
    cmd,
    env: { ...process.env, ...target.envVars },
  }
}

export function launchChild(target: LaunchTarget, server: Server): void {
  const { cmd, env } = buildLaunchCommand(target)

  const executable = cmd[0]
  if (!commandExists(executable)) {
    consola.error(
      `"${executable}" not found on PATH. Install it first, then try again.`,
    )
    process.exit(1)
  }

  let child: ChildProcess
  try {
    child = spawn(cmd[0], cmd.slice(1), {
      env,
      stdio: "inherit",
    })
  } catch (error) {
    consola.error(
      `Failed to launch ${executable}:`,
      error instanceof Error ? error.message : String(error),
    )
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

  child.on("exit", (exitCode) => {
    cleanup().then(() => exit(exitCode ?? 0)).catch(() => exit(1))
  })
  child.on("error", () => exit(1))
}
