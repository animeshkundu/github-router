/**
 * The Phase-0 structural-gate decision — the cheap, CERTAIN floor win. It blocks
 * marking work "done" when any canonical gate fails OR the diff weakens a gate.
 * A non-model check that fires every run and never ships broken or gate-gamed
 * code; per the floor analysis it is the only component that raises the
 * worst-case floor BY CONSTRUCTION (the orchestration on top is a conditional
 * bet).
 *
 * This is the logic behind the spawned-session Stop-hook AND the kernel runner's
 * pre-accept check. The process exec and the diff are inputs, so the decision is
 * pure + unit-testable; the hook script that runs `git diff` + invokes this is a
 * thin wrapper.
 */

import { detectGateWeakening, type WeakeningFinding } from "./gate-immutability"
import { runGateChecks, type CheckSpec, type ExecFn } from "./gate-runner"

export interface StopGateInput {
  /** The canonical gate commands (tests/types/lint/build). */
  checks: ReadonlyArray<CheckSpec>
  /** Workspace the checks run in. */
  cwd: string
  /** Injected process exec (the live wrapper spawns `command` in `cwd`). */
  exec: ExecFn
  /** The working-tree diff to scan for gate-weakening (e.g. `git diff HEAD`). */
  diff: string
}

export interface StopGateResult {
  /** True ⇒ refuse "done": a gate is red or the diff weakens a gate. */
  block: boolean
  /** Human-readable summary for the hook's stderr / the kernel's reason. */
  reason: string
  /** Canonical check ids that did not pass. */
  failedChecks: string[]
  /** Gate-weakening findings in the diff (added `.skip` / `as any` / …). */
  weakening: WeakeningFinding[]
}

export async function evaluateStopGate(input: StopGateInput): Promise<StopGateResult> {
  const gate = await runGateChecks(input.checks, input.cwd, input.exec)
  const weak = detectGateWeakening(input.diff)

  const failedChecks = input.checks.map((c) => c.id).filter((id) => !gate.passed.has(id))
  const block = failedChecks.length > 0 || weak.weakened

  const parts: string[] = []
  if (failedChecks.length > 0) parts.push(`failing gates: ${failedChecks.join(", ")}`)
  if (weak.weakened) {
    const pats = [...new Set(weak.findings.map((f) => f.pattern))].join(", ")
    parts.push(`gate-weakening in the diff: ${pats}`)
  }

  return {
    block,
    reason: block ? parts.join("; ") : "all canonical gates pass; no gate-weakening in the diff",
    failedChecks,
    weakening: weak.findings,
  }
}
