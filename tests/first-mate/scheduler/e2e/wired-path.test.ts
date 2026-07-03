import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import fsp from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  advance,
  type ControllerDeps,
  type ModelRequest,
} from "~/lib/first-mate/controller"
import {
  pruneTerminal as realPruneTerminal,
  readRepoLedger,
  upsertUnit as realUpsertUnit,
} from "~/lib/first-mate/ledger"
import {
  loadAllUnits as realLoadAllUnits,
  readMissions as realReadMissions,
  upsertMission,
} from "~/lib/first-mate/registry"
import { AnswerInbox } from "~/lib/first-mate/scheduler/answer-inbox"
import { EscalationQueue } from "~/lib/first-mate/scheduler/escalation"
import { makeDriveGate, SchedulerLease } from "~/lib/first-mate/scheduler/lease"
import { Outbox } from "~/lib/first-mate/scheduler/outbox"
import { routeAdvanceResult } from "~/lib/first-mate/scheduler/index"
import type { Observed, RepoRef, UnitRow } from "~/lib/first-mate/types"

/**
 * WIRED-PATH E2E (in-process). Unlike e2e.test.ts (which drives a FAKE advance in
 * a real OS process to exercise the fencing/outbox primitives), this drives the
 * REAL `controller.advance` — the real state machine, decompose, dispatch, and
 * escalation logic — against a fake GitHub, but with the REAL durable Outbox,
 * AnswerInbox, and EscalationQueue on a scratch ledger dir, routed through the
 * REAL `routeAdvanceResult`. It proves the full loop wiring in one flow:
 *
 *   need → escalation queue (lead/human) → lead enqueues an answer →
 *   holder advance drains + applies it → the resulting dispatch hits the Outbox
 *   exactly once (idempotent across re-runs).
 */

const repo: RepoRef = { owner: "o", name: "wired" }

let dir: string
let inbox: AnswerInbox
let escalation: EscalationQueue
let outbox: Outbox
let gh: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(tmpdir(), "fm-wired-"))
  process.env.GH_ROUTER_FIRST_MATE_DIR = dir
  process.env.GH_ROUTER_FM_OCC = "1"
  gh = path.join(dir, "gh.log")
  inbox = new AnswerInbox({ dir })
  escalation = new EscalationQueue({ dir })
  outbox = new Outbox({ dir })
})

afterEach(async () => {
  delete process.env.GH_ROUTER_FIRST_MATE_DIR
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
})

function ghCount(): number {
  try {
    return fs
      .readFileSync(gh, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0).length
  } catch {
    return 0
  }
}

/**
 * Fake ControllerDeps: the ledger/registry deps are the REAL durable modules
 * (so OCC + the outbox + the answer inbox exercise their production code); the
 * GitHub-touching deps are fakes. `startTask` is the single external side effect
 * — it appends its idempotency key to the gh log so a double dispatch is
 * observable. `observe` is a per-unit map so a single deps object serves every
 * tick as the units advance.
 */
function makeDeps(observe: Map<string, Observed>): {
  deps: ControllerDeps
  calls: Record<string, number>
} {
  const calls: Record<string, number> = {}
  const bump = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1
  }
  const startTask = async (
    _repo: unknown,
    opts: { idempotencyKey?: string },
  ): Promise<{ taskId: string; state: string }> => {
    bump("startTask")
    fs.appendFileSync(gh, `${opts.idempotencyKey ?? "?"}\n`)
    return { taskId: `task-${calls.startTask}`, state: "queued" }
  }
  const observeUnit = async (unit: UnitRow): Promise<Observed> => {
    bump("observeUnit")
    return observe.get(unit.id ?? "") ?? { provider: unit.provider, prs: [] }
  }
  const deps = {
    loadAllUnits: realLoadAllUnits,
    readMissions: realReadMissions,
    upsertUnit: realUpsertUnit,
    pruneTerminal: realPruneTerminal,
    observeUnit,
    startTask,
    dispatchOutbox: outbox,
    resolveAgentActor: async () => {
      bump("resolveAgentActor")
      return { login: "copilot[bot]" }
    },
    // Human-decision packet deps (fakes — createHumanRequest is real logic).
    findByKey: async () => {
      bump("findByKey")
      return undefined
    },
    buildDecisionPacket: () => {
      bump("buildDecisionPacket")
      return { html: "<html></html>", packetId: "packet", decisionId: "dec-1" }
    },
    writeDecisionPacketHtml: async () => {
      bump("writeDecisionPacketHtml")
      return path.join(dir, "packet.html")
    },
    upsertDecision: async () => {
      bump("upsertDecision")
    },
    // Model-answer side effects (approve → build, fix, etc.).
    submitReview: async () => {
      bump("submitReview")
    },
    postComment: async () => {
      bump("postComment")
    },
    markAnswered: async () => {
      bump("markAnswered")
    },
    // Any remaining GitHub dep is a hard error if the flow reaches it.
    ...(Object.fromEntries(
      [
        "classifyPlanReady",
        "classifyQuestionAnswerable",
        "classifyFixAddressed",
        "classifyStuck",
        "verifyAndConsumeApproval",
        "recordApproval",
        "followUpTask",
        "cancelTask",
        "createIssue",
        "resolveAgentRoster",
        "assignAgent",
        "findAgentPRs",
        "getPullRequestState",
        "requestReview",
        "rerunChecks",
        "mergePullRequest",
        "markReadyForReview",
      ].map((name) => [
        name,
        async (): Promise<never> => {
          bump(name)
          throw new Error(`unexpected dep ${name} in wired flow`)
        },
      ]),
    ) as Record<string, unknown>),
  } as unknown as ControllerDeps
  return { deps, calls }
}

async function seedMission(): Promise<void> {
  await upsertMission({
    id: "m1",
    goal: "ship the thing",
    acceptanceCriteria: "it works",
    repos: [repo],
    status: "active",
    createdMs: Date.now(),
    updatedMs: Date.now(),
  })
}

/** Drive one real advance as the lease holder, then route its result. */
async function driveAndRoute(
  deps: ControllerDeps,
  lease: SchedulerLease,
): Promise<Awaited<ReturnType<typeof advance>>> {
  const res = await advance(
    { driveGate: makeDriveGate(lease), answerQueue: inbox },
    deps,
  )
  await routeAdvanceResult(res, { escalation })
  return res
}

describe("first-mate wired-path E2E (real advance + real durable queues)", () => {
  test("decompose need → lead escalation → answer → drain+apply → dispatch once", async () => {
    await seedMission()
    const observe = new Map<string, Observed>()
    const { deps, calls } = makeDeps(observe)
    const lease = new SchedulerLease({ dir, ttlMs: 30_000 })

    // Tick 1: mission has no units → advance emits a `decompose` need, which
    // routeAdvanceResult escalates to the lead queue.
    const r1 = await driveAndRoute(deps, lease)
    expect(r1.drove).toBe(true)
    expect(r1.needsModel.map((m) => m.kind)).toContain("decompose")
    const esc1 = await escalation.list()
    expect(esc1.length).toBe(1)
    expect(esc1[0]?.target).toBe("lead")
    expect(esc1[0]?.kind).toBe("decompose")
    expect(esc1[0]?.requestId).toBe("decompose:m1")

    // The lead answers the decompose off-band (deferring), enqueuing to the inbox.
    const queued = await inbox.enqueue({
      modelAnswers: [
        {
          requestId: "decompose:m1",
          verdict: { units: [{ title: "unit one", repo: "o/wired" }] },
        },
      ],
    })
    expect(queued).toBe(1)

    // Tick 2: the holder drains the inbox, applies the decompose (creates the
    // unit on the REAL ledger), and — same tick — dispatches the new unit
    // through the durable Outbox. Exactly one external side effect.
    await driveAndRoute(deps, lease)
    const units = await readRepoLedger(repo)
    expect(units.length).toBe(1)
    expect(units[0]?.title).toBe("unit one")
    expect(units[0]?.taskId).not.toBeNull()
    expect(units[0]?.dispatch).toBeUndefined() // intent cleared after markDone
    expect(ghCount()).toBe(1)
    expect(calls.startTask).toBe(1)
    const outboxEntries = await outbox.list()
    expect(outboxEntries.length).toBe(1)
    expect(outboxEntries[0]?.status).toBe("done")

    // Tick 3: the unit is now in flight (queued, taskId set) — NOT undispatched.
    // A re-drive must not re-dispatch: the side effect stays at exactly one.
    observe.set(units[0]!.id!, { provider: "queued", prs: [] })
    await driveAndRoute(deps, lease)
    expect(ghCount()).toBe(1)
    expect(calls.startTask).toBe(1)
  })

  test("review_plan need → lead escalation → approve → drain+apply → build dispatch", async () => {
    await seedMission()
    const observe = new Map<string, Observed>()
    // A dispatched plan-mode unit whose plan task has completed and produced a
    // reviewable plan.
    const unit: UnitRow = {
      id: "u-plan",
      missionId: "m1",
      repo,
      issue: null,
      pr: null,
      taskId: "task-plan",
      agent: "copilot",
      botLogin: "copilot[bot]",
      dispatchMode: "plan",
      provider: "completed",
      phase: "plan",
      artifact: "no_pr",
      validation: "unknown",
      retries: 0,
      dependsOn: [],
      title: "u-plan",
    }
    await realUpsertUnit(repo, unit)
    observe.set("u-plan", {
      provider: "completed",
      prs: [],
      planReady: true,
      logExcerpt: "1. do X\n2. do Y",
    })
    const { deps, calls } = makeDeps(observe)
    const lease = new SchedulerLease({ dir, ttlMs: 30_000 })

    const r1 = await driveAndRoute(deps, lease)
    expect(r1.needsModel.map((m) => m.kind)).toContain("review_plan")
    const esc = await escalation.list()
    expect(esc.some((e) => e.kind === "review_plan" && e.target === "lead")).toBe(true)
    const reqId = r1.needsModel.find((m) => m.kind === "review_plan")!.requestId

    // Lead approves the plan off-band.
    await inbox.enqueue({ modelAnswers: [{ requestId: reqId, verdict: { decision: "approve" } }] })

    // After the build task is dispatched the next observation shows it queued
    // (no longer a completed plan), so the same-tick re-observe won't re-review.
    observe.set("u-plan", { provider: "queued", prs: [] })

    // Holder drains + applies: an approve re-dispatches a FRESH build task
    // (createPullRequest) carrying the plan, flipping the unit to build.
    await driveAndRoute(deps, lease)
    const [after] = await readRepoLedger(repo)
    expect(after?.phase).toBe("build")
    expect(after?.dispatchMode).toBe("build")
    expect(calls.startTask).toBe(1)
    expect(ghCount()).toBe(1)
  })

  test("needsHuman → human escalation queue", async () => {
    await seedMission()
    const observe = new Map<string, Observed>()
    const unit: UnitRow = {
      id: "u-multi",
      missionId: "m1",
      repo,
      issue: 7,
      pr: null,
      taskId: "task-multi",
      agent: "copilot",
      botLogin: "copilot[bot]",
      dispatchMode: "build",
      provider: "in_progress",
      phase: "build",
      artifact: "no_pr",
      validation: "unknown",
      retries: 0,
      dependsOn: [],
      title: "u-multi",
    }
    await realUpsertUnit(repo, unit)
    // Two PRs for one unit → the state machine escalates to a human.
    observe.set("u-multi", {
      provider: "in_progress",
      prs: [
        { number: 11, headSha: "a", isDraft: false, state: "OPEN" },
        { number: 12, headSha: "b", isDraft: false, state: "OPEN" },
      ],
    })
    const { deps } = makeDeps(observe)
    const lease = new SchedulerLease({ dir, ttlMs: 30_000 })

    const r1 = await driveAndRoute(deps, lease)
    expect(r1.needsHuman.length).toBe(1)
    const esc = await escalation.list()
    expect(esc.some((e) => e.target === "human")).toBe(true)
  })

  test("routeAdvanceResult auto-answers accepted model needs instead of escalating", async () => {
    // The auto-answer seam (Tier1) short-circuits an escalation: an accepted
    // model need is enqueued for the next tick, not surfaced to the lead.
    const enqueued: string[] = []
    const autoAnswer = async (req: ModelRequest): Promise<{ accepted: boolean }> => {
      if (req.kind === "author_fix") {
        enqueued.push(req.requestId)
        return { accepted: true }
      }
      return { accepted: false }
    }
    const summary = await routeAdvanceResult(
      {
        needsModel: [
          {
            requestId: "m1:1:author_fix",
            kind: "author_fix",
            missionId: "m1",
            repo,
            issue: 1,
            pr: 2,
            payload: {},
          },
          {
            requestId: "m1:1:review_plan",
            kind: "review_plan",
            missionId: "m1",
            repo,
            issue: 1,
            pr: null,
            payload: {},
          },
        ],
        needsHuman: [],
      },
      { escalation, autoAnswer },
    )
    expect(summary.autoAnswered).toBe(1)
    expect(summary.escalatedModel).toBe(1)
    expect(enqueued).toEqual(["m1:1:author_fix"])
    const esc = await escalation.list()
    expect(esc.map((e) => e.kind)).toEqual(["review_plan"])
  })
})
