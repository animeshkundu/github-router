import process from "node:process"

type ShellName = "bash" | "zsh" | "fish" | "powershell" | "cmd" | "sh"
type EnvVars = Record<string, string | undefined>

function getShell(): ShellName {
  const { platform, env } = process

  if (platform === "win32") {
    // Git Bash / MSYS2 / Cygwin set SHELL even on Windows
    if (env.SHELL) {
      if (env.SHELL.endsWith("zsh")) return "zsh"
      if (env.SHELL.endsWith("fish")) return "fish"
      if (env.SHELL.endsWith("bash")) return "bash"
      return "sh"
    }

    // Windows PowerShell 5.x sets this
    if (env.POWERSHELL_DISTRIBUTION_CHANNEL) return "powershell"

    // PowerShell (both 5.x and 7+/pwsh) adds user-scoped module paths
    // at runtime. The system-level PSModulePath in CMD lacks these paths.
    if (env.PSModulePath) {
      const lower = env.PSModulePath.toLowerCase()
      if (
        lower.includes("documents\\powershell")
        || lower.includes("documents\\windowspowershell")
      ) {
        return "powershell"
      }
    }

    return "cmd"
  }

  const shellPath = env.SHELL
  if (shellPath) {
    if (shellPath.endsWith("zsh")) return "zsh"
    if (shellPath.endsWith("fish")) return "fish"
    if (shellPath.endsWith("bash")) return "bash"
  }

  return "sh"
}

function quotePosixValue(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function quotePowerShellValue(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Generates a copy-pasteable script to set multiple environment variables
 * and run a subsequent command.
 * @param {EnvVars} envVars - An object of environment variables to set.
 * @param {string} commandToRun - The command to run after setting the variables.
 * @returns {string} The formatted script string.
 */
export function generateEnvScript(
  envVars: EnvVars,
  commandToRun: string = "",
): string {
  const shell = getShell()
  const filteredEnvVars = Object.entries(envVars).filter(
    ([, value]) => value !== undefined,
  ) as Array<[string, string]>

  let commandBlock: string

  switch (shell) {
    case "powershell": {
      commandBlock = filteredEnvVars
        .map(([key, value]) => `$env:${key} = ${quotePowerShellValue(value)}`)
        .join("; ")
      break
    }
    case "cmd": {
      commandBlock = filteredEnvVars
        .map(([key, value]) => `set "${key}=${value}"`)
        .join(" & ")
      break
    }
    case "fish": {
      commandBlock = filteredEnvVars
        .map(([key, value]) => `set -gx ${key} ${quotePosixValue(value)}`)
        .join("; ")
      break
    }
    default: {
      // bash, zsh, sh
      const assignments = filteredEnvVars
        .map(([key, value]) => `${key}=${quotePosixValue(value)}`)
        .join(" ")
      commandBlock = filteredEnvVars.length > 0 ? `export ${assignments}` : ""
      break
    }
  }

  if (commandBlock && commandToRun) {
    const separator =
      shell === "cmd" ? " & " : shell === "powershell" ? "; " : " && "
    return `${commandBlock}${separator}${commandToRun}`
  }

  return commandBlock || commandToRun
}
