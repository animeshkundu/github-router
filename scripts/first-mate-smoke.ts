/* eslint-disable @typescript-eslint/no-explicit-any */
// Real-filesystem integration smoke for the first-mate controller.
// Uses the REAL ledger / registry / decisions / approval / state-machine over a
// temp FIRST_MATE_DIR; only the GitHub + model boundary is stubbed. Proves the
// durable persistence + re-hydration + dispatch + model-answer routing work on
// the real code path (not the mocked-deps unit tests).
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.GH_ROUTER_FIRST_MATE_DIR = mkdtempSync(path.join(tmpdir(), "fm-smoke-"))

const { advance, defaultDeps } = await import("../src/lib/first-mate/controller")
const { upsertMission } = await import("../src/lib/first-mate/registry")
const { upsertUnit, readRepoLedger } = await import("../src/lib/first-mate/ledger")

let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`) }
  else { fail += 1; console.log(`  FAIL  ${name}`) }
}

const repo = { owner: "octo", name: "smoke" }

// GitHub + model boundary stubs; everything else (ledger/registry/decisions) is real.
let observed: any = { provider: "in_progress", prs: [] }
const deps: any = {
  ...defaultDeps,
  observeUnit: async () => observed,
  classifyPlanReady: async () => ({ planReady: true, planExcerpt: "1. impl 2. test" }),
  classifyQuestionAnswerable: async () => null,
  classifyFixAddressed: async () => null,
  classifyStuck: async () => null,
  resolveAgentActor: async () => ({ login: "copilot-swe-agent", botId: "BOT_x" }),
  resolveAgentRoster: async () => new Map([["copilot", { login: "copilot-swe-agent", botId: "BOT_x" }]]),
  startTask: async () => ({ taskId: "task-smoke-1", state: "queued" }),
  followUpTask: async () => ({ ok: true as const }),
  createIssue: async () => ({ number: 101, nodeId: "I_x", url: "u" }),
  assignAgent: async () => ({ assigned: true as const, via: "graphql" as const }),
}

console.log("SMOKE 1 — empty world")
{
  const r = await advance({}, deps)
  check("empty board", Array.isArray(r.board) && r.board.length === 0)
  check("no model/human requests", r.needsModel.length === 0 && r.needsHuman.length === 0)
  check("nextWakeAt null on empty world", r.nextWakeAt === null)
}

console.log("SMOKE 2 — register mission + queued unit, then dispatch (real persistence)")
await upsertMission({
  id: "m-smoke", goal: "Add a widget", acceptanceCriteria: "widget renders",
  repos: [repo], status: "active", createdMs: 1, updatedMs: 1,
} as any)
await upsertUnit(repo, {
  missionId: "m-smoke", repo, issue: null, pr: null, taskId: null,
  agent: "copilot", botLogin: "copilot-swe-agent", dispatchMode: "plan",
  provider: "none", phase: "plan", artifact: "no_pr", validation: "unknown",
  retries: 0, dependsOn: [], title: "widget",
} as any)
{
  const r = await advance({}, deps)
  const persisted = await readRepoLedger(repo)
  const u = persisted[0]
  console.log("    [diag] unit after dispatch:", JSON.stringify({ issue: u?.issue, taskId: u?.taskId, provider: u?.provider, phase: u?.phase, dispatchMode: u?.dispatchMode }))
  check("unit dispatched (issue or taskId set + provider queued)", (u?.taskId != null || u?.issue != null) && u?.provider === "queued")
  check("board shows the mission", r.board.some((b: any) => b.missionId === "m-smoke"))
}

console.log("SMOKE 3 — re-hydrate from disk (simulated restart) + plan review")
observed = { provider: "completed", prs: [] } // agent finished planning, no PR yet
{
  // Fresh advance() = a new wake; state comes ONLY from disk (re-hydration).
  const r = await advance({}, deps)
  const rp = r.needsModel.find((m: any) => m.kind === "review_plan")
  console.log("    [diag] review_plan req:", JSON.stringify(rp && { requestId: rp.requestId, payloadKeys: Object.keys(rp.payload ?? {}), payload: rp.payload }))
  check("re-hydrated unit surfaces review_plan", rp !== undefined)
  check("review_plan payload carries the plan excerpt", typeof rp?.payload?.plan_excerpt === "string")

  // Approve the plan (model answer routing over the real ledger).
  if (rp) {
    await advance({ modelAnswers: [{ requestId: rp.requestId, verdict: { decision: "approve" } }] }, deps)
    const persisted = await readRepoLedger(repo)
    console.log("    [diag] unit after approve:", JSON.stringify({ phase: persisted[0]?.phase, dispatchMode: persisted[0]?.dispatchMode }))
    check("approve flips unit to build phase (persisted)", persisted[0]?.phase === "build")
    check("dispatchMode persisted as build", persisted[0]?.dispatchMode === "build")
  }
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
