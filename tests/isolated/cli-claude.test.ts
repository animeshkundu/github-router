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
    stderr: { write: mock() },
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
    "extended-betas": { type: "boolean" as const, default: false },
  },
}))

mock.module("~/lib/port", () => ({
  DEFAULT_CLAUDE_MODEL: "claude-opus-4.7-1m-internal",
  DEFAULT_CLAUDE_MODEL_FALLBACKS: [
    "claude-opus-4.7",
    "claude-opus-4.6-1m",
    "claude-opus-4.6",
  ],
  // launch.ts imports DEFAULT_CODEX_MODEL transitively via claude.ts → launchChild;
  // re-export it so the module mock doesn't break sibling imports.
  DEFAULT_CODEX_MODEL: "gpt-5.5",
  DEFAULT_CODEX_MODEL_FALLBACKS: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"],
  DEFAULT_PORT: 8787,
}))

mock.module("consola", () => ({
  default: {
    error: mock(),
    info: mock(),
    warn: mock(),
    debug: mock(),
    success: mock(),
    level: 1,
    options: { reporters: [], throttle: 1000 },
    setReporters: mock(),
  },
}))

// --- Import module under test AFTER mocks ---
const { claude } = await import("../../src/claude")
const { state } = await import("../../src/lib/state")

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
    extendedBetas: false,
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

    // No --model and no model cache → claude.ts uses DEFAULT_CLAUDE_MODEL
    // ("claude-opus-4.7-1m-internal"); fallback chain only fires when the
    // cache is populated AND the default is missing.
    expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
      "http://127.0.0.1:12345",
      "claude-opus-4.7-1m-internal",
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

  test("default 1M variant in cache → used as-is (no fallback)", async () => {
    // Enterprise tier: 1M-internal is entitled. claude.ts must NOT fire the
    // fallback chain — the default is already in the cache.
    state.models = {
      data: [
        { id: "claude-opus-4.7" },
        { id: "claude-opus-4.7-1m-internal" },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    try {
      const run = getRunFn()
      await run({ args: {} })
      expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
        "http://127.0.0.1:12345",
        "claude-opus-4.7-1m-internal",
      )
    } finally {
      state.models = undefined
    }
  })

  test("default 1M missing but 4.7 present → falls back to claude-opus-4.7", async () => {
    // Pro+/Business/Max tier: claude-opus-4.7-1m-internal is gated, but the
    // 200K variant is available. The fallback chain should pick it up
    // gracefully without requiring --model.
    state.models = {
      data: [
        { id: "claude-opus-4.7" },
        { id: "claude-opus-4.6" },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    try {
      const run = getRunFn()
      await run({ args: {} })
      expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
        "http://127.0.0.1:12345",
        "claude-opus-4.7",
      )
    } finally {
      state.models = undefined
    }
  })

  test("default and all fallbacks missing → keeps literal default (warning logged)", async () => {
    // Degenerate case: cache has nothing in the opus family. Don't crash;
    // pass the literal default through and let validation surface the warning.
    state.models = {
      data: [
        { id: "gpt-5.5" },
        { id: "claude-sonnet-4.6" },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    try {
      const run = getRunFn()
      await run({ args: {} })
      expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
        "http://127.0.0.1:12345",
        "claude-opus-4.7-1m-internal",
      )
    } finally {
      state.models = undefined
    }
  })

  test("explicit --model is respected even when default 1M is in cache", async () => {
    // Discriminator: only the implicit DEFAULT path uses the fallback chain.
    // If the user explicitly types claude-opus-4.7, they get exactly 4.7.
    state.models = {
      data: [
        { id: "claude-opus-4.7" },
        { id: "claude-opus-4.7-1m-internal" },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    try {
      const run = getRunFn()
      await run({ args: { model: "claude-opus-4.7" } })
      expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
        "http://127.0.0.1:12345",
        "claude-opus-4.7",
      )
    } finally {
      state.models = undefined
    }
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
