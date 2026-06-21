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

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { parseBoolEnv, runCommandCapture } from "./lib/exec"
import { liveExec } from "./lib/orchestration"
import { readDiscoveredGate } from "./lib/orchestration/gate-discovery"
import { checksForDescriptor, descriptorHash, parseGateDescriptor, type GateDescriptor } from "./lib/orchestration/harness-parse"
import { hookMcpRuntimeFromEnv } from "./lib/orchestration/hook-mcp-client"
import {
  decideStopHook,
  fileBlockBudget,
  launchBaselineKey,
  stopGateId,
  stopReviewEnabled,
  type StopReviewContext,
} from "./lib/orchestration/stop-gate-hook"
import {
  fileBaselineStore,
  fileLastPromptStore,
  fileReviewDebounce,
  repoRoot,
  stopGateEnabledForRepo,
  stopReviewStateDir,
} from "./lib/orchestration/stop-gate-policy"

/**
 * Read the hook payload from stdin SYNCHRONOUSLY (`readFileSync(0)`). An async
 * stdin read leaves an in-flight libuv FS request that, on Windows, races the
 * process teardown and trips a `uv_async_send` assertion; a synchronous read has
 * no such handle. Hooks always receive piped/redirected stdin, so this never
 * blocks (guarded against an interactive TTY, and any error -> "").
 */
function readStdin(): string {
  try {
    if (process.stdin.isTTY) return ""
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
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

/**
 * Fire-and-forget spawn of the detached background reviewer. The payload (which
 * includes the up-to-2-MiB diff) is written to a temp file SYNCHRONOUSLY before
 * the spawn — a pipe to the child's stdin would race the parent's `process.exit`
 * and could deliver a truncated diff. The child reads the file (path passed via
 * `GH_ROUTER_STOP_REVIEW_PAYLOAD`), unlinks it, and inherits the proxy URL/nonce
 * env. Everything is swallowed: the advisory layer never affects the stop.
 */
function spawnStopReview(ctx: StopReviewContext, extras: { prompt: string; transcriptPath: string }): void {
  let payloadPath: string | undefined
  try {
    const dir = stopReviewStateDir()
    mkdirSync(dir, { recursive: true })
    payloadPath = path.join(dir, `payload-${process.pid}-${randomBytes(4).toString("hex")}.json`)
    writeFileSync(
      payloadPath,
      JSON.stringify({
        session_id: ctx.sessionId,
        cwd: ctx.cwd,
        diff: ctx.diff,
        prompt: extras.prompt,
        transcript_path: extras.transcriptPath,
      }),
      { mode: 0o600 },
    )
    // Invoke the same binary's `internal-stop-review` subcommand. Mirror
    // buildStopHookCommand's resolution: pass the script path only when it
    // differs from the node/bun executable (a packaged single-file build).
    const scriptArgs = process.argv[1] && process.argv[1] !== process.execPath ? [process.argv[1]] : []
    const child = spawn(process.execPath, [...scriptArgs, "internal-stop-review"], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, GH_ROUTER_STOP_REVIEW_PAYLOAD: payloadPath },
    })
    // A spawn failure (EAGAIN / EACCES / fork limit) is delivered ASYNCHRONOUSLY
    // via the child's 'error' event, AFTER this synchronous try block exits. With
    // no listener Node escalates it to an uncaughtException — which main.ts turns
    // into process.exit(1), corrupting the Stop hook's exit code. Swallow it here
    // (and drop the now-orphaned payload the child never read) so the advisory
    // spawn truly never affects the stop.
    const orphan = payloadPath
    child.on("error", () => {
      if (orphan) {
        try {
          unlinkSync(orphan)
        } catch {
          /* best-effort */
        }
      }
    })
    child.unref()
  } catch {
    // Advisory spawn is best-effort; never disrupt the stop. If we wrote the
    // payload file but the spawn failed, drop it so it doesn't orphan (the
    // child — which would normally unlink it — never started).
    if (payloadPath) {
      try {
        unlinkSync(payloadPath)
      } catch {
        /* best-effort */
      }
    }
  }
}

/** The checks for a resolved descriptor: sealed descriptors resolve their sealed
 *  command set; parsed/discovered carry their own. */
type ResolveChecks = NonNullable<Parameters<typeof decideStopHook>[0]["resolveChecks"]>

/**
 * Build the dynamic `resolveChecks` for the live Stop hook, per the env the
 * launcher set:
 *   - GH_ROUTER_STOP_GATE_PARSED → re-derive the deterministic parser at the
 *     stop-time tree (stateless, no cache);
 *   - GH_ROUTER_STOP_GATE_DISCOVERED → read the cached evidence-pinned record.
 * Both pin the checks to the descriptor's `workdir` (the repo root) and compute
 * the launch-stable baseline key so the launch-captured (pre-mutation) baseline
 * is read. Any miss → null → the hook fails OPEN.
 */
function buildResolveChecks(mode: "parsed" | "discovered"): ResolveChecks {
  const includeTests = parseBoolEnv(process.env.GH_ROUTER_STOP_GATE_RUN_TESTS) === true
  return async (cwd: string) => {
    const root = await repoRoot(cwd).catch(() => cwd)
    let descriptor: GateDescriptor | null = null
    if (mode === "parsed") {
      descriptor = await parseGateDescriptor(root, { includeTests }).catch(() => null)
    } else {
      const rec = await readDiscoveredGate(root).catch(() => null)
      if (rec) {
        descriptor = {
          kind: "discovered",
          checks: rec.checks,
          ecosystem: rec.ecosystem,
          workdir: root,
          evidence: rec.evidence,
        }
      }
    }
    if (!descriptor) return null
    const checks = checksForDescriptor(descriptor)
    if (checks.length === 0) return null
    const descriptorKey = descriptorHash(descriptor)
    const workdir = descriptor.workdir || root
    const token = process.env.GH_ROUTER_STOP_GATE_BASELINE_TOKEN || undefined
    return { checks, workdir, descriptorKey, baselineKey: launchBaselineKey(workdir, descriptorKey, token) }
  }
}

/** Which dynamic gate mode the launcher armed (sealed → undefined). */
function dynamicMode(): "parsed" | "discovered" | undefined {
  if (parseBoolEnv(process.env.GH_ROUTER_STOP_GATE_PARSED) === true) return "parsed"
  if (parseBoolEnv(process.env.GH_ROUTER_STOP_GATE_DISCOVERED) === true) return "discovered"
  return undefined
}

export const internalStopHook = defineCommand({
  meta: {
    name: "internal-stop-hook",
    description:
      "Internal: the structural-gate Stop hook. Reads the Claude Code hook payload on stdin, "
      + "runs the sealed gate, exits 2 (blocks the stop) on a red gate or gate-weakening diff.",
  },
  async run() {
    const stdin = readStdin()
    // The advisory review (hook V2) is wired only when it's enabled AND the
    // launcher injected the proxy URL/nonce. It is side-effect-only: the
    // deterministic gate below is unchanged and remains the only blocker.
    const reviewEnabled = stopReviewEnabled() && hookMcpRuntimeFromEnv() !== undefined
    let transcriptPath = ""
    let userPrompt = ""
    if (reviewEnabled) {
      // Parse the payload once for the transcript pointer + the session id used
      // to look up the user's last prompt (the Stop payload carries no prompt;
      // the UserPromptSubmit hook stashed it). Best-effort — a parse miss just
      // means the reviewer judges against the diff alone.
      try {
        const p: unknown = JSON.parse(stdin)
        if (p && typeof p === "object") {
          const obj = p as { transcript_path?: unknown; session_id?: unknown }
          transcriptPath = typeof obj.transcript_path === "string" ? obj.transcript_path : ""
          const sid = typeof obj.session_id === "string" ? obj.session_id : ""
          if (sid) {
            userPrompt = (await fileLastPromptStore(stopReviewStateDir()).read(sid).catch(() => null)) ?? ""
          }
        }
      } catch {
        /* tolerate a non-JSON stdin */
      }
    }

    let decision: { exitCode: 0 | 2; stderr?: string }
    try {
      const timeoutEnv = Number.parseInt(process.env.GH_ROUTER_STOP_GATE_TIMEOUT_MS ?? "", 10)
      const mode = dynamicMode()
      decision = await decideStopHook({
        stdin,
        gateId: stopGateId(),
        exec: liveExec,
        captureDiff,
        fallbackCwd: process.cwd(),
        budget: fileBlockBudget(path.join(tmpdir(), "gh-router-stopgate")),
        baseline: fileBaselineStore(path.join(tmpdir(), "gh-router-stopgate-baseline")),
        isEnabledForRepo: (cwd) => stopGateEnabledForRepo(cwd),
        resolveChecks: mode ? buildResolveChecks(mode) : undefined,
        timeoutMs: Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? timeoutEnv : undefined,
        reviewDebounce: reviewEnabled ? fileReviewDebounce(stopReviewStateDir()) : undefined,
        spawnReview: reviewEnabled
          ? (ctx) => spawnStopReview(ctx, { prompt: userPrompt, transcriptPath })
          : undefined,
      })
    } catch {
      // Fail OPEN on ANY unexpected error: a Stop hook must never wedge the
      // session, so an internal crash allows the stop (exit 0) rather than
      // surfacing a non-blocking error or a hang.
      process.exitCode = 0
      return
    }
    // Write any stderr the decision carries — both the exit-2 block reason AND
    // the LOUD exit-0 stand-down (max-block budget reached). A clean green stop
    // carries no stderr, so this stays silent on the common path.
    if (decision.stderr) {
      await writeStderr(`${decision.stderr}\n`)
    }
    // Natural exit: set the code and return. A hard process.exit() races libuv's
    // stdio teardown on Windows (uv_async_send assertion) on the fast-return
    // paths. The detached review child is unref'd and the gate's children are
    // reaped, so no handle keeps the loop alive — the process exits with this
    // code. The exit-2 block contract is preserved (stderr is flushed above).
    process.exitCode = decision.exitCode
  },
})
