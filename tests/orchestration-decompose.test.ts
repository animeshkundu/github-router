/**
 * Unit tests for the decompose loop (`src/lib/orchestration/decompose.ts`).
 * Driven with MOCK deps so the orchestration (draft → verify → re-draft on
 * violations → cross-lab critique → bounded re-draft) is tested without a live
 * model. The verifier is the authority: a draft that doesn't verify must never
 * be returned as `ok`.
 */

import { describe, expect, test } from "bun:test"

import { decomposeWorkflow, type DecomposeDeps } from "../src/lib/orchestration/decompose"
import { type WorkflowIR } from "../src/lib/orchestration/ir"

const validIR = (rawAskHash = "r"): WorkflowIR => ({
  rawAskHash,
  acceptanceCriteriaHash: "a",
  maxDepth: 1,
  nodes: [
    { id: "baseline", role: "baseline", inputs: [], gate: { kind: "none" }, onFail: "baseline" },
    { id: "impl", role: "implement", producerLab: "openai", inputs: [], gate: { kind: "executable", gateId: "tests" }, onFail: "loop" },
    { id: "select", role: "selector", inputs: ["baseline", "impl"], gate: { kind: "none" }, onFail: "baseline", judgesOnRawAsk: true },
  ],
})
const invalidIR = (): unknown => ({ ...validIR(), nodes: validIR().nodes.filter((n) => n.role !== "baseline") })

function mkDeps(drafts: unknown[], concerns?: string[][]) {
  const draftCalls: Array<{ ask: string; feedback?: string[] }> = []
  let critiqueCount = 0
  const deps: DecomposeDeps = {
    async draftIR(input) {
      draftCalls.push(input)
      return drafts[Math.min(draftCalls.length - 1, drafts.length - 1)]
    },
  }
  if (concerns) {
    deps.critiqueIR = async () => {
      const c = concerns[Math.min(critiqueCount, concerns.length - 1)]!
      critiqueCount += 1
      return { concerns: c }
    }
  }
  return { deps, draftCalls }
}

describe("decomposeWorkflow", () => {
  test("clean draft on the first try → ok, rounds 1", async () => {
    const { deps } = mkDeps([validIR()])
    const r = await decomposeWorkflow("build X", deps)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.rounds).toBe(1)
  })

  test("invalid draft then a clean one → ok, rounds 2, violations fed back", async () => {
    const { deps, draftCalls } = mkDeps([invalidIR(), validIR()])
    const r = await decomposeWorkflow("build X", deps)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.rounds).toBe(2)
    // The second draft call must have received the prior violations as feedback.
    expect(draftCalls[1]?.feedback?.some((f) => f.includes("NO_BASELINE"))).toBe(true)
  })

  test("never converges → not ok, returns the last violations", async () => {
    const { deps } = mkDeps([invalidIR(), invalidIR(), invalidIR()])
    const r = await decomposeWorkflow("build X", deps, { maxRounds: 3 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.rounds).toBe(3)
      expect(r.violations.map((v) => v.code)).toContain("NO_BASELINE")
    }
  })

  test("critique with no concerns → returns the clean draft, no re-draft", async () => {
    const { deps, draftCalls } = mkDeps([validIR()], [[]])
    const r = await decomposeWorkflow("build X", deps)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.rounds).toBe(1)
    expect(draftCalls.length).toBe(1) // critique returned no concerns → no re-draft
  })

  test("critique concerns → one re-draft incorporating them → ok", async () => {
    const { deps } = mkDeps([validIR("first"), validIR("second")], [["tighten the gate"]])
    const r = await decomposeWorkflow("build X", deps)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.rounds).toBe(2)
      expect(r.ir.rawAskHash).toBe("second") // the re-drafted IR
    }
  })

  test("critique re-draft regresses (invalid) → keep the earlier clean IR + surface concerns", async () => {
    const { deps } = mkDeps([validIR("first"), invalidIR()], [["tighten the gate"]])
    const r = await decomposeWorkflow("build X", deps)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.ir.rawAskHash).toBe("first") // fell back to the verified draft
      expect(r.rounds).toBe(2) // initial draft + the regressed re-draft attempt
      expect(r.concerns).toContain("tighten the gate")
    }
  })

  test("critique concerns with no round left (maxRounds 1) → return verified IR + concerns", async () => {
    const { deps } = mkDeps([validIR()], [["tighten the gate"]])
    const r = await decomposeWorkflow("build X", deps, { maxRounds: 1 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.rounds).toBe(1)
      expect(r.concerns).toContain("tighten the gate")
    }
  })

  test("a driver that throws → not ok (failed round), never rejects", async () => {
    const deps: DecomposeDeps = { async draftIR() { throw new Error("model down") } }
    const r = await decomposeWorkflow("build X", deps, { maxRounds: 2 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.violations.map((v) => v.code)).toContain("DRAFT_THREW")
      expect(r.rounds).toBe(2)
    }
  })

  test("malformed driver output (non-object) → not ok, never throws", async () => {
    const { deps } = mkDeps(["not an IR", 42, null])
    const r = await decomposeWorkflow("build X", deps, { maxRounds: 3 })
    expect(r.ok).toBe(false)
  })
})
