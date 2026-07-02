/**
 * The pure first-mate state machine. NO I/O, NO LLM call — unit-testable in
 * isolation. The advance() engine does all the I/O (observing GitHub, calling
 * the micro-classifier to distil fuzzy NL signals) and feeds the results here.
 *
 *   classify(observed, row)      → the orthogonal state fields + events
 *   nextAction(classified, row, policy) → the ONE deterministic action to take
 *   isEscalation(action)         → does this action need a human?
 *
 * `nextAction` is the decision TABLE from the design: every transition is a
 * lookup over the state fields + counters, so the loop can't drift or
 * hallucinate a step. Model inference enters ONLY where an action is
 * `ask_model` (a macro judgment) — and the micro-classifier signals baked into
 * `Observed` are produced upstream, never here.
 *
 * Note on merge: `nextAction` returns `escalate_human` at `floor_passed`
 * (build the merge packet). The ACTUAL merge is executed by the engine, out of
 * band, only when a durable live-valid human-approval record exists — that
 * check is a safety gate that depends on no model and lives in the engine, not
 * this pure function.
 */

import type {
  Action,
  Artifact,
  Classified,
  Observed,
  Phase,
  Policy,
  UnitRow,
  Validation,
} from "./types"

export function classify(observed: Observed, row: UnitRow): Classified {
  const events: string[] = []
  const provider = observed.provider

  const artifact = classifyArtifact(observed, events)
  const validation = classifyValidation(observed, artifact, row)
  const phase = classifyPhase(observed, row, artifact, validation)

  if (observed.externalMutation) {
    events.push(`external:${observed.externalMutation}`)
  }
  if (observed.steerAcknowledged === false) events.push("steer:no_progress")

  return { provider, phase, artifact, validation, events }
}

function classifyArtifact(observed: Observed, events: string[]): Artifact {
  if (observed.externalMutation === "merged") return "pr_merged"
  const prs = observed.prs
  if (prs.length === 0) {
    return observed.externalMutation === "closed" ? "pr_closed" : "no_pr"
  }
  if (prs.length > 1) {
    events.push("multiple_prs")
    return "multiple_prs"
  }
  const pr = prs[0]!
  if (pr.merged || pr.state === "MERGED") return "pr_merged"
  if (pr.state === "CLOSED") return "pr_closed"
  return "pr_open"
}

function classifyValidation(observed: Observed, artifact: Artifact, row: UnitRow): Validation {
  if (artifact !== "pr_open") return "unknown"
  // Preserve a floor verdict that was recorded for the CURRENT head. The floor
  // comes from an out-of-band different-lab verifier (a judge_review answer),
  // not from GitHub, so it lives in the ledger, not `observed`. Binding it to
  // `floorSha` means a new commit (head change) auto-invalidates the verdict
  // and the unit re-verifies — closing the stale-floor merge hole.
  const head = observed.prs[0]?.headSha
  if (
    (row.validation === "floor_passed" || row.validation === "floor_failed")
    && row.floorSha != null
    && row.floorSha.length > 0
    && head !== undefined
    && head === row.floorSha
  ) {
    return row.validation
  }
  // Floor verdict (only meaningful after CI passes) takes precedence.
  if (observed.floor === "failed") return "floor_failed"
  if (observed.floor === "passed") return "floor_passed"
  if (observed.floor === "pending") return "floor_pending"
  // A verifier was assigned and its review has landed → time to judge it.
  // (Reached only after assign_verifier set verifierAssigned; before the review
  // lands the unit sits in its CI state and waits.)
  if (row.verifierAssigned === true && observed.verifierReviewed === true) {
    return "floor_pending"
  }
  // Then an explicit human/reviewer changes-requested.
  if (observed.reviewDecision === "CHANGES_REQUESTED") return "changes_requested"
  // Then CI.
  const rollup = observed.ci?.rollup
  if (rollup === "failing") return "ci_failed"
  if (rollup === "pending") return "ci_running"
  if (rollup === "passing") {
    // CI green but a review is still required → surface review_pending so the
    // engine assigns an independent (different-lab) verifier.
    if (observed.reviewDecision === "REVIEW_REQUIRED") return "review_pending"
    return "ci_passed"
  }
  if (rollup === "none") {
    // Zero check runs. If the repo genuinely has no CI, the cross-lab review is
    // the gate → route to verification. If CI is configured but hasn't
    // registered yet, keep waiting rather than skipping it.
    return observed.ci?.noCi === true ? "no_ci" : "ci_running"
  }
  return "unknown"
}

function classifyPhase(
  observed: Observed,
  row: UnitRow,
  artifact: Artifact,
  validation: Validation,
): Phase {
  if (row.terminal || artifact === "pr_merged") return "done"
  if (artifact === "no_pr") {
    // No PR yet. Plan-mode units sit in `plan` until steered to build;
    // build-mode units are already building.
    if (observed.planReady) return "plan"
    return row.dispatchMode === "plan" ? "plan" : "build"
  }
  // A PR exists — derive from validation.
  if (validation === "floor_passed") return "merge"
  if (validation === "ci_failed" || validation === "changes_requested") return "fix"
  if (validation === "ci_passed" || validation === "review_pending" || validation === "no_ci")
    return "review"
  return "build"
}

export function nextAction(
  state: Classified,
  row: UnitRow,
  policy: Policy,
): Action {
  // Terminal.
  if (state.phase === "done" || row.terminal) return { kind: "mark_done" }

  // External / anomalous artifact states first.
  if (state.artifact === "pr_merged") return { kind: "mark_done" }
  if (state.artifact === "pr_closed") {
    // A loser we cancelled is expected; anything else is an external close.
    if (row.cancelledBy === "controller") return { kind: "mark_done" }
    return { kind: "escalate_human", reason: "pull request was closed outside the first mate" }
  }
  if (state.artifact === "multiple_prs") {
    return { kind: "escalate_human", reason: "the agent opened multiple pull requests for one unit" }
  }

  // Provider terminal-failure states. Re-dispatch semantics on the preview
  // API are unverified, so escalate rather than guess a destructive retry.
  if (state.provider === "failed" || state.provider === "timed_out") {
    return { kind: "escalate_human", reason: `cloud agent task ${state.provider}` }
  }

  // Agent is blocked asking a question.
  if (state.provider === "waiting_for_user") {
    if (row.blockingDecisionId) return { kind: "noop" } // already surfaced
    return {
      kind: "ask_model",
      request: "answer_agent_question",
    }
  }

  // A completed plan-mode task with a plan ready for review.
  if (state.phase === "plan" && state.provider === "completed" && state.artifact === "no_pr") {
    if (row.blockingDecisionId) return { kind: "noop" }
    return { kind: "ask_model", request: "review_plan" }
  }

  // Validation-driven rows (a PR exists).
  switch (state.validation) {
    case "ci_failed":
    case "changes_requested":
      if (row.retries < policy.maxRetries) {
        return { kind: "ask_model", request: "author_fix" }
      }
      return {
        kind: "escalate_human",
        reason:
          state.validation === "ci_failed"
            ? "CI still red after the self-heal retry cap"
            : "changes still requested after the self-heal retry cap",
      }
    case "ci_passed":
    case "no_ci":
      // Green (or no CI to gate on) → independent, different-lab verification
      // before merge. The cross-lab review is the real gate; CI is a bonus.
      // Re-request when the head has moved past the reviewed SHA (the agent
      // pushed a fix) so a stale review never judges new commits.
      if (
        !row.verifierAssigned ||
        (row.verifierSha != null &&
          row.headSha != null &&
          row.verifierSha !== row.headSha)
      ) {
        return { kind: "assign_verifier" }
      }
      return { kind: "noop" } // awaiting the verifier's floor verdict
    case "review_pending":
      if (!row.verifierAssigned) return { kind: "assign_verifier" }
      return { kind: "noop" }
    case "floor_failed":
      if (row.retries < policy.maxRetries) {
        return { kind: "ask_model", request: "author_fix" }
      }
      return { kind: "escalate_human", reason: "floor-keeper verdict is no-go after the retry cap" }
    case "floor_passed":
      // Human-gated. The engine performs the actual merge only when a durable
      // live-valid approval record exists; absent that, surface the packet.
      return { kind: "escalate_human", reason: "ready to merge — approval required" }
    case "ci_running":
      return { kind: "noop" }
    case "floor_pending":
      // The verifier's review has landed → have the lead judge it (a different
      // lab than the copilot producer). Until answered, re-emit each wake.
      return { kind: "ask_model", request: "judge_review" }
    default:
      break
  }

  // A dispatched build-mode unit still working; or a plan-mode unit mid-plan.
  return { kind: "noop" }
}

export function isEscalation(action: Action): boolean {
  return action.kind === "escalate_human"
}

/** Convenience: does an action require the LEAD model (macro judgment)? */
export function isModelRequest(action: Action): boolean {
  return action.kind === "ask_model"
}
