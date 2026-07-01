/* eslint-disable @typescript-eslint/no-explicit-any */
// Real-filesystem integration smoke for the first-mate controller.
// Uses the REAL ledger / registry / state-machine over a temp FIRST_MATE_DIR;
// only the GitHub + model boundary is stubbed. Proves the durable persistence,
// re-hydration, the decompose (mission→units) step, and dispatch on the real
// code path (not the mocked-deps unit tests).
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.GH_ROUTER_FIRST_MATE_DIR = mkdtempSync(path.join(tmpdir(), "fm-smoke-"))

const { advance, defaultDeps } = await import("../src/lib/first-mate/controller")
const { upsertMission } = await import("../src/lib/first-mate/registry")
const { readRepoLedger } = await import("../src/lib/first-mate/ledger")

let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`) }
  else { fail += 1; console.log(`  FAIL  ${name}`) }
}

const repo = { owner: "octo", name: "smoke" }

// GitHub + model boundary stubs; ledger/registry/decisions are REAL.
const deps: any = {
  ...defaultDeps,
  observeUnit: async () => ({ provider: "in_progress", prs: [] }),
  classifyPlanReady: async () => null,
  classifyQuestionAnswerable: async () => null,
  classifyFixAddressed: async () => null,
  classifyStuck: async () => null,
  resolveAgentActor: async () => ({ login: "copilot-swe-agent", botId: "BOT_x" }),
  resolveAgentRoster: async () => new Map([["copilot", { login: "copilot-swe-agent", botId: "BOT_x" }]]),
  startTask: async () => ({ taskId: `task-${Math.floor(Math.random() * 1e6)}`, state: "queued" }),
  followUpTask: async () => ({ ok: true as const }),
  createIssue: async () => ({ number: 101, nodeId: "I_x", url: "u" }),
  assignAgent: async () => ({ assigned: true as const, via: "graphql" as const }),
}

console.log("SMOKE 1 — empty world (edge)")
{
  const r = await advance({}, deps)
  check("empty board", r.board.length === 0)
  check("no requests + null wake", r.needsModel.length === 0 && r.needsHuman.length === 0 && r.nextWakeAt === null)
}

console.log("SMOKE 2 — register mission → advance emits a decompose request (real registry)")
await upsertMission({
  id: "m-smoke", goal: "Add a widget", acceptanceCriteria: "widget renders",
  repos: [repo], status: "active", createdMs: 1, updatedMs: 1,
} as any)
{
  const r = await advance({}, deps)
  const dec = r.needsModel.find((m: any) => m.kind === "decompose")
  console.log("    [diag] decompose req:", dec && JSON.stringify({ id: dec.requestId, goal: (dec.payload || {}).goal }))
  check("decompose request emitted for the unit-less mission", dec?.requestId === "decompose:m-smoke")
  check("board includes the (unit-less) mission", r.board.some((b: any) => b.missionId === "m-smoke"))
}

console.log("SMOKE 3 — answer decompose → units created + dispatched + persisted to the real ledger")
{
  await advance({
    modelAnswers: [{
      requestId: "decompose:m-smoke",
      verdict: { units: [{ title: "impl widget" }, { title: "test widget", dependsOn: [] }] },
    }],
  }, deps)
  const persisted = await readRepoLedger(repo)
  console.log("    [diag] persisted units:", JSON.stringify(persisted.map((u: any) => ({ title: u.title, id: !!u.id, taskId: u.taskId, provider: u.provider }))))
  check("2 units persisted to disk (no duplication)", persisted.length === 2)
  check("each unit has a stable id", persisted.every((u: any) => typeof u.id === "string" && u.id.length > 0))
  check("units dispatched in the same wake (taskId set)", persisted.every((u: any) => u.taskId !== null || u.issue !== null))
  check("titles round-tripped", persisted.map((u: any) => u.title).sort().join(",") === "impl widget,test widget")
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
