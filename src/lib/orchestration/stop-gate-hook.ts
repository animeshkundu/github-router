/**
 * The Phase-0 structural-gate Stop-hook glue. `runStopGateForLaunch` resolves a
 * SEALED gate by id and evaluates it against the working-tree diff, returning the
 * block decision a spawned-session Stop hook (or a manual check) acts on.
 *
 * Safety posture (deliberately different from the kernel): a Stop hook that
 * blocks on a MISCONFIGURATION would wedge the user's session (they could not
 * stop). So this fails OPEN on config problems (unknown gate id) and blocks ONLY
 * on a genuine red gate or a gate-weakening diff. The kernel, by contrast, fails
 * CLOSED to the baseline. Both are correct for their context.
 *
 * The sealed gate + diff + exec are inputs, so the decision is pure and
 * unit-testable; the thin live wrapper (capture `git diff`, spawn the checks,
 * map the result to an exit code) is the only part that needs a real process.
 */

import { resolveSealedGate } from "./gate-registry"
import { type ExecFn } from "./gate-runner"
import { evaluateStopGate, type StopGateResult } from "./stop-gate"
import { parseBoolEnv } from "~/lib/exec"

export interface StopGateLaunchInput {
  /** Workspace the checks run in (the session cwd). */
  workspace: string
  /** Which SEALED gate to run (the registry owns the commands). */
  gateId: string
  /** Injected process exec. */
  exec: ExecFn
  /** The working-tree diff to scan for gate-weakening (e.g. `git diff HEAD`). */
  diff: string
}

export async function runStopGateForLaunch(input: StopGateLaunchInput): Promise<StopGateResult> {
  const gate = resolveSealedGate(input.gateId)
  if (!gate) {
    // Fail OPEN: never wedge the session on a config error. Surface it instead.
    return {
      block: false,
      reason: `stop-gate: unknown gateId "${input.gateId}" (not blocking)`,
      failedChecks: [],
      weakening: [],
    }
  }
  return evaluateStopGate({ checks: gate.checks, cwd: input.workspace, exec: input.exec, diff: input.diff })
}

/**
 * The structural-gate Stop hook is OPT-IN and default-OFF: it changes the spawned
 * session's stop behavior (a red gate refuses "done"), so a user enables it
 * explicitly via `GH_ROUTER_ENABLE_STOP_GATE` (the canonical `parseBoolEnv`
 * accepts `1`/`true`/`yes`/`on`).
 */
export function stopGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBoolEnv(env.GH_ROUTER_ENABLE_STOP_GATE) === true
}

/** The sealed gate the Stop hook runs, overridable via `GH_ROUTER_STOP_GATE_ID`
 *  (must be a registered sealed id; the live wrapper falls open on an unknown
 *  id). Defaults to `default-ci`. */
export function stopGateId(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env.GH_ROUTER_STOP_GATE_ID ?? "").trim()
  return v.length > 0 ? v : "default-ci"
}

/**
 * Build the Claude Code `settings.json` fragment that registers `command` as a
 * Stop hook. Returns just the `hooks` object so the caller merges it into the
 * mirrored settings (never clobbering existing hooks). The Stop event takes no
 * matcher; the command runs on every stop and an exit code of 2 blocks it.
 */
export function buildStopHookSettings(command: string): {
  hooks: { Stop: Array<{ hooks: Array<{ type: "command"; command: string }> }> }
} {
  return { hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } }
}

/** True when a settings `Stop` entry already registers `command` (so the merge
 *  is idempotent across re-launches). */
function entryHasCommand(entry: unknown, command: string): boolean {
  if (!entry || typeof entry !== "object") return false
  const hooks = (entry as { hooks?: unknown }).hooks
  if (!Array.isArray(hooks)) return false
  return hooks.some((h) => h && typeof h === "object" && (h as { command?: unknown }).command === command)
}

/**
 * Idempotently merge a Stop hook running `command` into an existing Claude Code
 * settings object WITHOUT clobbering other hook events or other `Stop` entries.
 * Returns a new object (never mutates the input). Re-running the launcher with
 * the same command does not duplicate the hook.
 */
export function mergeStopHookIntoSettings(
  existing: Record<string, unknown> | undefined,
  command: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = existing && typeof existing === "object" ? { ...existing } : {}
  const hooks: Record<string, unknown> =
    base.hooks && typeof base.hooks === "object" ? { ...(base.hooks as Record<string, unknown>) } : {}
  const stop: unknown[] = Array.isArray(hooks.Stop) ? [...(hooks.Stop as unknown[])] : []
  if (!stop.some((e) => entryHasCommand(e, command))) {
    stop.push({ hooks: [{ type: "command", command }] })
  }
  hooks.Stop = stop
  base.hooks = hooks
  return base
}
