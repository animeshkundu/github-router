/**
 * Tests for the live runner adapter (`runner-live.ts`) using FAKE primitives (no
 * git, no worker engine, no model calls), plus one full kernel integration over
 * the fakes. Verifies the load-bearing properties the gated E2E cannot assert
 * cheaply: worktree cleanup, diff-as-artifact retention, gate sealing, advisory
 * critic non-blocking, and an end-to-end orchestrated-wins selection.
 */

import { describe, expect, test } from "bun:test"

import { resolveSealedGate, sealedGateIds } from "../src/lib/orchestration/gate-registry"
import { executeWorkflow } from "../src/lib/orchestration/kernel"
import { type WorkflowIR, type WorkflowNode } from "../src/lib/orchestration/ir"
import { makeRunner } from "../src/lib/orchestration/runner"
import {
  buildLiveRunner,
  type LiveRunnerPrimitives,
  roleToWorkerMode,
} from "../src/lib/orchestration/runner-live"

const GATE = resolveSealedGate("default-ci")!
const CTX = { gate: GATE, baseWorkspace: "/base" }
const node = (role: WorkflowNode["role"]): WorkflowNode =>
  ({ id: role, role, inputs: [], gate: { kind: "none" }, onFail: "baseline" }) as WorkflowNode

/** A configurable fake primitive set with bookkeeping. */
function fakes(over: Partial<LiveRunnerPrimitives> = {}): {
  prim: LiveRunnerPrimitives
  created: string[]
  removed: string[]
  finalized: string[]
} {
  const created: string[] = []
  const removed: string[] = []
  const finalized: string[] = []
  let n = 0
  const prim: LiveRunnerPrimitives = {
    async createWorktree() {
      const dir = `/wt/${n++}`
      created.push(dir)
      return {
        dir,
        async finalize() {
          finalized.push(dir)
          return `diff@${dir}`
        },
        async remove() {
          removed.push(dir)
        },
      }
    },
    async runWorker() {
      return { text: "worker-done" }
    },
    async runCritic() {
      /* advisory noop */
    },
    async exec() {
      return { exitCode: 0 }
    },
    ...over,
  }
  return { prim, created, removed, finalized }
}

describe("roleToWorkerMode", () => {
  test("maps every producer role to a worker mode", () => {
    expect(roleToWorkerMode("baseline")).toBe("implement")
    expect(roleToWorkerMode("implement")).toBe("implement")
    expect(roleToWorkerMode("test")).toBe("test")
    expect(roleToWorkerMode("plan")).toBe("plan")
    expect(roleToWorkerMode("verify")).toBe("review")
    expect(roleToWorkerMode("research")).toBe("explore")
  })
})

describe("buildLiveRunner primitives", () => {
  test("prepareWorkspace creates a worktree and tracks it for cleanup", async () => {
    const { prim, created, removed } = fakes()
    const lr = buildLiveRunner(CTX, prim)
    const ws = await lr.deps.prepareWorkspace(node("implement"))
    expect(created).toEqual([ws])
    await lr.cleanup()
    expect(removed).toEqual([ws])
  })

  test("runWorker captures the worktree diff as the artifact", async () => {
    const { prim, finalized } = fakes()
    const lr = buildLiveRunner(CTX, prim)
    const ws = await lr.deps.prepareWorkspace(node("implement"))
    const r = await lr.deps.runWorker({ role: "implement", prompt: "go", workspace: ws })
    expect(r.artifact).toBe(`diff@${ws}`)
    expect(finalized).toEqual([ws])
  })

  test("runWorker on an untracked (read-node) workspace returns text as artifact", async () => {
    const { prim, finalized } = fakes()
    const lr = buildLiveRunner(CTX, prim)
    const r = await lr.deps.runWorker({ role: "research", prompt: "go", workspace: "/base" })
    expect(r.artifact).toBe("worker-done")
    expect(finalized).toEqual([])
  })

  test("runWorker passes a worker error through (infra failure path)", async () => {
    const { prim } = fakes({ async runWorker() {
      return { text: "boom", isError: true }
    } })
    const lr = buildLiveRunner(CTX, prim)
    const ws = await lr.deps.prepareWorkspace(node("implement"))
    const r = await lr.deps.runWorker({ role: "implement", prompt: "go", workspace: ws })
    expect(r.isError).toBe(true)
  })

  test("a finalize throw disqualifies the write node (infra failure, not text artifact)", async () => {
    const { prim } = fakes({
      async createWorktree() {
        return { dir: "/wt/x", finalize: async () => { throw new Error("no git") }, remove: async () => {} }
      },
    })
    const lr = buildLiveRunner(CTX, prim)
    const ws = await lr.deps.prepareWorkspace(node("implement"))
    const r = await lr.deps.runWorker({ role: "implement", prompt: "go", workspace: ws })
    expect(r.isError).toBe(true)
    expect(r.artifact).toBeUndefined()
  })

  test("runGate runs the sealed checks; a non-canonical gateId runs nothing", async () => {
    const ran: string[] = []
    const { prim } = fakes({ async exec({ command }) {
      ran.push(command)
      return { exitCode: 0 }
    } })
    const lr = buildLiveRunner(CTX, prim)
    const ok = await lr.deps.runGate({ gateId: "default-ci", workspace: "/wt/0" })
    expect([...ok.ran].sort()).toEqual(["lint", "test", "typecheck"])
    ran.length = 0
    const bad = await lr.deps.runGate({ gateId: "rogue", workspace: "/wt/0" })
    expect(bad.ran.size).toBe(0)
    expect(ran).toEqual([]) // never executed an unsealed command
  })

  test("runCritic is advisory: a throw never blocks", async () => {
    const { prim } = fakes({ async runCritic() {
      throw new Error("critic down")
    } })
    const lr = buildLiveRunner(CTX, prim)
    expect(await lr.deps.runCritic({ checkerLab: "google", prompt: "x", workspace: "/base" })).toEqual({ block: false })
  })

  test("cleanup is idempotent", async () => {
    const { prim, removed } = fakes()
    const lr = buildLiveRunner(CTX, prim)
    await lr.deps.prepareWorkspace(node("implement"))
    await lr.cleanup()
    await lr.cleanup()
    expect(removed.length).toBe(1)
  })
})

describe("buildLiveRunner + kernel integration (fakes)", () => {
  const ir: WorkflowIR = {
    rawAskHash: "h",
    acceptanceCriteriaHash: "ac",
    maxDepth: 1,
    nodes: [
      { id: "base", role: "baseline", inputs: [], gate: { kind: "executable", gateId: "default-ci" }, onFail: "baseline", producerLab: "anthropic" },
      { id: "impl", role: "implement", inputs: [], gate: { kind: "executable", gateId: "default-ci" }, onFail: "baseline", producerLab: "openai" },
      { id: "sel", role: "selector", inputs: ["base", "impl"], gate: { kind: "none" }, onFail: "baseline", judgesOnRawAsk: true },
    ],
  }
  const CANON = new Set(["typecheck", "test", "lint"])

  test("orchestrated wins on a strict superset and delivers its diff; worktrees cleaned", async () => {
    // baseline (first worktree) fails lint; orchestrated passes all three.
    const { prim, created, removed } = fakes({
      async exec({ command, cwd }) {
        const baselineDir = created[0]
        if (cwd === baselineDir && command.includes("lint")) return { exitCode: 1 }
        return { exitCode: 0 }
      },
    })
    const lr = buildLiveRunner(CTX, prim)
    const runner = makeRunner(lr.deps, { rawAsk: "do it", baseWorkspace: "/base", canonicalGate: { id: "default-ci", checks: CANON } })
    let outcome
    try {
      outcome = await executeWorkflow(ir, runner, { tiePolicy: "strict", canonicalGateIds: CANON, knownGateIds: sealedGateIds() })
    } finally {
      await lr.cleanup()
    }
    expect(outcome).toMatchObject({ status: "delivered", winner: "orchestrated", gatesPassed: true })
    // the delivered artifact is the orchestrated worktree's diff (second created).
    expect(outcome.status === "delivered" && outcome.artifact).toBe(`diff@${created[1]}`)
    // both worktrees were created and cleaned up.
    expect(created.length).toBe(2)
    expect(removed.sort()).toEqual([...created].sort())
  })

  test("a worker infra failure on the orchestrated branch ships the baseline", async () => {
    let calls = 0
    const { prim } = fakes({
      async runWorker() {
        calls += 1
        // baseline worker (first) succeeds; the orchestrated worker fails.
        return calls === 1 ? { text: "ok" } : { text: "boom", isError: true }
      },
    })
    const lr = buildLiveRunner(CTX, prim)
    const runner = makeRunner(lr.deps, { rawAsk: "do it", baseWorkspace: "/base", canonicalGate: { id: "default-ci", checks: CANON } })
    let outcome
    try {
      outcome = await executeWorkflow(ir, runner, { tiePolicy: "strict", canonicalGateIds: CANON, knownGateIds: sealedGateIds(), maxRetries: 0 })
    } finally {
      await lr.cleanup()
    }
    expect(outcome.status).toBe("baseline")
  })
})
