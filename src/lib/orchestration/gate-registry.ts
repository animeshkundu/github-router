/**
 * The SEALED executable-gate registry. The kernel owns the gate commands; the
 * workflow IR (and the model that drafted it) references a gate by its `id` ONLY
 * and can never author or alter the command that runs (invariant 5,
 * gate-immutability at the command level). `run_workflow` resolves the caller's
 * `gateId` against this map; an unknown id is rejected before the kernel runs, so
 * a model cannot smuggle an arbitrary shell command in disguised as a "gate".
 *
 * The check `id`s (not the commands) are what champion-retention compares, so the
 * selector reasons over stable category names ("typecheck"/"test"/"lint"), not
 * over shell strings that vary per repo.
 */

import { type CheckSpec } from "./gate-runner"

export interface SealedGate {
  id: string
  /** The sealed checks (id + command). Run by the kernel, never by the model. */
  checks: CheckSpec[]
}

/**
 * Built-in sealed gates. Commands follow this repo's TS/Bun conventions (the
 * `bun run <script>` indirection means a repo without that script simply fails
 * the check, which the selector treats as not-passed rather than a crash). New
 * ecosystems get a new sealed id here, never a caller-supplied command.
 */
const SEALED_GATES: Readonly<Record<string, ReadonlyArray<CheckSpec>>> = {
  "default-ci": [
    { id: "typecheck", command: "bun run typecheck" },
    { id: "test", command: "bun test" },
    { id: "lint", command: "bun run lint" },
  ],
  "typecheck-test": [
    { id: "typecheck", command: "bun run typecheck" },
    { id: "test", command: "bun test" },
  ],
  "typecheck-only": [{ id: "typecheck", command: "bun run typecheck" }],
}

/** The set of sealed gate ids, used as the kernel's `knownGateIds` so the IR
 *  verifier rejects an executable gate that references an unregistered id. */
export function sealedGateIds(): ReadonlySet<string> {
  return new Set(Object.keys(SEALED_GATES))
}

/**
 * Resolve a sealed gate by id. Returns a DEFENSIVE CLONE (fresh objects) so a
 * caller can never mutate the registry's command set. `undefined` for an
 * unknown id, which `run_workflow` rejects before executing anything.
 */
export function resolveSealedGate(gateId: string): SealedGate | undefined {
  const checks = SEALED_GATES[gateId]
  if (!checks) return undefined
  return { id: gateId, checks: checks.map((c) => ({ id: c.id, command: c.command })) }
}
