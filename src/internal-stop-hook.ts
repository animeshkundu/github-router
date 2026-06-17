/**
 * The internal `internal-stop-hook` subcommand: the executable a spawned Claude
 * Code session's Stop hook invokes (registered into the mirrored settings.json by
 * the launcher when `GH_ROUTER_ENABLE_STOP_GATE` is set). It reads Claude Code's
 * hook payload from stdin, runs the SEALED structural gate over the session's
 * working-tree diff, and maps the result to the hook exit contract: exit 2 (with
 * the reason on stderr) blocks the stop so the model fixes the failure; exit 0
 * allows it. The `stop_hook_active` loop guard (in `decideStopHook`) guarantees
 * it can never wedge the session.
 *
 * All decision logic lives in `decideStopHook` (pure, unit-tested); this wrapper
 * only does stdin read + the live `git diff` capture + the exit. The live firing
 * is verified by the gated E2E (it needs a real spawned session).
 */

import { defineCommand } from "citty"

import { tmpdir } from "node:os"
import path from "node:path"

import { runCommandCapture } from "./lib/exec"
import { liveExec } from "./lib/orchestration"
import { decideStopHook, fileBlockBudget, stopGateId } from "./lib/orchestration/stop-gate-hook"
import { fileBaselineStore, stopGateEnabledForRepo } from "./lib/orchestration/stop-gate-policy"

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  try {
    for await (const c of process.stdin) chunks.push(c as Buffer)
  } catch {
    // no stdin / closed early -> treat as empty (decideStopHook tolerates it).
  }
  return Buffer.concat(chunks).toString("utf8")
}

/** Max diff bytes scanned for gate-weakening: a hard cap so a huge generated diff
 *  (e.g. a lockfile) can never OOM or stall the hook. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024

/** Capture the working-tree diff WITHOUT mutating the user's index (no
 *  `git add -N`): `git diff HEAD` covers modified tracked files, which is where
 *  gate-weakening edits live. Best-effort: any git failure yields an empty diff
 *  (the weakening scan is then a no-op; the executable gate still runs). Capped. */
async function captureDiff(cwd: string): Promise<string> {
  const r = await runCommandCapture(["git", "diff", "HEAD"], { cwd, timeoutMs: 5_000 }).catch(() => undefined)
  const out = r?.stdout ?? ""
  return out.length > MAX_DIFF_BYTES ? out.slice(0, MAX_DIFF_BYTES) : out
}

/** Flush a message to stderr before exiting (process.exit can drop an unflushed
 *  write; the model reads this stderr on a block). */
async function writeStderr(msg: string): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stderr.write(msg, () => resolve())
  })
}

export const internalStopHook = defineCommand({
  meta: {
    name: "internal-stop-hook",
    description:
      "Internal: the structural-gate Stop hook. Reads the Claude Code hook payload on stdin, "
      + "runs the sealed gate, exits 2 (blocks the stop) on a red gate or gate-weakening diff.",
  },
  async run() {
    const stdin = await readStdin()
    const timeoutEnv = Number.parseInt(process.env.GH_ROUTER_STOP_GATE_TIMEOUT_MS ?? "", 10)
    const decision = await decideStopHook({
      stdin,
      gateId: stopGateId(),
      exec: liveExec,
      captureDiff,
      fallbackCwd: process.cwd(),
      budget: fileBlockBudget(path.join(tmpdir(), "gh-router-stopgate")),
      baseline: fileBaselineStore(path.join(tmpdir(), "gh-router-stopgate-baseline")),
      isEnabledForRepo: (cwd) => stopGateEnabledForRepo(cwd),
      timeoutMs: Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? timeoutEnv : undefined,
    })
    if (decision.exitCode === 2 && decision.stderr) {
      await writeStderr(`${decision.stderr}\n`)
    }
    process.exit(decision.exitCode)
  },
})
