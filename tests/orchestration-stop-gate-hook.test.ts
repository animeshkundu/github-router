/**
 * Tests for the Stop-gate launch glue (`runStopGateForLaunch`). The sealed gate +
 * diff + exec are injected, so this runs in CI with fake exec (no real
 * subprocess). Verifies: a red gate blocks, a gate-weakening diff blocks, a clean
 * pass does not block, and a misconfigured (unknown) gate FAILS OPEN (never wedges
 * the session).
 */

import { describe, expect, test } from "bun:test"

import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { type ExecFn } from "../src/lib/orchestration/gate-runner"
import {
  type BlockBudget,
  buildStopHookCommand,
  buildStopHookSettings,
  decideStopHook,
  fileBlockBudget,
  injectStopHookIntoSettingsFile,
  mergeStopHookIntoSettings,
  runStopGateForLaunch,
  stopGateEnabled,
  stopGateId,
} from "../src/lib/orchestration/stop-gate-hook"

/** An in-memory block budget for the decision tests. */
function memBudget(): { state: { blocks: number }; budget: BlockBudget } {
  const state = { blocks: 0 }
  return {
    state,
    budget: { count: async () => state.blocks, record: async () => { state.blocks += 1 } },
  }
}

const allPass: ExecFn = async () => ({ exitCode: 0 })
const allFail: ExecFn = async () => ({ exitCode: 1 })

describe("runStopGateForLaunch", () => {
  test("a clean pass with no gate-weakening does not block", async () => {
    const r = await runStopGateForLaunch({ workspace: "/w", gateId: "typecheck-only", exec: allPass, diff: "+ const x = 1" })
    expect(r.block).toBe(false)
    expect(r.failedChecks).toEqual([])
  })

  test("a red gate blocks and names the failing check", async () => {
    const r = await runStopGateForLaunch({ workspace: "/w", gateId: "typecheck-only", exec: allFail, diff: "" })
    expect(r.block).toBe(true)
    expect(r.failedChecks).toContain("typecheck")
  })

  test("a gate-weakening diff blocks even when the gates pass", async () => {
    const r = await runStopGateForLaunch({
      workspace: "/w",
      gateId: "default-ci",
      exec: allPass,
      diff: "+  it.skip('important', () => {})\n+  const y = z as any",
    })
    expect(r.block).toBe(true)
    expect(r.weakening.length).toBeGreaterThan(0)
  })

  test("an unknown gateId FAILS OPEN (never wedges the session)", async () => {
    const r = await runStopGateForLaunch({ workspace: "/w", gateId: "nope", exec: allFail, diff: "" })
    expect(r.block).toBe(false)
    expect(r.reason).toMatch(/unknown gateId/)
  })
})

describe("stop-gate opt-in flag + gate id", () => {
  test("default-OFF; enabled only by an explicit truthy flag", () => {
    expect(stopGateEnabled({})).toBe(false)
    expect(stopGateEnabled({ GH_ROUTER_ENABLE_STOP_GATE: "0" })).toBe(false)
    expect(stopGateEnabled({ GH_ROUTER_ENABLE_STOP_GATE: "1" })).toBe(true)
    expect(stopGateEnabled({ GH_ROUTER_ENABLE_STOP_GATE: "true" })).toBe(true)
  })

  test("gate id defaults to default-ci, overridable", () => {
    expect(stopGateId({})).toBe("default-ci")
    expect(stopGateId({ GH_ROUTER_STOP_GATE_ID: "typecheck-only" })).toBe("typecheck-only")
  })
})

describe("settings config generation", () => {
  test("buildStopHookSettings produces the Claude Code Stop hook shape", () => {
    const s = buildStopHookSettings("gh-router internal-stop-hook")
    expect(s.hooks.Stop[0]!.hooks[0]).toEqual({ type: "command", command: "gh-router internal-stop-hook" })
  })

  test("merge preserves other hook events and other Stop entries", () => {
    const existing = {
      model: "opus",
      hooks: { PreToolUse: [{ matcher: "Bash" }], Stop: [{ hooks: [{ type: "command", command: "other" }] }] },
    }
    const merged = mergeStopHookIntoSettings(existing, "gh-stop") as { model: string; hooks: { PreToolUse: unknown[]; Stop: unknown[] } }
    expect(merged.model).toBe("opus")
    expect(merged.hooks.PreToolUse).toEqual([{ matcher: "Bash" }])
    expect(merged.hooks.Stop.length).toBe(2)
  })

  test("merge is idempotent (re-launch does not duplicate the hook)", () => {
    const once = mergeStopHookIntoSettings({}, "gh-stop")
    const twice = mergeStopHookIntoSettings(once, "gh-stop")
    expect((twice.hooks as { Stop: unknown[] }).Stop.length).toBe(1)
  })

  test("merge does not mutate the input object", () => {
    const input = { hooks: { Stop: [] as unknown[] } }
    const out = mergeStopHookIntoSettings(input, "gh-stop")
    expect(input.hooks.Stop.length).toBe(0)
    expect((out.hooks as { Stop: unknown[] }).Stop.length).toBe(1)
  })
})

describe("decideStopHook (subcommand decision)", () => {
  const allPass: ExecFn = async () => ({ exitCode: 0 })
  const allFail: ExecFn = async () => ({ exitCode: 1 })
  const noDiff = async () => ""
  const base = { gateId: "typecheck-only", captureDiff: noDiff, fallbackCwd: "/fallback" }

  test("a red gate on the first stop blocks (exit 2 + stderr) and records the block", async () => {
    const { state, budget } = memBudget()
    const d = await decideStopHook({
      ...base,
      stdin: JSON.stringify({ cwd: "/w", session_id: "s1", stop_hook_active: false }),
      exec: allFail,
      budget,
    })
    expect(d.exitCode).toBe(2)
    expect(d.stderr).toMatch(/structural gate failed/)
    expect(state.blocks).toBe(1)
  })

  test("a clean gate allows the stop (exit 0)", async () => {
    const { budget } = memBudget()
    const d = await decideStopHook({
      ...base,
      stdin: JSON.stringify({ cwd: "/w", session_id: "s1", stop_hook_active: false }),
      exec: allPass,
      budget,
    })
    expect(d.exitCode).toBe(0)
  })

  test("the stop_hook_active signal STANDS DOWN even when the gate is red", async () => {
    const { budget } = memBudget()
    const d = await decideStopHook({
      ...base,
      stdin: JSON.stringify({ cwd: "/w", session_id: "s1", stop_hook_active: true }),
      exec: allFail,
      budget,
    })
    expect(d.exitCode).toBe(0)
  })

  test("the HARD per-session budget bounds the loop: blocks maxBlocks times, then allows", async () => {
    const { budget } = memBudget()
    const call = () =>
      decideStopHook({
        ...base,
        stdin: JSON.stringify({ cwd: "/w", session_id: "s1", stop_hook_active: false }),
        exec: allFail, // always red
        budget,
        maxBlocks: 2,
      })
    expect((await call()).exitCode).toBe(2)
    expect((await call()).exitCode).toBe(2)
    expect((await call()).exitCode).toBe(0) // budget exhausted -> stand down, never wedge
    expect((await call()).exitCode).toBe(0)
  })

  test("no session_id -> fail OPEN (cannot budget-track)", async () => {
    const { budget } = memBudget()
    const d = await decideStopHook({
      ...base,
      stdin: JSON.stringify({ cwd: "/w", stop_hook_active: false }),
      exec: allFail,
      budget,
    })
    expect(d.exitCode).toBe(0)
  })

  test("a budget IO failure -> fail OPEN (cannot guarantee termination)", async () => {
    const badBudget: BlockBudget = { count: async () => { throw new Error("io") }, record: async () => {} }
    const d = await decideStopHook({
      ...base,
      stdin: JSON.stringify({ cwd: "/w", session_id: "s1", stop_hook_active: false }),
      exec: allFail,
      budget: badBudget,
    })
    expect(d.exitCode).toBe(0)
  })

  test("a hung gate evaluation hits the absolute timeout and FAILS OPEN (never wedges)", async () => {
    const { budget } = memBudget()
    const hangingExec: ExecFn = () => new Promise(() => {}) // never resolves
    const d = await decideStopHook({
      ...base,
      stdin: JSON.stringify({ cwd: "/w", session_id: "s1", stop_hook_active: false }),
      exec: hangingExec,
      budget,
      timeoutMs: 50, // tiny so the test is fast
    })
    expect(d.exitCode).toBe(0)
  })

  test("malformed stdin is tolerated -> fail OPEN", async () => {
    const { budget } = memBudget()
    const d = await decideStopHook({ ...base, stdin: "not json", exec: allFail, budget })
    expect(d.exitCode).toBe(0)
  })
})

describe("fileBlockBudget", () => {
  test("count starts at 0 and record increments persistently", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "ghr-budget-"))
    const b = fileBlockBudget(dir)
    expect(await b.count("sess-A")).toBe(0)
    await b.record("sess-A")
    await b.record("sess-A")
    expect(await b.count("sess-A")).toBe(2)
    expect(await b.count("sess-B")).toBe(0) // independent per session
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe("buildStopHookCommand", () => {
  test("uses binary + script when both present and distinct", () => {
    expect(buildStopHookCommand("/usr/bin/node", "/app/main.js")).toBe('"/usr/bin/node" "/app/main.js" internal-stop-hook')
  })
  test("uses just the binary when the script is absent or equals it", () => {
    expect(buildStopHookCommand("/app/ghr", undefined)).toBe('"/app/ghr" internal-stop-hook')
    expect(buildStopHookCommand("/app/ghr", "/app/ghr")).toBe('"/app/ghr" internal-stop-hook')
  })
})

describe("injectStopHookIntoSettingsFile", () => {
  test("creates the file when missing and writes the Stop hook", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "ghr-stopgate-"))
    const file = path.join(dir, "settings.json")
    await injectStopHookIntoSettingsFile(file, "gh-stop")
    const read = JSON.parse(await fs.readFile(file, "utf8")) as { hooks: { Stop: unknown[] } }
    expect(read.hooks.Stop.length).toBe(1)
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("preserves existing settings and is idempotent across re-launches", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "ghr-stopgate-"))
    const file = path.join(dir, "settings.json")
    await fs.writeFile(file, JSON.stringify({ model: "opus", hooks: { PreToolUse: [{ matcher: "Bash" }] } }))
    await injectStopHookIntoSettingsFile(file, "gh-stop")
    await injectStopHookIntoSettingsFile(file, "gh-stop")
    const read = JSON.parse(await fs.readFile(file, "utf8")) as {
      model: string
      hooks: { PreToolUse: unknown[]; Stop: unknown[] }
    }
    expect(read.model).toBe("opus")
    expect(read.hooks.PreToolUse.length).toBe(1)
    expect(read.hooks.Stop.length).toBe(1) // not duplicated
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("refuses to overwrite a settings file it cannot parse (preserves user content)", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "ghr-stopgate-"))
    const file = path.join(dir, "settings.json")
    await fs.writeFile(file, "{ this is not valid json")
    await expect(injectStopHookIntoSettingsFile(file, "gh-stop")).rejects.toThrow()
    // the original content is untouched (no clobber).
    expect(await fs.readFile(file, "utf8")).toBe("{ this is not valid json")
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("refuses to overwrite a settings file that is a JSON array, not an object", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "ghr-stopgate-"))
    const file = path.join(dir, "settings.json")
    await fs.writeFile(file, "[1,2,3]")
    await expect(injectStopHookIntoSettingsFile(file, "gh-stop")).rejects.toThrow()
    await fs.rm(dir, { recursive: true, force: true })
  })
})
