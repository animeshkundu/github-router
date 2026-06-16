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

export const liveExec: ExecFn = async ({ command, cwd }) => {
  const argv = command.trim().split(/\s+/).filter(Boolean)
  if (argv.length === 0) return { exitCode: 1 }
  try {
    const r = await runCommandCapture(argv, { cwd })
    // `code` is null when killed by signal/timeout → treat as a failed gate.
    return { exitCode: r.code ?? 1 }
  } catch {
    return { exitCode: 1 }
  }
}
