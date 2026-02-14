import { test, expect, mock, describe, beforeEach } from "bun:test"
import { EventEmitter } from "node:events"

// --- ExitError for process.exit mock ---
class ExitError extends Error {
  code: number
  constructor(code: number) {
    super(`exit(${code})`)
    this.code = code
  }
}

// All test files share the same mock.module shapes for node:child_process,
// node:process, and consola to avoid cross-file pollution.

const execFileSyncMock = mock()
const spawnMock = mock()

mock.module("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  spawn: spawnMock,
}))

const exitMock = mock((code: number) => {
  throw new ExitError(code)
})
const processOnMock = mock()
let isTTY = true

mock.module("node:process", () => ({
  default: {
    platform: "linux",
    env: {},
    exit: exitMock,
    on: processOnMock,
    stdout: { get isTTY() { return isTTY } },
  },
}))

const setupAndServeMock = mock()
const parseSharedArgsMock = mock()
const getClaudeCodeEnvVarsMock = mock()
const getCodexEnvVarsMock = mock()

mock.module("~/lib/server-setup", () => ({
  setupAndServe: setupAndServeMock,
  parseSharedArgs: parseSharedArgsMock,
  getClaudeCodeEnvVars: getClaudeCodeEnvVarsMock,
  getCodexEnvVars: getCodexEnvVarsMock,
  sharedServerArgs: {
    port: { alias: "p", type: "string" as const },
    verbose: { alias: "v", type: "boolean" as const, default: false },
    "account-type": { alias: "a", type: "string" as const, default: "enterprise" },
    manual: { type: "boolean" as const, default: false },
    "rate-limit": { alias: "r", type: "string" as const },
    wait: { alias: "w", type: "boolean" as const, default: false },
    "github-token": { alias: "g", type: "string" as const },
    "show-token": { type: "boolean" as const, default: false },
    "proxy-env": { type: "boolean" as const, default: false },
  },
}))

mock.module("consola", () => ({
  default: {
    error: mock(),
    info: mock(),
    warn: mock(),
    debug: mock(),
    success: mock(),
    level: 1,
  },
}))

// --- Import module under test AFTER mocks ---
const { claude } = await import("../../src/claude")

type CommandRunFn = (ctx: { args: Record<string, unknown> }) => Promise<void>

function getRunFn() {
  return (claude as unknown as { run: CommandRunFn }).run
}

const fakeServer = { close: mock(async () => {}), url: "http://127.0.0.1:12345" }

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof mock> }
  child.kill = mock()
  return child
}

beforeEach(() => {
  exitMock.mockReset()
  exitMock.mockImplementation((code: number) => {
    throw new ExitError(code)
  })
  processOnMock.mockReset()
  isTTY = true

  setupAndServeMock.mockReset()
  setupAndServeMock.mockResolvedValue({
    server: fakeServer,
    serverUrl: "http://127.0.0.1:12345",
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

  execFileSyncMock.mockReset()
  execFileSyncMock.mockReturnValue(Buffer.from("/usr/bin/claude"))
  spawnMock.mockReset()
  spawnMock.mockReturnValue(createFakeChild())
})

describe("claude command", () => {
  test("TTY check: non-interactive terminal exits with code 1", async () => {
    isTTY = false
    const run = getRunFn()

    await expect(run({ args: {} })).rejects.toThrow(ExitError)
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  test("TTY check: interactive terminal proceeds", async () => {
    isTTY = true
    const run = getRunFn()

    await run({ args: {} })

    expect(setupAndServeMock).toHaveBeenCalled()
  })

  test("calls setupAndServe with silent: true", async () => {
    const run = getRunFn()

    await run({ args: {} })

    const setupCall = setupAndServeMock.mock.calls[0][0]
    expect(setupCall.silent).toBe(true)
  })

  test("calls launchChild — verified via spawn mock", async () => {
    const run = getRunFn()

    await run({ args: {} })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [cmd] = spawnMock.mock.calls[0]
    expect(cmd).toBe("claude")
  })

  test("env vars include ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, DISABLE_ keys", async () => {
    const run = getRunFn()

    await run({ args: {} })

    expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
      "http://127.0.0.1:12345",
      undefined,
    )
    const [, , options] = spawnMock.mock.calls[0]
    expect(options.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:12345")
    expect(options.env.ANTHROPIC_AUTH_TOKEN).toBe("dummy")
    expect(options.env.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBe("1")
    expect(options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1")
  })

  test("model override sets ANTHROPIC_MODEL", async () => {
    const run = getRunFn()

    await run({ args: { model: "claude-sonnet-4-20250514" } })

    expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
      "http://127.0.0.1:12345",
      "claude-sonnet-4-20250514",
    )
    const [, , options] = spawnMock.mock.calls[0]
    expect(options.env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-20250514")
  })

  test("extra positional args passed through", async () => {
    const run = getRunFn()

    await run({ args: { _: ["--verbose", "--debug"] } as Record<string, unknown> })

    const [, args] = spawnMock.mock.calls[0]
    expect(args).toContain("--verbose")
    expect(args).toContain("--debug")
  })

  test("error from setupAndServe logs error and exits(1)", async () => {
    setupAndServeMock.mockRejectedValue(new Error("bind failed"))
    const run = getRunFn()

    await expect(run({ args: {} })).rejects.toThrow(ExitError)
    expect(exitMock).toHaveBeenCalledWith(1)
  })
})
