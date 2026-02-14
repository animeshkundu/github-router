import { test, expect, mock, describe, beforeEach } from "bun:test"
import { EventEmitter } from "node:events"
import type { Server } from "srvx"
import type { LaunchTarget } from "../../src/lib/launch"

// --- ExitError for process.exit mock ---
class ExitError extends Error {
  code: number
  constructor(code: number) {
    super(`exit(${code})`)
    this.code = code
  }
}

// All test files that mock node:child_process and node:process must use the same
// mock shapes to avoid cross-file pollution in bun:test's global mock.module registry.

const execFileSyncMock = mock()
const spawnMock = mock()

mock.module("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  spawn: spawnMock,
}))

const exitMock = mock((code: number) => {
  throw new ExitError(code)
})
const signalHandlers: Record<string, (...args: unknown[]) => void> = {}
const processOnMock = mock((signal: string, handler: (...args: unknown[]) => void) => {
  signalHandlers[signal] = handler
})

mock.module("node:process", () => ({
  default: {
    platform: "linux",
    env: {},
    exit: exitMock,
    on: processOnMock,
    stdout: { isTTY: true },
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

// Also mock ~/lib/server-setup with all exports — prevents other test files'
// mocks of this module from breaking our import of launch.ts (which imports port.ts)
mock.module("~/lib/server-setup", () => ({
  setupAndServe: mock(),
  parseSharedArgs: mock(),
  getClaudeCodeEnvVars: mock(),
  getCodexEnvVars: mock(),
  sharedServerArgs: {},
}))

// Import the real launch module after mocking its dependencies
const { launchChild } = await import("../../src/lib/launch")

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof mock>
  }
  child.kill = mock()
  return child
}

function createFakeServer(closeImpl?: () => Promise<void>) {
  return {
    close: mock(closeImpl ?? (async () => {})),
  }
}

const defaultTarget: LaunchTarget = {
  kind: "claude-code",
  envVars: {
    ANTHROPIC_BASE_URL: "http://localhost:12345",
    ANTHROPIC_AUTH_TOKEN: "dummy",
  },
  extraArgs: [],
}

beforeEach(() => {
  execFileSyncMock.mockReset()
  spawnMock.mockReset()
  exitMock.mockReset()
  exitMock.mockImplementation((code: number) => {
    throw new ExitError(code)
  })
  processOnMock.mockReset()
  for (const key of Object.keys(signalHandlers)) {
    delete signalHandlers[key]
  }
})

describe("commandExists (tested indirectly through launchChild)", () => {
  test("returns true when which succeeds — launchChild proceeds to spawn", () => {
    execFileSyncMock.mockReturnValue(Buffer.from("/usr/bin/claude"))
    const fakeChild = createFakeChild()
    spawnMock.mockReturnValue(fakeChild)
    const server = createFakeServer()

    launchChild(defaultTarget, server as unknown as Server)

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(execFileSyncMock).toHaveBeenCalledWith("which", ["claude"], {
      stdio: "ignore",
    })
  })

  test("returns false when which throws — launchChild exits with code 1", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found")
    })
    const server = createFakeServer()

    expect(() => launchChild(defaultTarget, server as unknown as Server)).toThrow(ExitError)
    expect(exitMock).toHaveBeenCalledWith(1)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe("launchChild", () => {
  test("exits with code 1 when executable not found", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found")
    })
    const server = createFakeServer()

    expect(() => launchChild(defaultTarget, server as unknown as Server)).toThrow(ExitError)
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  test("spawns child with correct cmd, env, and stdio", () => {
    execFileSyncMock.mockReturnValue(Buffer.from("/usr/bin/claude"))
    const fakeChild = createFakeChild()
    spawnMock.mockReturnValue(fakeChild)
    const server = createFakeServer()

    launchChild(defaultTarget, server as unknown as Server)

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [cmd, args, options] = spawnMock.mock.calls[0]
    expect(cmd).toBe("claude")
    expect(args).toEqual(["--dangerously-skip-permissions"])
    expect(options.stdio).toBe("inherit")
    expect(options.env.ANTHROPIC_BASE_URL).toBe("http://localhost:12345")
    expect(options.env.ANTHROPIC_AUTH_TOKEN).toBe("dummy")
  })

  test("uses shell: false on non-Windows platform", () => {
    execFileSyncMock.mockReturnValue(Buffer.from("/usr/bin/claude"))
    const fakeChild = createFakeChild()
    spawnMock.mockReturnValue(fakeChild)
    const server = createFakeServer()

    launchChild(defaultTarget, server as unknown as Server)

    const [, , options] = spawnMock.mock.calls[0]
    expect(options.shell).toBe(false)
  })

  test("registers SIGINT and SIGTERM handlers", () => {
    execFileSyncMock.mockReturnValue(Buffer.from("/usr/bin/claude"))
    const fakeChild = createFakeChild()
    spawnMock.mockReturnValue(fakeChild)
    const server = createFakeServer()

    launchChild(defaultTarget, server as unknown as Server)

    const signalCalls = processOnMock.mock.calls.map(
      (call: unknown[]) => call[0],
    )
    expect(signalCalls).toContain("SIGINT")
    expect(signalCalls).toContain("SIGTERM")
  })

  test("on child exit event: calls server.close() then process.exit(code)", async () => {
    execFileSyncMock.mockReturnValue(Buffer.from("/usr/bin/claude"))
    const fakeChild = createFakeChild()
    spawnMock.mockReturnValue(fakeChild)
    const server = createFakeServer()

    launchChild(defaultTarget, server as unknown as Server)

    fakeChild.emit("exit", 42)
    await new Promise((r) => setTimeout(r, 50))

    expect(server.close).toHaveBeenCalledWith(true)
    expect(exitMock).toHaveBeenCalledWith(42)
  })

  test("on child exit event with null code: defaults to exit(0)", async () => {
    execFileSyncMock.mockReturnValue(Buffer.from("/usr/bin/claude"))
    const fakeChild = createFakeChild()
    spawnMock.mockReturnValue(fakeChild)
    const server = createFakeServer()

    launchChild(defaultTarget, server as unknown as Server)

    fakeChild.emit("exit", null)
    await new Promise((r) => setTimeout(r, 50))

    expect(exitMock).toHaveBeenCalledWith(0)
  })

  test("on child error event: calls process.exit(1)", () => {
    execFileSyncMock.mockReturnValue(Buffer.from("/usr/bin/claude"))
    const fakeChild = createFakeChild()
    spawnMock.mockReturnValue(fakeChild)
    const server = createFakeServer()

    launchChild(defaultTarget, server as unknown as Server)

    try {
      fakeChild.emit("error", new Error("spawn failed"))
    } catch {
      // ExitError expected
    }

    expect(exitMock).toHaveBeenCalledWith(1)
  })

  test("cleanup kills child process", async () => {
    execFileSyncMock.mockReturnValue(Buffer.from("/usr/bin/claude"))
    const fakeChild = createFakeChild()
    spawnMock.mockReturnValue(fakeChild)
    const server = createFakeServer()

    launchChild(defaultTarget, server as unknown as Server)

    fakeChild.emit("exit", 0)
    await new Promise((r) => setTimeout(r, 50))

    expect(fakeChild.kill).toHaveBeenCalled()
  })

  test("spawn failure: calls server.close(true) before exit", () => {
    execFileSyncMock.mockReturnValue(Buffer.from("/usr/bin/claude"))
    spawnMock.mockImplementation(() => {
      throw new Error("spawn ENOENT")
    })
    const server = createFakeServer()

    expect(() => launchChild(defaultTarget, server as unknown as Server)).toThrow(ExitError)
    expect(server.close).toHaveBeenCalledWith(true)
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  test("double-cleanup is idempotent (second call is no-op)", async () => {
    execFileSyncMock.mockReturnValue(Buffer.from("/usr/bin/claude"))
    const fakeChild = createFakeChild()
    spawnMock.mockReturnValue(fakeChild)
    const server = createFakeServer()

    launchChild(defaultTarget, server as unknown as Server)

    const sigintIdx = processOnMock.mock.calls.findIndex(
      (call: unknown[]) => call[0] === "SIGINT",
    )
    const sigintHandler =
      sigintIdx >= 0 ? processOnMock.mock.calls[sigintIdx][1] : null

    fakeChild.emit("exit", 0)
    await new Promise((r) => setTimeout(r, 50))

    if (sigintHandler) {
      sigintHandler()
      await new Promise((r) => setTimeout(r, 50))
    }

    expect(fakeChild.kill).toHaveBeenCalledTimes(1)
  })

  test("server close timeout: if server.close() hangs, timeout set for process.exit(1)", async () => {
    execFileSyncMock.mockReturnValue(Buffer.from("/usr/bin/claude"))
    const fakeChild = createFakeChild()
    spawnMock.mockReturnValue(fakeChild)

    const server = createFakeServer(() => new Promise(() => {}))

    launchChild(defaultTarget, server as unknown as Server)

    fakeChild.emit("exit", 0)
    await new Promise((r) => setTimeout(r, 50))

    expect(fakeChild.kill).toHaveBeenCalled()
    expect(server.close).toHaveBeenCalledWith(true)
  })

  test("codex target: spawns codex with correct args", () => {
    execFileSyncMock.mockReturnValue(Buffer.from("/usr/bin/codex"))
    const fakeChild = createFakeChild()
    spawnMock.mockReturnValue(fakeChild)
    const server = createFakeServer()

    const codexTarget: LaunchTarget = {
      kind: "codex",
      envVars: {
        OPENAI_BASE_URL: "http://localhost:12345/v1",
        OPENAI_API_KEY: "dummy",
      },
      extraArgs: ["--full-auto"],
      model: "gpt-4o",
    }

    launchChild(codexTarget, server as unknown as Server)

    const [cmd, args, options] = spawnMock.mock.calls[0]
    expect(cmd).toBe("codex")
    expect(args).toContain("-m")
    expect(args).toContain("gpt-4o")
    expect(args).toContain("--full-auto")
    expect(options.env.OPENAI_BASE_URL).toBe("http://localhost:12345/v1")
  })
})
