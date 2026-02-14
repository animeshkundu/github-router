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
const getCodexEnvVarsMock = mock()
const getClaudeCodeEnvVarsMock = mock()

mock.module("~/lib/server-setup", () => ({
  setupAndServe: setupAndServeMock,
  parseSharedArgs: parseSharedArgsMock,
  getCodexEnvVars: getCodexEnvVarsMock,
  getClaudeCodeEnvVars: getClaudeCodeEnvVarsMock,
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

mock.module("~/lib/port", () => ({
  DEFAULT_CODEX_MODEL: "gpt5.3-codex",
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
const { codex } = await import("../../src/codex")

type CommandRunFn = (ctx: { args: Record<string, unknown> }) => Promise<void>

function getRunFn() {
  return (codex as unknown as { run: CommandRunFn }).run
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
  getCodexEnvVarsMock.mockReset()
  getCodexEnvVarsMock.mockImplementation((serverUrl: string) => ({
    OPENAI_BASE_URL: `${serverUrl}/v1`,
    OPENAI_API_KEY: "dummy",
  }))

  execFileSyncMock.mockReset()
  execFileSyncMock.mockReturnValue(Buffer.from("/usr/bin/codex"))
  spawnMock.mockReset()
  spawnMock.mockReturnValue(createFakeChild())
})

describe("codex command", () => {
  test("TTY check: non-interactive terminal exits with code 1", async () => {
    isTTY = false
    const run = getRunFn()

    await expect(run({ args: {} })).rejects.toThrow(ExitError)
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  test("constructs LaunchTarget with kind: codex — verified via spawn mock", async () => {
    const run = getRunFn()

    await run({ args: {} })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [cmd] = spawnMock.mock.calls[0]
    expect(cmd).toBe("codex")
  })

  test("env vars include OPENAI_BASE_URL with /v1 and OPENAI_API_KEY", async () => {
    const run = getRunFn()

    await run({ args: {} })

    expect(getCodexEnvVarsMock).toHaveBeenCalledWith("http://127.0.0.1:12345")
    const [, , options] = spawnMock.mock.calls[0]
    expect(options.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:12345/v1")
    expect(options.env.OPENAI_API_KEY).toBe("dummy")
  })

  test("default model is DEFAULT_CODEX_MODEL when no model override", async () => {
    const run = getRunFn()

    await run({ args: {} })

    const [, args] = spawnMock.mock.calls[0]
    expect(args).toContain("-m")
    expect(args).toContain("gpt5.3-codex")
  })

  test("model override applied", async () => {
    const run = getRunFn()

    await run({ args: { model: "gpt-4o" } })

    const [, args] = spawnMock.mock.calls[0]
    expect(args).toContain("-m")
    expect(args).toContain("gpt-4o")
  })

  test("extra args passed through", async () => {
    const run = getRunFn()

    await run({ args: { _: ["--full-auto"] } as Record<string, unknown> })

    const [, args] = spawnMock.mock.calls[0]
    expect(args).toContain("--full-auto")
  })

  test("error from setupAndServe logs error and exits(1)", async () => {
    setupAndServeMock.mockRejectedValue(new Error("bind failed"))
    const run = getRunFn()

    await expect(run({ args: {} })).rejects.toThrow(ExitError)
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  test("calls setupAndServe with silent: true", async () => {
    const run = getRunFn()

    await run({ args: {} })

    const setupCall = setupAndServeMock.mock.calls[0][0]
    expect(setupCall.silent).toBe(true)
  })
})
