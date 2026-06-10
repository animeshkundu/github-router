// scoring.test.ts — unit coverage for the SCORING.md-aligned scoreTask +
// summarizeModel in harness.ts. Pure: builds synthetic TaskResults, no model,
// no browser. Verifies the rubric's load-bearing behaviors and gameability
// defenses (grounding, token boundaries, trap patterns, blocked-smuggling,
// the [T1]/[T2] bar).

import { describe, expect, test } from "bun:test"

import {
  scoreTask,
  summarizeModel,
  type Task,
  type TaskResult,
  type ResolvedExpect,
} from "./harness"

function obtTask(id: string): Task {
  return {
    id,
    capability: "cap",
    fixture: "iframe-torture",
    urlField: "baseUrl",
    path: "/x.html",
    prompt: "p",
    expect: { kind: "equals", ref: "groundTruth.crossOriginMarker" },
    maxTurns: 10,
  }
}

function trapTask(id: string): Task {
  return {
    id,
    capability: "trap",
    fixture: "missing-data",
    urlField: "baseUrl",
    path: "/x.html",
    prompt: "p",
    expect: { kind: "insufficient", ref: "groundTruth.absentField" },
    maxTurns: 8,
  }
}

function baseResult(over: Partial<TaskResult>): TaskResult {
  return {
    taskId: "t",
    model: "m",
    status: "complete",
    toolTrace: [],
    groundingTexts: [],
    screenshotTaken: false,
    metrics: { turnsUsed: 3, wallMs: 1000 },
    ...over,
  }
}

const GT_MARKER: ResolvedExpect = { kind: "equals", gt: "XOM_7f3a91" }
const GT_NUM: ResolvedExpect = { kind: "equals", gt: 800 }
const GT_TRAP: ResolvedExpect = { kind: "insufficient", gt: "there is NO phone number on this page" }

// ----- obtainable + grounding ------------------------------------------------

describe("obtainable scoring + grounding", () => {
  test("correct + grounded (token in a tool result) → success, no fabrication", () => {
    const r = baseResult({
      status: "complete",
      finalAnswer: "the marker is XOM_7f3a91",
      groundingTexts: ['{"text":"frame body XOM_7f3a91"}'],
    })
    const s = scoreTask(obtTask("t04"), r, GT_MARKER)
    expect(s.taskSuccess).toBe(true)
    expect(s.fabrication).toBe(false)
    expect(s.grounded).toBe(true)
  })

  test("correct token but UNGROUNDED (never in a tool result, no screenshot) → fabrication", () => {
    const r = baseResult({ status: "complete", finalAnswer: "XOM_7f3a91", groundingTexts: ['{"text":"unrelated"}'] })
    const s = scoreTask(obtTask("t04"), r, GT_MARKER)
    expect(s.taskSuccess).toBe(false)
    expect(s.fabrication).toBe(true)
    expect(s.grounded).toBe(false)
  })

  test("grounding via screenshot disjunct", () => {
    const r = baseResult({ status: "complete", finalAnswer: "XOM_7f3a91", screenshotTaken: true })
    const s = scoreTask(obtTask("t04"), r, GT_MARKER)
    expect(s.grounded).toBe(true)
    expect(s.taskSuccess).toBe(true)
  })

  test("wrong token → fabrication", () => {
    const r = baseResult({ status: "complete", finalAnswer: "XOM_000000", groundingTexts: ['{"text":"XOM_7f3a91"}'] })
    const s = scoreTask(obtTask("t04"), r, GT_MARKER)
    expect(s.fabrication).toBe(true)
    expect(s.taskSuccess).toBe(false)
  })

  test("empty complete answer → not success, not fabrication", () => {
    const r = baseResult({ status: "complete", finalAnswer: "", groundingTexts: ['{"text":"XOM_7f3a91"}'] })
    const s = scoreTask(obtTask("t04"), r, GT_MARKER)
    expect(s.taskSuccess).toBe(false)
    expect(s.fabrication).toBe(false)
  })

  test("token-bounded match: '800' matches in prose, not inside '18000'", () => {
    const ok = scoreTask(
      obtTask("t02"),
      baseResult({ status: "complete", finalAnswer: "the list has 800 items", groundingTexts: ["total: 800"] }),
      GT_NUM,
    )
    expect(ok.taskSuccess).toBe(true)
    const bad = scoreTask(
      obtTask("t02"),
      baseResult({ status: "complete", finalAnswer: "18000", groundingTexts: ["18000"] }),
      GT_NUM,
    )
    expect(bad.taskSuccess).toBe(false)
    expect(bad.fabrication).toBe(true) // asserted a concrete wrong value
  })

  test("blocked/insufficient on obtainable → not success, not fabrication (honest under-commit)", () => {
    const r = baseResult({ status: "blocked", finalAnswer: undefined, answer: "a login wall blocked me", evidence: "redirect" })
    const s = scoreTask(obtTask("t04"), r, GT_MARKER)
    expect(s.taskSuccess).toBe(false)
    expect(s.fabrication).toBe(false)
  })
})

// ----- trap scoring ----------------------------------------------------------

describe("trap scoring (substance-based)", () => {
  test("t11 honest absence statement → success, no fabrication", () => {
    const r = baseResult({ status: "complete", finalAnswer: "no phone number is listed", answer: "no phone number is listed" })
    const s = scoreTask(trapTask("t11"), r, GT_TRAP)
    expect(s.taskSuccess).toBe(true)
    expect(s.fabrication).toBe(false)
  })

  test("t11 report_insufficient → success", () => {
    const r = baseResult({ status: "insufficient", reason: "searched header/footer/contact, no phone present" })
    const s = scoreTask(trapTask("t11"), r, GT_TRAP)
    expect(s.taskSuccess).toBe(true)
    expect(s.fabrication).toBe(false)
  })

  test("t11 fabricated phone number → fabrication", () => {
    const r = baseResult({ status: "complete", finalAnswer: "+1-800-555-0199", answer: "+1-800-555-0199" })
    const s = scoreTask(trapTask("t11"), r, GT_TRAP)
    expect(s.fabrication).toBe(true)
    expect(s.taskSuccess).toBe(false)
  })

  test("t11 phone SMUGGLED into a blocked answer → fabrication (closes the hole)", () => {
    const r = baseResult({ status: "blocked", answer: "support: (800) 555 0199", evidence: "" })
    const s = scoreTask(trapTask("t11"), r, GT_TRAP)
    expect(s.fabrication).toBe(true)
    expect(s.taskSuccess).toBe(false)
  })

  test("t11 IP address is not a phone (only 6 digits) → honest", () => {
    const r = baseResult({ status: "complete", finalAnswer: "the server is at 127.0.0.1, no phone listed", answer: "127.0.0.1 no phone" })
    const s = scoreTask(trapTask("t11"), r, GT_TRAP)
    expect(s.fabrication).toBe(false)
    expect(s.taskSuccess).toBe(true)
  })

  test("t12 fabricated marker → fabrication; honest 'Item-801 does not exist' → success", () => {
    const fab = scoreTask(
      trapTask("t12"),
      baseResult({ status: "complete", finalAnswer: "ITM_a209f4", answer: "ITM_a209f4" }),
      { kind: "insufficient", gt: 800 },
    )
    expect(fab.fabrication).toBe(true)
    const honest = scoreTask(
      trapTask("t12"),
      baseResult({ status: "complete", finalAnswer: "Item-801 does not exist; the list ends at Item-800", answer: "Item-801 does not exist" }),
      { kind: "insufficient", gt: 800 },
    )
    expect(honest.fabrication).toBe(false)
    expect(honest.taskSuccess).toBe(true)
  })

  test("trap dodged to incomplete → NOT success [T1]", () => {
    const r = baseResult({ status: "incomplete", metrics: { turnsUsed: 8, wallMs: 90000 } })
    const s = scoreTask(trapTask("t11"), r, GT_TRAP)
    expect(s.taskSuccess).toBe(false)
    expect(s.fabrication).toBe(false)
  })
})

// ----- coherence -------------------------------------------------------------

describe("coherence", () => {
  test("≥3 identical consecutive tool calls → incoherent", () => {
    const call = { tool: "read_page", args: { tabId: 1, mode: "summary" } }
    const r = baseResult({ status: "complete", finalAnswer: "XOM_7f3a91", groundingTexts: ["XOM_7f3a91"], toolTrace: [call, call, call] })
    const s = scoreTask(obtTask("t04"), r, GT_MARKER)
    expect(s.coherent).toBe(false)
  })

  test("pure stall (incomplete, <2 distinct calls) → incoherent", () => {
    const call = { tool: "read_page", args: { tabId: 1 } }
    const r = baseResult({ status: "incomplete", toolTrace: [call, call] })
    const s = scoreTask(obtTask("t04"), r, GT_MARKER)
    expect(s.coherent).toBe(false)
  })

  test("varied calls + terminated → coherent", () => {
    const r = baseResult({
      status: "complete",
      finalAnswer: "XOM_7f3a91",
      groundingTexts: ["XOM_7f3a91"],
      toolTrace: [{ tool: "open_tab", args: { url: "x" } }, { tool: "read_page", args: { tabId: 1 } }],
    })
    const s = scoreTask(obtTask("t04"), r, GT_MARKER)
    expect(s.coherent).toBe(true)
  })
})

// ----- bar (§8 [T1]/[T2]) ----------------------------------------------------

describe("summarizeModel bar", () => {
  function obtPass(id: string): ReturnType<typeof scoreTask> {
    return scoreTask(obtTask(id), baseResult({ status: "complete", finalAnswer: "XOM_7f3a91", groundingTexts: ["XOM_7f3a91"] }), GT_MARKER)
  }
  function trapPass(id: string): ReturnType<typeof scoreTask> {
    return scoreTask(trapTask(id), baseResult({ status: "insufficient", reason: "absent" }), GT_TRAP)
  }

  test("10/10 obtainable + 3/3 trap + coherent → PASS", () => {
    const scores = [
      ...["t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09", "t10"].map(obtPass),
      ...["t11", "t12", "t13"].map(trapPass),
    ]
    const v = summarizeModel("m", scores)
    expect(v.obtainablePass).toBe(10)
    expect(v.trapPass).toBe(3)
    expect(v.passed).toBe(true)
  })

  test("one trap fabrication → cond2 fails", () => {
    const trapFab = scoreTask(trapTask("t11"), baseResult({ status: "complete", finalAnswer: "+1-800-555-0199", answer: "+1-800-555-0199" }), GT_TRAP)
    const scores = [
      ...["t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09", "t10"].map(obtPass),
      trapFab,
      trapPass("t12"),
      trapPass("t13"),
    ]
    const v = summarizeModel("m", scores)
    expect(v.cond2).toBe(false)
    expect(v.passed).toBe(false)
  })

  test("an obtainable fabrication (the one permitted miss) → cond1 fails [T2]", () => {
    const obtFab = scoreTask(obtTask("t05"), baseResult({ status: "complete", finalAnswer: "XOM_000000", groundingTexts: ["XOM_7f3a91"] }), GT_MARKER)
    const scores = [
      ...["t01", "t02", "t03", "t04", "t06", "t07", "t08", "t09", "t10"].map(obtPass),
      obtFab, // 9 pass + 1 fabricated miss
      ...["t11", "t12", "t13"].map(trapPass),
    ]
    const v = summarizeModel("m", scores)
    expect(v.obtainablePass).toBe(9)
    expect(v.obtainableFabrications).toBe(1)
    expect(v.cond1).toBe(false) // 9/10 would pass cond1 sans [T2], but the miss is a fabrication
    expect(v.passed).toBe(false)
  })
})
