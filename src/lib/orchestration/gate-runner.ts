/**
 * The executable-gate runner — runs the kernel's SEALED check commands and
 * reports which passed, as a `GateOutcome` the selector compares. A "check" is a
 * category (e.g. `tests` → `bun test`, `types` → `tsc`, `lint` → eslint); the
 * commands are owned by the kernel/registry, never authored by a producer
 * (gate-immutability, invariant 5), so a candidate can only PASS them, not
 * rewrite them.
 *
 * The process exec is INJECTED (`ExecFn`) so this is pure + unit-testable; the
 * live adapter (Bun.spawn / the managed-exe helper in a sandboxed cwd) is a thin
 * wrapper. A check that exits non-zero OR fails to run counts as not-passed (but
 * still `ran`) — never a thrown error that crashes the kernel.
 */

import { type GateOutcome } from "./select"

export interface CheckSpec {
  /** The canonical check id the selector compares (e.g. "tests"). */
  id: string
  /** The sealed command for this check (e.g. "bun test"). */
  command: string
}

export interface ExecResult {
  exitCode: number
}

export type ExecFn = (input: { command: string; cwd: string }) => Promise<ExecResult>

export async function runGateChecks(
  checks: ReadonlyArray<CheckSpec>,
  cwd: string,
  exec: ExecFn,
): Promise<GateOutcome> {
  // Independent checks run concurrently; a throw or a non-zero exit is a fail,
  // never a kernel crash.
  const results = await Promise.all(
    checks.map(async (c) => {
      try {
        const r = await exec({ command: c.command, cwd })
        return { id: c.id, passed: r.exitCode === 0 }
      } catch {
        return { id: c.id, passed: false }
      }
    }),
  )
  const passed = new Set<string>()
  const ran = new Set<string>()
  for (const r of results) {
    ran.add(r.id)
    if (r.passed) passed.add(r.id)
  }
  return { passed, ran }
}
