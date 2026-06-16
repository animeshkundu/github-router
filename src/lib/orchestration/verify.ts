/**
 * Static verifier for the workflow IR. This is what `decompose`'s output is
 * checked against (and what Claude calls pre-flight) BEFORE the frozen kernel
 * executes it — the load-bearing v6 correction: the floor invariants live in
 * code that validates the IR, never in prose an LLM is trusted to honor.
 *
 * It checks the invariants that are STATICALLY decidable on the IR's structure,
 * and treats the IR as fully untrusted input (it never throws on a malformed
 * shape — it reports a violation). The kernel enforces the runtime ones
 * (running the sealed gates, forking the baseline worktree, the `git diff`
 * gate-immutability check, the superset-selection, and the recursion depth
 * BUDGET — `maxDepth` here is a declared ceiling the kernel decrements per
 * nesting level; a single IR can't bound runtime recursion on its own). See
 * `./ir` for the 8 invariants and the design doc.
 *
 * Hardened after a two-lab adversarial review (gpt-5.3-codex + gemini-3.1-pro):
 * topological reachability (no orphaned producer can dodge the selector),
 * runtime enum validation, producerLab required for cross_lab gates, the
 * selector must fail-to-baseline, and an optional sealed-gate allowlist.
 */

import { MAX_RECURSION_DEPTH, type WorkflowIR, type WorkflowNode } from "./ir"

export interface IRViolation {
  /** Stable machine code (e.g. "NO_BASELINE") so callers can branch / dedupe. */
  code: string
  message: string
  /** The offending node id, when the violation is node-scoped. */
  nodeId?: string
}

export interface IRVerifyResult {
  ok: boolean
  violations: IRViolation[]
}

export interface VerifyOpts {
  /**
   * The kernel's allowlist of sealed executable gate ids. When provided, every
   * `executable` gate's `gateId` MUST be in it (gate-immutability, invariant 5 —
   * a non-empty string alone could smuggle an unsealed id). Omit only before the
   * registry is available; the non-empty-string check still applies either way.
   */
  knownGateIds?: ReadonlySet<string>
}

const VALID_ROLES: ReadonlySet<string> = new Set([
  "research", "plan", "implement", "review", "test", "verify",
  "baseline", "selector", "integration",
])
const VALID_GATE_KINDS: ReadonlySet<string> = new Set(["executable", "cross_lab", "none"])
const VALID_ON_FAIL: ReadonlySet<string> = new Set(["loop", "baseline", "escalate"])

export function verifyWorkflowIR(ir: WorkflowIR, opts: VerifyOpts = {}): IRVerifyResult {
  const v: IRViolation[] = []
  const push = (code: string, message: string, nodeId?: string): void => {
    v.push(nodeId === undefined ? { code, message } : { code, message, nodeId })
  }

  if (!ir || typeof ir !== "object") {
    return { ok: false, violations: [{ code: "BAD_IR", message: "IR is not an object" }] }
  }

  const rawNodes = Array.isArray(ir.nodes) ? ir.nodes : []

  // ---- envelope ----
  if (typeof ir.rawAskHash !== "string" || ir.rawAskHash.length === 0) {
    push("MISSING_HASH", "rawAskHash is required (the selector judges against the raw ask)")
  }
  if (
    typeof ir.acceptanceCriteriaHash !== "string"
    || ir.acceptanceCriteriaHash.length === 0
  ) {
    push("MISSING_HASH", "acceptanceCriteriaHash is required")
  }
  if (
    typeof ir.maxDepth !== "number"
    || !Number.isInteger(ir.maxDepth)
    || ir.maxDepth < 1
    || ir.maxDepth > MAX_RECURSION_DEPTH
  ) {
    push("BAD_MAX_DEPTH", `maxDepth must be an integer in [1, ${MAX_RECURSION_DEPTH}]`)
  }
  if (rawNodes.length === 0) {
    push("EMPTY", "workflow has no nodes")
    return { ok: false, violations: v }
  }

  // ---- per-node shape validation (treat the IR as untrusted; never throw) ----
  // Only structurally-sound nodes flow into the topology checks below; a
  // malformed node yields a violation rather than a thrown exception.
  const nodes: WorkflowNode[] = []
  const ids = new Set<string>()
  for (let i = 0; i < rawNodes.length; i += 1) {
    const n = rawNodes[i] as Partial<WorkflowNode> | null | undefined
    if (!n || typeof n !== "object") {
      push("BAD_NODE", `node at index ${i} is not an object`)
      continue
    }
    if (typeof n.id !== "string" || n.id.length === 0) {
      push("BAD_ID", `node at index ${i} has no non-empty string id`)
      continue
    }
    if (ids.has(n.id)) {
      push("DUP_ID", `duplicate node id "${n.id}"`, n.id)
      continue
    }
    if (!Array.isArray(n.inputs)) {
      push("BAD_NODE", `node "${n.id}" inputs must be an array`, n.id)
      continue
    }
    if (typeof n.role !== "string" || !VALID_ROLES.has(n.role)) {
      push("BAD_ROLE", `node "${n.id}" has invalid role "${String(n.role)}"`, n.id)
      continue
    }
    if (!n.gate || typeof n.gate !== "object" || !VALID_GATE_KINDS.has(String(n.gate.kind))) {
      push("BAD_GATE", `node "${n.id}" has an invalid gate.kind`, n.id)
      continue
    }
    if (typeof n.onFail !== "string" || !VALID_ON_FAIL.has(n.onFail)) {
      push("BAD_ON_FAIL", `node "${n.id}" onFail must be loop|baseline|escalate (got "${String(n.onFail)}")`, n.id)
      continue
    }
    ids.add(n.id)
    nodes.push(n as WorkflowNode)
  }
  if (nodes.length === 0) {
    push("EMPTY", "no well-formed nodes")
    return { ok: false, violations: v }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]))

  // ---- input refs + gate detail (gate-immutability, cross-lab) ----
  for (const n of nodes) {
    for (const ref of n.inputs) {
      if (!ids.has(ref)) push("BAD_INPUT_REF", `node "${n.id}" references unknown input "${ref}"`, n.id)
    }
    const g = n.gate
    if (g.kind === "executable") {
      if (typeof g.gateId !== "string" || g.gateId.length === 0) {
        push("BAD_GATE", `executable gate on node "${n.id}" must reference a sealed gateId (gate-immutability)`, n.id)
      } else if (opts.knownGateIds && !opts.knownGateIds.has(g.gateId)) {
        push("UNKNOWN_GATE_ID", `executable gate on node "${n.id}" references gateId "${g.gateId}" not in the kernel's sealed-gate registry`, n.id)
      }
    }
    if (g.kind === "cross_lab") {
      if (typeof g.checkerLab !== "string" || g.checkerLab.length === 0) {
        push("BAD_GATE", `cross_lab gate on node "${n.id}" must name a checkerLab`, n.id)
      }
      if (typeof n.producerLab !== "string" || n.producerLab.length === 0) {
        // Without producerLab the cross-lab requirement can't be verified — so a
        // node could be checked by its own lab undetected. Require it.
        push("MISSING_PRODUCER_LAB", `node "${n.id}" has a cross_lab gate but no producerLab — the cross-lab check can't be verified`, n.id)
      } else if (typeof g.checkerLab === "string" && n.producerLab === g.checkerLab) {
        push("SAME_LAB_CHECK", `node "${n.id}" is checked by its own lab "${n.producerLab}" — the check must cross a different lab`, n.id)
      }
    }
  }

  const cyclic = hasCycle(nodes, byId)
  if (cyclic) push("CYCLE", "workflow graph has a cycle (must be a DAG)")

  // ---- invariant 1: parallel baseline (champion-retention) ----
  const baselines = nodes.filter((n) => n.role === "baseline")
  if (baselines.length === 0) {
    push("NO_BASELINE", "no baseline node — champion-retention requires a single-strong-model branch on the raw ask")
  } else if (baselines.length > 1) {
    push("MULTI_BASELINE", "more than one baseline node")
  }
  for (const b of baselines) {
    if (b.inputs.length > 0) {
      push("BASELINE_HAS_INPUTS", `baseline "${b.id}" must run on the raw ask (no inputs — off the orchestration chain)`, b.id)
    }
  }

  // ---- invariants 1 + 3 + 4: the selector is the raw-ask, fail-to-baseline sink ----
  const selectors = nodes.filter((n) => n.role === "selector")
  if (selectors.length === 0) {
    push("NO_SELECTOR", "no selector node — the floor guarantee delivers max(orchestrated, baseline)")
  } else if (selectors.length > 1) {
    push("MULTI_SELECTOR", "more than one selector node")
  }
  const dependedOn = new Set<string>()
  for (const n of nodes) for (const ref of n.inputs) dependedOn.add(ref)
  const roleById = new Map(nodes.map((n) => [n.id, n.role]))
  for (const s of selectors) {
    if (s.judgesOnRawAsk !== true) {
      push("SELECTOR_NOT_RAW_ASK", `selector "${s.id}" must judge on the RAW ask + blessed AC (judgesOnRawAsk: true), not a derived AC`, s.id)
    }
    if (s.onFail !== "baseline") {
      // invariant 3 — even when orchestration fails, the floor is the baseline,
      // not a halt/escalate that strands the run with nothing delivered.
      push("SELECTOR_ONFAIL_NOT_BASELINE", `selector "${s.id}" must fail to baseline (onFail: "baseline")`, s.id)
    }
    const inputRoles = s.inputs.map((id) => roleById.get(id))
    if (!inputRoles.includes("baseline")) {
      push("SELECTOR_MISSING_BASELINE_INPUT", `selector "${s.id}" must take the baseline as an input`, s.id)
    }
    // An "orchestrated candidate" is any input that is neither the baseline nor
    // another selector — a producer in the single-branch case, or the
    // `integration` node's assembled output in the coupled case. The selector
    // compares the baseline against EXACTLY ONE such candidate (route coupled
    // producers through an integration node); more than one is ambiguous and
    // lets the kernel silently compare only one branch.
    const orchestratedInputs = (s.inputs ?? []).filter((id) => {
      const r = roleById.get(id)
      return r !== undefined && r !== "baseline" && r !== "selector"
    })
    if (orchestratedInputs.length === 0) {
      push("SELECTOR_NO_ORCHESTRATED_INPUT", `selector "${s.id}" must take at least one orchestrated candidate (a producer or the integration output) as an input`, s.id)
    } else if (orchestratedInputs.length > 1) {
      push("SELECTOR_MULTIPLE_ORCHESTRATED", `selector "${s.id}" must take exactly one orchestrated candidate (route coupled producers through an integration node); got ${orchestratedInputs.length}`, s.id)
    }
    if (dependedOn.has(s.id)) {
      push("SELECTOR_NOT_TERMINAL", `selector "${s.id}" must be terminal (nothing may depend on it)`, s.id)
    }
  }

  // ---- topology: every node must feed the single selector sink (no orphans) ----
  // This is what makes the selector/integration checks SOUND: a disconnected
  // dummy can't satisfy "has an orchestrated input" while the real producers are
  // orphaned and never compared to baseline. Skipped on a cyclic graph (already
  // flagged) since reachability is meaningless there.
  if (!cyclic && selectors.length === 1) {
    const sink = selectors[0]!
    const feedsSink = collectAncestors(sink.id, byId)
    for (const n of nodes) {
      if (n.id === sink.id) continue
      if (!feedsSink.has(n.id)) {
        push("ORPHAN_NODE", `node "${n.id}" does not feed the selector (the workflow's single delivery sink)`, n.id)
      }
    }
  }

  // ---- invariant 7: coupled producers need an executable integration gate ----
  // they actually flow THROUGH (not just a disconnected integration node present).
  const implementNodes = nodes.filter((n) => n.role === "implement")
  if (!cyclic && implementNodes.length >= 2) {
    const integ = nodes.filter((n) => n.role === "integration" && n.gate.kind === "executable")
    if (integ.length === 0) {
      push("MISSING_INTEGRATION_GATE", "two or more implement nodes require an integration node with an executable gate over the assembled output")
    } else {
      const integAncestors = new Set<string>()
      for (const ig of integ) for (const a of collectAncestors(ig.id, byId)) integAncestors.add(a)
      for (const im of implementNodes) {
        if (!integAncestors.has(im.id)) {
          push("IMPLEMENT_NOT_INTEGRATED", `implement node "${im.id}" does not feed an executable integration gate`, im.id)
        }
      }
    }
  }

  return { ok: v.length === 0, violations: v }
}

/** All transitive input-ancestors of `startId` (the nodes that feed it).
 *  Iterative + `seen`-guarded, so it terminates even on a cyclic graph and
 *  never overflows the stack. */
function collectAncestors(
  startId: string,
  byId: ReadonlyMap<string, WorkflowNode>,
): Set<string> {
  const seen = new Set<string>()
  const stack = [...(byId.get(startId)?.inputs ?? [])]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id) || !byId.has(id)) continue
    seen.add(id)
    for (const ref of byId.get(id)!.inputs) stack.push(ref)
  }
  return seen
}

/** Iterative (explicit-stack) DFS cycle detection over input edges — no
 *  recursion, so a deep/large graph can't overflow the call stack. */
function hasCycle(
  nodes: ReadonlyArray<WorkflowNode>,
  byId: ReadonlyMap<string, WorkflowNode>,
): boolean {
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, 0 | 1 | 2>()
  for (const n of nodes) color.set(n.id, WHITE)
  for (const start of nodes) {
    if (color.get(start.id) !== WHITE) continue
    const stack: Array<{ id: string; idx: number }> = [{ id: start.id, idx: 0 }]
    color.set(start.id, GRAY)
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!
      const inputs = byId.get(top.id)?.inputs ?? []
      if (top.idx < inputs.length) {
        const ref = inputs[top.idx]!
        top.idx += 1
        if (!byId.has(ref)) continue
        const c = color.get(ref)
        if (c === GRAY) return true
        if (c === WHITE) {
          color.set(ref, GRAY)
          stack.push({ id: ref, idx: 0 })
        }
      } else {
        color.set(top.id, BLACK)
        stack.pop()
      }
    }
  }
  return false
}
