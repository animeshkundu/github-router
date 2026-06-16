/**
 * Typed workflow IR for the agent-orchestration kernel.
 *
 * `decompose` emits a `WorkflowIR` (NOT a build-prompt, NOT JS — see the v5
 * review / "IR/kernel correction" in `docs/agent-orchestration-design.md`).
 * The static verifier (`verifyWorkflowIR` in `./verify`) checks that the IR
 * *structurally* encodes the floor invariants BEFORE the frozen kernel executes
 * it; the kernel enforces the *runtime* invariants (actually running the sealed
 * gates, forking the baseline worktree, the `git diff` gate-immutability check,
 * the superset-selection). Splitting it this way is the whole point of the v6
 * correction: a probabilistic authoring step (an LLM emitting the IR) cannot be
 * trusted with a deterministic floor, so the IR is data the kernel validates and
 * executes — never code the model runs.
 *
 * The 8 invariants this IR + verifier + kernel uphold (design doc):
 *   1. parallel baseline + champion-retention (`max(orchestrated, baseline)`)
 *   2. executable-primary accept (executable gate is a FILTER, LLM advisory)
 *   3. fail-closed TO BASELINE, not to halt
 *   4. decorrelate the selector (judge on the RAW ask + blessed AC)
 *   5. gate-immutability (the kernel owns gate commands; the IR can't inline one)
 *   6. worktree-isolation, escalate-from-clean (runtime; kernel)
 *   7. executable integration gate over assembled output
 *   8. right-sizing / bounded recursion
 */

/** What a node is for. Drives kernel dispatch + the verifier's topology checks. */
export type NodeRole =
  | "research"
  | "plan"
  | "implement"
  | "review"
  | "test"
  | "verify"
  /** The single-strong-model branch run on the RAW ask, off the orchestration
   *  chain (champion-retention, invariant 1). */
  | "baseline"
  /** Chooses `max(orchestrated, baseline)` (invariant 1 + 4). */
  | "selector"
  /** The global integration gate over the assembled output (invariant 7). */
  | "integration"

/** How a node's output is checked before the workflow may advance past it. */
export type GateKind = "executable" | "cross_lab" | "none"

export interface NodeGate {
  kind: GateKind
  /**
   * For `executable` gates: the SEALED gate id the kernel runs (tests / types /
   * build / lint / a registered integration command). The IR may NOT inline an
   * arbitrary command — gate-immutability (invariant 5) means the kernel owns
   * the command registry; the IR only references a registered id. Required when
   * `kind === "executable"`.
   */
  gateId?: string
  /**
   * For `cross_lab` gates: the lab that performs the check. MUST differ from the
   * node's `producerLab` (a producer never blesses its own output, and the
   * check crosses a different lab to decorrelate). Required when
   * `kind === "cross_lab"`.
   */
  checkerLab?: string
}

/**
 * What happens when a node's gate fails.
 *   - `loop`: artifact-failure — retry the node (bounded by the kernel).
 *   - `baseline`: infra/check-failure — ship the baseline (invariant 3).
 *   - `escalate`: surface to the user.
 * There is deliberately NO `halt` variant: halting to nothing is itself
 * floor-lowering (the v5/floor review), so the type forbids it.
 */
export type OnFail = "loop" | "baseline" | "escalate"

export interface WorkflowNode {
  id: string
  role: NodeRole
  /** Lab/model family producing this node's output (e.g. "openai", "google",
   *  "anthropic"). Used to enforce producer != checker lab on `cross_lab` gates. */
  producerLab?: string
  /** Ids of nodes whose outputs feed this node (the DAG edges). */
  inputs: string[]
  gate: NodeGate
  onFail: OnFail
  /** Nodes sharing a group may run concurrently. */
  parallelGroup?: string
  /**
   * Selector only: must be `true`. Asserts the selector judges on the RAW ask +
   * user-blessed AC, never a decompose-derived AC (invariant 4 — the most
   * load-bearing: without it the selector can ship a wrong-but-AC-passing output
   * and discard a correct baseline).
   */
  judgesOnRawAsk?: boolean
}

export interface WorkflowIR {
  /** Content hash of the RAW user ask (the selector judges against THIS). */
  rawAskHash: string
  /** Content hash of the USER-blessed acceptance criteria. */
  acceptanceCriteriaHash: string
  nodes: WorkflowNode[]
  /** Max recursion/nesting depth a node may expand to (1..MAX_RECURSION_DEPTH). */
  maxDepth: number
}

/** Bounded recursion (invariant 8). A node may expand into a sub-workflow only
 *  up to this depth. NOTE: a single IR cannot bound runtime recursion on its own
 *  (a planner could emit `maxDepth: 3` at every level); this is a *declared
 *  ceiling* the kernel enforces by decrementing a depth BUDGET token it passes
 *  into each sub-orchestration. The verifier only range-checks the declaration. */
export const MAX_RECURSION_DEPTH = 3

/** Roles that produce a candidate artifact the selector may choose between
 *  (everything that isn't infrastructure). */
export const PRODUCER_ROLES: ReadonlySet<NodeRole> = new Set<NodeRole>([
  "research",
  "plan",
  "implement",
  "review",
  "test",
  "verify",
])
