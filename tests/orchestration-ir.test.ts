/**
 * Unit tests for the workflow IR static verifier
 * (`src/lib/orchestration/verify.ts`). Each test pins one invariant check by
 * its stable violation `code`. The verifier is the pre-flight gate the kernel
 * (and Claude) rely on, so a regression here would let a floor-violating IR
 * through — every check has a positive (valid IR passes) and negative case.
 *
 * Hardened after a two-lab adversarial review: topological reachability (no
 * orphaned producer dodges the selector), runtime enum validation, producerLab
 * required on cross_lab gates, fail-to-baseline on the selector, and a sealed
 * gate-id allowlist.
 */

import { describe, expect, test } from "bun:test"

import { MAX_RECURSION_DEPTH, type WorkflowIR } from "../src/lib/orchestration/ir"
import { verifyWorkflowIR } from "../src/lib/orchestration/verify"

/**
 * A minimal *sound* workflow: baseline + implement (executable gate) → a
 * cross-lab review → a raw-ask, fail-to-baseline selector taking baseline +
 * the review. Every node feeds the selector (the single sink). Rebuilt per call
 * so a test's mutation never bleeds into the next.
 */
function validIR(): WorkflowIR {
  return {
    rawAskHash: "raw-abc",
    acceptanceCriteriaHash: "ac-abc",
    maxDepth: 1,
    nodes: [
      { id: "baseline", role: "baseline", inputs: [], gate: { kind: "none" }, onFail: "baseline" },
      {
        id: "impl",
        role: "implement",
        producerLab: "openai",
        inputs: [],
        gate: { kind: "executable", gateId: "tests" },
        onFail: "loop",
      },
      {
        id: "review",
        role: "review",
        producerLab: "google",
        inputs: ["impl"],
        gate: { kind: "cross_lab", checkerLab: "anthropic" },
        onFail: "escalate",
      },
      {
        id: "select",
        role: "selector",
        inputs: ["baseline", "review"],
        gate: { kind: "none" },
        onFail: "baseline",
        judgesOnRawAsk: true,
      },
    ],
  }
}

const codes = (ir: WorkflowIR): string[] => verifyWorkflowIR(ir).violations.map((x) => x.code)

describe("verifyWorkflowIR", () => {
  test("a well-formed workflow passes", () => {
    const r = verifyWorkflowIR(validIR())
    expect(r.ok).toBe(true)
    expect(r.violations).toEqual([])
  })

  // ---- envelope ----
  test("missing rawAskHash / acceptanceCriteriaHash → MISSING_HASH", () => {
    const ir = validIR()
    ir.rawAskHash = ""
    ir.acceptanceCriteriaHash = ""
    expect(codes(ir).filter((c) => c === "MISSING_HASH").length).toBe(2)
  })

  test("maxDepth out of [1, MAX] → BAD_MAX_DEPTH", () => {
    const lo = validIR(); lo.maxDepth = 0
    const hi = validIR(); hi.maxDepth = MAX_RECURSION_DEPTH + 1
    const frac = validIR(); frac.maxDepth = 1.5
    expect(codes(lo)).toContain("BAD_MAX_DEPTH")
    expect(codes(hi)).toContain("BAD_MAX_DEPTH")
    expect(codes(frac)).toContain("BAD_MAX_DEPTH")
  })

  test("empty workflow → EMPTY", () => {
    const ir = validIR(); ir.nodes = []
    expect(codes(ir)).toContain("EMPTY")
  })

  test("non-object IR → BAD_IR", () => {
    expect(verifyWorkflowIR(null as unknown as WorkflowIR).violations[0]?.code).toBe("BAD_IR")
  })

  // ---- untrusted-shape hardening (never throw) ----
  test("a null node → BAD_NODE, not a thrown exception", () => {
    const ir = validIR()
    ;(ir.nodes as unknown[]).push(null)
    expect(() => verifyWorkflowIR(ir)).not.toThrow()
    expect(codes(ir)).toContain("BAD_NODE")
  })

  test("non-array inputs → BAD_NODE", () => {
    const ir = validIR()
    ;(ir.nodes[1] as unknown as { inputs: unknown }).inputs = 123
    expect(codes(ir)).toContain("BAD_NODE")
  })

  test("invalid role → BAD_ROLE", () => {
    const ir = validIR()
    ;(ir.nodes[1] as unknown as { role: string }).role = "bogus"
    expect(codes(ir)).toContain("BAD_ROLE")
  })

  test("invalid onFail (e.g. halt) → BAD_ON_FAIL", () => {
    const ir = validIR()
    ;(ir.nodes[1] as unknown as { onFail: string }).onFail = "halt"
    expect(codes(ir)).toContain("BAD_ON_FAIL")
  })

  // ---- ids / refs / gates ----
  test("duplicate node id → DUP_ID", () => {
    const ir = validIR()
    ir.nodes.push({ ...ir.nodes[1]!, id: "impl" })
    expect(codes(ir)).toContain("DUP_ID")
  })

  test("unknown input ref → BAD_INPUT_REF", () => {
    const ir = validIR()
    ir.nodes[2]!.inputs = ["does-not-exist"]
    expect(codes(ir)).toContain("BAD_INPUT_REF")
  })

  test("executable gate without gateId → BAD_GATE (gate-immutability)", () => {
    const ir = validIR()
    ir.nodes[1]!.gate = { kind: "executable" }
    expect(codes(ir)).toContain("BAD_GATE")
  })

  test("cross_lab gate without checkerLab → BAD_GATE", () => {
    const ir = validIR()
    ir.nodes[2]!.gate = { kind: "cross_lab" }
    expect(codes(ir)).toContain("BAD_GATE")
  })

  test("executable gateId not in the sealed allowlist → UNKNOWN_GATE_ID", () => {
    const r = verifyWorkflowIR(validIR(), { knownGateIds: new Set(["other"]) })
    expect(r.violations.map((x) => x.code)).toContain("UNKNOWN_GATE_ID")
  })

  test("executable gateId in the allowlist → passes", () => {
    const r = verifyWorkflowIR(validIR(), { knownGateIds: new Set(["tests"]) })
    expect(r.ok).toBe(true)
  })

  test("cycle in the graph → CYCLE", () => {
    const ir = validIR()
    ir.nodes[1]!.inputs = ["review"] // impl ← review, review ← impl
    expect(codes(ir)).toContain("CYCLE")
  })

  // ---- topology / reachability ----
  test("a node that does not feed the selector → ORPHAN_NODE", () => {
    const ir = validIR()
    ir.nodes.push({ id: "orphan", role: "verify", inputs: [], gate: { kind: "none" }, onFail: "escalate" })
    expect(codes(ir)).toContain("ORPHAN_NODE")
  })

  // ---- invariant 1: baseline ----
  test("no baseline → NO_BASELINE", () => {
    const ir = validIR()
    ir.nodes = ir.nodes.filter((n) => n.role !== "baseline")
    expect(codes(ir)).toContain("NO_BASELINE")
  })

  test("two baselines → MULTI_BASELINE", () => {
    const ir = validIR()
    ir.nodes.push({ id: "baseline2", role: "baseline", inputs: [], gate: { kind: "none" }, onFail: "baseline" })
    expect(codes(ir)).toContain("MULTI_BASELINE")
  })

  test("baseline with inputs → BASELINE_HAS_INPUTS", () => {
    const ir = validIR()
    ir.nodes[0]!.inputs = ["impl"]
    expect(codes(ir)).toContain("BASELINE_HAS_INPUTS")
  })

  // ---- invariants 1 + 3 + 4: selector ----
  test("no selector → NO_SELECTOR", () => {
    const ir = validIR()
    ir.nodes = ir.nodes.filter((n) => n.role !== "selector")
    expect(codes(ir)).toContain("NO_SELECTOR")
  })

  test("selector not judging the raw ask → SELECTOR_NOT_RAW_ASK", () => {
    const ir = validIR()
    ir.nodes[3]!.judgesOnRawAsk = false
    expect(codes(ir)).toContain("SELECTOR_NOT_RAW_ASK")
  })

  test("selector that does not fail-to-baseline → SELECTOR_ONFAIL_NOT_BASELINE", () => {
    const ir = validIR()
    ir.nodes[3]!.onFail = "escalate"
    expect(codes(ir)).toContain("SELECTOR_ONFAIL_NOT_BASELINE")
  })

  test("selector without the baseline as input → SELECTOR_MISSING_BASELINE_INPUT", () => {
    const ir = validIR()
    ir.nodes[3]!.inputs = ["review"]
    expect(codes(ir)).toContain("SELECTOR_MISSING_BASELINE_INPUT")
  })

  test("selector without an orchestrated candidate input → SELECTOR_NO_ORCHESTRATED_INPUT", () => {
    const ir = validIR()
    ir.nodes[3]!.inputs = ["baseline"]
    expect(codes(ir)).toContain("SELECTOR_NO_ORCHESTRATED_INPUT")
  })

  test("selector that something depends on → SELECTOR_NOT_TERMINAL", () => {
    const ir = validIR()
    ir.nodes.push({ id: "after", role: "verify", inputs: ["select"], gate: { kind: "none" }, onFail: "escalate" })
    expect(codes(ir)).toContain("SELECTOR_NOT_TERMINAL")
  })

  // ---- producer != checker lab ----
  test("a node checked by its own lab → SAME_LAB_CHECK", () => {
    const ir = validIR()
    ir.nodes[2]!.producerLab = "anthropic" // same as its cross_lab checkerLab
    expect(codes(ir)).toContain("SAME_LAB_CHECK")
  })

  test("cross_lab gate without producerLab → MISSING_PRODUCER_LAB", () => {
    const ir = validIR()
    delete ir.nodes[2]!.producerLab
    expect(codes(ir)).toContain("MISSING_PRODUCER_LAB")
  })

  // ---- invariant 7: integration gate (topology, not just presence) ----
  test("two implement nodes without an integration gate → MISSING_INTEGRATION_GATE", () => {
    const ir: WorkflowIR = {
      rawAskHash: "r", acceptanceCriteriaHash: "a", maxDepth: 1,
      nodes: [
        { id: "baseline", role: "baseline", inputs: [], gate: { kind: "none" }, onFail: "baseline" },
        { id: "i1", role: "implement", producerLab: "openai", inputs: [], gate: { kind: "executable", gateId: "tests" }, onFail: "loop" },
        { id: "i2", role: "implement", producerLab: "google", inputs: [], gate: { kind: "executable", gateId: "tests" }, onFail: "loop" },
        { id: "sel", role: "selector", inputs: ["baseline", "i1", "i2"], gate: { kind: "none" }, onFail: "baseline", judgesOnRawAsk: true },
      ],
    }
    expect(codes(ir)).toContain("MISSING_INTEGRATION_GATE")
  })

  test("an implement node that does not feed the integration gate → IMPLEMENT_NOT_INTEGRATED", () => {
    const ir: WorkflowIR = {
      rawAskHash: "r", acceptanceCriteriaHash: "a", maxDepth: 1,
      nodes: [
        { id: "baseline", role: "baseline", inputs: [], gate: { kind: "none" }, onFail: "baseline" },
        { id: "i1", role: "implement", producerLab: "openai", inputs: [], gate: { kind: "executable", gateId: "tests" }, onFail: "loop" },
        { id: "i2", role: "implement", producerLab: "google", inputs: [], gate: { kind: "executable", gateId: "tests" }, onFail: "loop" },
        { id: "integ", role: "integration", inputs: ["i1"], gate: { kind: "executable", gateId: "integration" }, onFail: "baseline" },
        { id: "sel", role: "selector", inputs: ["baseline", "integ", "i2"], gate: { kind: "none" }, onFail: "baseline", judgesOnRawAsk: true },
      ],
    }
    expect(codes(ir)).toContain("IMPLEMENT_NOT_INTEGRATED")
  })

  test("two implement nodes feeding an executable integration gate → passes", () => {
    const ir: WorkflowIR = {
      rawAskHash: "r", acceptanceCriteriaHash: "a", maxDepth: 1,
      nodes: [
        { id: "baseline", role: "baseline", inputs: [], gate: { kind: "none" }, onFail: "baseline" },
        { id: "i1", role: "implement", producerLab: "openai", inputs: [], gate: { kind: "executable", gateId: "tests" }, onFail: "loop" },
        { id: "i2", role: "implement", producerLab: "google", inputs: [], gate: { kind: "executable", gateId: "tests" }, onFail: "loop" },
        { id: "integ", role: "integration", inputs: ["i1", "i2"], gate: { kind: "executable", gateId: "integration" }, onFail: "baseline" },
        { id: "sel", role: "selector", inputs: ["baseline", "integ"], gate: { kind: "none" }, onFail: "baseline", judgesOnRawAsk: true },
      ],
    }
    const r = verifyWorkflowIR(ir)
    expect(r.ok).toBe(true)
  })
})
