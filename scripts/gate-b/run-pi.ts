// run-pi.ts — Gate B head-to-head eval driven by the REAL Pi Agent.
//
//   bun scripts/gate-b/run-pi.ts [--manifest <path>] [--tasks <path>]
//
// Compares gemini-3.5-flash vs gpt-5.4-mini, EACH at its highest (clamped)
// reasoning, for fast human-like browsing. Per task per model it builds a
// real Pi `Agent` (same wiring as src/lib/worker-agent/engine.ts) over the
// browse toolset, drives all 13 tasks for BOTH models (no stop-at-first),
// scores via SCORING.md (harness.ts), and prints a head-to-head table +
// a one-line verdict.
//
// The LEAD runs this live against the one real browser/bridge.

import { spawn } from "node:child_process"
import { access, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Agent } from "@earendil-works/pi-agent-core"
import type {
  AfterToolCallContext,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core"
import type {
  Model as PiModel,
} from "@earendil-works/pi-ai"

import { ensurePaths } from "~/lib/paths"
import { state } from "~/lib/state"
import { setupCopilotToken, setupGitHubToken } from "~/lib/token"
import { cacheModels, cacheCopilotVersion, cacheVSCodeVersion } from "~/lib/utils"
import { dispatchBrowserTool } from "~/lib/browser-mcp/dispatch"
import { buildBrowseTools, isBrowseTerminalTool } from "~/lib/worker-agent/browse-tools"
import { resolveModelAndThinking } from "~/lib/worker-agent/model-resolve"
import { createCopilotStreamFn, type ResolvedModel } from "~/lib/worker-agent/stream-fn"

import {
  SYSTEM_CONTRACT,
  FLASH_CONTRACT_VARIANTS,
  buildUserPrompt,
  resolveExpected,
  resolveTaskUrl,
  scoreTask,
  summarizeModel,
  type Manifest,
  type ModelVerdict,
  type Task,
  type TaskResult,
  type TaskScore,
  type TaskStatus,
  type ToolCallRecord,
} from "./harness"

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const SERVE_PATH = path.join(REPO_ROOT, "tests/fixtures/browser/serve.ts")
const DEFAULT_TASKS_PATH = path.join(REPO_ROOT, "scripts/gate-b/tasks.json")
const DEFAULT_MANIFEST_RUNTIME = path.join(REPO_ROOT, "tests/fixtures/browser/manifest.runtime.json")
const READY_MARKER = "GATE_B_READY "
const MANIFEST_TIMEOUT_MS = 30_000
const WALL_CLOCK_MS = 90_000

/** Models to compare, in order. Both run fully (no stop-at-first-pass). */
const MODELS = ["gemini-3.5-flash", "gpt-5.4-mini"]

// ----- Pi Model shim (replicated from engine.ts makeModelShim) ---------------

function makeModelShim(modelId: string): PiModel<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "github-copilot",
    baseUrl: "",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  }
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function resultTextOf(result: { content?: Array<unknown> } | undefined): string {
  if (!result?.content) return ""
  let out = ""
  for (const c of result.content) {
    if (c && typeof c === "object" && (c as { type?: string }).type === "text") {
      const t = (c as { text?: unknown }).text
      if (typeof t === "string") out += t
    }
  }
  return out
}

// ----- per-task Pi Agent run -------------------------------------------------

async function runTaskWithPi(
  resolved: ResolvedModel,
  task: Task,
  url: string,
  systemPrompt: string,
): Promise<TaskResult> {
  const toolTrace: Array<ToolCallRecord> = []
  const groundingTexts: Array<string> = []
  const openedTabIds = new Set<number>()
  let screenshotTaken = false
  let turnCount = 0
  let terminalTool: "submit_answer" | "report_insufficient" | undefined
  let terminalArgs: Record<string, unknown> = {}
  const startedAt = Date.now()
  // Assigned right after construction so the hooks can close over it (the
  // Agent isn't in scope inside its own constructor argument).
  let theAgent: Agent | undefined = undefined

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: makeModelShim(resolved.modelId),
      thinkingLevel: resolved.thinking,
      tools: buildBrowseTools(),
    },
    streamFn: createCopilotStreamFn({ resolved }),
    toolExecution: "parallel",
    beforeToolCall: async (
      ctx: BeforeToolCallContext,
    ): Promise<BeforeToolCallResult | undefined> => {
      const name = ctx.toolCall.name
      const args = (ctx.args && typeof ctx.args === "object" ? ctx.args : {}) as Record<
        string,
        unknown
      >
      if (isBrowseTerminalTool(name)) {
        // Capture the FIRST terminal call's args; the tool itself sets
        // terminate:true so Pi stops the loop after it runs.
        if (!terminalTool) {
          terminalTool = name === "submit_answer" ? "submit_answer" : "report_insufficient"
          terminalArgs = args
        }
        return undefined
      }
      // Block BEFORE recording, so a turn-capped (un-executed) call never
      // pollutes the coherence trace or the screenshot flag.
      if (turnCount >= task.maxTurns) {
        if (process.env.GATE_B_DEBUG === "1") console.log(`    [btc BLOCK] ${name} turnCount=${turnCount}>=${task.maxTurns}`)
        return { block: true, reason: "maxTurns reached" }
      }
      if (process.env.GATE_B_DEBUG === "1") console.log(`    [btc ok] ${name} turnCount=${turnCount}`)
      toolTrace.push({ tool: name, args })
      if (name === "screenshot") screenshotTaken = true
      return undefined
    },
    afterToolCall: async (ctx: AfterToolCallContext): Promise<undefined> => {
      if (!isBrowseTerminalTool(ctx.toolCall.name)) {
        const text = resultTextOf(ctx.result)
        groundingTexts.push(text)
        // Track tabs this task opened so we can close them at task end
        // (§12.2 per-task isolation — a fresh tab per task, no accumulation
        // across the 13×2 run that could degrade the shared browser).
        if (ctx.toolCall.name === "open_tab") {
          try {
            const tid = (JSON.parse(text) as { tabId?: unknown }).tabId
            if (typeof tid === "number") openedTabIds.add(tid)
          } catch {
            /* non-JSON / error result — nothing to track */
          }
        }
      }
      return undefined
    },
    prepareNextTurn: async (): Promise<undefined> => {
      // Bound the run: stop before exceeding the per-task turn cap.
      if (turnCount >= task.maxTurns) theAgent?.abort()
      return undefined
    },
  })
  theAgent = agent

  const unsubscribe = agent.subscribe((event) => {
    if (event.type !== "message_end") return
    const msg = (event as { message?: unknown }).message
    if (typeof msg !== "object" || msg === null) return
    if ((msg as { role?: unknown }).role !== "assistant") return
    // One message_end per assistant turn.
    turnCount++
    if (process.env.GATE_B_DEBUG === "1") {
      const content = (msg as { content?: Array<Record<string, unknown>> }).content ?? []
      const kinds = content.map((c) => c?.type).join(",")
      const sr = (msg as { stopReason?: unknown }).stopReason
      const tcs = content
        .filter((c) => c?.type === "toolCall")
        .map((c) => `name=${JSON.stringify(c.name)} id=${JSON.stringify(c.id)} args=${JSON.stringify(c.arguments).slice(0, 80)}`)
        .join(" | ")
      console.log(`    [message_end] turn=${turnCount} stopReason=${String(sr)} content=[${kinds}] ${tcs}`)
    }
  })

  const timer = setTimeout(() => agent.abort(), WALL_CLOCK_MS)
  timer.unref?.()
  try {
    await agent.prompt(buildUserPrompt(task, url))
    await agent.waitForIdle()
  } catch (err) {
    // agent.abort() (wall-clock / turn cap) rejects the prompt — expected.
    // Surface any OTHER failure (model/transport) so an infra defect isn't
    // silently scored as an ordinary "incomplete" task.
    if (!isAbortish(err)) {
      console.warn(
        `  [warn] ${task.id} ${resolved.modelId} run error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } finally {
    // Drain to idle so all in-flight parallel hooks finish mutating the
    // captured state BEFORE we snapshot it (avoids a post-return write race).
    try {
      await agent.waitForIdle()
    } catch {
      /* already aborted / settled */
    }
    clearTimeout(timer)
    unsubscribe()
    // §12.2 per-task isolation: close every tab this task opened so the next
    // task starts clean (fixtures use no persistent storage — verified — so a
    // fresh tab + fresh Agent context is total isolation). Best-effort; a
    // close failure must not fail the task.
    for (const tabId of openedTabIds) {
      try {
        await dispatchBrowserTool("browser_close_tab", { tabIds: [tabId] })
      } catch {
        /* tab already gone / bridge hiccup — cosmetic */
      }
    }
  }

  let status: TaskStatus
  let finalAnswer: string | undefined
  let answer: string | undefined
  let evidence: string | undefined
  let reason: string | undefined
  let partial: string | undefined
  if (terminalTool === "submit_answer") {
    status = terminalArgs.status === "blocked" ? "blocked" : "complete"
    answer = strOf(terminalArgs.answer)
    evidence = strOf(terminalArgs.evidence)
    finalAnswer = status === "complete" ? answer : undefined
  } else if (terminalTool === "report_insufficient") {
    status = "insufficient"
    reason = strOf(terminalArgs.reason)
    partial = strOf(terminalArgs.partial)
  } else {
    status = "incomplete"
  }

  if (process.env.GATE_B_DEBUG === "1") {
    const seq = toolTrace.map((t) => t.tool).join(" → ")
    console.log(
      `\n    [debug ${task.id}/${resolved.modelId}] status=${status} terminal=${terminalTool ?? "none"} turns=${turnCount} calls=${toolTrace.length}`,
    )
    console.log(`    [debug] tool sequence: ${seq || "(none)"}`)
    if (terminalTool) console.log(`    [debug] terminalArgs: ${JSON.stringify(terminalArgs).slice(0, 300)}`)
  }

  return {
    taskId: task.id,
    model: resolved.modelId,
    status,
    finalAnswer,
    terminalTool,
    answer,
    evidence,
    reason,
    partial,
    toolTrace: [...toolTrace],
    groundingTexts: [...groundingTexts],
    screenshotTaken,
    metrics: { turnsUsed: turnCount, wallMs: Date.now() - startedAt },
  }
}

/** True for the abort error agent.abort() raises (wall-clock / turn cap). */
function isAbortish(err: unknown): boolean {
  const s = err instanceof Error ? `${err.name} ${err.message}` : String(err)
  return /abort/i.test(s)
}

// ----- setup -----------------------------------------------------------------

async function setupTokenAndCatalog(): Promise<void> {
  await ensurePaths()
  await cacheVSCodeVersion()
  await cacheCopilotVersion()
  await setupGitHubToken()
  await setupCopilotToken()
  await cacheModels()
  if (!state.copilotToken) throw new Error("Copilot token not set — cannot run live model calls.")
  console.log(`[setup] Copilot token ready, ${state.models?.data.length ?? 0} models in catalog.`)
}

// ----- fixtures handshake (serve.ts) -----------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function watchStdoutForManifest(stdout: NodeJS.ReadableStream): Promise<Manifest> {
  return new Promise<Manifest>((resolve) => {
    let buf = ""
    stdout.setEncoding("utf8")
    stdout.on("data", (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.startsWith(READY_MARKER)) {
          try {
            resolve(JSON.parse(line.slice(READY_MARKER.length)) as Manifest)
          } catch {
            /* keep scanning */
          }
        } else if (line.trim().length > 0) {
          console.log(`[serve] ${line}`)
        }
      }
    })
  })
}

async function pollManifestFile(p: string): Promise<Manifest> {
  for (;;) {
    if (await fileExists(p)) {
      try {
        const m = JSON.parse(await readFile(p, "utf8")) as Manifest
        if (m.baseUrl && !/[<>]/.test(m.baseUrl)) return m
      } catch {
        /* partial write; retry */
      }
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function startFixtures(manifestOverride?: string): Promise<{ manifest: Manifest; stop: () => void }> {
  if (!(await fileExists(SERVE_PATH))) {
    throw new Error(`fixture server not found at ${SERVE_PATH} (fixtures-eng owns serve.ts).`)
  }
  const fileTarget = manifestOverride ?? DEFAULT_MANIFEST_RUNTIME
  // Delete any stale runtime manifest from a prior server BEFORE spawning, so
  // pollManifestFile can't resolve against a dead server's URLs (a previous
  // `serve.ts` writes its ephemeral ports here; reading them after that server
  // exited points every task at a dead origin → all-incomplete). The fresh
  // serve.ts rewrites this file on startup.
  await rm(fileTarget, { force: true }).catch(() => undefined)
  const proc = spawn("bun", [SERVE_PATH], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "inherit"] })
  const stop = () => {
    try {
      proc.kill("SIGINT")
    } catch {
      /* already gone */
    }
  }
  proc.on("error", (err) => console.error(`[serve] spawn error: ${err.message}`))

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timed out after ${MANIFEST_TIMEOUT_MS}ms waiting for fixture manifest`)), MANIFEST_TIMEOUT_MS),
  )
  try {
    const manifest = await Promise.race([
      proc.stdout ? watchStdoutForManifest(proc.stdout) : new Promise<Manifest>(() => {}),
      pollManifestFile(fileTarget),
      timeout,
    ])
    console.log(`[serve] manifest ready: base=${manifest.baseUrl} xorigin=${manifest.crossOriginBaseUrl} fixtures=${manifest.fixtures.length}`)
    return { manifest, stop }
  } catch (err) {
    stop()
    throw err
  }
}

async function loadTasks(tasksPath: string): Promise<Array<Task>> {
  if (!(await fileExists(tasksPath))) throw new Error(`tasks.json not found at ${tasksPath}.`)
  const parsed = JSON.parse(await readFile(tasksPath, "utf8")) as unknown
  if (!Array.isArray(parsed)) throw new Error("tasks.json must be a JSON array.")
  return parsed as Array<Task>
}

// ----- §12.1 live precondition probe (CDP read_page pierce) -------------------

/**
 * Before scoring, confirm the obtainable tasks whose ONLY intended path is the
 * CDP read_page pierce are actually reachable in THIS environment. SCORING.md
 * §12.1: t04 (cross-origin iframe → `crossOriginMarker`) and t05 (closed shadow
 * → `closedShadowMarker`) are obtainable ONLY via read_page's CDP extractor; if
 * CDP fell back to legacy, the markers never reach read_page and the tasks are
 * unobtainable for ALL models, so they must be dropped from |OBT| and the cond-1
 * threshold re-derived. We probe read_page(iframe-torture, full) once and return
 * the set of task ids to exclude (any whose marker is absent from read_page).
 *
 * This is a fairness guard, not a model test — it runs on the harness's own
 * dispatch, identical to what every model's read_page would return.
 */
async function probeReadPagePrecondition(manifest: Manifest): Promise<Set<string>> {
  const excluded = new Set<string>()
  const url = manifest.baseUrl.replace(/\/$/, "") + "/iframe-torture.html"
  const fx = manifest.fixtures.find((f) => f.id === "iframe-torture")
  const gt = (fx?.groundTruth ?? {}) as Record<string, unknown>
  const xom = typeof gt.crossOriginMarker === "string" ? gt.crossOriginMarker : "XOM_7f3a91"
  const som = typeof gt.sameOriginMarker === "string" ? gt.sameOriginMarker : "SOM_b4e2c8"
  const csm = typeof gt.closedShadowMarker === "string" ? gt.closedShadowMarker : "CSM_9d1f06"
  console.log("\n[precondition] §12.1 — probing read_page CDP pierce on iframe-torture…")
  let tabId: number | undefined
  try {
    const openText = resultTextOf(
      await dispatchBrowserTool("browser_open_tab", { url }),
    )
    tabId = (JSON.parse(openText) as { tabId?: number }).tabId
    if (typeof tabId !== "number") throw new Error("open_tab returned no tabId")
    await dispatchBrowserTool("browser_wait", { tabId, ms: 1500 }).catch(() => undefined)
    const rp = resultTextOf(
      await dispatchBrowserTool("browser_read_page", { tabId, mode: "full" }),
    )
    const lc = rp.toLowerCase()
    const hasXom = lc.includes(xom.toLowerCase())
    const hasSom = lc.includes(som.toLowerCase())
    const hasCsm = lc.includes(csm.toLowerCase())
    console.log(
      `  read_page surfaced: SOM(t03)=${hasSom ? "✓" : "✗"} XOM(t04)=${hasXom ? "✓" : "✗"} CSM(t05)=${hasCsm ? "✓" : "✗"} (len=${rp.length})`,
    )
    if (!hasXom) excluded.add("t04")
    if (!hasCsm) excluded.add("t05")
    if (excluded.size > 0) {
      console.log(
        `  CDP pierce DOWN → excluding [${[...excluded].join(", ")}] from the obtainable bar (|OBT| re-derived). `
          + "These still run; passes via screenshot/eval_js are reported but not scored toward cond-1.",
      )
    } else {
      console.log("  CDP pierce ACTIVE → full 10-task obtainable bar in effect.")
    }
  } catch (err) {
    console.warn(
      `  [warn] precondition probe failed (${err instanceof Error ? err.message : String(err)}). `
        + "Proceeding with the full 10-task bar; verify CDP manually if numbers look off.",
    )
  } finally {
    if (typeof tabId === "number") {
      await dispatchBrowserTool("browser_close_tab", { tabIds: [tabId] }).catch(() => undefined)
    }
  }
  return excluded
}

// ----- reporting -------------------------------------------------------------

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`
}

function printPerTask(model: string, scores: Array<TaskScore>): void {
  console.log(`\n  Per-task — ${model}:`)
  console.log(
    `  ${"id".padEnd(5)} ${"capability".padEnd(20)} ${"class".padEnd(11)} succ fab coh stop grnd ${"turns".padEnd(6)} wall_ms`,
  )
  for (const s of scores) {
    console.log(
      `  ${s.taskId.padEnd(5)} ${s.capability.slice(0, 20).padEnd(20)} ${(s.obtainable ? "obtainable" : "trap").padEnd(11)} `
        + `${(s.taskSuccess ? "✓" : "·").padEnd(4)} ${(s.fabrication ? "FAB" : "·").padEnd(3)} `
        + `${(s.coherent ? "✓" : "✗").padEnd(3)} ${(s.stopCorrect ? "✓" : "✗").padEnd(4)} `
        + `${(s.obtainable ? (s.grounded ? "✓" : "✗") : "–").padEnd(4)} ${String(s.turnsUsed).padEnd(6)} ${s.wallMs}`,
    )
  }
}

function printHeadToHead(verdicts: Array<ModelVerdict>): void {
  console.log("\n================ HEAD-TO-HEAD ================")
  console.log(
    `${"model".padEnd(20)} ${"obt".padEnd(7)} ${"obt_fab".padEnd(8)} ${"trap".padEnd(6)} ${"tot_fab".padEnd(8)} ${"incoh".padEnd(6)} ${"avg_turns".padEnd(10)} ${"avg_wall_ms".padEnd(12)} verdict`,
  )
  for (const v of verdicts) {
    const all = v.scores
    const avgTurns = all.length ? all.reduce((a, s) => a + s.turnsUsed, 0) / all.length : 0
    const avgWall = all.length ? all.reduce((a, s) => a + s.wallMs, 0) / all.length : 0
    console.log(
      `${v.model.padEnd(20)} ${`${v.obtainablePass}/${v.obtainableCount}`.padEnd(7)} `
        + `${String(v.obtainableFabrications).padEnd(8)} ${`${v.trapPass}/${v.trapCount}`.padEnd(6)} `
        + `${String(v.totalFabrications).padEnd(8)} ${String(v.incoherentCount).padEnd(6)} `
        + `${avgTurns.toFixed(1).padEnd(10)} ${Math.round(avgWall).toString().padEnd(12)} `
        + `${v.passed ? "PASS ✅" : "FAIL ❌"}`,
    )
  }
}

/** Pick the better model for fast + reliable + human-like browsing. */
function verdictLine(verdicts: Array<ModelVerdict>): string {
  if (verdicts.length < 2) return "[verdict] insufficient models ran to compare."
  const score = (v: ModelVerdict): Array<number> => [
    v.passed ? 1 : 0, // bar pass first
    -v.totalFabrications, // fewer fabrications (honesty)
    v.obtainablePass + v.trapPass, // more correct/honest tasks
  ]
  const avgWall = (v: ModelVerdict): number =>
    v.scores.length ? v.scores.reduce((a, s) => a + s.wallMs, 0) / v.scores.length : Infinity
  const sorted = [...verdicts].sort((a, b) => {
    const sa = score(a)
    const sb = score(b)
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i]
    return avgWall(a) - avgWall(b) // tiebreak: faster wins (speed matters)
  })
  const win = sorted[0]
  const lose = sorted[1]
  const winWall = Math.round(avgWall(win))
  const loseWall = Math.round(avgWall(lose))
  const why =
    win.totalFabrications !== lose.totalFabrications
      ? `${win.totalFabrications} vs ${lose.totalFabrications} fabrications`
      : win.obtainablePass + win.trapPass !== lose.obtainablePass + lose.trapPass
        ? `${win.obtainablePass + win.trapPass} vs ${lose.obtainablePass + lose.trapPass} tasks handled correctly`
        : `comparable accuracy, faster (${winWall}ms vs ${loseWall}ms avg)`
  return `[verdict] ${win.model} is the better fast+reliable browse model (${why}; avg ${winWall}ms/task, bar ${win.passed ? "PASS" : "FAIL"}).`
}

// ----- main ------------------------------------------------------------------

function parseArgs(argv: Array<string>): { manifest?: string; tasks: string; only?: string; flashVariant?: string } {
  let manifest: string | undefined
  let tasks = DEFAULT_TASKS_PATH
  let only: string | undefined
  let flashVariant: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--manifest") manifest = argv[++i]
    else if (argv[i] === "--tasks") tasks = argv[++i]
    else if (argv[i] === "--only") only = argv[++i]
    else if (argv[i] === "--flash-variant") flashVariant = argv[++i]
  }
  return { manifest, tasks, only, flashVariant }
}

/** Per-model SYSTEM prompt: the flash override when a variant is selected AND
 *  the model is gemini-3.5-flash; the shared contract otherwise. */
function systemPromptForModel(modelId: string, flashVariant?: string): { prompt: string; label: string } {
  if (flashVariant && /gemini-3\.5-flash/i.test(modelId)) {
    const v = FLASH_CONTRACT_VARIANTS[flashVariant]
    if (!v) throw new Error(`unknown --flash-variant "${flashVariant}" (have: ${Object.keys(FLASH_CONTRACT_VARIANTS).join(", ")})`)
    return { prompt: v, label: `flash:${flashVariant}` }
  }
  return { prompt: SYSTEM_CONTRACT, label: "base" }
}

async function main(): Promise<void> {
  const { manifest: manifestOverride, tasks: tasksPath, only, flashVariant } = parseArgs(process.argv.slice(2))
  await setupTokenAndCatalog()

  // Resolve each model at its highest (clamped) reasoning.
  const resolvedModels: Array<ResolvedModel> = []
  console.log("\n[models] resolving at thinking=xhigh (clamped to each model's allowlist):")
  for (const model of MODELS) {
    if (only && !model.toLowerCase().includes(only.toLowerCase())) continue
    const r = resolveModelAndThinking({ model, thinking: "xhigh" })
    if (!r.ok) {
      console.log(`  ${model.padEnd(20)} SKIPPED — ${r.error}`)
      continue
    }
    console.log(`  ${model.padEnd(20)} → ${r.modelId} @ thinking="${r.thinking}"`)
    resolvedModels.push({ modelId: r.modelId, thinking: r.thinking })
  }
  if (resolvedModels.length === 0) throw new Error("No comparison model resolved — nothing to run.")
  if (flashVariant) console.log(`[prompt] flash override active: variant "${flashVariant}" for gemini-3.5-flash`)

  const { manifest, stop } = await startFixtures(manifestOverride)
  const verdicts: Array<ModelVerdict> = []
  try {
    const tasks = await loadTasks(tasksPath)
    console.log(`[tasks] loaded ${tasks.length} tasks.`)

    // §12.1 — re-derive |OBT| if the CDP read_page pierce is down live.
    const excludedObtainable = await probeReadPagePrecondition(manifest)

    for (const resolved of resolvedModels) {
      const sp = systemPromptForModel(resolved.modelId, flashVariant)
      console.log(`\n================ MODEL: ${resolved.modelId} @ ${resolved.thinking} (prompt=${sp.label}) ================`)
      const scores: Array<TaskScore> = []
      for (const task of tasks) {
        const url = resolveTaskUrl(task, manifest)
        const expected = resolveExpected(task, manifest)
        process.stdout.write(`  ${task.id} (${task.capability})… `)
        const result = await runTaskWithPi(resolved, task, url, sp.prompt)
        const score = scoreTask(task, result, expected)
        scores.push(score)
        console.log(
          `${score.status} ${score.taskSuccess ? "ok" : "miss"}${score.fabrication ? " FAB" : ""} (${score.turnsUsed}t, ${score.wallMs}ms)`,
        )
      }
      printPerTask(resolved.modelId, scores)
      const v = summarizeModel(resolved.modelId, scores, excludedObtainable)
      const exclNote =
        v.excludedObtainable.length > 0
          ? ` [excluded §12.1: ${v.excludedObtainable.join(",")}; ${v.excludedObtainablePass} passed via alt-path]`
          : ""
      console.log(
        `\n  SUMMARY ${resolved.modelId}: obtainable ${v.obtainablePass}/${v.obtainableCount} (${pct(v.obtainableRate)})${exclNote}, `
          + `obt_fab ${v.obtainableFabrications}, trap_pass ${v.trapPass}/${v.trapCount}, total_fab ${v.totalFabrications}, `
          + `incoherent ${v.incoherentCount} → ${v.passed ? "PASS ✅" : `FAIL ❌ (${[!v.cond1 && "cond1", !v.cond2 && "cond2", !v.cond3 && "cond3"].filter(Boolean).join(", ")})`}`,
      )
      verdicts.push(v)
    }
  } finally {
    stop()
  }

  printHeadToHead(verdicts)
  console.log("\n" + verdictLine(verdicts))
  // The Copilot token-refresh setInterval keeps the loop alive; force exit.
  process.exit(0)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n[fatal] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    process.exit(2)
  })
}
