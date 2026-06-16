/**
 * Unit tests for champion-retention selection (`src/lib/orchestration/select.ts`).
 * The deterministic floor mechanism: orchestrated ships only when it verifiably
 * does not regress against the baseline over the CANONICAL raw-ask gate set, and
 * the tie-break is an explicit product policy. A regression here would let a
 * worse-than-baseline artifact ship — the exact floor violation the design
 * exists to prevent.
 */

import { describe, expect, test } from "bun:test"

import { type GateOutcome, selectChampion } from "../src/lib/orchestration/select"

const g = (passed: string[], ran: string[] = passed): GateOutcome => ({
  passed: new Set(passed),
  ran: new Set(ran),
})
const canon = (...ids: string[]): ReadonlySet<string> => new Set(ids)

describe("selectChampion", () => {
  test("strictly more of the canonical checks green → orchestrated", () => {
    const baseline = g(["a"], ["a", "b"]) // passes a, fails b
    const orch = g(["a", "b"]) // passes both
    expect(selectChampion(orch, baseline, canon("a", "b"), "strict").winner).toBe("orchestrated")
    expect(selectChampion(orch, baseline, canon("a", "b"), "superset").winner).toBe("orchestrated")
  })

  test("regression on a baseline-passing canonical check → baseline (both policies)", () => {
    const baseline = g(["a", "b"])
    const orch = g(["a"], ["a", "b"]) // drops b
    expect(selectChampion(orch, baseline, canon("a", "b"), "strict").winner).toBe("baseline")
    expect(selectChampion(orch, baseline, canon("a", "b"), "superset").winner).toBe("baseline")
  })

  test("orchestrated skipped a canonical check → baseline (can't claim parity)", () => {
    const baseline = g(["a"], ["a", "b"])
    const orch = g(["a"], ["a"]) // never ran b
    expect(selectChampion(orch, baseline, canon("a", "b"), "strict").winner).toBe("baseline")
    expect(selectChampion(orch, baseline, canon("a", "b"), "superset").winner).toBe("baseline")
  })

  test("equal on the canonical checks → strict ships baseline, superset ships orchestrated", () => {
    const baseline = g(["a", "b"])
    const orch = g(["a", "b"])
    expect(selectChampion(orch, baseline, canon("a", "b"), "strict").winner).toBe("baseline")
    expect(selectChampion(orch, baseline, canon("a", "b"), "superset").winner).toBe("orchestrated")
  })

  test("extra orchestrated-only passing checks do NOT inflate the score (not gameable)", () => {
    // "z" is outside the canonical set; within it orchestrated merely equals baseline.
    const baseline = g(["a", "b"])
    const orch = g(["a", "b", "z"])
    expect(selectChampion(orch, baseline, canon("a", "b"), "strict").winner).toBe("baseline")
  })

  test("baseline passes nothing, orchestrated passes some → orchestrated", () => {
    const baseline = g([], ["a", "b"])
    const orch = g(["a"], ["a", "b"])
    expect(selectChampion(orch, baseline, canon("a", "b"), "strict").winner).toBe("orchestrated")
  })

  test("no canonical gate (judgment-only ask) → baseline, regardless of policy", () => {
    const baseline = g([], [])
    const orch = g([], [])
    expect(selectChampion(orch, baseline, canon(), "strict").winner).toBe("baseline")
    expect(selectChampion(orch, baseline, canon(), "superset").winner).toBe("baseline")
  })

  test("malformed outcome (passed not a subset of ran) → baseline (fail closed)", () => {
    const orchMalformed = g(["a"], []) // claims to pass a check it never ran
    expect(selectChampion(orchMalformed, g(["a"]), canon("a"), "superset").winner).toBe("baseline")
    const baseMalformed = g(["a"], [])
    expect(selectChampion(g(["a"]), baseMalformed, canon("a"), "superset").winner).toBe("baseline")
  })

  test("a decision always carries a reason", () => {
    const d = selectChampion(g(["a"]), g(["a"]), canon("a"), "strict")
    expect(typeof d.reason).toBe("string")
    expect(d.reason.length).toBeGreaterThan(0)
  })
})
