import { afterEach, expect, test } from "bun:test"

import {
  decideRoute,
  shadowEnabled,
  tier1LiveEnabled,
  type Tier1Verdict,
} from "~/lib/first-mate/scheduler/shadow"
import { state } from "~/lib/state"

const originalShadow = process.env.GH_ROUTER_FM_SHADOW
const originalTier1Live = process.env.GH_ROUTER_FM_TIER1_LIVE
const originalModels = state.models

afterEach(() => {
  if (originalShadow === undefined) delete process.env.GH_ROUTER_FM_SHADOW
  else process.env.GH_ROUTER_FM_SHADOW = originalShadow
  if (originalTier1Live === undefined) delete process.env.GH_ROUTER_FM_TIER1_LIVE
  else process.env.GH_ROUTER_FM_TIER1_LIVE = originalTier1Live
  state.models = originalModels
})

function confident(verdict: unknown): Tier1Verdict {
  return {
    wouldVerdict: verdict,
    confidence: 0.95,
    novelty: "known",
    stakes: "low",
  }
}

function lowConfidence(verdict: unknown): Tier1Verdict {
  return {
    wouldVerdict: verdict,
    confidence: 0.5,
    novelty: "known",
    stakes: "low",
  }
}

test("Tier1 shadow and live routing are default-on with presence-guarded opt-out", () => {
  delete process.env.GH_ROUTER_FM_SHADOW
  delete process.env.GH_ROUTER_FM_TIER1_LIVE
  expect(shadowEnabled()).toBe(true)
  expect(tier1LiveEnabled()).toBe(true)

  process.env.GH_ROUTER_FM_SHADOW = "0"
  process.env.GH_ROUTER_FM_TIER1_LIVE = "false"
  expect(shadowEnabled()).toBe(false)
  expect(tier1LiveEnabled()).toBe(false)
})

test("author_fix auto-answers when high-confidence, known, low-stakes, and well-formed", () => {
  delete process.env.GH_ROUTER_FM_TIER1_LIVE
  const decision = decideRoute("author_fix", confident({ instruction: "Fix the failing unit test." }))
  expect(decision).toMatchObject({ autoAccept: true, verdict: { instruction: "Fix the failing unit test." } })
})

test("answer_agent_question auto-answers when high-confidence, known, low-stakes, and well-formed", () => {
  delete process.env.GH_ROUTER_FM_TIER1_LIVE
  const decision = decideRoute("answer_agent_question", confident({ answer: "Use the existing adapter." }))
  expect(decision).toMatchObject({ autoAccept: true, verdict: { answer: "Use the existing adapter." } })
})

test("decompose auto-answers only when the deterministic dependency verifier accepts", () => {
  delete process.env.GH_ROUTER_FM_TIER1_LIVE
  const valid = decideRoute("decompose", confident({ units: [{ title: "A" }, { title: "B", dependsOn: [0] }] }))
  expect(valid.autoAccept).toBe(true)

  const selfLoop = decideRoute("decompose", confident({ units: [{ title: "A", dependsOn: [0] }] }))
  expect(selfLoop.autoAccept).toBe(false)
  expect(selfLoop.reason).toContain("verifier")

  const twoCycle = decideRoute("decompose", confident({ units: [{ title: "A", dependsOn: [1] }, { title: "B", dependsOn: [0] }] }))
  expect(twoCycle.autoAccept).toBe(false)
  expect(twoCycle.reason).toContain("verifier")

  state.models = { data: [{ id: "gpt-5.5" }] } as typeof state.models
  const badModel = decideRoute("decompose", confident({ units: [{ title: "A", model: "not-in-catalog" }] }))
  expect(badModel.autoAccept).toBe(false)
  expect(badModel.reason).toContain("verifier")
})

test("Tier1 live escalates on low confidence, novel, high stakes, unknown, or malformed verdicts", () => {
  delete process.env.GH_ROUTER_FM_TIER1_LIVE
  expect(decideRoute("author_fix", lowConfidence({ instruction: "x" })).autoAccept).toBe(false)
  expect(decideRoute("author_fix", { ...confident({ instruction: "x" }), novelty: "novel" }).autoAccept).toBe(false)
  expect(decideRoute("author_fix", { ...confident({ instruction: "x" }), stakes: "high" }).autoAccept).toBe(false)
  expect(decideRoute("unknown_kind", confident({ instruction: "x" })).autoAccept).toBe(false)
  expect(decideRoute("author_fix", confident({ instruction: "" })).autoAccept).toBe(false)
})

test("merge-authorizing review_plan and judge_review are never auto-answered", () => {
  delete process.env.GH_ROUTER_FM_TIER1_LIVE
  expect(decideRoute("review_plan", confident({ decision: "approve" })).autoAccept).toBe(false)
  expect(decideRoute("judge_review", confident({ pass: true })).autoAccept).toBe(false)
})
