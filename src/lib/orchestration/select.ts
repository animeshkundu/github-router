/**
 * Champion-retention selection — the deterministic heart of the floor guarantee
 * (`max(orchestrated, baseline)`; invariants 1, 2, 4). Both candidates are judged
 * over the CANONICAL raw-ask executable gate set (declared in the verified IR,
 * NOT inferred from either candidate's self-reported outcome — that authority
 * can't be shrunk or renamed to dodge a check). The orchestrated candidate is
 * accepted ONLY when it verifiably does not regress against the baseline over
 * that fixed set. Any uncertainty — malformed outcome, an un-run canonical gate,
 * no executable evidence, or a tie under the strict policy — ships the baseline.
 * The LLM never decides; the comparison is code over executable outcomes. This
 * is what makes the floor monotone on harness-bearing asks.
 *
 * Run inside the frozen kernel after both branches have been gated. See
 * `docs/agent-orchestration-design.md`. Hardened after a cross-lab review
 * (gpt-5.3-codex): canonical authority, `passed ⊆ ran` validation, and the
 * no-executable-evidence → baseline rule.
 */

/** The executable-gate outcome for one candidate, judged over the raw-ask gates. */
export interface GateOutcome {
  /** Executable check ids that PASSED for this candidate. Must be a subset of `ran`. */
  passed: ReadonlySet<string>
  /** Executable check ids that RAN (passed ∪ failed). */
  ran: ReadonlySet<string>
}

/**
 * How to treat an orchestrated candidate that is EQUAL to the baseline over the
 * canonical gate set (passes exactly the same canonical checks):
 *   - "strict":   ship the BASELINE unless orchestrated passes STRICTLY MORE of
 *                 the canonical checks. Maximally floor-protective.
 *   - "superset": ship the ORCHESTRATED candidate on equal. Bets on un-checked-
 *                 quality upside; accepts the irreducible Goodhart residual the
 *                 floor analysis names.
 *
 * There is deliberately NO default — this is a floor-vs-upside PRODUCT decision
 * the caller must make explicitly (it is the user's call, not the model's).
 */
export type TiePolicy = "strict" | "superset"

export interface SelectDecision {
  winner: "orchestrated" | "baseline"
  reason: string
}

const subsetOf = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  for (const x of a) if (!b.has(x)) return false
  return true
}

export function selectChampion(
  orchestrated: GateOutcome,
  baseline: GateOutcome,
  /** The authoritative raw-ask executable gate ids from the VERIFIED IR — the
   *  fixed universe the comparison runs over (never inferred from an outcome). */
  canonicalGateIds: ReadonlySet<string>,
  tiePolicy: TiePolicy,
): SelectDecision {
  // 0. Fail closed on malformed outcomes: a candidate can't claim to have PASSED
  //    a check it never RAN. (Both outcomes come from the trusted kernel, but we
  //    validate anyway — a worse-than-baseline ship is the failure we exist to
  //    prevent.)
  if (!subsetOf(orchestrated.passed, orchestrated.ran)) {
    return { winner: "baseline", reason: "orchestrated outcome malformed (passed not a subset of ran)" }
  }
  if (!subsetOf(baseline.passed, baseline.ran)) {
    return { winner: "baseline", reason: "baseline outcome malformed (passed not a subset of ran)" }
  }

  // 1. No executable evidence (no canonical gate exists for this ask): the
  //    executable selector cannot establish that orchestrated is >= baseline, so
  //    ship the baseline. Judgment-only asks are handled by a separate
  //    decorrelated-bar path, not by auto-shipping orchestrated here.
  if (canonicalGateIds.size === 0) {
    return { winner: "baseline", reason: "no executable gate for this ask — ship the baseline (judgment-only)" }
  }

  // 2. Orchestrated must have RUN every canonical gate to be eligible — it can't
  //    win by skipping checks.
  for (const id of canonicalGateIds) {
    if (!orchestrated.ran.has(id)) {
      return { winner: "baseline", reason: `orchestrated did not run canonical gate "${id}"` }
    }
  }

  // 3. Count passes WITHIN the canonical set only (extra candidate-only checks
  //    don't count — a candidate can't inflate its score by adding tests).
  let baselinePass = 0
  let orchestratedPass = 0
  for (const id of canonicalGateIds) {
    if (baseline.passed.has(id)) baselinePass += 1
    if (orchestrated.passed.has(id)) {
      orchestratedPass += 1
    } else if (baseline.passed.has(id)) {
      // 4. Regression: orchestrated fails a canonical check the baseline passed.
      return { winner: "baseline", reason: `orchestrated regresses on canonical check "${id}" the baseline passed` }
    }
  }

  // 5. Strictly more canonical checks green → unambiguous win.
  if (orchestratedPass > baselinePass) {
    return { winner: "orchestrated", reason: "orchestrated passes strictly more canonical executable checks" }
  }

  // 6. Equal (orchestrated passes exactly the baseline's canonical checks) → the
  //    explicit product policy decides.
  if (tiePolicy === "superset") {
    return { winner: "orchestrated", reason: "orchestrated matches the baseline on the canonical checks (superset policy)" }
  }
  return { winner: "baseline", reason: "orchestrated does not pass strictly more canonical checks than the baseline (strict policy)" }
}
