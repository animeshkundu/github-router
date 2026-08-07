import { beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { advance, type ControllerDeps } from "~/lib/first-mate/controller"
import type { Mission } from "~/lib/first-mate/registry"
import {
  __resetHeldClaimsForTests,
  AnswerInbox,
} from "~/lib/first-mate/scheduler/answer-inbox"

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
    // ack-after-apply: the claim survives until ack so a crash before apply
    // replays it. Only after ack are the .draining.* files removed.
    let stragglers = (await fs.readdir(dir)).filter((n) => n.includes(".draining."))
    expect(stragglers.length).toBe(2)
    await drained.ack()
    stragglers = (await fs.readdir(dir)).filter((n) => n.includes(".draining."))
    expect(stragglers.length).toBe(0)
    const empty = await inbox.drain()
    expect(empty.modelAnswers).toEqual([])
  })

  test("crash after drain-before-ack: the next drain replays the claim (no loss)", async () => {
    const crashed = new AnswerInbox({ dir })
    await crashed.enqueue({ humanDecisions: [{ requestId: "h1", choice: "merge" }] })
    const drained = await crashed.drain()
    expect(drained.humanDecisions).toEqual([{ requestId: "h1", choice: "merge" }])
    // Process dies WITHOUT acking (no drained.ack()). A crash also loses the
    // process-wide held-claim set that stops a LIVE peer from re-claiming, so
    // clearing it here is what makes this a faithful new-process simulation
    // rather than a same-process peer drain.
    __resetHeldClaimsForTests()
    const recovered = new AnswerInbox({ dir })
    const replay = await recovered.drain()
    expect(replay.humanDecisions).toEqual([{ requestId: "h1", choice: "merge" }])
    await replay.ack()
    expect((await recovered.drain()).humanDecisions).toEqual([])
  })

  test("a concurrent enqueue during an in-flight drain is not lost", async () => {
    const inbox = new AnswerInbox({ dir })
    await inbox.enqueue({ modelAnswers: [{ requestId: "before", verdict: 1 }] })
    // Kick off a drain and, without awaiting it, enqueue another answer. Because
    // drain and enqueue share the same chain, the enqueue serializes AFTER the
    // rename and lands in a fresh inbox file rather than a claimed/unlinked one.
    const drainP = inbox.drain()
    const enqP = inbox.enqueue({ modelAnswers: [{ requestId: "during", verdict: 2 }] })
    const [d1] = await Promise.all([drainP, enqP])
    await d1.ack()
    expect(d1.modelAnswers.map((m) => m.requestId)).toEqual(["before"])
    // The concurrently-enqueued answer survives for the next drain.
    const d2 = await inbox.drain()
    await d2.ack()
    expect(d2.modelAnswers.map((m) => m.requestId)).toEqual(["during"])
  })

  test("two concurrent drainers claim a given orphan EXACTLY ONCE (R3 #3)", async () => {
    // A crashed prior drain left an orphan. Two live drainers — separate
    // instances with SEPARATE process-local inflight sets, i.e. two processes —
    // drain concurrently. The old in-place readFile let BOTH read and return the
    // same orphan (→ double-apply); the atomic single-source rename-claim means
    // exactly one drainer claims it and the other gets ENOENT.
    await fs.writeFile(
      path.join(dir, "answers.jsonl.draining.9999.dead"),
      `${JSON.stringify({ t: "h", requestId: "orphan-1", choice: "merge" })}\n`,
    )
    const a = new AnswerInbox({ dir })
    const b = new AnswerInbox({ dir })
    const [da, db] = await Promise.all([a.drain(), b.drain()])
    const surfaced = [...da.humanDecisions, ...db.humanDecisions]
    expect(surfaced).toEqual([{ requestId: "orphan-1", choice: "merge" }]) // once, not twice
    await Promise.all([da.ack(), db.ack()])
    // Nothing left behind.
    expect((await fs.readdir(dir)).filter((n) => n.includes(".draining."))).toEqual([])
  })

  test("a peer drainer never re-claims a live drainer's claim (deterministic)", async () => {
    // The concurrent variant above races two drains and only catches this when
    // the interleaving happens to line up — which is why CI saw it intermittently
    // and 20 local runs did not. This pins the same invariant with no timing:
    // A claims the orphan and has NOT acked, so its claim file is still on disk.
    // Because the claim keeps the `.draining.` prefix (deliberate, so a crash
    // leaves it discoverable), B's scan matched it and surfaced the SAME human
    // decision a second time — a double-apply of durable human-decision state.
    await fs.writeFile(
      path.join(dir, "answers.jsonl.draining.9999.dead"),
      `${JSON.stringify({ t: "h", requestId: "orphan-1", choice: "merge" })}\n`,
    )
    const a = new AnswerInbox({ dir })
    const da = await a.drain()
    expect(da.humanDecisions).toEqual([{ requestId: "orphan-1", choice: "merge" }])
    // A is still holding the claim (no ack yet). A peer must see nothing.
    const b = new AnswerInbox({ dir })
    const db = await b.drain()
    expect(db.humanDecisions).toEqual([])
    await da.ack()
    expect((await fs.readdir(dir)).filter((n) => n.includes(".draining."))).toEqual([])
  })

  test("a transient Windows sharing violation on the claim-rename is retried, not fatal (R3 #3 win32)", async () => {
    // On Windows two concurrent drainers renaming the SAME source can transiently
    // get EPERM/EACCES/EBUSY (a sharing violation) instead of a clean ENOENT. The
    // old code threw on any non-ENOENT rename error, failing the whole drain. The
    // claim-rename must retry the transient error and still claim the orphan.
    await fs.writeFile(
      path.join(dir, "answers.jsonl.draining.9999.dead"),
      `${JSON.stringify({ t: "h", requestId: "orphan-1", choice: "merge" })}\n`,
    )
    const inbox = new AnswerInbox({ dir })
    // First rename (the orphan claim) throws EPERM once; the retry calls through.
    const spy = spyOn(fs, "rename").mockImplementationOnce(async () => {
      const e = new Error("simulated win32 sharing violation") as NodeJS.ErrnoException
      e.code = "EPERM"
      throw e
    })
    const drained = await inbox.drain()
    spy.mockRestore()
    // The orphan was claimed despite the transient error (not thrown away, not lost).
    expect(drained.humanDecisions).toEqual([{ requestId: "orphan-1", choice: "merge" }])
    await drained.ack()
    expect((await fs.readdir(dir)).filter((n) => n.includes(".draining."))).toEqual([])
  })

  test("a transient read error PRESERVES the orphan (never deletes an unread answer) (R3 #4)", async () => {
    await fs.writeFile(
      path.join(dir, "answers.jsonl.draining.9999.dead"),
      `${JSON.stringify({ t: "h", requestId: "keep-me", choice: "merge" })}\n`,
    )
    const inbox = new AnswerInbox({ dir })
    // Force a transient read failure (EACCES) on the claimed file exactly once —
    // the old blind `catch { unlink }` would permanently delete the answer.
    const spy = spyOn(fs, "readFile").mockImplementationOnce(async () => {
      const e = new Error("simulated transient read failure") as NodeJS.ErrnoException
      e.code = "EACCES"
      throw e
    })
    const drained = await inbox.drain()
    spy.mockRestore()
    // The read failed → not surfaced this drain, and NOT deleted.
    expect(drained.humanDecisions).toEqual([])
    await drained.ack()
    const survivors = (await fs.readdir(dir)).filter((n) => n.includes(".draining."))
    expect(survivors.length).toBeGreaterThan(0)
    // A later drain recovers the preserved answer — nothing was lost.
    const recovered = await inbox.drain()
    expect(recovered.humanDecisions).toEqual([{ requestId: "keep-me", choice: "merge" }])
    await recovered.ack()
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
    continueTaskOnBranch: boom("continueTaskOnBranch"),
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
    // Inbox is now empty (drained + acked).
    expect((await inbox.drain()).modelAnswers).toEqual([])
  })
})

describe("#6 — fail-closed fencing on the supervisor drive path", () => {
  test("a fence-required drive whose token resolves undefined refuses to drive", async () => {
    await expect(
      advance({ driveGate: () => true, fenceToken: () => undefined }, fakeDeps()),
    ).rejects.toThrow(/fail-closed/i)
  })

  test("omitting the fenceToken provider still allows an unfenced drive (opt-out)", async () => {
    const res = await advance({ driveGate: () => true }, fakeDeps())
    expect(res.drove).toBe(true)
  })
})

describe("F1 — a failed answer apply is re-enqueued, never marked answered", () => {
  test("upsertUnit throwing under contention re-enqueues the decision and does not wedge", async () => {
    const inbox = new AnswerInbox({ dir })
    // A unit blocked on decision "d1". Applying the human answer clears
    // blockingDecisionId then persists via upsertUnit — which we force to throw
    // (simulating OCC exhaustion / a fenced write).
    const blocked = {
      id: "u1",
      missionId: "m1",
      repo: { owner: "o", name: "n" },
      issue: 1,
      pr: 7,
      taskId: "task-1",
      agent: "copilot",
      botLogin: "copilot-swe-agent",
      dispatchMode: "plan",
      provider: "in_progress",
      phase: "plan",
      artifact: "no_pr",
      validation: "unknown",
      retries: 0,
      dependsOn: [],
      title: "u1",
      blockingDecisionId: "d1",
    }
    let answered = 0
    const base = fakeDeps({ missions: [mission] })
    const deps = {
      ...base,
      // Fresh clone each call so the in-memory clear in applyHumanDecision does
      // not leak into the drive sweep's copy (which must still see it blocked).
      loadAllUnits: async () => [{ ...blocked }],
      findByKey: async () => undefined, // fall back to the unit's blockingDecisionId
      markAnswered: async () => {
        answered += 1
      },
      upsertUnit: async () => {
        throw new Error("occ exhausted")
      },
    } as unknown as ControllerDeps
    const res = await advance(
      {
        driveGate: () => true,
        answerQueue: inbox,
        // Non-approve / non-abandon choice → straight to the failing upsertUnit,
        // skipping the (best-effort) approval path.
        humanDecisions: [{ requestId: "d1", choice: "keep going" }],
      },
      deps,
    )
    expect(res.drove).toBe(true)
    // markAnswered LAST means a failed upsertUnit throws before it — the decision
    // is never durably "answered" while the unit stays blocked (no wedge).
    expect(answered).toBe(0)
    // The drained answer was NOT dropped — it is re-enqueued for a later retry.
    const replay = await inbox.drain()
    await replay.ack()
    expect(replay.humanDecisions).toEqual([{ requestId: "d1", choice: "keep going" }])
  })
})
