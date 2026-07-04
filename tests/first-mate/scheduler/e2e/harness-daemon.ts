#!/usr/bin/env bun
/**
 * E2E harness process (test-only). Runs the REAL fencing lease + durable outbox
 * + ledger OCC as a real OS process against a SCRATCH ledger dir, with GitHub
 * FAKED as local file ops. Never touches the live ledger.
 *
 * Config via env:
 *   E2E_DIR    scratch first-mate dir (also set as GH_ROUTER_FIRST_MATE_DIR)
 *   E2E_GH     fake-GitHub file; a "dispatch" appends its idempotency key here
 *   E2E_MODE   "drive" (daemon drives a scratch mission) | "writer" (raw commits)
 *              | "real-drive" (ONE real controller.advance() against fake GitHub,
 *                routed through the real EscalationQueue; crashes mid-dispatch
 *                when E2E_CRASH=after_sideeffect to prove exactly-once recovery)
 *   E2E_REPO   "owner/name" (default o/e2e)
 *   E2E_TTL_MS lease TTL (default 30000)
 *   E2E_CRASH  "after_sideeffect" → hard-exit(137) inside the outbox executor
 *              AFTER the fake side effect but BEFORE it is marked done
 *   E2E_WRITES writer mode: how many units to append
 *   E2E_ID     writer mode: unit id prefix (keeps two writers distinct)
 *
 * PATHS.FIRST_MATE_DIR reads the env lazily, so setting it in the body (after
 * imports) still points the ledger at the scratch dir before any write.
 */
import fs from "node:fs"

import {
  advance,
  type ControllerDeps,
  type ModelRequest,
  type HumanRequest,
} from "~/lib/first-mate/controller"
import { commitUnits, readRepoLedgerWithRev, upsertUnit } from "~/lib/first-mate/ledger"
import { upsertMission } from "~/lib/first-mate/registry"
import { EscalationQueue } from "~/lib/first-mate/scheduler/escalation"
import { installGracefulShutdown } from "~/lib/first-mate/scheduler/graceful-shutdown"
import { SchedulerDaemon } from "~/lib/first-mate/scheduler/daemon"
import { SchedulerLease, makeDriveGate } from "~/lib/first-mate/scheduler/lease"
import { Outbox } from "~/lib/first-mate/scheduler/outbox"
import { routeAdvanceResult } from "~/lib/first-mate/scheduler/index"
import type { RepoRef, UnitRow } from "~/lib/first-mate/types"

const dir = process.env.E2E_DIR
if (!dir) {
  process.stderr.write("E2E_DIR required\n")
  process.exit(2)
}
process.env.GH_ROUTER_FIRST_MATE_DIR = dir
process.env.GH_ROUTER_FM_OCC = process.env.GH_ROUTER_FM_OCC ?? "1"

function parseRepo(s: string): RepoRef {
  const [owner, name] = s.split("/")
  return { owner: owner ?? "o", name: name ?? "e2e" }
}

const repo = parseRepo(process.env.E2E_REPO ?? "o/e2e")
const ghFile = process.env.E2E_GH ?? `${dir}/fake-github.log`
const ttlMs = Number(process.env.E2E_TTL_MS ?? 30_000)

function mkUnit(id: string, phase: UnitRow["phase"]): UnitRow {
  return {
    missionId: "m1",
    repo,
    issue: null,
    pr: null,
    taskId: null,
    agent: "copilot",
    botLogin: "",
    dispatchMode: "plan",
    provider: "none",
    phase,
    artifact: "no_pr",
    validation: "unknown",
    retries: 0,
    dependsOn: [],
    title: id,
    id,
  }
}

async function runWriter(): Promise<void> {
  const n = Number(process.env.E2E_WRITES ?? 5)
  const prefix = process.env.E2E_ID ?? "w"
  for (let i = 0; i < n; i += 1) {
    await commitUnits(repo, (cur) => [...cur, mkUnit(`${prefix}-${i}`, "plan")])
  }
  process.exit(0)
}

async function runDriveDaemon(): Promise<void> {
  const outbox = new Outbox({ dir })
  const crash = process.env.E2E_CRASH === "after_sideeffect"

  const fakeAdvance = async (): Promise<{
    nextWakeSeconds: number | null
    activeUnits: number
    progressKey: string
  }> => {
    const { units } = await readRepoLedgerWithRev(repo)
    const u = units.find((x) => x.id === "u1")
    if (!u) {
      await commitUnits(repo, () => [mkUnit("u1", "plan")])
      return { nextWakeSeconds: 60, activeUnits: 1, progressKey: "seed" }
    }
    if (u.phase === "plan") {
      const key = `dispatch:${repo.owner}/${repo.name}#u1`
      await outbox.record({ key, kind: "dispatch" })
      await outbox.reconcile(async (entry) => {
        const existing = fs.existsSync(ghFile) ? fs.readFileSync(ghFile, "utf8") : ""
        if (existing.includes(entry.key)) return "already" // already applied → no re-do
        fs.appendFileSync(ghFile, `${entry.key}\n`) // <-- the fake side effect
        if (crash) process.exit(137) // crash AFTER side effect, BEFORE mark-done
        return "done"
      })
      // ledger write AFTER the dispatch side effect has settled
      await commitUnits(repo, (cur) =>
        cur.map((x) => (x.id === "u1" ? { ...x, phase: "build" } : x)),
      )
      return { nextWakeSeconds: 60, activeUnits: 1, progressKey: "build" }
    }
    if (u.phase === "build") {
      await commitUnits(repo, (cur) =>
        cur.map((x) => (x.id === "u1" ? { ...x, phase: "done", terminal: true } : x)),
      )
      return { nextWakeSeconds: null, activeUnits: 0, progressKey: "done" }
    }
    return { nextWakeSeconds: null, activeUnits: 0, progressKey: "done" }
  }

  const lease = new SchedulerLease({ dir, ttlMs })
  const daemon = new SchedulerDaemon({
    advance: fakeAdvance,
    lease,
    minBackoffMs: 30,
    maxBackoffMs: 100,
    delayOverrideMs: 40, // fast ticks for the harness
  })
  daemon.start()
  process.stdout.write("started\n")

  const shutdown = (): void => {
    void daemon.stop().finally(() => process.exit(0))
  }
  // Wire the SAME production teardown (SIGINT/SIGTERM + stdin EOF, once-guarded)
  // the daemon script uses, so this E2E exercises the real wiring rather than a
  // divergent copy. stdin EOF is the cross-platform kill switch the kill-switch
  // test relies on: Windows has no observable POSIX signal (an external SIGTERM
  // is a hard TerminateProcess), but the parent closing the stdin write end
  // fires 'end' identically on Windows named pipes and POSIX pipes.
  installGracefulShutdown({ onShutdown: shutdown })

  await new Promise<void>(() => {}) // keep alive
}

/**
 * Real-advance driver (test-only). Runs ONE `controller.advance()` as the lease
 * holder against a fake GitHub (startTask appends its idempotency key to the gh
 * log — the single external side effect), with the REAL durable Outbox and the
 * REAL EscalationQueue. With E2E_CRASH=after_sideeffect the fake startTask
 * hard-exits(137) AFTER the append but BEFORE the outbox is marked done, so a
 * restart must reconcile via the persisted dispatch-intent: it escalates the
 * interrupted dispatch to a human and NEVER re-dispatches (exactly-once).
 */
async function runRealDrive(): Promise<void> {
  const crash = process.env.E2E_CRASH === "after_sideeffect"
  const escalation = new EscalationQueue({ dir })

  // Seed a mission + one undispatched unit on first run (idempotent).
  await upsertMission({
    id: "m1",
    goal: "g",
    acceptanceCriteria: "ac",
    repos: [repo],
    status: "active",
    createdMs: Date.now(),
    updatedMs: Date.now(),
  })
  const { units: existing } = await readRepoLedgerWithRev(repo)
  if (!existing.some((u) => u.id === "u1")) {
    await upsertUnit(repo, mkUnit("u1", "plan"))
  }

  const fail =
    (name: string) =>
    async (): Promise<never> => {
      throw new Error(`unexpected dep ${name} in real-drive`)
    }
  const deps = {
    loadAllUnits: async () => (await readRepoLedgerWithRev(repo)).units,
    readMissions: async () => [
      {
        id: "m1",
        goal: "g",
        acceptanceCriteria: "ac",
        repos: [repo],
        status: "active" as const,
        createdMs: 0,
        updatedMs: 0,
      },
    ],
    upsertUnit,
    pruneTerminal: async () => {},
    dispatchOutbox: new Outbox({ dir }),
    resolveAgentActor: async () => ({ login: "copilot[bot]" }),
    startTask: async (_r: unknown, opts: { idempotencyKey?: string }) => {
      fs.appendFileSync(ghFile, `${opts.idempotencyKey ?? "?"}\n`) // the side effect
      if (crash) process.exit(137) // crash AFTER side effect, BEFORE mark-done
      return { taskId: "task-1", state: "queued" }
    },
    // Recovery path (restart): the interrupted dispatch is surfaced to a human.
    findByKey: async () => undefined,
    buildDecisionPacket: () => ({ html: "<html></html>", packetId: "p", decisionId: "d" }),
    writeDecisionPacketHtml: async () => `${dir}/packet.html`,
    upsertDecision: async () => {},
    observeUnit: fail("observeUnit"),
    classifyPlanReady: fail("classifyPlanReady"),
    classifyQuestionAnswerable: fail("classifyQuestionAnswerable"),
    classifyFixAddressed: fail("classifyFixAddressed"),
    classifyStuck: fail("classifyStuck"),
    verifyAndConsumeApproval: fail("verifyAndConsumeApproval"),
    recordApproval: fail("recordApproval"),
    markAnswered: fail("markAnswered"),
    followUpTask: fail("followUpTask"),
    cancelTask: fail("cancelTask"),
    createIssue: fail("createIssue"),
    resolveAgentRoster: fail("resolveAgentRoster"),
    assignAgent: fail("assignAgent"),
    findAgentPRs: fail("findAgentPRs"),
    getPullRequestState: fail("getPullRequestState"),
    postComment: fail("postComment"),
    submitReview: fail("submitReview"),
    requestReview: fail("requestReview"),
    rerunChecks: fail("rerunChecks"),
    mergePullRequest: fail("mergePullRequest"),
    markReadyForReview: fail("markReadyForReview"),
  } as unknown as ControllerDeps

  const lease = new SchedulerLease({ dir, ttlMs })
  // Poll until we actually hold the drive lease (a crashed prior holder's lease
  // only frees after its TTL). Only the drive path performs dispatch/recovery.
  const deadline = Date.now() + 20_000
  for (;;) {
    const res = await advance({ driveGate: makeDriveGate(lease) }, deps)
    if (res.drove) {
      await routeAdvanceResult(
        res as { needsModel: ModelRequest[]; needsHuman: HumanRequest[] },
        { escalation },
      )
      break
    }
    if (Date.now() > deadline) {
      process.stderr.write("real-drive never acquired lease\n")
      process.exit(3)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  process.stdout.write("advanced\n")
  process.exit(0)
}

const mode = process.env.E2E_MODE ?? "drive"
if (mode === "writer") await runWriter()
else if (mode === "real-drive") await runRealDrive()
else await runDriveDaemon()
