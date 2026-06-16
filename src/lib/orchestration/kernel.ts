/**
 * The frozen orchestration kernel — executes a VERIFIED `WorkflowIR` and enforces
 * the floor invariants at runtime. The LLM never drives this loop; it is code.
 *
 * The kernel is parameterised by an injected `NodeRunner` so the orchestration
 * logic here (verify → run the baseline first → schedule the orchestrated DAG →
 * handle gate failures (loop / fail-to-baseline / escalate) → champion-retention
 * selection) is pure and unit-testable, while the side-effecting runner (git
 * worktrees, running the SEALED gates, model calls) is a separate integration
 * slice that can't fabricate a floor-violating result the kernel would accept.
 *
 * Invariants enforced here: 1 (baseline always runs first + champion-retention),
 * 2 (selection is over executable gate outcomes), 3 (infra failure ships the
 * baseline, never halts — UNLESS the baseline itself can't be produced, the one
 * case where there is no floor to fall to), 4 (selection via `selectChampion` on
 * the canonical gates). The delivered/baseline outcomes surface `gatesPassed` so
 * the caller (and the Phase-0 Stop-hook) can refuse a gate-failing artifact.
 * See `docs/agent-orchestration-design.md`.
 */

import { type WorkflowIR, type WorkflowNode } from "./ir"
import { selectChampion, type GateOutcome, type TiePolicy } from "./select"
import { verifyWorkflowIR, type IRViolation } from "./verify"

/** What the injected runner returns for one node. The runner owns all side
 *  effects; the kernel only reads these fields. */
export interface NodeRunResult {
  /** Did the node's gate pass? (Ungated nodes: true.) For the baseline and the
   *  orchestrated candidate this means "passes all of its canonical gates" and
   *  is surfaced to the caller as `gatesPassed`. */
  ok: boolean
  /** Executable-gate outcome (for gated nodes) — fed to champion-retention. */
  gate?: GateOutcome
  /** Opaque artifact reference (e.g. a commit SHA / worktree path). */
  artifact?: string
  /**
   * `true` ⇒ a CHECK/INFRA failure (critic unavailable, budget exhausted, gate
   * runner crashed) → ship the baseline, never halt (invariant 3). `false`/absent
   * with `ok:false` ⇒ an ARTIFACT failure → the node's `onFail` policy applies.
   */
  infraFailure?: boolean
}

export interface NodeRunner {
  /** Run `node` given its already-completed inputs. Must never throw for an
   *  ordinary failure — report it via `NodeRunResult` (the kernel treats a thrown
   *  error as an infra failure → baseline). */
  runNode(
    node: WorkflowNode,
    inputs: ReadonlyMap<string, NodeRunResult>,
  ): Promise<NodeRunResult>
}

export interface KernelOpts {
  /** The floor-vs-upside tie-break (see `selectChampion`) — an explicit product
   *  decision, no default. */
  tiePolicy: TiePolicy
  /** The authoritative raw-ask executable gate ids the selection runs over. */
  canonicalGateIds: ReadonlySet<string>
  /** The kernel's sealed-gate registry, threaded into IR verification. */
  knownGateIds?: ReadonlySet<string>
  /** Retries ATTEMPTED AFTER the first attempt for an artifact failure on an
   *  `onFail:"loop"` node, and for an infra failure on the baseline. Total
   *  attempts = 1 + maxRetries. */
  maxRetries?: number
}

export type KernelOutcome =
  | { status: "rejected"; violations: IRViolation[] }
  | { status: "delivered"; winner: "orchestrated" | "baseline"; artifact?: string; reason: string; gatesPassed: boolean }
  | { status: "baseline"; reason: string; artifact?: string; gatesPassed: boolean }
  | { status: "escalated"; reason: string; nodeId?: string }

const DEFAULT_MAX_RETRIES = 2

export async function executeWorkflow(
  ir: WorkflowIR,
  runner: NodeRunner,
  opts: KernelOpts,
): Promise<KernelOutcome> {
  // ---- 0. only a VERIFIED IR is ever executed ----
  const verdict = verifyWorkflowIR(ir, { knownGateIds: opts.knownGateIds })
  if (!verdict.ok) return { status: "rejected", violations: verdict.violations }

  const byId = new Map(ir.nodes.map((n) => [n.id, n]))
  const baselineNode = ir.nodes.find((n) => n.role === "baseline")!
  const selectorNode = ir.nodes.find((n) => n.role === "selector")!
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const results = new Map<string, NodeRunResult>()

  const run = async (node: WorkflowNode): Promise<NodeRunResult> => {
    const inputs = new Map<string, NodeRunResult>()
    for (const ref of node.inputs) {
      const r = results.get(ref)
      if (r) inputs.set(ref, r)
    }
    try {
      return await runner.runNode(node, inputs)
    } catch {
      // A thrown error is treated as an infra failure (fail-to-baseline), never
      // a crash of the whole run.
      return { ok: false, infraFailure: true }
    }
  }

  // ---- 1. the baseline (the floor) ALWAYS runs first, off the chain, with
  //         retries on transient infra failure ----
  let baseRes = await run(baselineNode)
  for (let t = 0; baseRes.infraFailure && t < maxRetries; t += 1) baseRes = await run(baselineNode)
  if (baseRes.infraFailure) {
    // The floor itself couldn't be produced — there is nothing safe to ship.
    // This is the ONE case where the kernel escalates instead of shipping the
    // baseline (there is no baseline to ship).
    return { status: "escalated", reason: "baseline (the floor) could not run", nodeId: baselineNode.id }
  }
  results.set(baselineNode.id, baseRes)

  /** Every fall-to-baseline path goes through here so the baseline's gate status
   *  (`gatesPassed`) is always surfaced — the caller refuses a broken floor. */
  const shipBaseline = (reason: string): KernelOutcome => ({
    status: "baseline",
    reason,
    artifact: baseRes.artifact,
    gatesPassed: baseRes.ok,
  })

  // ---- 2. schedule the orchestrated DAG in dependency order ----
  const remaining = new Set(
    ir.nodes.filter((n) => n.role !== "selector" && n.role !== "baseline").map((n) => n.id),
  )
  while (remaining.size > 0) {
    const readyId = [...remaining].find((id) =>
      byId.get(id)!.inputs.every((ref) => results.has(ref)),
    )
    // The IR is verified acyclic + reachable, so a stall can't normally happen;
    // treat it as unschedulable rather than spin.
    if (readyId === undefined) {
      return { status: "escalated", reason: "workflow is unschedulable (dependency deadlock)" }
    }
    const node = byId.get(readyId)!

    let res = await run(node)
    for (let t = 0; !res.ok && !res.infraFailure && node.onFail === "loop" && t < maxRetries; t += 1) {
      res = await run(node)
    }

    if (!res.ok) {
      // infra failure OR an artifact failure whose policy is fail-to-baseline.
      if (res.infraFailure || node.onFail === "baseline") {
        return shipBaseline(
          res.infraFailure
            ? `infra failure at "${node.id}" — shipped the baseline`
            : `node "${node.id}" failed its gate — shipped the baseline`,
        )
      }
      // onFail === "escalate" (or "loop" exhausted) — surface it.
      return { status: "escalated", reason: `node "${node.id}" failed its gate`, nodeId: node.id }
    }
    results.set(readyId, res)
    remaining.delete(readyId)
  }

  // ---- 3. champion-retention selection at the sink ----
  // The verifier guarantees exactly one orchestrated input; assert it as
  // defense-in-depth so a verifier gap can never silently pick the wrong branch.
  const orchestratedInputIds = selectorNode.inputs.filter((id) => byId.get(id)?.role !== "baseline")
  if (orchestratedInputIds.length !== 1) {
    return { status: "escalated", reason: `selector must have exactly one orchestrated input (got ${orchestratedInputIds.length})` }
  }
  const orchestratedRes = results.get(orchestratedInputIds[0]!)
  if (!baseRes.gate || !orchestratedRes?.gate) {
    // No executable outcomes to compare — do no harm, ship the baseline.
    return shipBaseline("no executable gate outcome to compare — shipped the baseline")
  }

  const decision = selectChampion(orchestratedRes.gate, baseRes.gate, opts.canonicalGateIds, opts.tiePolicy)
  const winnerRes = decision.winner === "orchestrated" ? orchestratedRes : baseRes
  return {
    status: "delivered",
    winner: decision.winner,
    artifact: winnerRes.artifact,
    reason: decision.reason,
    gatesPassed: winnerRes.ok,
  }
}
