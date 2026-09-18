/**
 * Tests for the `github-router index` command (Phase 4a).
 *
 * Colbert leaves (provision/runner/index-store/lifecycle) + consola are
 * mocked; `validateWorkspace` (pure) and `PATHS` (no import side effects)
 * stay real. process.exitCode is saved/restored per test (the command
 * signals via exitCode, never process.exit(), per repo convention).
 *
 * Isolated (own process): the module mocks are process-global.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const provisionColbertMock = mock(async () => ({ status: "ready" as const }))
const kickBackgroundInitMock = mock((_workspace: string) => {})
const waitForInitMock = mock(async (_workspace: string) => {})
const registerExitHandlersMock = mock(() => {})

// Scripted freshness sequence (shifted per call).
let freshnessScript: Array<{ verdict: string }> = []
const freshnessMock = mock(async (_workspace: string) => {
  const next = freshnessScript.shift()
  return { verdict: next?.verdict ?? "fresh", meta: null as unknown as null }
})
const consolaInfoMock = mock((..._args: Array<unknown>) => {})
const consolaWarnMock = mock((..._args: Array<unknown>) => {})
const consolaErrorMock = mock((..._args: Array<unknown>) => {})
const consolaSuccessMock = mock((..._args: Array<unknown>) => {})
const consolaDebugMock = mock((..._args: Array<unknown>) => {})

mock.module("~/lib/colbert/provision", () => ({
  provisionColbert: provisionColbertMock,
}))

mock.module("~/lib/colbert/runner", () => ({
  kickBackgroundInit: kickBackgroundInitMock,
  waitForInit: waitForInitMock,
}))

mock.module("~/lib/colbert/lifecycle", () => ({
  registerColbertExitHandlers: registerExitHandlersMock,
}))

mock.module("~/lib/colbert/index-store", () => ({
  freshnessVerdict: freshnessMock,
  colbertProjectDir: async () => null,
  completedIndexOnDisk: async () => false,
  indexDirSignature: () => ({ kind: "not-created" as const }),
  readColbertMeta: async () => null,
  validateIndexIntegrity: () => ({ verdict: "not-built" as const }),
}))

mock.module("consola", () => ({
  default: {
    info: consolaInfoMock,
    warn: consolaWarnMock,
    error: consolaErrorMock,
    success: consolaSuccessMock,
    debug: consolaDebugMock,
  },
}))

type IndexCmd = typeof import("../../src/index-cmd").indexCmd
let indexCmd: IndexCmd

let root: string

beforeAll(async () => {
  ;({ indexCmd } = await import("../../src/index-cmd"))
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gh-router-index-cmd-")))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  // NOTE: `process.exitCode = undefined` does NOT reset under Bun (stays
  // stuck); use explicit 0 as the clean state and normalize on read.
  process.exitCode = 0
  freshnessScript = []
  for (const m of [
    provisionColbertMock,
    kickBackgroundInitMock,
    waitForInitMock,
    registerExitHandlersMock,
    freshnessMock,
    consolaInfoMock,
    consolaWarnMock,
    consolaErrorMock,
    consolaSuccessMock,
    consolaDebugMock,
  ]) {
    m.mockClear()
  }
  delete process.env.GH_ROUTER_DISABLE_SEMANTIC_SEARCH
  delete process.env.GH_ROUTER_COLBERT_PARALLEL
})

afterEach(() => {
  process.exitCode = 0
  delete process.env.GH_ROUTER_DISABLE_SEMANTIC_SEARCH
  delete process.env.GH_ROUTER_COLBERT_PARALLEL
})

/** Normalized exit code (undefined and 0 both mean success). */
function exitCode(): number {
  return typeof process.exitCode === "number" ? process.exitCode : 0
}

async function run(args: Record<string, unknown>): Promise<void> {
  await (indexCmd.run as (ctx: { args: Record<string, unknown> }) => Promise<void>)({ args })
}

describe("github-router index", () => {
  test("--status prints without provisioning or kicking", async () => {
    freshnessScript = [{ verdict: "absent" }]
    await run({ workspace: root, status: true })
    expect(exitCode()).toBe(0)
    expect(provisionColbertMock).toHaveBeenCalledTimes(0)
    expect(kickBackgroundInitMock).toHaveBeenCalledTimes(0)
    expect(consolaInfoMock.mock.calls.some((c) => String(c[0]).includes("verdict"))).toBe(true)
  })

  test("relative workspace → exit 2, no side effects", async () => {
    await run({ workspace: "relative/path" })
    expect(process.exitCode).toBe(2)
    expect(provisionColbertMock).toHaveBeenCalledTimes(0)
  })

  test("hard-disabled → exit 2 before provisioning", async () => {
    process.env.GH_ROUTER_DISABLE_SEMANTIC_SEARCH = "1"
    await run({ workspace: root })
    expect(process.exitCode).toBe(2)
    expect(provisionColbertMock).toHaveBeenCalledTimes(0)
  })

  test("already fresh → success, no kick", async () => {
    freshnessScript = [{ verdict: "fresh" }]
    await run({ workspace: root })
    expect(exitCode()).toBe(0)
    expect(provisionColbertMock).toHaveBeenCalledTimes(1)
    expect(kickBackgroundInitMock).toHaveBeenCalledTimes(0)
    expect(consolaSuccessMock.mock.calls.some((c) => String(c[0]).includes("already fresh"))).toBe(true)
  })

  test("building → fresh: kicks once, waits, reports ready", async () => {
    freshnessScript = [{ verdict: "building" }, { verdict: "fresh" }]
    await run({ workspace: root })
    expect(exitCode()).toBe(0)
    expect(kickBackgroundInitMock).toHaveBeenCalledTimes(1)
    expect(kickBackgroundInitMock).toHaveBeenCalledWith(root)
    expect(waitForInitMock).toHaveBeenCalledWith(root)
    expect(consolaSuccessMock.mock.calls.some((c) => String(c[0]).includes("ready"))).toBe(true)
  })

  test("failed build → exit 1", async () => {
    freshnessScript = [{ verdict: "building" }, { verdict: "failed" }]
    await run({ workspace: root })
    expect(process.exitCode).toBe(1)
    expect(consolaErrorMock.mock.calls.some((c) => String(c[0]).includes("failed"))).toBe(true)
  })

  test("provision failure → exit 1", async () => {
    provisionColbertMock.mockResolvedValueOnce({ status: "incomplete", reason: "no network" } as never)
    await run({ workspace: root })
    expect(process.exitCode).toBe(1)
    expect(kickBackgroundInitMock).toHaveBeenCalledTimes(0)
  })

  test("foreground build defaults parallelism to core count (overridable)", async () => {
    freshnessScript = [{ verdict: "fresh" }]
    await run({ workspace: root })
    const cpus = (await import("node:os")).cpus().length
    expect(process.env.GH_ROUTER_COLBERT_PARALLEL).toBe(String(cpus))
  })

  test("explicit GH_ROUTER_COLBERT_PARALLEL is respected", async () => {
    process.env.GH_ROUTER_COLBERT_PARALLEL = "2"
    freshnessScript = [{ verdict: "fresh" }]
    await run({ workspace: root })
    expect(process.env.GH_ROUTER_COLBERT_PARALLEL).toBe("2")
  })
})
