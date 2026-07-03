import { beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { advance, type ControllerDeps } from "~/lib/first-mate/controller"
import type { Mission } from "~/lib/first-mate/registry"
import { AnswerInbox } from "~/lib/first-mate/scheduler/answer-inbox"

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "fm-inbox-"))
})

describe("AnswerInbox", () => {
  test("enqueue then drain round-trips model + human answers and clears", async () => {
    const inbox = new AnswerInbox({ dir })
    expect(await inbox.enqueue({ modelAnswers: [{ requestId: "m1", verdict: { decision: "approve" } }] })).toBe(1)
    expect(await inbox.enqueue({ humanDecisions: [{ requestId: "h1", choice: "merge" }] })).toBe(1)
    const drained = await inbox.drain()
    expect(drained.modelAnswers.map((m) => m.requestId)).toEqual(["m1"])
    expect(drained.humanDecisions).toEqual([{ requestId: "h1", choice: "merge" }])
    // Cleared after drain.
    const again = await inbox.drain()
    expect(again.modelAnswers).toEqual([])
    expect(again.humanDecisions).toEqual([])
  })

  test("enqueue of nothing is a no-op", async () => {
    const inbox = new AnswerInbox({ dir })
    expect(await inbox.enqueue({})).toBe(0)
    expect((await inbox.drain()).modelAnswers).toEqual([])
  })

  test("an enqueue that lands after a drain is not lost", async () => {
    const inbox = new AnswerInbox({ dir })
    await inbox.enqueue({ modelAnswers: [{ requestId: "first", verdict: 1 }] })
    const d1 = await inbox.drain()
    expect(d1.modelAnswers.map((m) => m.requestId)).toEqual(["first"])
    await inbox.enqueue({ modelAnswers: [{ requestId: "second", verdict: 2 }] })
    const d2 = await inbox.drain()
    expect(d2.modelAnswers.map((m) => m.requestId)).toEqual(["second"])
  })

  test("recovers orphaned .draining.* answers from a crashed prior drain", async () => {
    const inbox = new AnswerInbox({ dir })
    // A prior drain renamed the inbox then died before consuming it.
    await fs.writeFile(
      path.join(dir, "answers.jsonl.draining.9999.dead"),
      `${JSON.stringify({ t: "m", requestId: "orphan-1", verdict: { decision: "approve" } })}\n`,
    )
    await inbox.enqueue({ modelAnswers: [{ requestId: "live-1", verdict: 1 }] })
    const drained = await inbox.drain()
    expect(drained.modelAnswers.map((m) => m.requestId).sort()).toEqual(["live-1", "orphan-1"])
    // Orphan file was consumed + removed; a subsequent drain is empty.
    const stragglers = (await fs.readdir(dir)).filter((n) => n.includes(".draining."))
    expect(stragglers.length).toBe(0)
    expect((await inbox.drain()).modelAnswers).toEqual([])
  })
})

// Fake deps: loadAllUnits/readMissions are exercised; a decompose answer's
// upsertUnit is optionally spied (proves the drained answer was applied); any
// real DRIVE dep throws (so we prove deferring doesn't drive).
function fakeDeps(
  opts: { missions?: Mission[]; onUpsertUnit?: (id: string) => void } = {},
): ControllerDeps {
  const readonly = (v: unknown) => async (): Promise<unknown> => v
  const boom = (n: string) => async (): Promise<never> => {
    throw new Error(`unexpected drive dep: ${n}`)
  }
  return {
    loadAllUnits: readonly([]),
    readMissions: readonly(opts.missions ?? []),
    upsertUnit: async (_repo: unknown, unit: { id?: string }) => {
      if (!opts.onUpsertUnit) throw new Error("unexpected drive dep: upsertUnit")
      opts.onUpsertUnit(unit.id ?? "")
    },
    pruneTerminal: readonly(undefined),
    findByKey: boom("findByKey"),
    markAnswered: async () => {},
    observeUnit: boom("observeUnit"),
    classifyPlanReady: boom("classifyPlanReady"),
    classifyQuestionAnswerable: boom("classifyQuestionAnswerable"),
    classifyFixAddressed: boom("classifyFixAddressed"),
    classifyStuck: boom("classifyStuck"),
    verifyAndConsumeApproval: boom("verifyAndConsumeApproval"),
    recordApproval: boom("recordApproval"),
    upsertDecision: boom("upsertDecision"),
    startTask: boom("startTask"),
    followUpTask: boom("followUpTask"),
    cancelTask: boom("cancelTask"),
    createIssue: boom("createIssue"),
    resolveAgentActor: boom("resolveAgentActor"),
    resolveAgentRoster: boom("resolveAgentRoster"),
    assignAgent: boom("assignAgent"),
    findAgentPRs: boom("findAgentPRs"),
    getPullRequestState: boom("getPullRequestState"),
    postComment: boom("postComment"),
    submitReview: boom("submitReview"),
    requestReview: boom("requestReview"),
    rerunChecks: boom("rerunChecks"),
    mergePullRequest: boom("mergePullRequest"),
    markReadyForReview: boom("markReadyForReview"),
    buildDecisionPacket: boom("buildDecisionPacket"),
    writeDecisionPacketHtml: boom("writeDecisionPacketHtml"),
  } as unknown as ControllerDeps
}

const mission: Mission = {
  id: "m1",
  goal: "g",
  acceptanceCriteria: "ac",
  repos: [{ owner: "o", name: "n" }],
  status: "active",
  createdMs: 1,
  updatedMs: 1,
}

describe("Phase A — answer submission decoupled from driving", () => {
  test("a deferring (non-holder) advance PERSISTS the answer and does not drive", async () => {
    const inbox = new AnswerInbox({ dir })
    const res = await advance(
      {
        driveGate: () => false,
        answerQueue: inbox,
        modelAnswers: [{ requestId: "r1", verdict: { decision: "approve" } }],
      },
      fakeDeps(),
    )
    expect(res.drove).toBe(false)
    // Answer was queued durably (not applied — no drive deps hit).
    const drained = await inbox.drain()
    expect(drained.modelAnswers.map((m) => m.requestId)).toEqual(["r1"])
  })

  test("the lease HOLDER drains queued answers and applies them", async () => {
    const inbox = new AnswerInbox({ dir })
    // A non-holder queued a decompose answer earlier…
    await inbox.enqueue({
      modelAnswers: [
        { requestId: "decompose:m1", verdict: { units: [{ title: "u1", repo: "o/n" }] } },
      ],
    })
    const upserted: string[] = []
    // …now the holder advances and must drain + apply it (upsertUnit proves apply ran).
    const res = await advance(
      { driveGate: () => true, answerQueue: inbox, modelAnswers: [] },
      fakeDeps({ missions: [mission], onUpsertUnit: (id) => upserted.push(id) }),
    )
    expect(res.drove).toBe(true)
    expect(upserted.length).toBe(1) // the decompose answer created a unit
    // Inbox is now empty (drained).
    expect((await inbox.drain()).modelAnswers).toEqual([])
  })
})
