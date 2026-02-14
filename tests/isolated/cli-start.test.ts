import { test, expect, mock, describe, beforeEach } from "bun:test"

// Mock dependencies BEFORE importing the module under test
const setupAndServeMock = mock()
const parseSharedArgsMock = mock((_args: Record<string, unknown>) => ({
  port: undefined,
  verbose: false,
  accountType: "enterprise",
  manual: false,
  rateLimit: undefined,
  rateLimitWait: false,
  githubToken: undefined,
  showToken: false,
  proxyEnv: false,
}))
const getClaudeCodeEnvVarsMock = mock(
  (serverUrl: string, model?: string) => {
    const vars: Record<string, string> = {
      ANTHROPIC_BASE_URL: serverUrl,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    }
    if (model) vars.ANTHROPIC_MODEL = model
    return vars
  },
)
const getCodexEnvVarsMock = mock((serverUrl: string) => ({
  OPENAI_BASE_URL: `${serverUrl}/v1`,
  OPENAI_API_KEY: "dummy",
}))

mock.module("~/lib/server-setup", () => ({
  setupAndServe: setupAndServeMock,
  parseSharedArgs: parseSharedArgsMock,
  getClaudeCodeEnvVars: getClaudeCodeEnvVarsMock,
  getCodexEnvVars: getCodexEnvVarsMock,
  sharedServerArgs: {
    port: { alias: "p", type: "string" as const },
    verbose: { alias: "v", type: "boolean" as const, default: false },
    "account-type": {
      alias: "a",
      type: "string" as const,
      default: "enterprise",
    },
    manual: { type: "boolean" as const, default: false },
    "rate-limit": { alias: "r", type: "string" as const },
    wait: { alias: "w", type: "boolean" as const, default: false },
    "github-token": { alias: "g", type: "string" as const },
    "show-token": { type: "boolean" as const, default: false },
    "proxy-env": { type: "boolean" as const, default: false },
  },
}))

const clipboardWriteSyncMock = mock(() => {})
mock.module("clipboardy", () => ({
  default: { writeSync: clipboardWriteSyncMock },
}))

const consolaBoxMock = mock(() => {})
const consolaSuccessMock = mock(() => {})
const consolaWarnMock = mock(() => {})
mock.module("consola", () => ({
  default: {
    box: consolaBoxMock,
    success: consolaSuccessMock,
    warn: consolaWarnMock,
    info: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    level: 0,
  },
}))

mock.module("~/lib/shell", () => ({
  generateEnvScript: (
    vars: Record<string, string | undefined>,
    cmd?: string,
  ) => {
    const parts = Object.entries(vars)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
    if (cmd) parts.push(cmd)
    return parts.join(" && ")
  },
}))

// Now dynamically import the module under test
const { start } = await import("../../src/start")

const fakeServer = { close: mock(async () => {}) }

beforeEach(() => {
  setupAndServeMock.mockReset()
  setupAndServeMock.mockResolvedValue({
    server: fakeServer,
    serverUrl: "http://127.0.0.1:8787",
  })
  parseSharedArgsMock.mockReset()
  parseSharedArgsMock.mockReturnValue({
    port: undefined,
    verbose: false,
    accountType: "enterprise",
    manual: false,
    rateLimit: undefined,
    rateLimitWait: false,
    githubToken: undefined,
    showToken: false,
    proxyEnv: false,
  })
  getClaudeCodeEnvVarsMock.mockReset()
  getClaudeCodeEnvVarsMock.mockImplementation(
    (serverUrl: string, model?: string) => {
      const vars: Record<string, string> = {
        ANTHROPIC_BASE_URL: serverUrl,
        ANTHROPIC_AUTH_TOKEN: "dummy",
        DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      }
      if (model) vars.ANTHROPIC_MODEL = model
      return vars
    },
  )
  getCodexEnvVarsMock.mockReset()
  getCodexEnvVarsMock.mockImplementation((serverUrl: string) => ({
    OPENAI_BASE_URL: `${serverUrl}/v1`,
    OPENAI_API_KEY: "dummy",
  }))
  clipboardWriteSyncMock.mockReset()
  consolaBoxMock.mockReset()
  consolaSuccessMock.mockReset()
  consolaWarnMock.mockReset()
})

type CommandRunFn = (ctx: { args: Record<string, unknown> }) => Promise<void>

// Helper to extract the run function from the citty command
function getRunFn() {
  return (start as unknown as { run: CommandRunFn }).run
}

describe("cli-start", () => {
  test("calls setupAndServe with DEFAULT_PORT when no port specified", async () => {
    const run = getRunFn()

    await run({ args: { cc: false, cx: false } })

    expect(setupAndServeMock).toHaveBeenCalledTimes(1)
    const callArgs = (setupAndServeMock.mock.calls as unknown[][])[0][0] as Record<
      string,
      unknown
    >
    expect(callArgs.port).toBe(8787)
    expect(callArgs.silent).toBe(false)
  })

  test("--cc flag generates Claude Code command", async () => {
    const run = getRunFn()

    await run({ args: { cc: true, cx: false } })

    // consolaBoxMock should be called at least twice: command + usage viewer
    expect(consolaBoxMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    const boxCall = (consolaBoxMock.mock.calls as unknown[][])[0][0] as string
    expect(boxCall).toContain("Claude Code")
  })

  test("--cx flag generates Codex CLI command", async () => {
    const run = getRunFn()

    await run({ args: { cc: false, cx: true } })

    expect(consolaBoxMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    const boxCall = (consolaBoxMock.mock.calls as unknown[][])[0][0] as string
    expect(boxCall).toContain("Codex CLI")
  })

  test("both --cc and --cx generate both commands", async () => {
    const run = getRunFn()

    await run({ args: { cc: true, cx: true } })

    // Two command boxes + usage viewer box = at least 3 calls
    expect(consolaBoxMock.mock.calls.length).toBeGreaterThanOrEqual(3)
    const allBoxCalls = consolaBoxMock.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    )
    expect(allBoxCalls.some((c: string) => c.includes("Claude Code"))).toBe(
      true,
    )
    expect(allBoxCalls.some((c: string) => c.includes("Codex CLI"))).toBe(true)
  })

  test("model override included in generated command", async () => {
    const run = getRunFn()

    await run({ args: { cc: true, cx: false, model: "custom-model" } })

    expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8787",
      "custom-model",
    )
  })

  test("clipboard copy failure handled gracefully", async () => {
    clipboardWriteSyncMock.mockImplementation(() => {
      throw new Error("clipboard unavailable")
    })

    const run = getRunFn()

    // Should not throw
    await run({ args: { cc: true, cx: false } })

    expect(consolaWarnMock).toHaveBeenCalledWith(
      "Failed to copy to clipboard. Copy the command above manually.",
    )
  })

  test("neither --cc nor --cx still starts server", async () => {
    const run = getRunFn()

    await run({ args: { cc: false, cx: false } })

    expect(setupAndServeMock).toHaveBeenCalledTimes(1)
    // Only the usage viewer box is shown
    expect(consolaBoxMock).toHaveBeenCalledTimes(1)
    const boxCall = (consolaBoxMock.mock.calls as unknown[][])[0][0] as string
    expect(boxCall).toContain("Usage Viewer")
  })

  test("setupAndServe error propagates", async () => {
    setupAndServeMock.mockRejectedValue(new Error("setup failed"))

    const run = getRunFn()

    await expect(
      run({ args: { cc: false, cx: false } }),
    ).rejects.toThrow("setup failed")
  })
})
