/**
 * Tests for the Stop-gate launch glue (`runStopGateForLaunch`). The sealed gate +
 * diff + exec are injected, so this runs in CI with fake exec (no real
 * subprocess). Verifies: a red gate blocks, a gate-weakening diff blocks, a clean
 * pass does not block, and a misconfigured (unknown) gate FAILS OPEN (never wedges
 * the session).
 */

import { describe, expect, test } from "bun:test"

import { type ExecFn } from "../src/lib/orchestration/gate-runner"
import {
  buildStopHookSettings,
  mergeStopHookIntoSettings,
  runStopGateForLaunch,
  stopGateEnabled,
  stopGateId,
} from "../src/lib/orchestration/stop-gate-hook"

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
