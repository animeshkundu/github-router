#!/usr/bin/env bun
/**
 * Opt-in LIVE prompt-cache measurement harness.
 *
 *   GH_ROUTER_RUN_CACHE_PROBE=1 bun run probe:cache
 *
 * Spawns the REAL launcher (`bun run ./src/main.ts claude`) and the REAL
 * installed Claude Code CLI, feeding >=2 user turns over stdin in one
 * process via `--input-format stream-json --output-format stream-json`, so
 * the requests are authentic append-only multi-turn Claude Code traffic
 * (not a hand-built `/v1/messages` payload). Costs real Copilot budget.
 *
 * See docs/prompt-caching.md for the full design, the JSONL input/output
 * schema this relies on, and the proof limitations.
 *
 * Config (all optional):
 *   GH_ROUTER_CACHE_PROBE_TRIALS         controlled trials per model (default 3)
 *   GH_ROUTER_CACHE_PROBE_TURNS          user turns per short controlled/authentic
 *                                        trial, >=2 (default 2)
 *   GH_ROUTER_CACHE_PROBE_PREFIX_CHARS   deterministic system-prompt chars for
 *                                        controlled trials — an explicit value
 *                                        here overrides the PER-MODEL default
 *                                        (6,000 chars; 40,000 for Gemini/Grok,
 *                                        whose implicit-cache floor measured
 *                                        higher — see systemPrefixCharsFor)
 *   GH_ROUTER_CACHE_PROBE_GROWING_TURNS  turns in the GPT-5.6 growing-history
 *                                        trial, >=3 (default 4)
 *   GH_ROUTER_CACHE_PROBE_GROWING_CHUNK_CHARS  chars appended per growing-history
 *                                        turn (default 6000)
 *   GH_ROUTER_CACHE_PROBE_TIMEOUT_MS     per-trial child wall-clock (default 180000)
 *   GH_ROUTER_CACHE_PROBE_MAX_BUDGET_USD forwarded as `--max-budget-usd` (unset = no cap)
 *   GH_ROUTER_CACHE_PROBE_OUTPUT         evidence artifact path override
 *
 * Pure parsing/verdict/catalog-selection logic lives in
 * `src/lib/cache-probe.ts` and is unit-tested in `tests/cache-probe.test.ts`
 * without any live model call.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import {
  buildCacheProbeClaudeArgs,
  buildCacheProbeTurns,
  buildGrowingHistoryTurns,
  buildSaltedSystemPrefix,
  buildStreamJsonUserLine,
  cacheOracleClassFor,
  computeCacheProbeExitDecision,
  computeCacheProbeRollup,
  computeCacheProbeVerdict,
  computeGrowingHistoryVerdict,
  isCacheProbeResultEvent,
  parseCacheProbeResultUsage,
  randomSaltHex,
  selectCacheProbeTargets,
  systemPrefixCharsFor,
  type CacheOracleClass,
  type CacheProbeVerdict,
  type CacheProbeVerdictResult,
  type CacheUsageSample,
  type ResolvedCacheProbeTarget,
} from "~/lib/cache-probe"
import { runCommandCapture } from "~/lib/exec"
import { PATHS } from "~/lib/paths"
import { ensurePaths } from "~/lib/paths"
import { setupCopilotToken, setupGitHubToken, type StopCopilotTokenRefresh } from "~/lib/token"
import { getPackageVersion } from "~/lib/version"
import { getModels } from "~/services/copilot/get-models"

const REPO_ROOT = path.resolve(import.meta.dir, "..")
const MAIN_ENTRY = path.join(REPO_ROOT, "src", "main.ts")

const INSTRUCTIONS = `Live prompt-cache measurement harness is gated (costs real Copilot budget).

Set GH_ROUTER_RUN_CACHE_PROBE=1 to run it, e.g.:

  GH_ROUTER_RUN_CACHE_PROBE=1 bun run probe:cache

It resolves claude-opus-5, claude-haiku-4.5, all three GPT-5.6 tiers
(sol/terra/luna), gemini-3.8-flash, and the highest-context grok-4.6* sibling
from the LIVE Copilot catalog, then spawns
the real launcher ("bun run ./src/main.ts claude") and the real installed
Claude Code CLI for each, feeding multi-turn stdin traffic and reading the
per-turn result-event usage's cache fields (NOT assistant.message.usage,
which is a synthesized all-zero placeholder for translated models). See
docs/prompt-caching.md.`

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw || !/^\d+$/.test(raw)) return fallback
  const parsed = Number(raw)
  return parsed > 0 ? parsed : fallback
}

/**
 * Env keys this harness's OWN session may already carry (this script itself
 * commonly runs INSIDE a `github-router claude` session) that are
 * session-routing state, not general environment — a nested `bun run
 * ./src/main.ts claude` inherits `process.env` by default, and without this
 * scrub it would silently reuse the OUTER session's config mirror and
 * Stop-hook wiring instead of starting clean. Live-observed: a probe run
 * with `--no-stop-gate` still executed the CALLING session's Stop hook
 * because `GH_ROUTER_HOOK_MCP_URL`/`GH_ROUTER_HOOK_NONCE` (pointing at the
 * outer session's still-running hook MCP server) survived the env spread —
 * `--no-stop-gate` only stops the NESTED session from arming its OWN gate,
 * it does not erase inherited pointers to a DIFFERENT, already-armed one.
 * That produced 3 extra API calls per user turn and corrupted samples.
 */
const INHERITED_SESSION_ENV_KEYS: ReadonlyArray<string> = [
  "CLAUDE_CONFIG_DIR",
  "GH_ROUTER_HOOK_MCP_URL",
  "GH_ROUTER_HOOK_NONCE",
  "GH_ROUTER_STOP_GATE_ID",
  "GH_ROUTER_STOP_GATE_PARSED",
  "GH_ROUTER_STOP_GATE_DISCOVERED",
  "GH_ROUTER_STOP_GATE_RUN_TESTS",
  "GH_ROUTER_STOP_GATE_BASELINE_TOKEN",
]

function buildChildEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of INHERITED_SESSION_ENV_KEYS) delete env[key]
  return {
    ...env,
    // Headless-mode opt-in: `claude` normally hard-requires a TTY. This
    // harness's `--print --input-format stream-json --output-format
    // stream-json` combination never touches one — see the comment on this
    // flag in src/claude.ts.
    GH_ROUTER_ALLOW_HEADLESS_CLAUDE: "1",
    // Keep each trial to exactly what it's measuring: no proxy self-update,
    // no toolbelt/semantic-search provisioning, no Windows keep-awake helper.
    GH_ROUTER_NO_SELF_UPDATE: "1",
    GH_ROUTER_DISABLE_TOOLBELT: "1",
    GH_ROUTER_DISABLE_SEMANTIC_SEARCH: "1",
    GH_ROUTER_DISABLE_KEEP_AWAKE: "1",
    GH_ROUTER_DISABLE_BROWSER_PROVISION: "1",
  }
}

async function consumeLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let all = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    const text = decoder.decode(value, { stream: true })
    all += text
    pending += text
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ""
    for (const line of lines) onLine(line)
  }
  pending += decoder.decode()
  if (pending) onLine(pending)
  return all
}

interface ChildTrialOutcome {
  exitCode: number | null
  timedOut: boolean
  samples: Array<CacheUsageSample>
  /** Count of top-level `result` events observed, regardless of whether a
   * usable `usage` field was extractable — if this differs from
   * `samples.length`, some `result` event was seen but had no extractable
   * usage, which is itself diagnostic rather than being silently dropped. */
  resultEventCount: number
  /** Set to a STABLE error classification (e.g. `EPIPE`, or the error's
   * `name`) when a stdin write (or the final `.end()`) threw — most
   * commonly from the child having already exited. Deliberately never the
   * raw error message: Node/Bun error messages can embed a file path, and
   * this harness's evidence artifact must not carry local paths. Turns fed
   * before the failure are still recorded; the trial is reported honestly
   * rather than letting the exception propagate and abort the whole
   * harness run. */
  stdinWriteError?: string
  /** Byte length of captured stderr — never the content. The evidence
   * artifact and verdict reasons must not carry raw stderr: it can contain
   * absolute paths, usernames, or (via a misconfigured child) secrets. */
  stderrBytes: number
}

/** Stable, path-free classification of a thrown value: the Node/Bun error
 * `code` (e.g. `EPIPE`) when present, else the constructor name, else
 * `"unknown"`. Never the raw `.message`, which can embed a file path. */
function classifyError(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code
    if (typeof code === "string" && code.length > 0) return code
    if (err instanceof Error && err.name) return err.name
  }
  return "unknown"
}

/** Spawns `bun run ./src/main.ts claude <claudeArgs>` (the real launcher +
 * real Claude Code CLI), feeds `turns` as `--input-format stream-json`
 * lines, closes stdin, and parses stdout as it arrives. Never uses a shell,
 * never sends a POSIX signal name — `proc.kill()` is Bun's cross-platform
 * default termination. */
async function runChildTrial(opts: {
  claudeArgs: ReadonlyArray<string>
  turns: ReadonlyArray<string>
  cwd: string
  timeoutMs: number
}): Promise<ChildTrialOutcome> {
  const proc = Bun.spawn(
    [process.execPath, "run", MAIN_ENTRY, "claude", ...opts.claudeArgs],
    {
      cwd: opts.cwd,
      env: buildChildEnv(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )

  // Feed turns one at a time. Claude Code's stream-json input is interactive:
  // queueing every line and closing stdin immediately can make it terminate
  // after only part of the queue. A top-level result is the acknowledgement
  // that the current turn completed and the next line may be sent.
  let stdinWriteError: string | undefined
  let sentTurns = 0
  let stdinEndPromise: Promise<void> | undefined
  const sendNextTurn = (): void => {
    if (stdinWriteError || sentTurns >= opts.turns.length) return
    try {
      proc.stdin.write(`${buildStreamJsonUserLine(opts.turns[sentTurns])}\n`)
      sentTurns += 1
    } catch (err) {
      stdinWriteError = classifyError(err)
    }
  }
  const closeStdin = (): void => {
    if (stdinEndPromise) return
    stdinEndPromise = Promise.resolve(proc.stdin.end()).then(
      () => undefined,
      (err: unknown) => {
        stdinWriteError = classifyError(err)
      },
    )
  }

  const samples: Array<CacheUsageSample> = []
  let resultEventCount = 0
  const onStdoutLine = (line: string) => {
    if (!isCacheProbeResultEvent(line)) return
    resultEventCount += 1
    const sample = parseCacheProbeResultUsage(line)
    if (sample) samples.push(sample)
    if (sentTurns < opts.turns.length) sendNextTurn()
    else closeStdin()
  }

  const stdoutPromise = consumeLines(proc.stdout, onStdoutLine)
  sendNextTurn()
  if (opts.turns.length === 0) closeStdin()
  // Content is discarded — only the byte count is retained (see
  // `stderrBytes` doc comment above).
  let stderrBytes = 0
  const stderrPromise = consumeLines(proc.stderr, () => {}).then((all) => {
    stderrBytes = Buffer.byteLength(all, "utf8")
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, opts.timeoutMs)

  const exitCode = await proc.exited
  clearTimeout(timer)
  await Promise.all([
    stdoutPromise,
    stderrPromise,
    stdinEndPromise ?? Promise.resolve(),
  ])

  return {
    exitCode,
    timedOut,
    samples,
    resultEventCount,
    stdinWriteError,
    stderrBytes,
  }
}

interface TrialRecord {
  label: string
  controlled: boolean
  saltHex: string
  systemPrefixChars?: number
  turnCount: number
  exitCode: number | null
  timedOut: boolean
  elapsedMs: number
  resultEventCount: number
  stdinWriteError?: string
  samples: Array<CacheUsageSample>
  verdict: CacheProbeVerdictResult
}

async function runOneTrial(opts: {
  catalogId: string
  controlled: boolean
  salt: string
  turns: ReadonlyArray<string>
  /** Deterministic (already-salted) `--system-prompt` text for a controlled
   * trial (required when `controlled` is true; ignored otherwise). */
  systemPrefix?: string
  /** Authentic trial only: forwarded as `--append-system-prompt`. */
  appendSystemPromptSalt?: string
  /** Recorded in the evidence artifact for a controlled trial's system
   * prompt size. Distinct from any per-turn growing-history chunk size. */
  systemPrefixCharsForRecord?: number
  timeoutMs: number
  maxBudgetUsd?: string
  parentDir: string
  label: string
  /** Verdict function to apply — `computeGrowingHistoryVerdict` for the
   * growing-history trial, `computeCacheProbeVerdict` (default) otherwise. */
  verdictFn?: (
    oracleClass: CacheOracleClass,
    samples: ReadonlyArray<CacheUsageSample>,
    expectedTurns: number,
  ) => CacheProbeVerdictResult
}): Promise<TrialRecord> {
  const claudeArgs = buildCacheProbeClaudeArgs({
    modelId: opts.catalogId,
    controlled: opts.controlled,
    systemPrefix: opts.systemPrefix,
    appendSystemPromptSalt: opts.appendSystemPromptSalt,
    maxBudgetUsd: opts.maxBudgetUsd,
  })

  const trialDir = mkdtempSync(path.join(opts.parentDir, "trial-"))
  const startedAt = Date.now()
  let child: ChildTrialOutcome
  try {
    child = await runChildTrial({ claudeArgs, turns: opts.turns, cwd: trialDir, timeoutMs: opts.timeoutMs })
  } finally {
    rmSync(trialDir, { recursive: true, force: true })
  }
  const elapsedMs = Date.now() - startedAt
  const turnCount = opts.turns.length
  const verdictFn = opts.verdictFn ?? computeCacheProbeVerdict

  // A child failure/timeout is reported honestly, never laundered into a
  // cold/warm verdict and never auto-retried. Never carries raw stderr
  // content or the raw stdin-write error message — see the doc comments on
  // `ChildTrialOutcome.stderrBytes`/`stdinWriteError`.
  let verdict: CacheProbeVerdictResult
  if (child.timedOut) {
    verdict = {
      verdict: "AMBIGUOUS",
      reason: `child process timed out after ${opts.timeoutMs}ms and was killed`,
    }
  } else if (child.exitCode !== 0) {
    verdict = {
      verdict: "AMBIGUOUS",
      reason:
        `child process exited with code ${child.exitCode} (stderr: ${child.stderrBytes} bytes, not included)`
        + (child.stdinWriteError ? `; stdin write error: ${child.stdinWriteError}` : ""),
    }
  } else {
    verdict = verdictFn(cacheOracleClassFor(opts.catalogId), child.samples, turnCount)
  }

  return {
    label: opts.label,
    controlled: opts.controlled,
    saltHex: opts.salt,
    systemPrefixChars: opts.systemPrefixCharsForRecord,
    turnCount,
    exitCode: child.exitCode,
    timedOut: child.timedOut,
    elapsedMs,
    resultEventCount: child.resultEventCount,
    stdinWriteError: child.stdinWriteError,
    samples: child.samples,
    verdict,
  }
}

function contextWindowNoteFor(target: ResolvedCacheProbeTarget): string | undefined {
  if (target.contextWindow === undefined) return undefined
  if (target.contextWindow >= 1_000_000) return undefined
  return `sub-1M advertised context (${target.contextWindow} tokens) — reported as measured, not assumed 1M`
}

async function commandOutput(command: ReadonlyArray<string>, cwd: string): Promise<string> {
  try {
    const result = await runCommandCapture([...command], { cwd, timeoutMs: 10_000 })
    if (result.code !== 0) return "unknown"
    return result.stdout.trim() || "unknown"
  } catch {
    return "unknown"
  }
}

function resolveOutputPath(): string {
  const override = process.env.GH_ROUTER_CACHE_PROBE_OUTPUT
  if (override) return path.resolve(override)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  return path.join(PATHS.APP_DIR, "cache-probe", `cache-probe-${stamp}.json`)
}

interface ModelProbeResult {
  requestedId: string
  catalogId?: string
  contextWindow?: number
  contextWindowNote?: string
  oracleClass?: CacheOracleClass
  trials: Array<TrialRecord>
  authenticTrial?: TrialRecord
  growingHistoryTrial?: TrialRecord
  rollup: CacheProbeVerdict | "MIXED"
  /** True when this target was absent from the live catalog — no trials
   * ran. Still contributes an AMBIGUOUS verdict to the overall exit-code
   * decision so an all-missing run can never read as a silent pass. */
  missing?: boolean
}

/** A short, fixed system prompt for the growing-history trial — that
 * trial's variable of interest is CONVERSATION-history cache coverage, not
 * system-prompt cache coverage (already covered by the controlled trial),
 * so its own system prompt does not need to be large. Salted per trial for
 * the same isolation reason as the controlled trial's system prompt. */
const GROWING_HISTORY_SYSTEM_PROMPT_BASE =
  "github-router prompt-cache probe: growing-history trial. Follow user instructions exactly."

async function main(): Promise<void> {
  if (process.env.GH_ROUTER_RUN_CACHE_PROBE !== "1") {
    console.log(INSTRUCTIONS)
    return
  }

  const trialsPerModel = positiveIntEnv("GH_ROUTER_CACHE_PROBE_TRIALS", 3)
  const turnCount = Math.max(2, positiveIntEnv("GH_ROUTER_CACHE_PROBE_TURNS", 2))
  const rawPrefixChars = process.env.GH_ROUTER_CACHE_PROBE_PREFIX_CHARS
  const prefixCharsOverride =
    rawPrefixChars && /^\d+$/.test(rawPrefixChars) && Number(rawPrefixChars) > 0
      ? Number(rawPrefixChars)
      : undefined
  const growingTurnCount = Math.max(3, positiveIntEnv("GH_ROUTER_CACHE_PROBE_GROWING_TURNS", 4))
  const growingChunkChars = positiveIntEnv("GH_ROUTER_CACHE_PROBE_GROWING_CHUNK_CHARS", 6_000)
  const timeoutMs = positiveIntEnv("GH_ROUTER_CACHE_PROBE_TIMEOUT_MS", 180_000)
  const maxBudgetUsd = process.env.GH_ROUTER_CACHE_PROBE_MAX_BUDGET_USD

  await ensurePaths()
  await setupGitHubToken()

  let stopRefresh: StopCopilotTokenRefresh | undefined
  try {
    stopRefresh = await setupCopilotToken()
  } catch (err) {
    console.error("Failed to obtain a Copilot token:", err)
    process.exitCode = 1
    return
  }

  try {
    let catalog: Awaited<ReturnType<typeof getModels>>
    try {
      catalog = await getModels()
    } catch (err) {
      console.error("Failed to fetch the live Copilot model catalog:", err)
      process.exitCode = 1
      return
    }

    const selection = selectCacheProbeTargets(catalog.data)
    if (selection.missing.length > 0) {
      console.warn(`Not present in the live catalog, skipping: ${selection.missing.join(", ")}`)
    }

    const parentDir = mkdtempSync(path.join(tmpdir(), "gh-router-cache-probe-"))
    const modelResults: Array<ModelProbeResult> = []
    try {
      for (const target of selection.targets) {
        if (!target.found || !target.catalogId) {
          // Missing targets are represented explicitly, not silently
          // skipped — an all-missing catalog must never read as a passing
          // run (see computeCacheProbeExitDecision's empty-input handling).
          modelResults.push({
            requestedId: target.requestedId,
            trials: [],
            rollup: "AMBIGUOUS",
            missing: true,
          })
          continue
        }
        const catalogId = target.catalogId
        console.log(`\n== ${target.requestedId} -> ${catalogId} ==`)
        const oracleClass = cacheOracleClassFor(catalogId)
        const prefixChars = systemPrefixCharsFor(catalogId, prefixCharsOverride)

        const trials: Array<TrialRecord> = []
        for (let i = 0; i < trialsPerModel; i++) {
          const salt = randomSaltHex()
          const trial = await runOneTrial({
            catalogId,
            controlled: true,
            salt,
            turns: buildCacheProbeTurns(salt, turnCount),
            // Salt PREPENDED so the prefix is unique per trial (same total
            // length) — otherwise every trial's "cold" first turn shares a
            // byte-identical prefix and can read a PRIOR trial's cache.
            systemPrefix: buildSaltedSystemPrefix(prefixChars, salt),
            systemPrefixCharsForRecord: prefixChars,
            timeoutMs,
            maxBudgetUsd,
            parentDir,
            label: `controlled-${i}`,
          })
          trials.push(trial)
          console.log(`  controlled trial ${i}: ${trial.verdict.verdict} — ${trial.verdict.reason}`)
        }

        // One authentic trial per native-Claude target: default toolset,
        // default system prompt, salted first turn, single execution (not
        // multiplied by trialsPerModel). The salt is
        // forwarded via `--append-system-prompt` (not `--system-prompt`) so
        // Claude Code's own default system prompt/toolset stays intact;
        // that shared built-in boilerplate is common across every session
        // ever run and will still legitimately cache-hit regardless of this
        // salt — expected provider-level caching, not contamination.
        let authenticTrial: TrialRecord | undefined
        if (catalogId.startsWith("claude-")) {
          const salt = randomSaltHex()
          authenticTrial = await runOneTrial({
            catalogId,
            controlled: false,
            salt,
            turns: buildCacheProbeTurns(salt, turnCount),
            appendSystemPromptSalt: salt,
            timeoutMs,
            maxBudgetUsd,
            parentDir,
            label: "authentic",
          })
          console.log(`  authentic trial: ${authenticTrial.verdict.verdict} — ${authenticTrial.verdict.reason}`)
        }

        // Growing-history trial, GPT-5.6 family only: a fixed-size two-turn
        // trial cannot distinguish "the whole growing conversation is
        // cached" from "only the static system prompt is cached" — live
        // measurement found exactly the latter (cache_read staying flat at
        // roughly the system-prompt size while input grew every turn). Uses
        // `computeGrowingHistoryVerdict`, NOT the generic current-turn-total
        // ratio: with large new chunks appended every turn, even perfect
        // caching can't reach a 0.9-of-CURRENT-turn-total bar, so this
        // trial's oracle compares each turn's cache_read against the PRIOR
        // turn's own total instead (see the function's doc comment).
        let growingHistoryTrial: TrialRecord | undefined
        if (catalogId.startsWith("gpt-5.6")) {
          const salt = randomSaltHex()
          growingHistoryTrial = await runOneTrial({
            catalogId,
            controlled: true,
            salt,
            turns: buildGrowingHistoryTurns(salt, growingTurnCount, growingChunkChars),
            systemPrefix: `${salt} ${GROWING_HISTORY_SYSTEM_PROMPT_BASE}`,
            systemPrefixCharsForRecord: GROWING_HISTORY_SYSTEM_PROMPT_BASE.length + salt.length + 1,
            timeoutMs,
            maxBudgetUsd,
            parentDir,
            label: "growing-history",
            verdictFn: computeGrowingHistoryVerdict,
          })
          console.log(`  growing-history trial: ${growingHistoryTrial.verdict.verdict} — ${growingHistoryTrial.verdict.reason}`)
        }

        // Rollup covers EVERY trial type that ran for this model — controlled,
        // authentic, AND growing-history — never controlled trials alone.
        // A per-model rollup that only looked at controlled trials let a
        // growing-history or authentic-trial regression disappear behind a
        // passing controlled average.
        const componentVerdicts: Array<CacheProbeVerdict> = [
          ...trials.map((t) => t.verdict.verdict),
          ...(authenticTrial ? [authenticTrial.verdict.verdict] : []),
          ...(growingHistoryTrial ? [growingHistoryTrial.verdict.verdict] : []),
        ]

        modelResults.push({
          requestedId: target.requestedId,
          catalogId,
          contextWindow: target.contextWindow,
          contextWindowNote: contextWindowNoteFor(target),
          oracleClass,
          trials,
          authenticTrial,
          growingHistoryTrial,
          rollup: computeCacheProbeRollup(componentVerdicts),
        })
      }
    } finally {
      rmSync(parentDir, { recursive: true, force: true })
    }

    // Exit-code decision is computed from the FLAT list of every individual
    // trial verdict across every model and every trial type — never from
    // the per-model rollups alone, for the same reason the rollup itself
    // must include authentic/growing: a rollup can already be "MIXED" or
    // a single bad trial can hide inside an otherwise-PASS rollup summary.
    // A missing target contributes its own AMBIGUOUS rollup directly (it has
    // no trials to flatten), so an all-missing run still drives exit 1.
    const allTrialVerdicts: Array<CacheProbeVerdict> = modelResults.flatMap((result) => {
      if (result.missing) return [result.rollup as CacheProbeVerdict]
      return [
        ...result.trials.map((t) => t.verdict.verdict),
        ...(result.authenticTrial ? [result.authenticTrial.verdict.verdict] : []),
        ...(result.growingHistoryTrial ? [result.growingHistoryTrial.verdict.verdict] : []),
      ]
    })
    const exitDecision = computeCacheProbeExitDecision(allTrialVerdicts)
    process.exitCode = exitDecision.exitCode

    const [commitSha, claudeCliVersion] = await Promise.all([
      commandOutput(["git", "rev-parse", "HEAD"], REPO_ROOT),
      commandOutput(["claude", "--version"], REPO_ROOT),
    ])

    const artifact = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      commitSha,
      claudeCliVersion,
      routerVersion: getPackageVersion(),
      config: {
        trialsPerModel,
        turnCount,
        prefixCharsOverride: prefixCharsOverride ?? null,
        growingTurnCount,
        growingChunkChars,
        timeoutMs,
        maxBudgetUsd: maxBudgetUsd ?? null,
      },
      catalogSelection: selection,
      results: modelResults,
      exitCode: exitDecision.exitCode,
      warning: exitDecision.warning ?? null,
    }

    const outputPath = resolveOutputPath()
    mkdirSync(path.dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`)

    console.log("\n--- summary ---")
    for (const result of modelResults) {
      const controlledSummary = result.trials.map((t) => t.verdict.verdict).join(",")
      const authenticSummary = result.authenticTrial ? ` authentic=${result.authenticTrial.verdict.verdict}` : ""
      const growingSummary = result.growingHistoryTrial ? ` growing=${result.growingHistoryTrial.verdict.verdict}` : ""
      console.log(
        `${result.requestedId} (${result.catalogId}): overall=${result.rollup} `
        + `controlled=[${controlledSummary}]${authenticSummary}${growingSummary}`
        + `${result.contextWindowNote ? ` [${result.contextWindowNote}]` : ""}`,
      )
    }
    if (exitDecision.warning) {
      console.warn(`\nWARNING: ${exitDecision.warning}`)
    }
    console.log(`\nEvidence artifact: ${outputPath}`)
    console.log(`Exit code: ${exitDecision.exitCode}`)
  } finally {
    stopRefresh?.()
  }
}

if (import.meta.main) await main()
