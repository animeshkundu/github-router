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
import { isSubagentContext, regressions, type BaselineStore, type ReviewDebounce } from "./stop-gate-policy"
import { parseBoolEnv } from "~/lib/exec"

import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import nodePath from "node:path"

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

/**
 * The advisory background review (hook V2) is ON by default whenever the Stop
 * gate runs; it is the cross-lab accountability layer. Opt out with
 * `GH_ROUTER_DISABLE_STOP_REVIEW=1` to keep the deterministic gate but drop the
 * LLM review. (Disabling the whole gate with `GH_ROUTER_DISABLE_STOP_GATE=1`
 * also drops the review, since the review only ever fires from the gate's green
 * path.)
 */
export function stopReviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBoolEnv(env.GH_ROUTER_DISABLE_STOP_REVIEW) !== true
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
 * Idempotently merge a hook running `command` for `event` (default `Stop`) into
 * an existing Claude Code settings object WITHOUT clobbering other hook events or
 * other entries. Returns a new object (never mutates the input). Re-running the
 * launcher with the same command+event does not duplicate the hook.
 */
export function mergeStopHookIntoSettings(
  existing: Record<string, unknown> | undefined,
  command: string,
  event: string = "Stop",
  timeoutSec?: number,
): Record<string, unknown> {
  const base: Record<string, unknown> = existing && typeof existing === "object" ? { ...existing } : {}
  const hooks: Record<string, unknown> =
    base.hooks && typeof base.hooks === "object" ? { ...(base.hooks as Record<string, unknown>) } : {}
  const arr: unknown[] = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : []
  if (!arr.some((e) => entryHasCommand(e, command))) {
    const hook: { type: "command"; command: string; timeout?: number } = { type: "command", command }
    if (typeof timeoutSec === "number" && Number.isFinite(timeoutSec) && timeoutSec > 0) {
      hook.timeout = timeoutSec
    }
    arr.push({ hooks: [hook] })
  }
  hooks[event] = arr
  base.hooks = hooks
  return base
}

/**
 * The Stop-hook subcommand decision, factored out so it is pure + unit-testable.
 * Given the raw stdin JSON Claude Code sends, the sealed gate id, an exec, a
 * diff-capture, and a persistent per-session block budget, it returns the exit
 * code (2 blocks, 0 allows) and the stderr Claude reads on a block.
 *
 * TERMINATION GUARANTEE (the one property that must hold: never wedge the
 * session). Three independent stand-down paths, any of which yields exit 0:
 *   1. unparseable stdin or no session_id  -> can't budget-track safely, allow;
 *   2. Claude Code's own `stop_hook_active` re-entry signal;
 *   3. a HARD per-session block budget (`maxBlocks`, default 3): after that many
 *      blocks for one session_id the gate ALWAYS allows the stop. This is the
 *      load-bearing guard, because `stop_hook_active` can reset when the model
 *      does intervening tool calls between stop attempts (so it alone does NOT
 *      bound the loop). Any budget IO failure also stands down (can't guarantee
 *      termination -> don't block).
 * The gate blocks only when ALL of these allow it AND the executable gate is red
 * or the diff weakens a gate.
 */
export interface StopHookDecision {
  exitCode: 0 | 2
  /** stderr text shown to Claude on a block (exit 2). */
  stderr?: string
}

/** Inputs the detached background reviewer needs (assembled on the green path). */
export interface StopReviewContext {
  sessionId: string
  cwd: string
  diff: string
  diffHash: string
}

/** A persistent per-session count of how many times the gate has blocked, so the
 *  budget survives across separate hook-process invocations within one session. */
export interface BlockBudget {
  count: (sessionId: string) => Promise<number>
  record: (sessionId: string) => Promise<void>
  /** Clear the count for a session (called by the per-prompt reset hook so the
   *  budget is per-user-prompt, not per-session-lifetime). */
  reset: (sessionId: string) => Promise<void>
}

export async function decideStopHook(input: {
  /** Raw stdin from Claude Code (a JSON payload; tolerated if malformed). */
  stdin: string
  gateId: string
  exec: ExecFn
  /** Capture the working-tree diff for the session cwd (e.g. `git diff HEAD`). */
  captureDiff: (cwd: string) => Promise<string>
  /** cwd to use when the payload omits one. */
  fallbackCwd: string
  /** Persistent per-session block budget (the hard termination guard). */
  budget: BlockBudget
  /** Per-session baseline of pre-existing failures (block only on regressions). */
  baseline: BaselineStore
  /**
   * Runtime trust re-check: act ONLY in a repo the user consented to (or
   * force-enabled). Injected for testability; the live wrapper passes
   * `stopGateEnabledForRepo`. This is the security gate — even though the
   * launcher only registers the hook for a trusted repo, re-checking at runtime
   * against `payload.cwd` defends against a mid-session cwd change.
   */
  isEnabledForRepo: (cwd: string) => Promise<boolean>
  /** Max blocks per prompt before the gate always allows (default 2). */
  maxBlocks?: number
  /** Absolute wall-clock cap on the diff+gate evaluation; on timeout the hook
   *  FAILS OPEN (exit 0) and never claims the gate passed. Default 300s. */
  timeoutMs?: number
  /**
   * Advisory-review layer (hook V2), entirely OPTIONAL and side-effect-only.
   * When BOTH `reviewDebounce` and `spawnReview` are provided, a GREEN stop with
   * a substantive diff (and a not-yet-reviewed diff hash) spawns a detached,
   * background read-only review. This NEVER affects the exit code — the
   * deterministic gate above is the only blocker. Any failure in this block is
   * swallowed (the stop still ends exit 0). Omitted in tests / when
   * `GH_ROUTER_DISABLE_STOP_REVIEW` is set → the deterministic gate is unchanged.
   */
  reviewDebounce?: ReviewDebounce
  /** Fire-and-forget spawn of the detached background reviewer. Must return
   *  immediately (detached + unref'd); decideStopHook never awaits the review. */
  spawnReview?: (ctx: StopReviewContext) => void
}): Promise<StopHookDecision> {
  const maxBlocks = input.maxBlocks ?? 2
  let payload: { cwd?: unknown; session_id?: unknown; agent_id?: unknown; agent_type?: unknown } = {}
  let parsed = false
  try {
    const p: unknown = JSON.parse(input.stdin)
    if (p && typeof p === "object") {
      payload = p as typeof payload
      parsed = true
    }
  } catch {
    // tolerate a non-JSON stdin.
  }
  // (1) abnormal payload -> fail OPEN (can't budget-track safely).
  if (!parsed) return { exitCode: 0 }
  // (2) SCOPING: stand down in any subagent / teammate context. A Stop hook is
  //     converted to SubagentStop for subagents, so this command CAN run there;
  //     the payload's agent_type/agent_id mark it. The gate is top-level-only.
  if (isSubagentContext(payload)) return { exitCode: 0 }
  const sessionId = typeof payload.session_id === "string" && payload.session_id.length > 0 ? payload.session_id : ""
  // (3) without a session id we cannot enforce the termination budget -> allow.
  if (!sessionId) return { exitCode: 0 }
  const cwdRaw = typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : input.fallbackCwd
  // Resolve symlinks ONCE so the consent check and the gate's exec target are
  // the same immutable path — defends against a symlink/rename swap between the
  // trust check and the exec (codex review #3). Keep the raw path if realpath
  // fails (e.g. the dir was removed) — the consent check then simply denies.
  let cwd = cwdRaw
  try {
    cwd = await fs.realpath(cwdRaw)
  } catch {
    /* keep raw */
  }
  // (4) CONSENT: only run the repo's scripts if the user trusted it (or forced).
  //     Any failure -> allow (never wedge, never run untrusted code).
  let enabled = false
  try {
    enabled = await input.isEnabledForRepo(cwd)
  } catch {
    return { exitCode: 0 }
  }
  if (!enabled) return { exitCode: 0 }
  // (5) hard per-prompt budget: never block more than maxBlocks times per
  //     prompt. This — NOT the (now-absent) stop_hook_active flag — is the
  //     termination guard; relying on stop_hook_active would defeat block-twice.
  let priorBlocks = 0
  try {
    priorBlocks = await input.budget.count(sessionId)
  } catch {
    return { exitCode: 0 } // can't read the budget -> can't guarantee termination -> allow.
  }
  if (priorBlocks >= maxBlocks) return { exitCode: 0 }

  // (6) Run the gate under an absolute timeout. The gate result is computed
  //     inside the raced promise; the BASELINE read/write happens AFTER the race
  //     resolves to a real result, so a timed-out (abandoned) eval can never
  //     seed or poison the baseline (codex review #5). The gate's child process
  //     is bounded + tree-killed by liveExec's per-command timeout, and the
  //     wrapper process.exit()s, so a timeout never wedges the session.
  //
  //     The working-tree diff is captured INSIDE the raced promise (so a stalled
  //     `git diff` is covered by the same absolute timeout, not run unbounded on
  //     the critical path) and RETURNED so the advisory review below judges the
  //     exact same tree without a second capture. captureDiff swallows its own
  //     failures to "".
  const runGate = async (): Promise<{ failedChecks: string[]; weakeningPatterns: string[]; diff: string }> => {
    const diff = await input.captureDiff(cwd).catch(() => "")
    const result = await runStopGateForLaunch({ workspace: cwd, gateId: input.gateId, exec: input.exec, diff })
    return {
      failedChecks: [...result.failedChecks],
      weakeningPatterns: [...new Set(result.weakening.map((w) => w.pattern))],
      diff,
    }
  }
  const timeoutMs = input.timeoutMs ?? 300_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const raced = await Promise.race<
    { failedChecks: string[]; weakeningPatterns: string[]; diff: string } | "timeout"
  >([
    runGate(),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs)
    }),
  ])
  if (timer) clearTimeout(timer)
  if (raced === "timeout") return { exitCode: 0 } // gate did not complete -> allow; never a claimed pass.

  // Baseline isolation, keyed by (session, cwd, gate) so a mid-session repo/gate
  // change can't mask or invent regressions (codex review #7). Only a COMPLETED
  // eval reads/writes it.
  const baselineKey = JSON.stringify([sessionId, cwd, input.gateId])
  const recorded = await input.baseline.get(baselineKey).catch(() => null)
  if (recorded === null) {
    await input.baseline.set(baselineKey, raced.failedChecks).catch(() => {})
  }
  const regressed = regressions(raced.failedChecks, recorded)
  const weakened = raced.weakeningPatterns.length > 0
  if (regressed.length === 0 && !weakened) {
    // GREEN stop. Fire the advisory background review (never blocks, never
    // changes the exit code). Fully isolated + time-bounded so a store or spawn
    // failure (or a stalled debounce read/write) can't turn a clean stop into
    // anything but a prompt exit 0.
    await maybeSpawnReview(input, sessionId, cwd, raced.diff)
    return { exitCode: 0 }
  }
  try {
    await input.budget.record(sessionId)
  } catch {
    return { exitCode: 0 } // can't persist the block -> can't bound the loop -> allow.
  }
  const parts: string[] = []
  if (regressed.length > 0) parts.push(`regressed gates: ${regressed.join(", ")}`)
  if (weakened) parts.push(`gate-weakening in the diff: ${raced.weakeningPatterns.join(", ")}`)
  return {
    exitCode: 2,
    stderr:
      `structural gate failed (block ${priorBlocks + 1}/${maxBlocks}): ${parts.join("; ")}. `
      + `Fix the failing checks and revert any gate-weakening (no new .skip / as any / `
      + `lint-disable) before finishing.`,
  }
}

/**
 * The advisory-review side-effect on a GREEN stop: debounce by diff hash, then
 * fire the detached background reviewer. ADVISORY-ONLY — it returns void, never
 * throws (every step is swallowed), and the caller does not await its result for
 * the exit decision. A no-op when the review layer isn't wired (no debounce /
 * spawn injected, e.g. GH_ROUTER_DISABLE_STOP_REVIEW) or the diff is empty.
 *
 * `markReviewed` runs BEFORE the spawn so a crashing spawn still records the
 * debounce (an identical tree won't re-trigger on the next stop). The review is
 * gated on the diff CHANGING since the last review — without it, every stop of
 * an unchanged tree would re-spend a background gpt-5.5 review.
 *
 * The whole body is bounded by a short timeout (the stores are local temp files
 * that complete in well under a millisecond in practice, so the timeout never
 * fires normally — but if the debounce read/write ever stalled, the stop must
 * still proceed promptly; the advisory layer never delays a clean stop).
 */
const REVIEW_SIDE_EFFECT_BUDGET_MS = 2_000

async function maybeSpawnReview(
  input: { reviewDebounce?: ReviewDebounce; spawnReview?: (ctx: StopReviewContext) => void },
  sessionId: string,
  cwd: string,
  diff: string,
): Promise<void> {
  if (!input.reviewDebounce || !input.spawnReview) return
  if (diff.trim().length === 0) return // no substantive diff -> nothing to review.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const work = (async (): Promise<void> => {
      const diffHash = createHash("sha256").update(diff).digest("hex")
      if (!(await input.reviewDebounce!.shouldReview(sessionId, diffHash))) return
      await input.reviewDebounce!.markReviewed(sessionId, diffHash)
      input.spawnReview!({ sessionId, cwd, diff, diffHash })
    })()
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, REVIEW_SIDE_EFFECT_BUDGET_MS)
      }),
    ])
  } catch {
    // Advisory layer must never affect the stop. Swallow everything.
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * A file-backed `BlockBudget` under `stateDir`, keyed by a hash of the session id
 * (so a session id is never written verbatim to a predictable path). Best-effort:
 * a read miss counts as 0; `record` increments. A write/read error propagates so
 * `decideStopHook` stands down (it can't guarantee termination without the
 * budget).
 */
export function fileBlockBudget(stateDir: string): BlockBudget {
  const fileFor = (sid: string): string =>
    nodePath.join(stateDir, `block-${createHash("sha256").update(sid).digest("hex").slice(0, 32)}`)
  const readCount = async (sid: string): Promise<number> => {
    try {
      const raw = await fs.readFile(fileFor(sid), "utf8")
      const n = Number.parseInt(raw.trim(), 10)
      return Number.isFinite(n) && n > 0 ? n : 0
    } catch {
      return 0 // a miss is 0 blocks so far.
    }
  }
  return {
    count: readCount,
    async record(sid) {
      const next = (await readCount(sid)) + 1
      await fs.mkdir(stateDir, { recursive: true })
      await fs.writeFile(fileFor(sid), String(next), { mode: 0o600 })
    },
    async reset(sid) {
      await fs.unlink(fileFor(sid)).catch(() => {})
    },
  }
}

/**
 * Build the shell command string Claude Code runs for the Stop hook. Invokes the
 * running github-router via its node/bun binary so it works regardless of PATH.
 * Pure (takes the binary + script paths) so the quoting is unit-testable; the
 * cross-platform firing is verified by the gated E2E.
 */
export function buildStopHookCommand(execPath: string, scriptPath: string | undefined): string {
  const q = (s: string): string => `"${s}"`
  if (scriptPath && scriptPath !== execPath) {
    return `${q(execPath)} ${q(scriptPath)} internal-stop-hook`
  }
  return `${q(execPath)} internal-stop-hook`
}

/**
 * Build the shell command Claude Code runs for the SessionStart/SessionEnd hooks
 * (registered only when github-router runs inside an ai-or-die Terminal tab). The
 * sidecar path is baked in as a literal `--out` arg — NOT passed via env — so it
 * survives `AIORDIE_CLAUDE_BIND` being stripped from the child's environment and a
 * nested `github-router claude` can't inherit it. Pure (binary + script + out
 * paths) for unit-testable quoting; the live firing is verified end-to-end.
 */
export function buildSessionBindHookCommand(
  execPath: string,
  scriptPath: string | undefined,
  outPath: string,
): string {
  const q = (s: string): string => `"${s}"`
  const head = scriptPath && scriptPath !== execPath ? `${q(execPath)} ${q(scriptPath)}` : q(execPath)
  return `${head} internal-session-bind --out ${q(outPath)}`
}

/**
 * Read-merge-atomic-write the Stop hook into a Claude Code `settings.json` file
 * (the mirrored one). A MISSING file (ENOENT) starts from `{}`; any OTHER read or
 * parse error THROWS (the caller's try/catch warns and continues) rather than
 * overwriting a file we couldn't understand with our defaults. Preserves every
 * other setting, is idempotent, and uses temp+rename so Claude Code's mtime
 * watcher never sees a half-written file. Returns the merged object.
 */
export async function injectStopHookIntoSettingsFile(
  settingsPath: string,
  command: string,
  event: string = "Stop",
  timeoutSec?: number,
): Promise<Record<string, unknown>> {
  let existing: Record<string, unknown> = {}
  let raw: string | undefined
  try {
    raw = await fs.readFile(settingsPath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err // never clobber on a transient read error.
    raw = undefined // missing file -> start clean.
  }
  if (raw !== undefined) {
    // A parse failure means a real file we don't understand: do NOT replace it.
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    } else {
      throw new Error(`settings.json at ${settingsPath} is not a JSON object; refusing to overwrite`)
    }
  }
  const merged = mergeStopHookIntoSettings(existing, command, event, timeoutSec)
  const tmp = `${settingsPath}.${process.pid}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(tmp, settingsPath)
  return merged
}
