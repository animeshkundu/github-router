/**
 * Tests for the Stop-gate launch glue and Stop-hook decision. These tests treat
 * the Stop hook as security-critical: by default it must fail open, must never
 * run repo code without consent, must scope itself to the top-level session, and
 * must bound repeated blocks with a hard per-prompt budget.
 */

import { describe, expect, mock, test } from "bun:test"

import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { type ExecFn } from "../src/lib/orchestration/gate-runner"
import {
  type BlockBudget,
  buildStopHookCommand,
  buildStopHookSettings,
  captureLaunchBaseline,
  decideStopHook,
  fileBlockBudget,
  injectStopHookIntoSettingsFile,
  launchBaselineKey,
  mergeStopHookIntoSettings,
  runStopGateForLaunch,
  stopGateEnabled,
  stopGateId,
} from "../src/lib/orchestration/stop-gate-hook"
import { fileBaselineStore, type BaselineStore } from "../src/lib/orchestration/stop-gate-policy"

type StopHookInput = Parameters<typeof decideStopHook>[0]

/** An in-memory block budget for decision tests. */
function memBudget(): { counts: Map<string, number>; budget: BlockBudget } {
  const counts = new Map<string, number>()
  return {
    counts,
    budget: {
      count: async (sid) => counts.get(sid) ?? 0,
      record: async (sid) => { counts.set(sid, (counts.get(sid) ?? 0) + 1) },
      reset: async (sid) => { counts.delete(sid) },
    },
  }
}

function mockedBudget(countImpl: (sessionId: string) => Promise<number> = async () => 0): {
  budget: BlockBudget
  count: ReturnType<typeof mock<(sessionId: string) => Promise<number>>>
  record: ReturnType<typeof mock<(sessionId: string) => Promise<void>>>
  reset: ReturnType<typeof mock<(sessionId: string) => Promise<void>>>
} {
  const count = mock(countImpl)
  const record = mock(async (_sessionId: string) => {})
  const reset = mock(async (_sessionId: string) => {})
  return { budget: { count, record, reset }, count, record, reset }
}

/** An in-memory baseline store; omitted sessions return null (first eval). */
function memBaseline(initial: Record<string, string[]> = {}): { state: Map<string, string[]>; baseline: BaselineStore } {
  const state = new Map<string, string[]>(Object.entries(initial))
  return {
    state,
    baseline: {
      get: async (sid) => (state.has(sid) ? new Set(state.get(sid)!) : null),
      set: async (sid, failed) => { state.set(sid, [...failed]) },
    },
  }
}

function singleSlotBaseline(initial: string[] = []): BaselineStore {
  let slot: string[] | null = initial
  return {
    get: async () => (slot === null ? null : new Set(slot)),
    set: async (_sid, failed) => { slot = [...failed] },
  }
}

function baselineKey(sessionId: string, cwd: string, gateId: string): string {
  return JSON.stringify([sessionId, cwd, gateId])
}

function decisionInput(overrides: Partial<StopHookInput> = {}): StopHookInput {
  const { budget } = memBudget()
  // Default to an already-recorded empty baseline so a red typecheck-only gate is
  // a regression. Tests for first-eval isolation override this with memBaseline().
  const baseline = singleSlotBaseline([])
  return {
    stdin: JSON.stringify({ cwd: "/w", session_id: "s1" }),
    gateId: "typecheck-only",
    exec: async () => ({ exitCode: 0 }),
    captureDiff: async () => "",
    fallbackCwd: "/fallback",
    budget,
    baseline,
    isEnabledForRepo: async () => true,
    ...overrides,
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

  test("matcher writes a PostToolUse(ExitPlanMode) entry, idempotent", () => {
    const once = mergeStopHookIntoSettings({}, "gh-router internal-artifact-open", "PostToolUse", undefined, "ExitPlanMode")
    const entries = (once.hooks as { PostToolUse: Array<{ matcher: string; hooks: unknown[] }> }).PostToolUse
    expect(entries[0]!.matcher).toBe("ExitPlanMode")
    expect(entries[0]!.hooks[0]).toEqual({ type: "command", command: "gh-router internal-artifact-open" })
    const twice = mergeStopHookIntoSettings(once, "gh-router internal-artifact-open", "PostToolUse", undefined, "ExitPlanMode")
    expect((twice.hooks as { PostToolUse: unknown[] }).PostToolUse.length).toBe(1)
  })

  test("merge does not mutate the input object", () => {
    const input = { hooks: { Stop: [] as unknown[] } }
    const out = mergeStopHookIntoSettings(input, "gh-stop")
    expect(input.hooks.Stop.length).toBe(0)
    expect((out.hooks as { Stop: unknown[] }).Stop.length).toBe(1)
  })
})

describe("decideStopHook (subcommand decision)", () => {
  test("malformed or non-object stdin is tolerated -> fail OPEN without consent or gate execution", async () => {
    for (const stdin of ["not json", "42"]) {
      const exec = mock(async () => ({ exitCode: 1 }))
      const captureDiff = mock(async (_cwd: string) => "")
      const isEnabledForRepo = mock(async (_cwd: string) => true)
      const d = await decideStopHook(decisionInput({ stdin, exec, captureDiff, isEnabledForRepo }))
      expect(d.exitCode).toBe(0)
      expect(isEnabledForRepo.mock.calls.length).toBe(0)
      expect(captureDiff.mock.calls.length).toBe(0)
      expect(exec.mock.calls.length).toBe(0)
    }
  })

  test("subagent agent_type or agent_id stands down before consent and never runs the gate", async () => {
    for (const agentFields of [{ agent_type: "Explore" }, { agent_id: "a1" }]) {
      const exec = mock(async () => ({ exitCode: 1 }))
      const captureDiff = mock(async (_cwd: string) => "")
      const isEnabledForRepo = mock(async (_cwd: string) => true)
      const d = await decideStopHook(decisionInput({
        stdin: JSON.stringify({ cwd: "/w", session_id: "s1", ...agentFields }),
        exec,
        captureDiff,
        isEnabledForRepo,
      }))
      expect(d.exitCode).toBe(0)
      expect(isEnabledForRepo.mock.calls.length).toBe(0)
      expect(captureDiff.mock.calls.length).toBe(0)
      expect(exec.mock.calls.length).toBe(0)
    }
  })

  test("empty-string or numeric agent_type is a subagent stand-down and is not evaluated", async () => {
    for (const agent_type of ["", 123]) {
      const exec = mock(async () => ({ exitCode: 1 }))
      const captureDiff = mock(async (_cwd: string) => "")
      const isEnabledForRepo = mock(async (_cwd: string) => true)
      const d = await decideStopHook(decisionInput({
        stdin: JSON.stringify({ cwd: "/w", session_id: "s1", agent_type }),
        exec,
        captureDiff,
        isEnabledForRepo,
      }))
      expect(d.exitCode).toBe(0)
      expect(isEnabledForRepo.mock.calls.length).toBe(0)
      expect(captureDiff.mock.calls.length).toBe(0)
      expect(exec.mock.calls.length).toBe(0)
    }
  })

  test("missing or empty session_id fails open before consent and gate execution", async () => {
    for (const payload of [{ cwd: "/w" }, { cwd: "/w", session_id: "" }]) {
      const exec = mock(async () => ({ exitCode: 1 }))
      const captureDiff = mock(async (_cwd: string) => "")
      const isEnabledForRepo = mock(async (_cwd: string) => true)
      const d = await decideStopHook(decisionInput({ stdin: JSON.stringify(payload), exec, captureDiff, isEnabledForRepo }))
      expect(d.exitCode).toBe(0)
      expect(isEnabledForRepo.mock.calls.length).toBe(0)
      expect(captureDiff.mock.calls.length).toBe(0)
      expect(exec.mock.calls.length).toBe(0)
    }
  })

  test("consent false stands down, uses payload cwd, and never counts budget or runs repo code", async () => {
    const exec = mock(async () => ({ exitCode: 1 }))
    const captureDiff = mock(async (_cwd: string) => "")
    const isEnabledForRepo = mock(async (_cwd: string) => false)
    const { budget, count, record } = mockedBudget()
    const d = await decideStopHook(decisionInput({
      stdin: JSON.stringify({ cwd: "/payload", session_id: "s1" }),
      exec,
      captureDiff,
      isEnabledForRepo,
      budget,
      fallbackCwd: "/fallback",
    }))
    expect(d.exitCode).toBe(0)
    expect(isEnabledForRepo.mock.calls.length).toBe(1)
    expect(isEnabledForRepo.mock.calls[0]?.[0]).toBe("/payload")
    expect(count.mock.calls.length).toBe(0)
    expect(record.mock.calls.length).toBe(0)
    expect(captureDiff.mock.calls.length).toBe(0)
    expect(exec.mock.calls.length).toBe(0)
  })

  test("consent check uses fallbackCwd when payload cwd is missing", async () => {
    const isEnabledForRepo = mock(async (_cwd: string) => false)
    const d = await decideStopHook(decisionInput({
      stdin: JSON.stringify({ session_id: "s1" }),
      isEnabledForRepo,
      fallbackCwd: "/fallback-cwd",
      exec: allFail,
    }))
    expect(d.exitCode).toBe(0)
    expect(isEnabledForRepo.mock.calls[0]?.[0]).toBe("/fallback-cwd")
  })

  test("consent throws -> fail OPEN and never runs repo code", async () => {
    const exec = mock(async () => ({ exitCode: 1 }))
    const captureDiff = mock(async (_cwd: string) => "")
    const isEnabledForRepo = mock(async (_cwd: string) => { throw new Error("trust-store unavailable") })
    const { budget, count } = mockedBudget()
    const d = await decideStopHook(decisionInput({ exec, captureDiff, isEnabledForRepo, budget }))
    expect(d.exitCode).toBe(0)
    expect(count.mock.calls.length).toBe(0)
    expect(captureDiff.mock.calls.length).toBe(0)
    expect(exec.mock.calls.length).toBe(0)
  })

  test("budget count throws -> fail OPEN and never runs the gate", async () => {
    const exec = mock(async () => ({ exitCode: 1 }))
    const captureDiff = mock(async (_cwd: string) => "")
    const { budget, count, record } = mockedBudget(async () => { throw new Error("budget read failed") })
    const d = await decideStopHook(decisionInput({ exec, captureDiff, budget }))
    expect(d.exitCode).toBe(0)
    expect(count.mock.calls.length).toBe(1)
    expect(record.mock.calls.length).toBe(0)
    expect(captureDiff.mock.calls.length).toBe(0)
    expect(exec.mock.calls.length).toBe(0)
  })

  test("budget at maxBlocks stands down before diff capture or gate execution", async () => {
    const exec = mock(async () => ({ exitCode: 1 }))
    const captureDiff = mock(async (_cwd: string) => "")
    const { budget, record } = mockedBudget(async () => 2)
    const d = await decideStopHook(decisionInput({ exec, captureDiff, budget, maxBlocks: 2 }))
    expect(d.exitCode).toBe(0)
    expect(record.mock.calls.length).toBe(0)
    expect(captureDiff.mock.calls.length).toBe(0)
    expect(exec.mock.calls.length).toBe(0)
  })

  test("a clean gate allows the stop and records an empty first-eval baseline", async () => {
    const { state, baseline } = memBaseline()
    const d = await decideStopHook(decisionInput({ baseline, exec: allPass }))
    expect(d.exitCode).toBe(0)
    expect(state.get(baselineKey("s1", "/w", "typecheck-only"))).toEqual([])
  })

  test("baseline first eval records pre-existing failures and does not block on them", async () => {
    const { counts, budget } = memBudget()
    const { state, baseline } = memBaseline()
    const d = await decideStopHook(decisionInput({ baseline, budget, exec: allFail }))
    expect(d.exitCode).toBe(0)
    expect(counts.get("s1") ?? 0).toBe(0)
    expect(state.get(baselineKey("s1", "/w", "typecheck-only"))).toEqual(["typecheck"])
  })

  test("an existing baseline blocks only newly regressed checks", async () => {
    const { baseline } = memBaseline({ [baselineKey("s1", "/w", "typecheck-test")]: ["typecheck"] })
    const d = await decideStopHook(decisionInput({
      gateId: "typecheck-test",
      baseline,
      exec: allFail,
    }))
    expect(d.exitCode).toBe(2)
    expect(d.stderr).toContain("regressed gates: test")
    expect(d.stderr).not.toContain("regressed gates: typecheck")
    expect(d.stderr).toContain("block 1/2")
  })

  test("gate-weakening blocks even on first evaluation with no baseline", async () => {
    const { counts, budget } = memBudget()
    const { state, baseline } = memBaseline()
    const d = await decideStopHook(decisionInput({
      baseline,
      budget,
      exec: allPass,
      captureDiff: async () => "+ it.skip('must run', () => {})\n",
    }))
    expect(d.exitCode).toBe(2)
    expect(d.stderr).toContain("gate-weakening")
    expect(d.stderr).toContain("block 1/2")
    expect(counts.get("s1")).toBe(1)
    expect(state.get(baselineKey("s1", "/w", "typecheck-only"))).toEqual([])
  })

  test("budget record throws on a blocking eval -> fail OPEN (cannot bound the loop)", async () => {
    const badBudget: BlockBudget = {
      count: async () => 0,
      record: async () => { throw new Error("budget write failed") },
      reset: async () => {},
    }
    const d = await decideStopHook(decisionInput({ budget: badBudget, exec: allFail }))
    expect(d.exitCode).toBe(0)
  })

  test("stop_hook_active is not a stand-down: real budget blocks twice, then allows", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "ghr-stop-budget-"))
    try {
      const budget = fileBlockBudget(path.join(dir, "budget"))
      const baseline = fileBaselineStore(path.join(dir, "baseline"))
      const call = () => decideStopHook(decisionInput({
        stdin: JSON.stringify({ cwd: "/w", session_id: "s-budget", stop_hook_active: true }),
        budget,
        baseline,
        exec: allPass,
        captureDiff: async () => "+ it.skip('must run', () => {})\n",
        maxBlocks: 2,
      }))

      const first = await call()
      const second = await call()
      const third = await call()

      expect(first.exitCode).toBe(2)
      expect(first.stderr).toContain("block 1/2")
      expect(second.exitCode).toBe(2)
      expect(second.stderr).toContain("block 2/2")
      expect(third.exitCode).toBe(0)
      expect(await budget.count("s-budget")).toBe(2)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("a hung gate evaluation hits the absolute timeout and FAILS OPEN (never wedges)", async () => {
    const { budget, record } = mockedBudget()
    const hangingExec: ExecFn = () => new Promise(() => {})
    const d = await decideStopHook(decisionInput({
      exec: hangingExec,
      budget,
      timeoutMs: 25,
    }))
    expect(d.exitCode).toBe(0)
    expect(record.mock.calls.length).toBe(0)
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
    try {
      const file = path.join(dir, "settings.json")
      await injectStopHookIntoSettingsFile(file, "gh-stop")
      const read = JSON.parse(await fs.readFile(file, "utf8")) as { hooks: { Stop: unknown[] } }
      expect(read.hooks.Stop.length).toBe(1)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("preserves existing settings and is idempotent across re-launches", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "ghr-stopgate-"))
    try {
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
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses to overwrite a settings file it cannot parse (preserves user content)", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "ghr-stopgate-"))
    try {
      const file = path.join(dir, "settings.json")
      await fs.writeFile(file, "{ this is not valid json")
      await expect(injectStopHookIntoSettingsFile(file, "gh-stop")).rejects.toThrow()
      // the original content is untouched (no clobber).
      expect(await fs.readFile(file, "utf8")).toBe("{ this is not valid json")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses to overwrite a settings file that is a JSON array, not an object", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "ghr-stopgate-"))
    try {
      const file = path.join(dir, "settings.json")
      await fs.writeFile(file, "[1,2,3]")
      await expect(injectStopHookIntoSettingsFile(file, "gh-stop")).rejects.toThrow()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("decideStopHook — dynamic resolveChecks (parser/discovered path)", () => {
  const dynChecks = [{ id: "typecheck", command: "x" }]

  test("blocks on a regressed dynamic check (baseline empty)", async () => {
    const resolveChecks = async () => ({ checks: dynChecks, workdir: "/w", descriptorKey: "k1" })
    const d = await decideStopHook(decisionInput({
      gateId: "unused",
      exec: allFail,
      resolveChecks,
      baseline: singleSlotBaseline([]),
    }))
    expect(d.exitCode).toBe(2)
    expect(d.stderr).toMatch(/typecheck/)
  })

  test("resolveChecks returning null FAILS OPEN (no gate resolvable now)", async () => {
    const exec = mock(async () => ({ exitCode: 1 }))
    const resolveChecks = async () => null
    const d = await decideStopHook(decisionInput({ gateId: "unused", exec, resolveChecks }))
    expect(d.exitCode).toBe(0)
    expect(exec.mock.calls.length).toBe(0)
  })

  test("an empty check set FAILS OPEN", async () => {
    const exec = mock(async () => ({ exitCode: 1 }))
    const resolveChecks = async () => ({ checks: [], workdir: "/w", descriptorKey: "k" })
    const d = await decideStopHook(decisionInput({ gateId: "unused", exec, resolveChecks }))
    expect(d.exitCode).toBe(0)
    expect(exec.mock.calls.length).toBe(0)
  })

  test("a launch-captured baseline EXCUSES a pre-existing failure but BLOCKS an agent-introduced one", async () => {
    // Scenario A: the check already fails at launch → recorded as baseline → the
    // same failure at stop is NOT a regression → allow.
    const a = memBaseline()
    await captureLaunchBaseline({
      checks: dynChecks, workdir: "/w", exec: allFail, descriptorKey: "k", baseline: a.baseline,
    })
    const keyA = launchBaselineKey("/w", "k")
    const dA = await decideStopHook(decisionInput({
      gateId: "unused", exec: allFail, baseline: a.baseline,
      resolveChecks: async () => ({ checks: dynChecks, workdir: "/w", descriptorKey: "k", baselineKey: keyA }),
    }))
    expect(a.state.get(keyA)).toEqual(["typecheck"]) // captured pre-mutation
    expect(dA.exitCode).toBe(0) // pre-existing failure excused

    // Scenario B: the check PASSES at launch (baseline empty) but the agent broke
    // it → the stop-time failure IS a regression → block.
    const b = memBaseline()
    await captureLaunchBaseline({
      checks: dynChecks, workdir: "/w", exec: allPass, descriptorKey: "k", baseline: b.baseline,
    })
    const keyB = launchBaselineKey("/w", "k")
    const dB = await decideStopHook(decisionInput({
      gateId: "unused", exec: allFail, baseline: b.baseline,
      resolveChecks: async () => ({ checks: dynChecks, workdir: "/w", descriptorKey: "k", baselineKey: keyB }),
    }))
    expect(b.state.get(keyB)).toEqual([]) // clean at launch
    expect(dB.exitCode).toBe(2) // agent-introduced failure blocked
  })

  test("the max-block stand-down is LOUD (carries stderr on the allowing exit 0)", async () => {
    const { budget } = mockedBudget(async () => 2)
    const d = await decideStopHook(decisionInput({ exec: allFail, budget, maxBlocks: 2 }))
    expect(d.exitCode).toBe(0)
    expect(d.stderr).toMatch(/limit/i)
  })
})
