/**
 * Live `ExecFn` for the gate runner — runs the kernel's SEALED gate command in a
 * workspace via the project's Windows-safe exec helper (`runCommandCapture` →
 * `buildExecInvocation`, which handles cmd.exe quoting on Windows). Only the
 * kernel's sealed gate commands flow through here (tests/types/lint/build),
 * never a producer-authored string, so a simple whitespace split into argv is
 * safe for these fixed commands. A command that can't run (spawn error / killed)
 * counts as a non-zero exit, never a throw — the gate runner treats it as
 * not-passed.
 *
 * This is the one piece of the gate engine that touches a real subprocess; it is
 * model-free and cross-platform, so it is exercised directly in CI (unlike the
 * worker/worktree/model adapters, which need the gated E2E harness).
 */

import { runCommandCapture } from "~/lib/exec"

import { type ExecFn } from "./gate-runner"

/** Per-command wall-clock cap so a hung gate command (watch-mode test, a process
 *  waiting on stdin, a stale lockfile) is tree-killed instead of hanging the
 *  caller forever. Generous (a real typecheck/test/lint can take minutes) but
 *  bounded; override with GH_ROUTER_GATE_CMD_TIMEOUT_MS. A timeout kills the
 *  command (code null) which the gate runner treats as not-passed. */
const CMD_TIMEOUT_MS = ((): number => {
  const n = Number.parseInt(process.env.GH_ROUTER_GATE_CMD_TIMEOUT_MS ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : 600_000
})()

export const liveExec: ExecFn = async ({ command, cwd }) => {
  const argv = command.trim().split(/\s+/).filter(Boolean)
  if (argv.length === 0) return { exitCode: 1 }
  try {
    const r = await runCommandCapture(argv, { cwd, timeoutMs: CMD_TIMEOUT_MS })
    // `code` is null when killed by signal/timeout → treat as a failed gate.
    return { exitCode: r.code ?? 1 }
  } catch {
    return { exitCode: 1 }
  }
}
