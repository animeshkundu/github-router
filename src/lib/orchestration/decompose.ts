/**
 * The `decompose` brain — turns an open-ended ask into a VERIFIED `WorkflowIR`.
 *
 * Per the v6 design it is single-driver but cross-lab-vetted: one strong driver
 * model drafts the IR; the static verifier checks it; on a violation the driver
 * re-drafts WITH the concrete violations as feedback (bounded); a cross-lab
 * critic then reviews the verified draft and, if it raises concerns AND a round
 * remains, the driver re-drafts once more — otherwise the concerns are surfaced
 * as advisory `concerns`. The output is a verifier-clean IR (or the violations
 * if it never converged) — never a build-prompt, never code.
 *
 * The model dispatch is INJECTED (`DecomposeDeps`) so this loop is fully
 * unit-testable; the live adapter (prompting a Copilot model with the tool
 * catalog + the IR schema + the invariants, and routing the critique to a
 * cross-lab persona) is a thin separate slice.
 *
 * Hardened after a cross-lab review (gpt-5.3-codex): the returned IR is the
 * verifier-clean snapshot (a clone is handed to the critic, so a mutating critic
 * can't return an unverified object); external deps are wrapped (a throw becomes
 * a failed round, never a rejected promise); the round count reflects every
 * draft attempt; unaddressed concerns are surfaced.
 */

import { type WorkflowIR } from "./ir"
import { verifyWorkflowIR, type IRViolation, type VerifyOpts } from "./verify"

export interface DecomposeDeps {
  /**
   * Ask the driver model to (re)draft the workflow IR. `feedback` carries prior
   * verification violations and/or critic concerns to fix. Returns the parsed
   * IR as UNTRUSTED input — the verifier validates it; the deps need not.
   */
  draftIR(input: { ask: string; context?: string; feedback?: string[] }): Promise<unknown>
  /**
   * Optional cross-lab critique of a verifier-clean draft (advisory concerns to
   * incorporate). Receives a CLONE — mutating it has no effect on the result.
   * Omit to skip the critique. Concerns never block delivery of a verified IR.
   */
  critiqueIR?(ir: WorkflowIR): Promise<{ concerns: string[] }>
}

export interface DecomposeOpts {
  /** Total draft attempts before giving up (default 3). */
  maxRounds?: number
  /** Threaded into verification (e.g. the kernel's sealed-gate allowlist). */
  verify?: VerifyOpts
}

export type DecomposeResult =
  | { ok: true; ir: WorkflowIR; rounds: number; concerns?: string[] }
  | { ok: false; violations: IRViolation[]; rounds: number }

const DEFAULT_MAX_ROUNDS = 3

const formatViolations = (violations: ReadonlyArray<IRViolation>): string[] =>
  violations.map((v) => `${v.code}: ${v.message}${v.nodeId ? ` (node "${v.nodeId}")` : ""}`)

/** Draft once, never throwing — a thrown driver becomes a failed round. */
async function safeDraft(
  deps: DecomposeDeps,
  input: { ask: string; context?: string; feedback?: string[] },
): Promise<{ ok: true; value: unknown } | { ok: false; violations: IRViolation[] }> {
  try {
    return { ok: true, value: await deps.draftIR(input) }
  } catch (e) {
    return { ok: false, violations: [{ code: "DRAFT_THREW", message: `driver draftIR threw: ${(e as Error)?.message ?? String(e)}` }] }
  }
}

/** Critique is advisory; a throw or a missing critic degrades to "no concerns". */
async function safeCritique(deps: DecomposeDeps, ir: WorkflowIR): Promise<string[]> {
  if (!deps.critiqueIR) return []
  try {
    const { concerns } = await deps.critiqueIR(clone(ir))
    return Array.isArray(concerns) ? concerns.filter((c): c is string => typeof c === "string") : []
  } catch {
    return []
  }
}

const clone = <T>(v: T): T =>
  typeof structuredClone === "function"
    ? structuredClone(v)
    : (JSON.parse(JSON.stringify(v)) as T)

export async function decomposeWorkflow(
  ask: string,
  deps: DecomposeDeps,
  opts: DecomposeOpts = {},
): Promise<DecomposeResult> {
  const maxRounds = Math.max(1, opts.maxRounds ?? DEFAULT_MAX_ROUNDS)
  const verifyOpts = opts.verify ?? {}
  let feedback: string[] | undefined
  let lastViolations: IRViolation[] = [{ code: "NO_DRAFT", message: "decompose produced no draft" }]
  let attempts = 0

  for (let round = 1; round <= maxRounds; round += 1) {
    const drafted = await safeDraft(deps, { ask, feedback })
    attempts += 1
    if (!drafted.ok) {
      lastViolations = drafted.violations
      feedback = formatViolations(drafted.violations)
      continue
    }
    const verdict = verifyWorkflowIR(drafted.value as WorkflowIR, verifyOpts)
    if (!verdict.ok) {
      lastViolations = verdict.violations
      feedback = formatViolations(verdict.violations)
      continue
    }

    // Verifier-clean. `ir` is the value we will RETURN — never a post-critique
    // object (the critic only ever sees a clone).
    const ir = drafted.value as WorkflowIR
    const concerns = await safeCritique(deps, ir)
    if (concerns.length === 0) return { ok: true, ir, rounds: attempts }

    if (round < maxRounds) {
      // A round remains — re-draft incorporating the concerns.
      const next = await safeDraft(deps, { ask, feedback: concerns })
      attempts += 1
      if (next.ok) {
        const reVerdict = verifyWorkflowIR(next.value as WorkflowIR, verifyOpts)
        if (reVerdict.ok) return { ok: true, ir: next.value as WorkflowIR, rounds: attempts }
      }
      // Re-draft regressed — keep the earlier verified IR, surface the concerns.
      return { ok: true, ir, rounds: attempts, concerns }
    }

    // No round left to re-draft — return the verified IR WITH the concerns.
    return { ok: true, ir, rounds: attempts, concerns }
  }

  return { ok: false, violations: lastViolations, rounds: attempts }
}
