import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { decideRoute, type Tier1Verdict } from "~/lib/first-mate/scheduler/shadow"

const good: Tier1Verdict = {
  wouldVerdict: { instruction: "tidy up" },
  confidence: 0.95,
  novelty: "known",
  stakes: "low",
}

beforeEach(() => {
  process.env.GH_ROUTER_FM_TIER1_LIVE = "1"
})
afterEach(() => {
  delete process.env.GH_ROUTER_FM_TIER1_LIVE
})

describe("Phase 3 — decideRoute (escalate-by-default gate)", () => {
  test("auto-accepts an allowlisted, high-confidence, known, low-stakes verdict", () => {
    const d = decideRoute("author_fix", good)
    expect(d.autoAccept).toBe(true)
    expect(d.verdict).toEqual({ instruction: "tidy up" })
  })

  test("decompose is also allowlisted", () => {
    expect(decideRoute("decompose", good).autoAccept).toBe(true)
  })

  test("review_plan and judge_review NEVER auto-accept (not allowlisted)", () => {
    expect(decideRoute("review_plan", good).autoAccept).toBe(false)
    expect(decideRoute("judge_review", good).autoAccept).toBe(false)
  })

  test("escalates below the confidence floor", () => {
    expect(decideRoute("author_fix", { ...good, confidence: 0.5 }).autoAccept).toBe(false)
  })

  test("escalates when novel or high-stakes", () => {
    expect(decideRoute("author_fix", { ...good, novelty: "novel" }).autoAccept).toBe(false)
    expect(decideRoute("author_fix", { ...good, stakes: "high" }).autoAccept).toBe(false)
  })

  test("escalates when there is no verdict", () => {
    expect(decideRoute("author_fix", null).autoAccept).toBe(false)
  })

  test("with the live flag OFF, NOTHING auto-accepts (default posture)", () => {
    delete process.env.GH_ROUTER_FM_TIER1_LIVE
    expect(decideRoute("author_fix", good).autoAccept).toBe(false)
    expect(decideRoute("decompose", good).reason).toContain("disabled")
  })
})
