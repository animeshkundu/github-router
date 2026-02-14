import process from "node:process"

import consola from "consola"

import type { Server } from "srvx"

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
      : ["codex", "-m", target.model ?? "gpt5.3-codex", ...target.extraArgs]

  return {
    cmd,
    env: { ...process.env, ...target.envVars },
  }
}

export function launchChild(target: LaunchTarget, server: Server): void {
  const { cmd, env } = buildLaunchCommand(target)

  const executable = cmd[0]
  if (!Bun.which(executable)) {
    consola.error(
      `"${executable}" not found on PATH. Install it first, then try again.`,
    )
    process.exit(1)
  }

  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn({
      cmd,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
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

  const onSignal = () => {
    cleanup().then(() => process.exit(130))
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  child.exited.then(async (exitCode) => {
    await cleanup()
    process.exit(exitCode ?? 0)
  })
}
