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
  // Anthropic-published dashed slug (per plan §14) — Claude Code's `/model`
  // UI registry expects this, and the proxy's resolver translates back to
  // Copilot's `claude-opus-4.7-1m-internal` at request time.
  DEFAULT_CLAUDE_MODEL: "claude-opus-4-7",
  DEFAULT_CLAUDE_MODEL_FALLBACKS: ["claude-opus-4-6", "claude-opus-4-5"],
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

// MCP wiring mocks — keep tests hermetic. Real fs operations (and the
// real per-launch nonce generation) are exercised in
// tests/codex-mcp-config.test.ts; here we just verify that claude.ts
// invokes the wiring with the expected args and threads the resulting
// flags into spawnMock.
const writePeerMcpRuntimeFilesMock = mock()
const resolveCodexCliBackendMock = mock()
const getCodexVersionMock = mock()

mock.module("~/lib/codex-mcp-config", () => ({
  writePeerMcpRuntimeFiles: writePeerMcpRuntimeFilesMock,
  resolveCodexCliBackend: resolveCodexCliBackendMock,
}))

// launch.ts also exports buildLaunchCommand etc. — re-export the real
// ones, but stub getCodexVersion so we don't shell out to `codex --version`.
const realLaunch = await import("../../src/lib/launch")
mock.module("~/lib/launch", () => ({
  ...realLaunch,
  getCodexVersion: getCodexVersionMock,
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

  // MCP wiring: default-on. Most tests exercise the default path
  // (codex-cli absent) where we get HTTP backend + 2-3 personas.
  writePeerMcpRuntimeFilesMock.mockReset()
  writePeerMcpRuntimeFilesMock.mockResolvedValue({
    mcpConfigPath: "/tmp/peer-mcp-test.json",
    agentsPath: "/tmp/peer-agents-test.json",
    nonce: "test-nonce",
    personas: [
      { agentName: "codex-critic" },
      { agentName: "codex-reviewer" },
    ],
    cleanup: async () => {},
  })
  resolveCodexCliBackendMock.mockReset()
  resolveCodexCliBackendMock.mockReturnValue("http")
  getCodexVersionMock.mockReset()
  getCodexVersionMock.mockReturnValue({ ok: false })
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
    // ("claude-opus-4-7"); resolver is a no-op without a cache, so the
    // Anthropic slug flows through unchanged.
    expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
      "http://127.0.0.1:12345",
      "claude-opus-4-7",
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

  test("default works on enterprise (resolver maps Anthropic slug → 1M Copilot slug)", async () => {
    // ANTHROPIC_MODEL must be the Anthropic slug (claude-opus-4-7) so
    // Claude Code's `/model` UI matches menu entry 3 "Opus 4.7 (1M context)".
    // The proxy's resolveModel translates to Copilot's
    // claude-opus-4.7-1m-internal at request time — invisible to the user.
    // Cache populated with 1M variant → inCache check passes, no fallback.
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
        "claude-opus-4-7",
      )
    } finally {
      state.models = undefined
    }
  })

  test("default works on non-enterprise (resolver downgrades 1M→200K transparently)", async () => {
    // Pro+/Business/Max: only the 200K variant is available. Resolver's
    // family-preference branch finds no -1m, falls through to step 4
    // (normalized match), which translates claude-opus-4-7 → claude-opus-4.7.
    // Since claude-opus-4.7 IS in cache, inCache returns true and the
    // fallback chain does NOT fire — ANTHROPIC_MODEL remains the Anthropic
    // slug for UI compatibility.
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
        "claude-opus-4-7",
      )
    } finally {
      state.models = undefined
    }
  })

  test("opus 4.7 absent → fallback chain picks claude-opus-4-6 (load-bearing test)", async () => {
    // Discriminator for the fallback chain firing. Cache has 4.6 but no 4.7
    // of any kind. claude-opus-4-7 doesn't resolve to anything in cache;
    // walking the chain, claude-opus-4-6 resolves to claude-opus-4.6 (step 4
    // normalized match), which IS in cache → fallback fires.
    state.models = {
      data: [
        { id: "claude-opus-4.6" },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    try {
      const run = getRunFn()
      await run({ args: {} })
      expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
        "http://127.0.0.1:12345",
        "claude-opus-4-6",
      )
    } finally {
      state.models = undefined
    }
  })

  test("default and all fallbacks missing → keeps literal default (warning logged)", async () => {
    // Degenerate case: no Opus models at all. Don't crash; pass the literal
    // Anthropic default through. The /v1/messages route's resolveModelInBody
    // would then return the input unchanged (step 5 with warning) and
    // Copilot would 400 — that's fine, it's a misconfigured environment
    // and the warning surfaces it.
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
        "claude-opus-4-7",
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

  describe("codex-mcp wiring", () => {
    test("default → writes runtime files, appends --mcp-config + --agents to spawn", async () => {
      const run = getRunFn()
      await run({ args: {} })

      expect(writePeerMcpRuntimeFilesMock).toHaveBeenCalledTimes(1)
      const [serverUrl, opts] = writePeerMcpRuntimeFilesMock.mock.calls[0]
      expect(serverUrl).toBe("http://127.0.0.1:12345")
      expect(opts.codexCli).toBe(false)

      const [, args] = spawnMock.mock.calls[0]
      expect(args).toContain("--mcp-config")
      expect(args).toContain("/tmp/peer-mcp-test.json")
      expect(args).toContain("--agents")
      expect(args).toContain("/tmp/peer-agents-test.json")
      expect(args).not.toContain("--strict-mcp-config")
    })

    test("--no-codex-mcp → no MCP wiring, no extra spawn args", async () => {
      const run = getRunFn()
      await run({ args: { "codex-mcp": false } })

      expect(writePeerMcpRuntimeFilesMock).not.toHaveBeenCalled()
      const [, args] = spawnMock.mock.calls[0]
      expect(args).not.toContain("--mcp-config")
      expect(args).not.toContain("--agents")
    })

    test("--codex-cli requested + codex absent → falls back to http backend", async () => {
      resolveCodexCliBackendMock.mockReturnValue("http")
      const run = getRunFn()
      await run({ args: { "codex-cli": true } })

      // resolveCodexCliBackend is consulted with requested=true and codex info
      expect(resolveCodexCliBackendMock).toHaveBeenCalledTimes(1)
      const resolveArgs = resolveCodexCliBackendMock.mock.calls[0][0]
      expect(resolveArgs.requested).toBe(true)
      expect(resolveArgs.codexInfo).toEqual({ ok: false })

      // Resulting backend was http, so writePeerMcpRuntimeFiles got codexCli: false
      const writeArgs = writePeerMcpRuntimeFilesMock.mock.calls[0][1]
      expect(writeArgs.codexCli).toBe(false)
    })

    test("--codex-cli with codex 0.129+ → cli backend selected", async () => {
      getCodexVersionMock.mockReturnValue({ ok: true, version: "0.129.0" })
      resolveCodexCliBackendMock.mockReturnValue("cli")
      const run = getRunFn()
      await run({ args: { "codex-cli": true } })

      const writeArgs = writePeerMcpRuntimeFilesMock.mock.calls[0][1]
      expect(writeArgs.codexCli).toBe(true)
    })

    test("--codex-mcp-only → adds --strict-mcp-config to spawn args", async () => {
      const run = getRunFn()
      await run({ args: { "codex-mcp-only": true } })

      const [, args] = spawnMock.mock.calls[0]
      expect(args).toContain("--strict-mcp-config")
    })

    test("writePeerMcpRuntimeFiles failure does not block claude launch", async () => {
      writePeerMcpRuntimeFilesMock.mockRejectedValue(new Error("disk full"))
      const run = getRunFn()
      await run({ args: {} })

      // Spawn still happened (claude launches without MCP wiring)
      expect(spawnMock).toHaveBeenCalledTimes(1)
      const [, args] = spawnMock.mock.calls[0]
      expect(args).not.toContain("--mcp-config")
    })

    test("gemini availability is probed against state.models catalog", async () => {
      state.models = {
        data: [
          { id: "gemini-3.1-pro-preview" },
          { id: "claude-opus-4.7" },
        ] as unknown as NonNullable<typeof state.models>["data"],
        object: "list",
      }
      try {
        const run = getRunFn()
        await run({ args: {} })
        const writeArgs = writePeerMcpRuntimeFilesMock.mock.calls[0][1]
        expect(writeArgs.geminiAvailable).toBe(true)
      } finally {
        state.models = undefined
      }
    })

    test("gemini absent from catalog → geminiAvailable=false", async () => {
      state.models = {
        data: [
          { id: "gpt-5.5" },
          { id: "claude-opus-4.7" },
        ] as unknown as NonNullable<typeof state.models>["data"],
        object: "list",
      }
      try {
        const run = getRunFn()
        await run({ args: {} })
        const writeArgs = writePeerMcpRuntimeFilesMock.mock.calls[0][1]
        expect(writeArgs.geminiAvailable).toBe(false)
      } finally {
        state.models = undefined
      }
    })
  })
})
