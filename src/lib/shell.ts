import process from "node:process"

type ShellName = "bash" | "zsh" | "fish" | "powershell" | "cmd" | "sh"
type EnvVars = Record<string, string | undefined>

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function assertSafeEnvKey(key: string): string {
  if (!ENV_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid environment variable name: ${key}`)
  }
  return key
}

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
  const entries = Object.entries(envVars).map(
    ([key, value]) => [assertSafeEnvKey(key), value] as const,
  )
  const filteredEnvVars = entries.filter(
    ([, value]) => value !== undefined,
  ) as Array<[string, string]>
  const unsetEnvKeys = entries
    .filter(([, value]) => value === undefined)
    .map(([key]) => key)

  let commandBlock: string

  switch (shell) {
    case "powershell": {
      const unsetBlock = unsetEnvKeys
        .map((key) => `Remove-Item Env:${key} -ErrorAction SilentlyContinue`)
        .join("; ")
      const setBlock = filteredEnvVars
        .map(([key, value]) => `$env:${key} = ${quotePowerShellValue(value)}`)
        .join("; ")
      commandBlock = [unsetBlock, setBlock].filter(Boolean).join("; ")
      break
    }
    case "cmd": {
      const unsetBlock = unsetEnvKeys.map((key) => `set "${key}="`).join(" & ")
      const setBlock = filteredEnvVars
        .map(([key, value]) => `set "${key}=${value}"`)
        .join(" & ")
      commandBlock = [unsetBlock, setBlock].filter(Boolean).join(" & ")
      break
    }
    case "fish": {
      const unsetBlock = unsetEnvKeys.map((key) => `set -e ${key}`).join("; ")
      const setBlock = filteredEnvVars
        .map(([key, value]) => `set -gx ${key} ${quotePosixValue(value)}`)
        .join("; ")
      commandBlock = [unsetBlock, setBlock].filter(Boolean).join("; ")
      break
    }
    default: {
      // bash, zsh, sh
      const unsetBlock = unsetEnvKeys.length > 0 ? `unset ${unsetEnvKeys.join(" ")}` : ""
      const assignments = filteredEnvVars
        .map(([key, value]) => `${key}=${quotePosixValue(value)}`)
        .join(" ")
      const setBlock = filteredEnvVars.length > 0 ? `export ${assignments}` : ""
      commandBlock = [unsetBlock, setBlock].filter(Boolean).join(" && ")
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
