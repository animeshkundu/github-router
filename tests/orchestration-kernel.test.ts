/**
 * Unit tests for the orchestration kernel (`src/lib/orchestration/kernel.ts`).
 * The kernel is driven with a MOCK `NodeRunner` so the orchestration logic
 * (verify → baseline-first → schedule → gate-failure handling → champion
 * selection → fail-to-baseline) is tested in isolation from worktrees / gates /
 * model calls. The invariants under test are floor-critical: a bug here could
 * ship a worse-than-baseline artifact or halt where it should fall to baseline.
 */

import { describe, expect, test } from "bun:test"

import { type WorkflowIR } from "../src/lib/orchestration/ir"
import { executeWorkflow, type NodeRunResult, type NodeRunner } from "../src/lib/orchestration/kernel"
import { type GateOutcome } from "../src/lib/orchestration/select"

const gate = (passed: string[], ran: string[]): GateOutcome => ({ passed: new Set(passed), ran: new Set(ran) })

/** A clean IR that passes verification: baseline + impl (executable) → review
 *  (cross-lab) → raw-ask fail-to-baseline selector. The selector's orchestrated
 *  input is `review`, which threads the executable outcome forward. */
function baseIR(): WorkflowIR {
  return {
    rawAskHash: "r", acceptanceCriteriaHash: "a", maxDepth: 1,
    nodes: [
      { id: "baseline", role: "baseline", inputs: [], gate: { kind: "none" }, onFail: "baseline" },
      { id: "impl", role: "implement", producerLab: "openai", inputs: [], gate: { kind: "executable", gateId: "tests" }, onFail: "loop" },
      { id: "review", role: "review", producerLab: "google", inputs: ["impl"], gate: { kind: "cross_lab", checkerLab: "anthropic" }, onFail: "escalate" },
      { id: "select", role: "selector", inputs: ["baseline", "review"], gate: { kind: "none" }, onFail: "baseline", judgesOnRawAsk: true },
    ],
  }
}

/** Mock runner: per-node a fixed result or a sequence (for retry behaviour). */
function mockRunner(script: Record<string, NodeRunResult | NodeRunResult[]>): NodeRunner {
  const calls = new Map<string, number>()
  return {
    async runNode(node) {
      const s = script[node.id]
      if (s === undefined) return { ok: true }
      if (Array.isArray(s)) {
        const i = calls.get(node.id) ?? 0
        calls.set(node.id, i + 1)
        return s[Math.min(i, s.length - 1)]!
      }
      return s
    },
  }
}

const canonical = new Set(["a", "b"])
const opts = (tiePolicy: "strict" | "superset" = "strict") => ({ tiePolicy, canonicalGateIds: canonical } as const)

describe("executeWorkflow", () => {
  test("orchestrated passes strictly more → delivered orchestrated", async () => {
    const r = await executeWorkflow(baseIR(), mockRunner({
      baseline: { ok: true, gate: gate(["a"], ["a", "b"]), artifact: "base" },
      impl: { ok: true, gate: gate(["a", "b"], ["a", "b"]), artifact: "impl" },
      review: { ok: true, gate: gate(["a", "b"], ["a", "b"]), artifact: "impl" },
    }), opts())
    expect(r.status).toBe("delivered")
    if (r.status === "delivered") {
      expect(r.winner).toBe("orchestrated")
      expect(r.artifact).toBe("impl")
    }
  })

  test("tie under strict policy → delivered baseline", async () => {
    const r = await executeWorkflow(baseIR(), mockRunner({
      baseline: { ok: true, gate: gate(["a", "b"], ["a", "b"]), artifact: "base" },
      impl: { ok: true, gate: gate(["a", "b"], ["a", "b"]), artifact: "impl" },
      review: { ok: true, gate: gate(["a", "b"], ["a", "b"]), artifact: "impl" },
    }), opts("strict"))
    expect(r.status).toBe("delivered")
    if (r.status === "delivered") {
      expect(r.winner).toBe("baseline")
      expect(r.artifact).toBe("base")
    }
  })

  test("infra failure on a producer → fall to baseline (never halt)", async () => {
    const r = await executeWorkflow(baseIR(), mockRunner({
      baseline: { ok: true, gate: gate(["a", "b"], ["a", "b"]), artifact: "base" },
      impl: { ok: false, infraFailure: true },
    }), opts())
    expect(r.status).toBe("baseline")
    if (r.status === "baseline") expect(r.artifact).toBe("base")
  })

  test("a thrown runner error is treated as infra → fall to baseline", async () => {
    const throwing: NodeRunner = {
      async runNode(node) {
        if (node.id === "impl") throw new Error("boom")
        if (node.id === "baseline") return { ok: true, gate: gate(["a"], ["a", "b"]), artifact: "base" }
        return { ok: true }
      },
    }
    const r = await executeWorkflow(baseIR(), throwing, opts())
    expect(r.status).toBe("baseline")
  })

  test("artifact failure with onFail:baseline → fall to baseline", async () => {
    const ir = baseIR()
    ir.nodes.find((n) => n.id === "impl")!.onFail = "baseline"
    const r = await executeWorkflow(ir, mockRunner({
      baseline: { ok: true, gate: gate(["a"], ["a", "b"]), artifact: "base" },
      impl: { ok: false }, // artifact failure (not infra)
    }), opts())
    expect(r.status).toBe("baseline")
  })

  test("artifact failure with onFail:loop, exhausted → escalate", async () => {
    const r = await executeWorkflow(baseIR(), mockRunner({
      baseline: { ok: true, gate: gate(["a"], ["a", "b"]), artifact: "base" },
      impl: { ok: false }, // always fails its gate; onFail is "loop"
    }), { ...opts(), maxRetries: 2 })
    expect(r.status).toBe("escalated")
    if (r.status === "escalated") expect(r.nodeId).toBe("impl")
  })

  test("loop that eventually passes → delivered", async () => {
    const r = await executeWorkflow(baseIR(), mockRunner({
      baseline: { ok: true, gate: gate(["a"], ["a", "b"]), artifact: "base" },
      impl: [{ ok: false }, { ok: true, gate: gate(["a", "b"], ["a", "b"]), artifact: "impl" }],
      review: { ok: true, gate: gate(["a", "b"], ["a", "b"]), artifact: "impl" },
    }), opts())
    expect(r.status).toBe("delivered")
  })

  test("invalid IR is rejected before any node runs", async () => {
    const ir = baseIR()
    ir.nodes = ir.nodes.filter((n) => n.role !== "baseline") // NO_BASELINE
    let ran = false
    const r = await executeWorkflow(ir, { async runNode() { ran = true; return { ok: true } } }, opts())
    expect(r.status).toBe("rejected")
    expect(ran).toBe(false)
  })

  test("baseline itself cannot run → escalate (no floor)", async () => {
    const r = await executeWorkflow(baseIR(), mockRunner({
      baseline: { ok: false, infraFailure: true },
    }), opts())
    expect(r.status).toBe("escalated")
    if (r.status === "escalated") expect(r.nodeId).toBe("baseline")
  })
})
