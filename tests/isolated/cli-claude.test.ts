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
const execFileMock = mock()
const spawnMock = mock()
const spawnSyncMock = mock()

mock.module("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execFile: execFileMock,
  spawn: spawnMock,
  // worker-agent/bash.ts and lifecycle.ts use spawnSync (Windows
  // taskkill, exit-handler sweep that can't await async). Without
  // this, the static import graph pulled in by peer-mcp-personas →
  // worker-agent fails at load with `Export named 'spawnSync' not
  // found in module 'node:child_process'`.
  spawnSync: spawnSyncMock,
}))

const exitMock = mock((code: number) => {
  throw new ExitError(code)
})
const processOnMock = mock()
let isTTY = true
// Mutable env that the mocked `process` exposes. Tests can write to this
// to drive env-conditional code paths (e.g. GH_ROUTER_PEER_AWARENESS opt-out).
const mockProcessEnv: Record<string, string | undefined> = {}

mock.module("node:process", () => ({
  default: {
    platform: "linux",
    env: mockProcessEnv,
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

// Closure-captured impl for the pickClaudeDefault mock. Tests rebind this
// in beforeEach (and per-test) to drive the cap-aware default behavior
// without needing to load the real state module from the mock factory
// (Bun deadlocks if a mock.module factory dynamically resolves another
// module via require / import at factory-eval time). The optional
// `family` arg mirrors the real `pickClaudeDefault(opusFamily?)` so
// the `-m 4.7` / `-m 4.8` shorthand path is exercisable.
let pickClaudeDefaultImpl: (family?: string) => string = () => "claude-opus-4-8"
let pickClaudeDefaultCalls: Array<string | undefined> = []

mock.module("~/lib/port", () => ({
  // Anthropic-published dashed slug (per plan §14) — Claude Code's `/model`
  // UI registry expects this, and the proxy's resolver translates back to
  // Copilot's `claude-opus-4.8` at request time.
  DEFAULT_CLAUDE_MODEL: "claude-opus-4-8",
  DEFAULT_CLAUDE_MODEL_FALLBACKS: ["claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"],
  // Delegates to the closure-captured impl so tests can swap behavior
  // per-case (cap-aware-default tests set this to return "...[1m]").
  // Records every call's `family` arg so shorthand-routing tests can
  // assert the right value was forwarded from `-m 4.X` to the picker.
  pickClaudeDefault: (family?: string) => {
    pickClaudeDefaultCalls.push(family)
    return pickClaudeDefaultImpl(family)
  },
  // launch.ts imports DEFAULT_CODEX_MODEL transitively via claude.ts → launchChild;
  // re-export it so the module mock doesn't break sibling imports.
  DEFAULT_CODEX_MODEL: "gpt-5.5",
  DEFAULT_CODEX_MODEL_FALLBACKS: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"],
  DEFAULT_PORT: 8787,
  // The worker-agent surface (registered via peer-mcp-personas → tools.ts →
  // create-responses.ts) statically imports these from ~/lib/port. The
  // mock has to re-export them or any test that loads the worker static
  // graph fails at import time with `Export named 'UPSTREAM_FETCH_TIMEOUT_MS'
  // not found in module`. Values are the real defaults (per src/lib/port.ts).
  UPSTREAM_FETCH_TIMEOUT_MS: 0,
  UPSTREAM_INACTIVITY_TIMEOUT_MS: 300_000,
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
const injectPeerMcpIntoMirrorMock = mock()
const resolveGroupKeysFromMirrorMock = mock()
const getCodexVersionMock = mock()

mock.module("~/lib/codex-mcp-config", () => ({
  writePeerMcpRuntimeFiles: writePeerMcpRuntimeFilesMock,
  resolveCodexCliBackend: resolveCodexCliBackendMock,
  injectPeerMcpIntoMirror: injectPeerMcpIntoMirrorMock,
  resolveGroupKeysFromMirror: resolveGroupKeysFromMirrorMock,
}))

// Capability-gate predicates. claude.ts imports these from
// ~/lib/mcp-capabilities to decide which scoped MCP servers to register
// (workers / decide / browser only when their catalog gate passes). Pin
// them OFF by default so the enabled-group set is the deterministic
// `["peers", "search"]` for every test that doesn't override; tests that
// exercise a group's gate rebind the relevant mock per-case.
const workerToolsEnabledMock = mock(() => false)
const standInToolEnabledMock = mock(() => false)
const browserToolsEnabledMock = mock(() => false)
mock.module("~/lib/mcp-capabilities", () => ({
  workerToolsEnabled: workerToolsEnabledMock,
  standInToolEnabled: standInToolEnabledMock,
  browserToolsEnabled: browserToolsEnabledMock,
  // handler.ts (pulled in transitively via the static import graph)
  // also imports these two; re-export stubs so the module mock doesn't
  // break that import. claude.ts itself only uses the three above.
  browserCompoundToolsEnabled: mock(() => false),
  browserPowerToolsEnabled: mock(() => false),
}))

// The CLAUDE.md append + prepend helpers are the new descendant-reach
// surface; mock both here so the cli-claude test focuses on call/no-call
// assertions and the real filesystem write logic is exercised by
// tests/claude-md-injection.test.ts in isolation.
const appendPeerAwarenessToMirroredClaudeMdMock = mock()
const prependStyleDirectiveToMirroredClaudeMdMock = mock()
const appendToolbeltAwarenessToMirroredClaudeMdMock = mock()
mock.module("~/lib/claude-md-injection", () => ({
  appendPeerAwarenessToMirroredClaudeMd:
    appendPeerAwarenessToMirroredClaudeMdMock,
  prependStyleDirectiveToMirroredClaudeMd:
    prependStyleDirectiveToMirroredClaudeMdMock,
  appendToolbeltAwarenessToMirroredClaudeMd:
    appendToolbeltAwarenessToMirroredClaudeMdMock,
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
    agentMdPaths: [
      "/tmp/.claude/agents/peer-1-deadbeef-codex-critic.md",
      "/tmp/.claude/agents/peer-1-deadbeef-codex-reviewer.md",
      "/tmp/.claude/agents/peer-1-deadbeef-peer-review-coordinator.md",
    ],
    nonce: "test-nonce",
    personas: [
      { agentName: "codex-critic" },
      { agentName: "codex-reviewer" },
    ],
    cleanup: async () => {},
  })
  resolveCodexCliBackendMock.mockReset()
  resolveCodexCliBackendMock.mockReturnValue("http")
  injectPeerMcpIntoMirrorMock.mockReset()
  injectPeerMcpIntoMirrorMock.mockResolvedValue({
    ok: true,
    serversAdded: ["peers", "search"],
  })
  resolveGroupKeysFromMirrorMock.mockReset()
  // Default: no user-side collision → bare keys for the always-on groups.
  resolveGroupKeysFromMirrorMock.mockResolvedValue({
    keys: { peers: "peers", search: "search" },
    skipped: [],
  })
  workerToolsEnabledMock.mockReset()
  workerToolsEnabledMock.mockReturnValue(false)
  standInToolEnabledMock.mockReset()
  standInToolEnabledMock.mockReturnValue(false)
  browserToolsEnabledMock.mockReset()
  browserToolsEnabledMock.mockReturnValue(false)
  appendPeerAwarenessToMirroredClaudeMdMock.mockReset()
  appendPeerAwarenessToMirroredClaudeMdMock.mockResolvedValue(undefined)
  prependStyleDirectiveToMirroredClaudeMdMock.mockReset()
  prependStyleDirectiveToMirroredClaudeMdMock.mockResolvedValue(undefined)
  appendToolbeltAwarenessToMirroredClaudeMdMock.mockReset()
  appendToolbeltAwarenessToMirroredClaudeMdMock.mockResolvedValue(undefined)
  getCodexVersionMock.mockReset()
  getCodexVersionMock.mockReturnValue({ ok: false })

  // Default pickClaudeDefault to the bare slug; tests that exercise the
  // 1M-detection path rebind this to return "claude-opus-4-8[1m]". Reset
  // the call recorder so per-test assertions see a clean slate.
  pickClaudeDefaultImpl = () => "claude-opus-4-8"
  pickClaudeDefaultCalls = []
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
    // ("claude-opus-4-8"); resolver is a no-op without a cache, so the
    // Anthropic slug flows through unchanged.
    expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
      "http://127.0.0.1:12345",
      "claude-opus-4-8",
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

  test("default works on enterprise (cap-aware default adds [1m] suffix so Claude Code accounts for 1M context locally)", async () => {
    // Enterprise tier: catalog signals 4.8 is 1M-capable (base slug's
    // max_context_window_tokens is 1_000_000 — 4.8 has no -1m sibling).
    // pickClaudeDefault (src/lib/port.ts) detects via the dual-signal
    // checker and returns the bracketed slug "claude-opus-4-8[1m]".
    // Claude Code's has1mContext (cc-backup context.ts:35-40) matches
    // /\[1m\]/i and flips its context window to 1_000_000 — driving
    // compaction triggers and the status-line context %. The proxy's
    // resolveModel strips the bracket before talking to Copilot (which
    // would 400 on it), so the upstream call still routes to
    // claude-opus-4.8.
    //
    // Here we simulate the enterprise outcome by overriding the mocked
    // pickClaudeDefault to return the bracketed slug (the catalog-detection
    // logic itself is covered by tests/lib-utils.test.ts). state.models is
    // still set so the fallback-chain probe (inCache) finds the resolved
    // 4.8 slug and doesn't trigger a fallback.
    pickClaudeDefaultImpl = () => "claude-opus-4-8[1m]"
    state.models = {
      data: [
        { id: "claude-opus-4.8" },
        { id: "claude-opus-4.7-1m-internal" },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    try {
      const run = getRunFn()
      await run({ args: {} })
      expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
        "http://127.0.0.1:12345",
        "claude-opus-4-8[1m]",
      )
    } finally {
      state.models = undefined
    }
  })

  test("default works on non-enterprise (no 1M signal in catalog → bare slug, 200K accounting)", async () => {
    // Pro tier: only the 200K variant is available. pickClaudeDefault
    // returns the bare DEFAULT_CLAUDE_MODEL (no [1m] suffix), so Claude Code's
    // local context accounting matches the upstream behavior. The fallback
    // chain doesn't fire because claude-opus-4.8 IS in cache.
    state.models = {
      data: [
        { id: "claude-opus-4.8" },
        { id: "claude-opus-4.7" },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    try {
      const run = getRunFn()
      await run({ args: {} })
      expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
        "http://127.0.0.1:12345",
        "claude-opus-4-8",
      )
    } finally {
      state.models = undefined
    }
  })

  test("opus 4.8 absent → fallback chain picks claude-opus-4-7 (load-bearing test)", async () => {
    // Discriminator for the fallback chain firing. Cache has 4.7 but no 4.8
    // of any kind. claude-opus-4-8 doesn't resolve to anything in cache;
    // walking the chain, claude-opus-4-7 resolves to claude-opus-4.7 (step 4
    // normalized match), which IS in cache → fallback fires on the first
    // older Opus that exists.
    state.models = {
      data: [
        { id: "claude-opus-4.7" },
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
        "claude-opus-4-8",
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

  // --- Opus family shorthand: `-m 4.7` / `-m 4.8` / `-m 4.6` ---

  test("--model 4.7 shorthand routes through pickClaudeDefault(\"4.7\")", async () => {
    // The shorthand pattern /^\d+\.\d+$/ on args.model expands via
    // pickClaudeDefault(family). On enterprise (1M present), the picker
    // returns the bracketed slug; the env var carries the bracket so
    // Claude Code unlocks 1M-context local accounting.
    pickClaudeDefaultImpl = (family?: string) =>
      family === "4.7" ? "claude-opus-4-7[1m]" : "claude-opus-4-8"
    state.models = {
      data: [
        { id: "claude-opus-4.7" },
        { id: "claude-opus-4.7-1m-internal" },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    try {
      const run = getRunFn()
      await run({ args: { model: "4.7" } })
      expect(pickClaudeDefaultCalls).toContain("4.7")
      expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
        "http://127.0.0.1:12345",
        "claude-opus-4-7[1m]",
      )
    } finally {
      state.models = undefined
    }
  })

  test("--model 4.8 shorthand routes through pickClaudeDefault(\"4.8\") and returns bracketed slug (base-slug capability signal flips [1m])", async () => {
    // Mirrors the live Copilot catalog as of 2026-06-04: `claude-opus-4.8`
    // ships as a single base slug whose max_context_window_tokens already
    // advertises 1M context. The picker's dual-signal detector flips [1m]
    // on via the base-slug capability path (no -1m sibling exists for 4.8).
    pickClaudeDefaultImpl = (family?: string) =>
      family === "4.8" ? "claude-opus-4-8[1m]" : "claude-opus-4-8"
    state.models = {
      data: [
        { id: "claude-opus-4.8" },
        { id: "claude-opus-4.7-1m-internal" },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    try {
      const run = getRunFn()
      await run({ args: { model: "4.8" } })
      expect(pickClaudeDefaultCalls).toContain("4.8")
      expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
        "http://127.0.0.1:12345",
        "claude-opus-4-8[1m]",
      )
      const [, , options] = spawnMock.mock.calls[0]
      expect(options.env.ANTHROPIC_MODEL).toBe("claude-opus-4-8[1m]")
    } finally {
      state.models = undefined
    }
  })

  test("--model 4.6 shorthand routes through pickClaudeDefault(\"4.6\")", async () => {
    pickClaudeDefaultImpl = (family?: string) =>
      family === "4.6" ? "claude-opus-4-6[1m]" : "claude-opus-4-8"
    state.models = {
      data: [
        { id: "claude-opus-4.6-1m" },
        { id: "claude-opus-4.6" },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    try {
      const run = getRunFn()
      await run({ args: { model: "4.6" } })
      expect(pickClaudeDefaultCalls).toContain("4.6")
      expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
        "http://127.0.0.1:12345",
        "claude-opus-4-6[1m]",
      )
    } finally {
      state.models = undefined
    }
  })

  test("--model with a full slug is NOT treated as shorthand (passthrough preserved)", async () => {
    // Regression guard: full slugs like `claude-opus-4-7-something` must
    // continue to flow straight through to resolveModel without touching
    // pickClaudeDefault — that's the existing "power-user pinning" path.
    state.models = {
      data: [
        { id: "claude-opus-4.7-1m-internal" },
      ] as unknown as NonNullable<typeof state.models>["data"],
      object: "list",
    }
    try {
      const run = getRunFn()
      await run({ args: { model: "claude-opus-4.7-1m-internal" } })
      expect(pickClaudeDefaultCalls).toEqual([])
      expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
        "http://127.0.0.1:12345",
        "claude-opus-4.7-1m-internal",
      )
    } finally {
      state.models = undefined
    }
  })

  test("--model garbage (non-numeric) is NOT treated as shorthand", async () => {
    // The regex only matches `\d+\.\d+`; any other string flows through
    // unchanged so e.g. typoed slugs surface the existing model-not-found
    // warning rather than silently triggering a family lookup.
    const run = getRunFn()
    await run({ args: { model: "garbage-slug" } })
    expect(pickClaudeDefaultCalls).toEqual([])
    expect(getClaudeCodeEnvVarsMock).toHaveBeenCalledWith(
      "http://127.0.0.1:12345",
      "garbage-slug",
    )
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
    test("default (mirror inject succeeds) → writes runtime files + inject into mirror; --mcp-config NOT pushed", async () => {
      const run = getRunFn()
      await run({ args: {} })

      // The always-on groups (peers + search) are resolved against the
      // mirror snapshot; workers/decide/browser stay off because their
      // capability mocks return false by default.
      expect(resolveGroupKeysFromMirrorMock).toHaveBeenCalledTimes(1)
      const [enabledGroups] = resolveGroupKeysFromMirrorMock.mock.calls[0]
      expect(enabledGroups).toEqual(["peers", "search"])

      expect(writePeerMcpRuntimeFilesMock).toHaveBeenCalledTimes(1)
      const [serverUrl, opts] = writePeerMcpRuntimeFilesMock.mock.calls[0]
      expect(serverUrl).toBe("http://127.0.0.1:12345")
      expect(opts.codexCli).toBe(false)
      // Resolved group keys thread into the runtime-file builder so the
      // --mcp-config payload points at OUR scoped endpoints.
      expect(opts.groupKeys).toEqual({ peers: "peers", search: "search" })

      // injectPeerMcpIntoMirror is called with the same nonce as runtime files
      // so the proxy validates Authorization regardless of which channel the
      // request came through.
      expect(injectPeerMcpIntoMirrorMock).toHaveBeenCalledTimes(1)
      const [injectUrl, injectOpts] = injectPeerMcpIntoMirrorMock.mock.calls[0]
      expect(injectUrl).toBe("http://127.0.0.1:12345")
      expect(injectOpts.codexCli).toBe(false)
      expect(injectOpts.nonce).toBe("test-nonce")
      // Same resolved group keys thread into the mirror inject so the two
      // channels never drift.
      expect(injectOpts.groupKeys).toEqual({ peers: "peers", search: "search" })

      const [, args] = spawnMock.mock.calls[0]
      // Mirror inject succeeded → MCP is discovered from
      // <CLAUDE_CONFIG_DIR>/.claude.json (subagent-visible), so --mcp-config
      // is NOT pushed. Pushing both channels would register the same server
      // name twice (ambiguous across Claude Code versions).
      expect(args).not.toContain("--mcp-config")
      expect(args).not.toContain("--agents")
      expect(args).not.toContain("--strict-mcp-config")
    })

    test("user-side `peers` collision → our peers server registers as gh-router-peers (capability preserved, no drop)", async () => {
      // The user already has a `peers` MCP. resolveGroupKeysFromMirror
      // falls back to the prefixed `gh-router-peers` key for OUR peers
      // server rather than dropping the capability. The bare `search`
      // group is collision-free so it keeps the bare key. Mirror inject
      // STILL succeeds (the resolved keys are collision-free by
      // construction), so subagents stay visible and --mcp-config is NOT
      // pushed.
      resolveGroupKeysFromMirrorMock.mockResolvedValue({
        keys: { peers: "gh-router-peers", search: "search" },
        skipped: [],
      })
      injectPeerMcpIntoMirrorMock.mockResolvedValue({
        ok: true,
        serversAdded: ["gh-router-peers", "search"],
      })
      const run = getRunFn()
      await run({ args: {} })

      // The fallback key threads into BOTH wiring channels so every
      // reference points at OUR server, never the user's same-named one.
      const writeArgs = writePeerMcpRuntimeFilesMock.mock.calls[0][1]
      expect(writeArgs.groupKeys).toEqual({
        peers: "gh-router-peers",
        search: "search",
      })
      const injectArgs = injectPeerMcpIntoMirrorMock.mock.calls[0][1]
      expect(injectArgs.groupKeys).toEqual({
        peers: "gh-router-peers",
        search: "search",
      })

      const [, args] = spawnMock.mock.calls[0]
      // Inject succeeded (collision-free resolved keys) → subagent-visible,
      // so --mcp-config is NOT pushed.
      expect(args).not.toContain("--mcp-config")
    })

    test("mirror inject race refusal → --mcp-config IS pushed as fallback for parent-only visibility", async () => {
      // Distinct from the user-side-collision path above: here
      // resolveGroupKeysFromMirror handed back collision-free keys, but a
      // racing mirror mutation between resolution and write made the
      // inject refuse (ok:false). The parent session stays functional via
      // --mcp-config even though subagents won't see the peer tools.
      injectPeerMcpIntoMirrorMock.mockResolvedValue({
        ok: false,
        conflictingServers: ["peers"],
      })
      const run = getRunFn()
      await run({ args: {} })

      const [, args] = spawnMock.mock.calls[0]
      expect(args).toContain("--mcp-config")
      expect(args).toContain("/tmp/peer-mcp-test.json")
    })

    test("--no-codex-mcp → no MCP wiring, no mirror inject, no extra spawn args", async () => {
      const run = getRunFn()
      await run({ args: { "codex-mcp": false } })

      expect(writePeerMcpRuntimeFilesMock).not.toHaveBeenCalled()
      expect(injectPeerMcpIntoMirrorMock).not.toHaveBeenCalled()
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
      // Mirror inject also gets codexCli=true so the codex-cli stdio entry
      // lands in the mirrored mcpServers map alongside the scoped peers entry.
      const injectArgs = injectPeerMcpIntoMirrorMock.mock.calls[0][1]
      expect(injectArgs.codexCli).toBe(true)
    })

    test("--codex-mcp-only with mirror-inject success → no --strict-mcp-config, warns about ineffective flag", async () => {
      const run = getRunFn()
      await run({ args: { "codex-mcp-only": true } })

      const [, args] = spawnMock.mock.calls[0]
      // Mirror channel can't enforce strict-MCP-only (user's snapshot
      // MCPs are visible) — flag is downgraded to a warning, no
      // --strict-mcp-config push.
      expect(args).not.toContain("--strict-mcp-config")
      expect(args).not.toContain("--mcp-config")
    })

    test("--codex-mcp-only with collision fallback → --strict-mcp-config IS pushed alongside --mcp-config", async () => {
      injectPeerMcpIntoMirrorMock.mockResolvedValue({
        ok: false,
        conflictingServers: ["peers"],
      })
      const run = getRunFn()
      await run({ args: { "codex-mcp-only": true } })

      const [, args] = spawnMock.mock.calls[0]
      expect(args).toContain("--mcp-config")
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
      // Mirror inject was never attempted because runtime files failed first.
      expect(injectPeerMcpIntoMirrorMock).not.toHaveBeenCalled()
    })

    test("injectPeerMcpIntoMirror failure does not block claude launch", async () => {
      injectPeerMcpIntoMirrorMock.mockRejectedValue(new Error("permission denied"))
      const run = getRunFn()
      await run({ args: {} })

      // Whole codex-mcp block is wrapped in try/catch → spawn still happens.
      expect(spawnMock).toHaveBeenCalledTimes(1)
      const [, args] = spawnMock.mock.calls[0]
      expect(args).not.toContain("--mcp-config")
    })

    test("default env → --append-system-prompt is pushed AND both CLAUDE.md helpers are invoked", async () => {
      delete mockProcessEnv.GH_ROUTER_PEER_AWARENESS
      const run = getRunFn()
      await run({ args: {} })

      const [, args] = spawnMock.mock.calls[0]
      const idx = args.indexOf("--append-system-prompt")
      expect(idx).toBeGreaterThanOrEqual(0)
      const snippet = args[idx + 1] as string
      expect(snippet).toContain("Peer review and advisor")

      // The peer-MCP awareness append at the bottom of CLAUDE.md.
      expect(appendPeerAwarenessToMirroredClaudeMdMock).toHaveBeenCalledTimes(1)
      const [appendedSnippet] = appendPeerAwarenessToMirroredClaudeMdMock
        .mock.calls[0]
      expect(appendedSnippet).toBe(snippet)

      // The style-directive prepend at the top of CLAUDE.md.
      expect(prependStyleDirectiveToMirroredClaudeMdMock).toHaveBeenCalledTimes(1)
    })

    test("--append-system-prompt is pushed exactly once (no accidental double-injection)", async () => {
      delete mockProcessEnv.GH_ROUTER_PEER_AWARENESS
      const run = getRunFn()
      await run({ args: {} })

      const [, args] = spawnMock.mock.calls[0]
      const occurrences = (args as Array<string>).filter(
        (a) => a === "--append-system-prompt",
      ).length
      expect(occurrences).toBe(1)
    })

    test("GH_ROUTER_PEER_AWARENESS=0 is a no-op (flag was dropped) — --append-system-prompt still pushed", async () => {
      // Per peer-review #8 and the plan: the GH_ROUTER_PEER_AWARENESS
      // flag was removed; the snippet is now default-on across both
      // surfaces. Existing shell exports become silent no-ops. This
      // test guards against accidental re-introduction of the gate.
      mockProcessEnv.GH_ROUTER_PEER_AWARENESS = "0"
      try {
        const run = getRunFn()
        await run({ args: {} })
        const [, args] = spawnMock.mock.calls[0]
        expect(args).toContain("--append-system-prompt")
        expect(
          appendPeerAwarenessToMirroredClaudeMdMock,
        ).toHaveBeenCalledTimes(1)
      } finally {
        delete mockProcessEnv.GH_ROUTER_PEER_AWARENESS
      }
    })

    test("GH_ROUTER_PEER_AWARENESS='' (empty string) is also a no-op", async () => {
      // Edge case per peer-review S5 — empty-string opt-out parsing
      // was a common bug surface in the old flag. Verify the
      // post-deletion behaviour is uniform across falsy values.
      mockProcessEnv.GH_ROUTER_PEER_AWARENESS = ""
      try {
        const run = getRunFn()
        await run({ args: {} })
        const [, args] = spawnMock.mock.calls[0]
        expect(args).toContain("--append-system-prompt")
        expect(
          appendPeerAwarenessToMirroredClaudeMdMock,
        ).toHaveBeenCalledTimes(1)
      } finally {
        delete mockProcessEnv.GH_ROUTER_PEER_AWARENESS
      }
    })

    test("GH_ROUTER_PEER_AWARENESS=FALSE is also a no-op", async () => {
      mockProcessEnv.GH_ROUTER_PEER_AWARENESS = "FALSE"
      try {
        const run = getRunFn()
        await run({ args: {} })
        const [, args] = spawnMock.mock.calls[0]
        expect(args).toContain("--append-system-prompt")
        expect(
          appendPeerAwarenessToMirroredClaudeMdMock,
        ).toHaveBeenCalledTimes(1)
      } finally {
        delete mockProcessEnv.GH_ROUTER_PEER_AWARENESS
      }
    })

    test("CLAUDE.md append failure does not block claude launch (warn-and-continue)", async () => {
      // Descendant-reach is enhancement, not a launch-blocker. The
      // main agent still has --append-system-prompt, so a CLAUDE.md
      // write failure should not surface as an error to the user.
      appendPeerAwarenessToMirroredClaudeMdMock.mockRejectedValue(
        new Error("disk full"),
      )
      const run = getRunFn()
      await run({ args: {} })

      expect(spawnMock).toHaveBeenCalledTimes(1)
      const [, args] = spawnMock.mock.calls[0]
      // --append-system-prompt was still pushed for the main agent.
      expect(args).toContain("--append-system-prompt")
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
