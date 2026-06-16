/**
 * The LIVE adapter for the kernel's NodeRunner primitives. buildLiveRunner wires
 * the four injected RunnerDeps to real side effects: a git worktree per write
 * producer, the worker engine for the producing step, the SEALED gate runner for
 * the executable gate, and a cross-lab persona for the advisory critic.
 *
 * The side-effecting primitives are themselves INJECTED here (createWorktree,
 * runWorker, runCritic, exec) so this role-to-side-effect wiring is unit-testable
 * with fakes (cleanup, artifact retention, gate sealing, fail-to-baseline). The
 * genuinely live composition (real createWorktree, runWorkerAgent, liveExec,
 * dispatchModelCall) is assembled in the run_workflow MCP tool and exercised only
 * by the gated E2E.
 *
 * Worktree lifecycle (the load-bearing bit): a write producer gets a fresh
 * worktree, the worker edits it IN PLACE, the gate runs in that same tree, and
 * the worker's changes are captured as a DIFF artifact via finalize() BEFORE any
 * cleanup, so KernelOutcome.artifact never points at a removed directory. Every
 * handle is tracked and removed by cleanup() AFTER executeWorkflow returns (win
 * or lose), not at end-of-node, because the artifact path would otherwise be dead
 * while the selector still references it.
 */

import { type CheckSpec, type ExecFn, runGateChecks } from "./gate-runner"
import { type SealedGate } from "./gate-registry"
import { type WorkflowNode } from "./ir"
import { type RunnerDeps } from "./runner"
import { type GateOutcome } from "./select"

/** The worker-engine tool surfaces this adapter routes roles to. */
export type WorkerMode = "explore" | "review" | "plan" | "implement" | "test"

/** A minimal worktree handle (the subset of the worker-agent WorktreeHandle this
 *  adapter needs). Injected so tests can fake it. */
export interface LiveWorktreeHandle {
  dir: string
  finalize: () => Promise<string>
  remove: () => Promise<void>
}

export interface LiveRunnerPrimitives {
  /** Create a fresh isolated worktree off the base workspace. */
  createWorktree: () => Promise<LiveWorktreeHandle>
  /** Run a worker of `mode` on `prompt` in `workspace` (edits in place). */
  runWorker: (input: {
    mode: WorkerMode
    prompt: string
    workspace: string
  }) => Promise<{ text: string; isError?: boolean }>
  /** Run a cross-lab critic (advisory) on an artifact (the producer's diff). May
   *  throw; the adapter swallows it. */
  runCritic: (input: { checkerLab: string; prompt: string; artifact: string }) => Promise<void>
  /** Run one sealed check command in a cwd. */
  exec: ExecFn
}

export interface LiveRunnerCtx {
  /** The sealed gate every write producer is judged over. */
  gate: SealedGate
  /** Base workspace path for read-only nodes. */
  baseWorkspace: string
}

/** Map a node role to the worker-engine mode. `baseline` is pre-mapped to
 *  `implement` by the reference runner, but handle it here too for safety. */
export function roleToWorkerMode(role: WorkflowNode["role"]): WorkerMode {
  switch (role) {
    case "baseline":
    case "implement":
      return "implement"
    case "test":
      return "test"
    case "plan":
      return "plan"
    case "verify":
      return "review"
    case "research":
      return "explore"
    default:
      return "explore"
  }
}

export interface LiveRunner {
  deps: RunnerDeps
  /** Remove every worktree created during the run. Idempotent; never throws. */
  cleanup: () => Promise<void>
}

export function buildLiveRunner(ctx: LiveRunnerCtx, prim: LiveRunnerPrimitives): LiveRunner {
  const handles: LiveWorktreeHandle[] = []
  const byDir = new Map<string, LiveWorktreeHandle>()
  const checks: ReadonlyArray<CheckSpec> = ctx.gate.checks

  const deps: RunnerDeps = {
    async prepareWorkspace(_node: WorkflowNode): Promise<string> {
      // Only called for write producers (baseline/implement/test/integration);
      // read nodes use ctx.baseWorkspace directly via the reference runner.
      const h = await prim.createWorktree()
      handles.push(h)
      byDir.set(h.dir, h)
      return h.dir
    },

    async runWorker({ role, prompt, workspace }) {
      const r = await prim.runWorker({ mode: roleToWorkerMode(role), prompt, workspace })
      if (r.isError) return { text: r.text, isError: true }
      const h = byDir.get(workspace)
      if (h) {
        // A write producer's artifact MUST be the diff. If finalize() fails we
        // cannot produce an appliable artifact even though the worker may have
        // edited the tree (and the gate may pass), so DISQUALIFY the candidate as
        // an infra failure rather than ship un-appliable worker text. The kernel
        // then ships the baseline (floor preserved).
        try {
          return { text: r.text, artifact: await h.finalize() }
        } catch {
          return { text: r.text, isError: true }
        }
      }
      // Read node: the worker's text IS the artifact (no worktree to diff).
      return { text: r.text, artifact: r.text }
    },

    async runGate({ gateId, workspace }): Promise<GateOutcome> {
      // Defense in depth: the kernel only ever passes the canonical gate id, but
      // never run anything other than the resolved sealed command set.
      if (gateId !== ctx.gate.id) return { passed: new Set(), ran: new Set() }
      return runGateChecks(checks, workspace, prim.exec)
    },

    async runCritic({ checkerLab, prompt, workspace }) {
      // Advisory only: a critic failure never blocks (invariant 2). The reference
      // runner passes the producer's artifact (a diff in the live path) as
      // `workspace`, so the critic sees what it reviews.
      try {
        await prim.runCritic({ checkerLab, prompt, artifact: workspace })
      } catch {
        // swallow; the executable gate is the authority.
      }
      return { block: false }
    },
  }

  return {
    deps,
    async cleanup() {
      for (const h of handles) {
        try {
          await h.remove()
        } catch {
          // best-effort; a leaked worktree is swept by the worker-agent age sweep.
        }
      }
      handles.length = 0
      byDir.clear()
    },
  }
}
