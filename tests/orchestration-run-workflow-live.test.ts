/**
 * Tests for the input-validation / pre-flight paths of `runWorkflowLive`: the
 * branches that reject BEFORE any worker or model call (empty ask, relative
 * workspace, unknown sealed gate, non-object IR, IR that fails verification). The
 * genuinely-live execution (real worktrees + worker + gate subprocesses) is the
 * gated E2E (`GH_ROUTER_RUN_ORCHESTRATION_E2E=1`); these run in CI because they
 * short-circuit before touching the network.
 */

import { describe, expect, test } from "bun:test"

import { runWorkflowLive } from "../src/lib/orchestration/run-workflow-live"
import { type WorkflowIR } from "../src/lib/orchestration"

const ABS = process.cwd() // a real absolute path

/** A well-formed IR so gate/workspace rejections are isolated from IR shape. */
const goodIR: WorkflowIR = {
  rawAskHash: "h",
  acceptanceCriteriaHash: "ac",
  maxDepth: 1,
  nodes: [
    { id: "base", role: "baseline", inputs: [], gate: { kind: "executable", gateId: "default-ci" }, onFail: "baseline", producerLab: "anthropic" },
    { id: "impl", role: "implement", inputs: [], gate: { kind: "executable", gateId: "default-ci" }, onFail: "baseline", producerLab: "openai" },
    { id: "sel", role: "selector", inputs: ["base", "impl"], gate: { kind: "none" }, onFail: "baseline", judgesOnRawAsk: true },
  ],
}

describe("runWorkflowLive validation", () => {
  test("rejects an empty ask", async () => {
    const r = await runWorkflowLive({ ir: goodIR, ask: "  ", workspace: ABS, gateId: "default-ci" })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/ask is required/)
  })

  test("rejects a relative workspace", async () => {
    const r = await runWorkflowLive({ ir: goodIR, ask: "do it", workspace: "relative/path", gateId: "default-ci" })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/absolute path/)
  })

  test("rejects an unknown sealed gate (no model-authored commands)", async () => {
    const r = await runWorkflowLive({ ir: goodIR, ask: "do it", workspace: ABS, gateId: "rm -rf /" })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/unknown gateId/)
  })

  test("rejects a non-object IR", async () => {
    const r = await runWorkflowLive({ ir: "not an object", ask: "do it", workspace: ABS, gateId: "default-ci" })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/ir must be an object/)
  })

  test("rejects an IR that fails verification, surfacing violation codes", async () => {
    // No baseline / no selector → the verifier rejects it before the kernel runs.
    const badIR = { rawAskHash: "h", acceptanceCriteriaHash: "ac", maxDepth: 1, nodes: [
      { id: "impl", role: "implement", inputs: [], gate: { kind: "none" }, onFail: "baseline", producerLab: "openai" },
    ] }
    const r = await runWorkflowLive({ ir: badIR, ask: "do it", workspace: ABS, gateId: "default-ci" })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/IR failed verification/)
  })

  test("rejects an IR whose executable gate references a DIFFERENT gate than the selected one", async () => {
    // goodIR's executable gates reference "default-ci"; selecting "typecheck-only"
    // must reject it so the kernel never runs a gate the verified IR did not
    // declare (the fail-open consistency gap).
    const r = await runWorkflowLive({ ir: goodIR, ask: "do it", workspace: ABS, gateId: "typecheck-only" })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/IR failed verification/)
  })
})
