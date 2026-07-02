/**
 * Shared types for the first-mate controller. The durable ledger, the pure
 * state machine, the observe pass, and the advance() engine all speak these.
 *
 * A UNIT is one dispatchable piece of work (an issue/PR on some repo, worked
 * by one cloud coding agent). A MISSION is one user goal (may span repos)
 * decomposed into units. The controller is the only writer of these records;
 * the model holds none of them and re-hydrates from the ledger every wake.
 */

export type AgentKey = "copilot" | "anthropic" | "openai"

/** Raw GitHub Agent-Tasks provider state (verbatim from the tasks API). */
export type ProviderState =
  | "none"
  | "queued"
  | "in_progress"
  | "waiting_for_user"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"

/** Where in the dev cycle a unit is (controller lifecycle, not GitHub's). */
export type Phase = "plan" | "build" | "fix" | "review" | "merge" | "done"

/** The unit's pull-request artifact state. */
export type Artifact =
  | "no_pr"
  | "pr_open"
  | "pr_closed"
  | "pr_merged"
  | "multiple_prs"

/** CI + review + floor-keeper validation state. */
export type Validation =
  | "unknown"
  | "ci_running"
  | "ci_passed"
  | "ci_failed"
  | "no_ci"
  | "review_pending"
  | "changes_requested"
  | "floor_pending"
  | "floor_passed"
  | "floor_failed"

export type DispatchMode = "plan" | "build"

export interface RepoRef {
  owner: string
  name: string
}

/**
 * One unit's durable ledger row. Holds only HANDLES + classification +
 * bookkeeping — never diffs, logs, or PR bodies (those are re-fetchable).
 */
export interface UnitRow {
  /**
   * Stable per-unit identity, independent of GitHub handles. Set when a unit
   * is created (e.g. from a decompose answer) so it can be correlated across
   * its queued→dispatched transition (before it has an issue/taskId) without
   * duplicating in the ledger. Optional for backward compatibility.
   */
  id?: string
  missionId: string
  repo: RepoRef
  issue: number | null
  pr: number | null
  taskId: string | null
  agent: AgentKey
  botLogin: string
  dispatchMode: DispatchMode
  provider: ProviderState
  phase: Phase
  artifact: Artifact
  validation: Validation
  /** Bounded CI/review self-heal counter → blocked_on_human at the cap. */
  retries: number
  lastSteer?: { cursor?: string; sha?: string; atMs: number }
  /** Distinguishes loser-cleanup (controller) from an external cancel. */
  cancelledBy?: "controller" | "external"
  bakeoffGroupId?: string | null
  /** Issue numbers (same mission) that must MERGE before this unit dispatches. */
  dependsOn: number[]
  /** Set iff this unit is waiting on a human decision (its decisionId). */
  blockingDecisionId?: string | null
  /** True once an independent (different-lab) verifier has been assigned. */
  verifierAssigned?: boolean
  /**
   * The head SHA the current verifier review was requested for. When the head
   * moves past this (the agent pushed a fix), the controller re-requests a
   * review so a stale review never judges new commits.
   */
  verifierSha?: string
  /** The lab that produced this unit's work (for producer≠checker). */
  implementerLab?: AgentKey
  /**
   * The head SHA the floor verdict (floor_passed/floor_failed) was recorded
   * against. Binds the verdict — and any merge approval derived from it — to a
   * specific head, so a new commit after the verdict auto-invalidates the floor
   * (classify won't preserve it) and the merge gate refuses a moved head.
   */
  floorSha?: string | null
  title: string
  /**
   * Durable dispatch-intent (outbox), persisted BEFORE the irreversible
   * startTask so a crash in the startTask→persist window never blind-re-dispatches
   * (at-most-once). Cleared once the taskId is persisted. `id` is the correlation
   * id (embedded in the task prompt) and the Idempotency-Key. See
   * docs/research/first-mate-dispatch-durability.md.
   */
  dispatch?: { id: string; requestedMs: number; attempts: number }
  /**
   * The plan the agent produced in the plan phase (distilled from its session
   * log), stashed at review_plan time so an approve can re-dispatch a build
   * task carrying it. Cleared once the build task is dispatched.
   */
  planExcerpt?: string
  branch?: string | null
  headSha?: string | null
  baseSha?: string | null
  lastCheckedMs?: number
  /** True once the unit is finished (merged) or abandoned. */
  terminal?: boolean
}

/**
 * The structured observations the controller feeds `classify()`. Raw GitHub
 * signals PLUS the micro-classifier's distillations of fuzzy NL signals
 * (plan text, the agent's question, progress). `classify` stays pure over
 * this — it never does I/O or an LLM call itself.
 */
export interface Observed {
  provider: ProviderState
  prs: Array<{
    number: number
    headSha: string
    isDraft: boolean
    /** GitHub PR state: "OPEN" | "CLOSED" | "MERGED". */
    state: string
    merged?: boolean
  }>
  ci?: { rollup: "pending" | "passing" | "failing" | "none"; noCi?: boolean }
  /** GitHub reviewDecision: APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null. */
  reviewDecision?: string | null
  /** /gh-floor-keeper verdict for the current head, when it has run. */
  floor?: "pending" | "passed" | "failed" | null
  // --- micro-classifier distillations (T0 model, validated by the engine) ---
  /** A plan-mode task completed and produced a reviewable plan. */
  planReady?: boolean
  /**
   * The cloud-agent's distilled session log (plan + reasoning + progress),
   * fetched from the Copilot host and hard-truncated. Untrusted agent text.
   * Feeds the plan-ready / stuck micro-classifiers.
   */
  logExcerpt?: string
  /** For waiting_for_user: the agent's question, distilled from its log. */
  question?: string
  /** For waiting_for_user: is the agent's question answerable from the AC? */
  agentQuestionAnswerableFromAC?: boolean | null
  /** A different-lab verifier (Copilot code review) has posted its review. */
  verifierReviewed?: boolean
  /** The verifier's review findings, fed to judge_review as the review summary. */
  reviewExcerpt?: string
  /** Did the last steer visibly land (log cursor / head sha advanced)? */
  steerAcknowledged?: boolean | null
  /** An out-of-band change to the unit's PR the controller didn't make. */
  externalMutation?: "closed" | "merged" | "head_changed" | null
}

/** Tunable policy the pure functions read (no globals). */
export interface Policy {
  /** CI/review self-heal cap before escalating to a human. Default 3. */
  maxRetries: number
}

export const DEFAULT_POLICY: Policy = { maxRetries: 3 }

/** The classified orthogonal state + the events observed this step. */
export interface Classified {
  provider: ProviderState
  phase: Phase
  artifact: Artifact
  validation: Validation
  events: string[]
}

/** Kinds of judgment the engine can ask the LEAD model for (macro-tier). */
export type ModelRequestKind =
  | "decompose"
  | "review_plan"
  | "answer_agent_question"
  | "author_fix"
  | "judge_review"

/**
 * The single action the pure `nextAction` prescribes for a unit this step.
 * The engine EXECUTES it (all deterministic mechanism); `ask_model` /
 * `escalate_human` are the only two that leave the deterministic core.
 */
export type Action =
  | { kind: "noop" }
  | { kind: "dispatch" }
  | { kind: "steer"; instruction: string; expect: "log_cursor_advance" | "head_sha_change" | "ci_rerun" }
  | { kind: "cancel"; reason: string }
  | { kind: "rerun_ci" }
  | { kind: "assign_verifier" }
  | { kind: "merge" }
  | { kind: "ask_model"; request: ModelRequestKind }
  | { kind: "escalate_human"; reason: string }
  | { kind: "mark_rebase" }
  | { kind: "mark_done" }
