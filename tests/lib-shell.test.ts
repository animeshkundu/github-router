import { test, expect, describe, afterEach } from "bun:test"

import { generateEnvScript } from "../src/lib/shell"

const isWindows = process.platform === "win32"

// Save original env vars to restore after each test
const savedEnv: Record<string, string | undefined> = {}

function setEnv(vars: Record<string, string | undefined>) {
  for (const [key, val] of Object.entries(vars)) {
    savedEnv[key] = process.env[key]
    if (val === undefined) delete process.env[key]
    else process.env[key] = val
  }
}

afterEach(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key]
    else process.env[key] = val
  }
  Object.keys(savedEnv).forEach((k) => delete savedEnv[k])
})

// ─── Shell detection tests ───────────────────────────────────────────────────
// On Windows, we can test all Windows detection branches via env manipulation.
// On Linux/macOS, we can test all Unix detection branches.
// The CI matrix covers both platforms.

describe("shell detection (Windows)", () => {
  test.skipIf(!isWindows)(
    "SHELL=/bin/bash → bash format",
    () => {
      setEnv({ SHELL: "/bin/bash", POWERSHELL_DISTRIBUTION_CHANNEL: undefined, PSModulePath: undefined })
      const result = generateEnvScript({ FOO: "bar" }, "cmd")
      expect(result).toContain("export")
      expect(result).toContain("&&")
    },
  )

  test.skipIf(!isWindows)(
    "SHELL=/bin/zsh → bash/zsh format",
    () => {
      setEnv({ SHELL: "/bin/zsh", POWERSHELL_DISTRIBUTION_CHANNEL: undefined, PSModulePath: undefined })
      const result = generateEnvScript({ FOO: "bar" }, "cmd")
      expect(result).toContain("export")
      expect(result).toContain("&&")
    },
  )

  test.skipIf(!isWindows)(
    "SHELL=/bin/fish → fish format",
    () => {
      setEnv({ SHELL: "/bin/fish", POWERSHELL_DISTRIBUTION_CHANNEL: undefined, PSModulePath: undefined })
      const result = generateEnvScript({ FOO: "bar" }, "cmd")
      expect(result).toContain("set -gx FOO")
    },
  )

  test.skipIf(!isWindows)(
    "SHELL=/other → sh format",
    () => {
      setEnv({ SHELL: "/other", POWERSHELL_DISTRIBUTION_CHANNEL: undefined, PSModulePath: undefined })
      const result = generateEnvScript({ FOO: "bar" }, "cmd")
      expect(result).toContain("export")
      expect(result).toContain("&&")
    },
  )

  test.skipIf(!isWindows)(
    "POWERSHELL_DISTRIBUTION_CHANNEL set → PowerShell format",
    () => {
      setEnv({ SHELL: undefined, POWERSHELL_DISTRIBUTION_CHANNEL: "MSI:Windows 10 Pro", PSModulePath: undefined })
      const result = generateEnvScript({ FOO: "bar" }, "cmd")
      expect(result).toContain("$env:FOO")
    },
  )

  test.skipIf(!isWindows)(
    "PSModulePath with documents\\powershell → PowerShell format",
    () => {
      setEnv({
        SHELL: undefined,
        POWERSHELL_DISTRIBUTION_CHANNEL: undefined,
        PSModulePath: "C:\\Users\\test\\Documents\\PowerShell\\Modules;C:\\Program Files",
      })
      const result = generateEnvScript({ FOO: "bar" }, "cmd")
      expect(result).toContain("$env:FOO")
    },
  )

  test.skipIf(!isWindows)(
    "PSModulePath with documents\\windowspowershell → PowerShell format",
    () => {
      setEnv({
        SHELL: undefined,
        POWERSHELL_DISTRIBUTION_CHANNEL: undefined,
        PSModulePath: "C:\\Users\\test\\Documents\\WindowsPowerShell\\Modules",
      })
      const result = generateEnvScript({ FOO: "bar" }, "cmd")
      expect(result).toContain("$env:FOO")
    },
  )

  test.skipIf(!isWindows)(
    "no special env → CMD format",
    () => {
      setEnv({ SHELL: undefined, POWERSHELL_DISTRIBUTION_CHANNEL: undefined, PSModulePath: undefined })
      const result = generateEnvScript({ FOO: "bar" }, "cmd")
      expect(result).toContain('set "FOO=bar"')
    },
  )
})

describe("shell detection (Unix)", () => {
  test.skipIf(isWindows)(
    "SHELL=/bin/bash → bash format",
    () => {
      setEnv({ SHELL: "/bin/bash" })
      const result = generateEnvScript({ FOO: "bar" }, "cmd")
      expect(result).toContain("export")
      expect(result).toContain("&&")
    },
  )

  test.skipIf(isWindows)(
    "SHELL=/bin/zsh → zsh format",
    () => {
      setEnv({ SHELL: "/bin/zsh" })
      const result = generateEnvScript({ FOO: "bar" }, "cmd")
      expect(result).toContain("export")
      expect(result).toContain("&&")
    },
  )

  test.skipIf(isWindows)(
    "SHELL=/bin/fish → fish format",
    () => {
      setEnv({ SHELL: "/bin/fish" })
      const result = generateEnvScript({ FOO: "bar" }, "cmd")
      expect(result).toContain("set -gx FOO")
    },
  )

  test.skipIf(isWindows)(
    "no SHELL → sh format",
    () => {
      setEnv({ SHELL: undefined })
      const result = generateEnvScript({ FOO: "bar" }, "cmd")
      expect(result).toContain("export")
      expect(result).toContain("&&")
    },
  )
})

// ─── Script generation tests ─────────────────────────────────────────────────
// These test the output format for the CURRENT platform's detected shell.

describe("script generation", () => {
  test("single quotes escaped with '\\'' (POSIX)", () => {
    // Force bash on current platform
    if (isWindows) setEnv({ SHELL: "/bin/bash", POWERSHELL_DISTRIBUTION_CHANNEL: undefined, PSModulePath: undefined })
    else setEnv({ SHELL: "/bin/bash" })
    const result = generateEnvScript({ VAL: "it's" }, "cmd")
    expect(result).toBe("export VAL='it'\\''s' && cmd")
  })

  test.skipIf(!isWindows)(
    "PowerShell single quote escaped with ''",
    () => {
      setEnv({ SHELL: undefined, POWERSHELL_DISTRIBUTION_CHANNEL: "MSI", PSModulePath: undefined })
      const result = generateEnvScript({ VAL: "it's" }, "cmd")
      expect(result).toBe("$env:VAL = 'it''s'; cmd")
    },
  )

  test.skipIf(!isWindows)(
    "CMD with & in value: documents current behavior (no escaping)",
    () => {
      setEnv({ SHELL: undefined, POWERSHELL_DISTRIBUTION_CHANNEL: undefined, PSModulePath: undefined })
      // Current behavior: & is NOT escaped in CMD — known security issue
      const result = generateEnvScript({ VAL: "a&b" }, "cmd")
      expect(result).toBe('set "VAL=a&b" & cmd')
    },
  )

  test("no env vars → returns command only", () => {
    const result = generateEnvScript({}, "run-thing")
    expect(result).toBe("run-thing")
  })

  test("no command → returns env block only", () => {
    if (isWindows) setEnv({ SHELL: "/bin/bash", POWERSHELL_DISTRIBUTION_CHANNEL: undefined, PSModulePath: undefined })
    else setEnv({ SHELL: "/bin/bash" })
    const result = generateEnvScript({ FOO: "bar" })
    expect(result).toBe("export FOO='bar'")
  })

  test("both empty → returns empty string", () => {
    const result = generateEnvScript({})
    expect(result).toBe("")
  })

  test("multiple env vars combined correctly", () => {
    if (isWindows) setEnv({ SHELL: "/bin/bash", POWERSHELL_DISTRIBUTION_CHANNEL: undefined, PSModulePath: undefined })
    else setEnv({ SHELL: "/bin/bash" })
    const result = generateEnvScript(
      { FOO: "1", BAR: "2", BAZ: "3" },
      "cmd",
    )
    expect(result).toBe("export FOO='1' BAR='2' BAZ='3' && cmd")
  })

  test("undefined values filtered out", () => {
    if (isWindows) setEnv({ SHELL: "/bin/bash", POWERSHELL_DISTRIBUTION_CHANNEL: undefined, PSModulePath: undefined })
    else setEnv({ SHELL: "/bin/bash" })
    const result = generateEnvScript(
      { FOO: "1", SKIP: undefined, BAR: "2" },
      "cmd",
    )
    expect(result).toBe("export FOO='1' BAR='2' && cmd")
  })
})
