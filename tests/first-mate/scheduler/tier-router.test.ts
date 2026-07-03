import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  decideRoute,
  isValidVerdictShape,
  type Tier1Verdict,
} from "~/lib/first-mate/scheduler/shadow"

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
  test("#7: allowlisted + high-confidence still ESCALATES with no deterministic verifier", () => {
    // Self-report is not a safety boundary; with no verifier registered, escalate.
    const d = decideRoute("author_fix", good)
    expect(d.autoAccept).toBe(false)
    expect(d.reason).toContain("verifier")
  })

  test("decompose also escalates (no verifier registered)", () => {
    expect(decideRoute("decompose", good).autoAccept).toBe(false)
  })

  test("#6: a null/undefined verdict payload NEVER auto-accepts", () => {
    const nullV = decideRoute("author_fix", { ...good, wouldVerdict: null })
    expect(nullV.autoAccept).toBe(false)
    expect(nullV.reason).toContain("null")
    expect(decideRoute("author_fix", { ...good, wouldVerdict: undefined }).autoAccept).toBe(false)
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

describe("Tier1 verdict SHAPE validation (per judgment kind)", () => {
  test("author_fix requires a non-empty instruction", () => {
    expect(isValidVerdictShape("author_fix", { instruction: "fix the lint error" })).toBe(true)
    expect(isValidVerdictShape("author_fix", { instruction: "" })).toBe(false)
    expect(isValidVerdictShape("author_fix", {})).toBe(false)
    expect(isValidVerdictShape("author_fix", null)).toBe(false)
  })

  test("decompose requires a non-empty unit list with titles", () => {
    expect(isValidVerdictShape("decompose", { units: [{ title: "a" }] })).toBe(true)
    expect(isValidVerdictShape("decompose", { units: [] })).toBe(false)
    expect(isValidVerdictShape("decompose", { units: [{ title: "" }] })).toBe(false)
    expect(isValidVerdictShape("decompose", { units: "nope" })).toBe(false)
  })

  test("review_plan / judge_review / answer_agent_question shapes", () => {
    expect(isValidVerdictShape("review_plan", { decision: "approve" })).toBe(true)
    expect(isValidVerdictShape("review_plan", { decision: "yolo" })).toBe(false)
    expect(isValidVerdictShape("judge_review", { pass: true })).toBe(true)
    expect(isValidVerdictShape("judge_review", { pass: "yes" })).toBe(false)
    expect(isValidVerdictShape("answer_agent_question", { answer: "use main" })).toBe(true)
    expect(isValidVerdictShape("answer_agent_question", { answer: "" })).toBe(false)
  })

  test("an unknown kind is never valid", () => {
    expect(isValidVerdictShape("mystery", { anything: true })).toBe(false)
  })
})
