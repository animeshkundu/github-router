/**
 * Unit tests for the reference runner (`src/lib/orchestration/runner.ts`) plus
 * an END-TO-END test driving the kernel WITH the runner (mock deps) — proving
 * the orchestration core executes a real WorkflowIR from baseline through
 * selection. Deps are mocked; the live adapter (worktrees / gates / models) is
 * the separate slice that gets E2E verification.
 */

import { describe, expect, test } from "bun:test"

import { type WorkflowIR, type WorkflowNode } from "../src/lib/orchestration/ir"
import { executeWorkflow } from "../src/lib/orchestration/kernel"
import { makeRunner, type RunnerDeps } from "../src/lib/orchestration/runner"
import { type GateOutcome } from "../src/lib/orchestration/select"

const gate = (passed: string[], ran: string[]): GateOutcome => ({ passed: new Set(passed), ran: new Set(ran) })

function mkDeps(overrides: Partial<{
  worker: (i: { role: string; workspace: string }) => { text: string; isError?: boolean; artifact?: string }
  gate: (i: { gateId: string; workspace: string }) => GateOutcome
  critic: (i: { checkerLab: string }) => { block: boolean }
}> = {}) {
  const calls = {
    ws: [] as string[],
    worker: [] as Array<{ role: string; prompt: string; workspace: string }>,
    gate: [] as Array<{ gateId: string; workspace: string }>,
    critic: [] as Array<{ checkerLab: string }>,
  }
  const deps: RunnerDeps = {
    async prepareWorkspace(node) { calls.ws.push(node.id); return `/ws/${node.id}` },
    async runWorker(i) { calls.worker.push(i); return overrides.worker?.(i) ?? { text: "ok" } },
    async runGate(i) { calls.gate.push(i); return overrides.gate?.(i) ?? gate(["a", "b"], ["a", "b"]) },
    async runCritic(i) { calls.critic.push(i); return overrides.critic?.({ checkerLab: i.checkerLab }) ?? { block: false } },
  }
  return { deps, calls }
}

const ctx = { rawAsk: "build X", baseWorkspace: "/base", canonicalGate: { id: "fullsuite", checks: new Set(["a", "b"]) } }
const node = (p: Partial<WorkflowNode> & { id: string; role: WorkflowNode["role"] }): WorkflowNode =>
  ({ inputs: [], gate: { kind: "none" }, onFail: "escalate", ...p })

describe("makeRunner.runNode", () => {
  test("baseline → worker(implement) on the raw ask + the canonical gate", async () => {
    const { deps, calls } = mkDeps()
    const r = await makeRunner(deps, ctx).runNode(node({ id: "baseline", role: "baseline", onFail: "baseline" }), new Map())
    expect(r.ok).toBe(true)
    expect(r.gate?.passed.has("a")).toBe(true)
    expect(calls.worker[0]?.role).toBe("implement")
    expect(calls.worker[0]?.prompt).toBe("build X")
    expect(calls.gate[0]?.gateId).toBe("fullsuite")
  })

  test("a failing worker → infra failure (fall-to-baseline upstream)", async () => {
    const { deps } = mkDeps({ worker: () => ({ text: "", isError: true }) })
    const r = await makeRunner(deps, ctx).runNode(node({ id: "impl", role: "implement", gate: { kind: "executable", gateId: "fullsuite" }, onFail: "loop" }), new Map())
    expect(r.ok).toBe(false)
    expect(r.infraFailure).toBe(true)
  })

  test("producer that fails the canonical gate → ok:false (not infra)", async () => {
    const { deps } = mkDeps({ gate: () => gate(["a"], ["a", "b"]) }) // fails b
    const r = await makeRunner(deps, ctx).runNode(node({ id: "impl", role: "implement", gate: { kind: "executable", gateId: "fullsuite" }, onFail: "loop" }), new Map())
    expect(r.ok).toBe(false)
    expect(r.infraFailure).toBeUndefined()
  })

  test("review threads the input's executable outcome + runs the critic (advisory)", async () => {
    const { deps, calls } = mkDeps()
    const inputGate = gate(["a", "b"], ["a", "b"])
    const inputs = new Map([["impl", { ok: true, gate: inputGate, artifact: "/ws/impl" }]])
    const r = await makeRunner(deps, ctx).runNode(
      node({ id: "review", role: "review", producerLab: "google", inputs: ["impl"], gate: { kind: "cross_lab", checkerLab: "anthropic" } }),
      inputs,
    )
    expect(r.gate).toBe(inputGate) // threaded, not re-gated
    expect(r.artifact).toBe("/ws/impl")
    expect(calls.gate.length).toBe(0) // review never runs an executable gate itself
    expect(calls.critic[0]?.checkerLab).toBe("anthropic")
  })

  test("read-only role (research) → worker on the base workspace, no gate", async () => {
    const { deps, calls } = mkDeps()
    const r = await makeRunner(deps, ctx).runNode(node({ id: "res", role: "research" }), new Map())
    expect(r.ok).toBe(true)
    expect(r.gate).toBeUndefined()
    expect(calls.gate.length).toBe(0)
    expect(calls.worker[0]?.workspace).toBe("/base")
  })
})

describe("kernel + runner end-to-end", () => {
  const ir: WorkflowIR = {
    rawAskHash: "r", acceptanceCriteriaHash: "a", maxDepth: 1,
    nodes: [
      node({ id: "baseline", role: "baseline", onFail: "baseline" }),
      node({ id: "impl", role: "implement", producerLab: "openai", gate: { kind: "executable", gateId: "fullsuite" }, onFail: "loop" }),
      node({ id: "review", role: "review", producerLab: "google", inputs: ["impl"], gate: { kind: "cross_lab", checkerLab: "anthropic" } }),
      node({ id: "select", role: "selector", inputs: ["baseline", "review"], onFail: "baseline", judgesOnRawAsk: true }),
    ],
  }

  test("orchestrated passes more than baseline → delivered orchestrated", async () => {
    // baseline workspace passes only {a}; impl passes {a,b}; review threads impl.
    const { deps } = mkDeps({
      gate: ({ workspace }) => (workspace === "/ws/baseline" ? gate(["a"], ["a", "b"]) : gate(["a", "b"], ["a", "b"])),
    })
    const r = await executeWorkflow(ir, makeRunner(deps, ctx), { tiePolicy: "strict", canonicalGateIds: new Set(["a", "b"]) })
    expect(r.status).toBe("delivered")
    if (r.status === "delivered") expect(r.winner).toBe("orchestrated")
  })

  test("baseline ties orchestrated, strict policy → delivered baseline", async () => {
    const { deps } = mkDeps({ gate: () => gate(["a", "b"], ["a", "b"]) }) // both pass everything
    const r = await executeWorkflow(ir, makeRunner(deps, ctx), { tiePolicy: "strict", canonicalGateIds: new Set(["a", "b"]) })
    expect(r.status).toBe("delivered")
    if (r.status === "delivered") expect(r.winner).toBe("baseline")
  })

  test("a worker infra failure mid-run → fall to baseline", async () => {
    const { deps } = mkDeps({ worker: ({ workspace }) => (workspace === "/ws/impl" ? { text: "", isError: true } : { text: "ok" }) })
    const r = await executeWorkflow(ir, makeRunner(deps, ctx), { tiePolicy: "strict", canonicalGateIds: new Set(["a", "b"]) })
    expect(r.status).toBe("baseline")
  })
})
