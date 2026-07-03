import { describe, expect, test } from "bun:test"

import type { HumanRequest, ModelRequest } from "~/lib/first-mate/controller"
import { routeAdvanceResult } from "~/lib/first-mate/scheduler"

function modelReq(id: string, kind = "review_plan"): ModelRequest {
  return { requestId: id, kind: kind as ModelRequest["kind"], missionId: "m1", repo: { owner: "o", name: "n" }, issue: null, pr: null, payload: {} }
}
function humanReq(id: string): HumanRequest {
  return { requestId: id, decisionId: `d-${id}`, missionId: "m1", repo: { owner: "o", name: "n" }, issue: null, pr: 5, reason: "merge approval" }
}

interface Captured {
  requestId: string
  target: "lead" | "human"
  kind: string
}
function fakeEscalation(): { enqueue: (i: Captured & Record<string, unknown>) => Promise<void>; items: Captured[] } {
  const items: Captured[] = []
  return {
    items,
    enqueue: async (i) => {
      items.push({ requestId: i.requestId, target: i.target, kind: i.kind })
    },
  }
}

describe("routing-gap fix — routeAdvanceResult always surfaces requests", () => {
  test("with shadow/Tier1 OFF (no autoAnswer): needsModel→lead AND needsHuman→human, nothing dropped", async () => {
    const esc = fakeEscalation()
    const res = {
      needsModel: [modelReq("rp-1", "review_plan"), modelReq("af-1", "author_fix")],
      needsHuman: [humanReq("h-1")],
    }
    const summary = await routeAdvanceResult(res, { escalation: esc })
    expect(summary.escalatedModel).toBe(2)
    expect(summary.escalatedHuman).toBe(1)
    expect(summary.autoAnswered).toBe(0)
    expect(esc.items.filter((i) => i.target === "lead").map((i) => i.requestId).sort()).toEqual(["af-1", "rp-1"])
    const human = esc.items.find((i) => i.target === "human")
    expect(human?.requestId).toBe("h-1")
    expect(human?.kind).toBe("human_decision")
  })

  test("needsHuman is ALWAYS surfaced even if there are no model requests", async () => {
    const esc = fakeEscalation()
    const summary = await routeAdvanceResult({ needsModel: [], needsHuman: [humanReq("h-2")] }, { escalation: esc })
    expect(summary.escalatedHuman).toBe(1)
    expect(esc.items[0]?.target).toBe("human")
  })

  test("an auto-answered model request is NOT escalated; the rest still are", async () => {
    const esc = fakeEscalation()
    const autoAnswer = async (req: ModelRequest) => ({ accepted: req.requestId === "auto-ok" })
    const res = { needsModel: [modelReq("auto-ok"), modelReq("needs-lead")], needsHuman: [] }
    const summary = await routeAdvanceResult(res, { escalation: esc, autoAnswer })
    expect(summary.autoAnswered).toBe(1)
    expect(summary.escalatedModel).toBe(1)
    expect(esc.items.map((i) => i.requestId)).toEqual(["needs-lead"])
  })
})
