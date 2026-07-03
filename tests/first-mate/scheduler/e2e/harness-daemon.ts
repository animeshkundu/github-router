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

import { commitUnits, readRepoLedgerWithRev } from "~/lib/first-mate/ledger"
import { SchedulerDaemon } from "~/lib/first-mate/scheduler/daemon"
import { SchedulerLease } from "~/lib/first-mate/scheduler/lease"
import { Outbox } from "~/lib/first-mate/scheduler/outbox"
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
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)

  await new Promise<void>(() => {}) // keep alive
}

const mode = process.env.E2E_MODE ?? "drive"
if (mode === "writer") await runWriter()
else await runDriveDaemon()
