/**
 * `attest_step` — code-driven attestation that an orchestrated run actually
 * honored the bias-isolation invariant: every producer node was checked by a
 * DIFFERENT lab, and that check covered the producer's FINAL artifact (matched by
 * content hash, so a check of a stale earlier version doesn't count).
 *
 * Why it exists: the frozen kernel (`run_workflow`) ENFORCES the invariants in
 * code, but a workflow Claude composes itself with its own Workflow tool runs
 * OUTSIDE the kernel. `attest_step` lets that composition submit its lineage and
 * get a code-enforced verdict, so "a cross-lab check ran on the final artifact"
 * is verified by a deterministic function instead of trusted from the model.
 *
 * Fail-closed to baseline (the floor-preserving default): anything short of a
 * valid cross-lab + hash-matching check for every submitted node yields
 * `recommendation: "ship_baseline"`. The tool RECOMMENDS; it never executes.
 */

export interface AttestCheck {
  /** The lab that performed this check (openai / google / anthropic / ...). */
  checkerLab: string
  /** The artifact content hash this check actually verified. Must equal the
   *  producer's final `artifactHash` to count (a check of a stale version is not
   *  evidence about the shipped artifact). */
  verifiedArtifactHash: string
}

export interface AttestNode {
  id: string
  /** The lab that PRODUCED this node's artifact. */
  producerLab: string
  /** The producer's FINAL artifact content hash (what would ship). */
  artifactHash: string
  /** The independent checks claimed for this node. */
  checks: AttestCheck[]
}

export interface NodeAttestation {
  id: string
  attested: boolean
  reason: string
}

export interface AttestResult {
  /** True iff EVERY submitted node has a valid different-lab check on its final
   *  artifact hash. */
  attested: boolean
  /** Fail-closed: accept only a fully-attested run, else ship the baseline. */
  recommendation: "accept" | "ship_baseline"
  nodes: NodeAttestation[]
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

/** Attest one node: it needs ≥1 check by a DIFFERENT lab whose verified hash
 *  equals the producer's final artifact hash. */
function attestNode(node: AttestNode): NodeAttestation {
  if (!isNonEmptyString(node?.id)) {
    return { id: String(node?.id ?? "?"), attested: false, reason: "node is missing a string id" }
  }
  if (!isNonEmptyString(node.producerLab) || !isNonEmptyString(node.artifactHash)) {
    return { id: node.id, attested: false, reason: "node is missing producerLab or artifactHash" }
  }
  const checks = Array.isArray(node.checks) ? node.checks : []
  if (checks.length === 0) {
    return { id: node.id, attested: false, reason: "no independent check (a producer cannot bless itself)" }
  }
  const sameLab = checks.filter((c) => isNonEmptyString(c?.checkerLab) && c.checkerLab === node.producerLab)
  const valid = checks.find(
    (c) =>
      isNonEmptyString(c?.checkerLab)
      && c.checkerLab !== node.producerLab
      && isNonEmptyString(c?.verifiedArtifactHash)
      && c.verifiedArtifactHash === node.artifactHash,
  )
  if (valid) {
    return { id: node.id, attested: true, reason: `checked by ${valid.checkerLab} (different lab) on the final artifact` }
  }
  // Diagnose the most actionable failure.
  const crossLab = checks.filter((c) => isNonEmptyString(c?.checkerLab) && c.checkerLab !== node.producerLab)
  if (crossLab.length === 0) {
    return {
      id: node.id,
      attested: false,
      reason: `every check is by the producer's own lab "${node.producerLab}"${sameLab.length > 0 ? "" : ""} — the check must cross a different lab`,
    }
  }
  return {
    id: node.id,
    attested: false,
    reason: "a different-lab check exists but verified a different artifact hash than the final one (stale check)",
  }
}

export function attestRun(input: { nodes: AttestNode[] }): AttestResult {
  const nodes = Array.isArray(input?.nodes) ? input.nodes : []
  if (nodes.length === 0) {
    // Nothing to attest: fail closed (do not bless an empty lineage).
    return { attested: false, recommendation: "ship_baseline", nodes: [] }
  }
  const results = nodes.map(attestNode)
  const attested = results.every((r) => r.attested)
  return {
    attested,
    recommendation: attested ? "accept" : "ship_baseline",
    nodes: results,
  }
}
