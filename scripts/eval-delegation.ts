#!/usr/bin/env bun

/**
 * Opt-in live evaluation of Claude Code's unprompted subagent delegation.
 *
 * Live usage (costs real Copilot budget):
 *   GH_ROUTER_RUN_DELEGATION_EVAL=1 bun scripts/eval-delegation.ts
 *
 * Parser/scorer self-test (no model calls):
 *   GH_ROUTER_RUN_DELEGATION_EVAL=1 bun scripts/eval-delegation.ts --self-test
 */

import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "..")
const FIXTURE_SOURCE = path.join(REPO_ROOT, "tests", "fixtures", "delegation-repo")
const SYNTHETIC_TRANSCRIPT = path.join(FIXTURE_SOURCE, ".eval", "synthetic-stream.jsonl")
const MODEL = process.env.GH_ROUTER_DELEGATION_EVAL_MODEL ?? "claude-opus-5"
const BASE_URL = process.env.GH_ROUTER_DELEGATION_EVAL_BASE_URL ?? "http://127.0.0.1:8787"
const RUN_TIMEOUT_MS = positiveInt(process.env.GH_ROUTER_DELEGATION_EVAL_TIMEOUT_MS, 120_000)
const SEED = process.env.GH_ROUTER_DELEGATION_EVAL_SEED ?? new Date().toISOString().slice(0, 10)

export type ArmName = "A" | "B"
export type Stratum =
  | "cheap-implementation"
  | "complex-implementation"
  | "specialist"
  | "ambiguous"
  | "negative-control"
  | "parallel-fanout"

export interface EvalInstance {
  id: string
  stratum: Stratum
  prompt: string
  acceptableAgents: ReadonlyArray<string>
  expectedParallelCalls?: number
}

export interface TaskCall {
  order: number
  assistantMessage: number
  batchPosition: number
  toolName: "Task" | "Agent"
  subagentType: string
  toolUseId?: string
}

export interface ParsedTranscript {
  taskCalls: Array<TaskCall>
  startedAgentIds: Array<string>
}

export interface RunResult extends ParsedTranscript {
  promptId: string
  stratum: Stratum
  arm: ArmName
  acceptableAgents: ReadonlyArray<string>
  expectedParallelCalls?: number
  startedAt: string
  endedAt: string
  elapsedMs: number
  firstTaskMs?: number
  exitCode: number
  timedOut: boolean
  killedAfterTask: boolean
  requestedButNeverStarted: boolean
  stdoutTail: string
  stderrTail: string
  model: string
  cliVersion: string
  proxyRevision: string
  proxyCommand: ReadonlyArray<string>
}

interface ArmConfig {
  name: ArmName
  command: Array<string>
  revision: string
  env: Record<string, string>
}

interface Rate {
  successes: number
  denominator: number
  rate: number | null
  wilson95: { low: number; high: number } | null
}

export interface ScoreSummary {
  spontaneousDelegation: Record<ArmName, Rate>
  routingConditionalOnDelegation: Record<ArmName, Rate>
  restraint: Record<ArmName, Rate>
  parallelFanout: Record<ArmName, Rate>
  complexImplementationDelegation: Record<ArmName, Rate>
  pairedTransitions: {
    noDelegationToDelegation: number
    delegationToNoDelegation: number
    bothDelegated: number
    neitherDelegated: number
  }
}

export const BATTERY: ReadonlyArray<EvalInstance> = [
  {
    id: "cheap-add-format-helper",
    stratum: "cheap-implementation",
    prompt: "Add an exported formatAttempt(attempt: number) helper that returns `attempt-<n>`, with one focused test.",
    acceptableAgents: ["implementer-fast"],
  },
  {
    id: "cheap-rename-parser-local",
    stratum: "cheap-implementation",
    prompt: "Rename the local variable `raw` to `input` in src/parser.ts and update nothing else.",
    acceptableAgents: ["implementer-fast"],
  },
  {
    id: "cheap-add-readme-example",
    stratum: "cheap-implementation",
    prompt: "Add one README example showing parsePort('8080') returning 8080. Keep the edit minimal.",
    acceptableAgents: ["implementer-fast", "scribe"],
  },
  {
    id: "complex-retry-cancellation",
    stratum: "complex-implementation",
    prompt: "Extend the retry helper so callers can cancel an in-progress backoff with AbortSignal. Preserve the existing retry semantics and add race-focused tests.",
    acceptableAgents: ["implementer"],
  },
  {
    id: "complex-config-reload",
    stratum: "complex-implementation",
    prompt: "Implement atomic runtime config reload for the service. Concurrent readers must see either the old complete config or the new complete config, never a partial update. Add tests for failed reload and concurrent reads.",
    acceptableAgents: ["implementer"],
  },
  {
    id: "complex-parser-diagnostics",
    stratum: "complex-implementation",
    prompt: "Redesign parsePort to return structured diagnostics without breaking existing callers, migrate the service, and add compatibility tests. Make the API maintainable rather than patching one call site.",
    acceptableAgents: ["implementer"],
  },
  {
    id: "specialist-find-retry",
    stratum: "specialist",
    prompt: "Where is retry delay calculated, which tests pin it, and what calls it? Give me file and line references; do not change anything.",
    acceptableAgents: ["scout"],
  },
  {
    id: "specialist-review-race",
    stratum: "specialist",
    prompt: "Review the retry and service code for real cancellation or concurrency bugs. Verify findings against the tests and report severity with file and line references. Do not edit.",
    acceptableAgents: ["reviewer"],
  },
  {
    id: "specialist-brainstorm-api",
    stratum: "specialist",
    prompt: "We need to expose retry progress without coupling callers to timers. Generate genuinely different API designs, challenge the obvious callback approach, and recommend one. Do not implement it.",
    acceptableAgents: ["brainstorm"],
  },
  {
    id: "specialist-document-retries",
    stratum: "specialist",
    prompt: "Document the retry policy for maintainers: defaults, terminal conditions, and the contract callers can rely on. Keep the documentation grounded in the current code.",
    acceptableAgents: ["scribe"],
  },
  {
    id: "ambiguous-investigate-failure",
    stratum: "ambiguous",
    prompt: "The retry test intermittently reports one extra attempt. Investigate the likely cause and tell me the smallest justified fix; make the fix if the evidence is conclusive.",
    acceptableAgents: ["reviewer", "implementer", "scout"],
  },
  {
    id: "ambiguous-small-doc-code",
    stratum: "ambiguous",
    prompt: "Add a short public example for the retry helper and fix any obvious mismatch you find between that example and the exported API.",
    acceptableAgents: ["scribe", "implementer-fast", "implementer"],
  },
  {
    id: "negative-read-version",
    stratum: "negative-control",
    prompt: "What version is in package.json? Reply with only the version.",
    acceptableAgents: [],
  },
  {
    id: "negative-list-source-files",
    stratum: "negative-control",
    prompt: "List the TypeScript files directly under src. Do not inspect their contents.",
    acceptableAgents: [],
  },
  {
    id: "negative-explain-one-line",
    stratum: "negative-control",
    prompt: "In one sentence, what does parsePort('8080') return?",
    acceptableAgents: [],
  },
  {
    id: "fanout-independent-audit",
    stratum: "parallel-fanout",
    prompt: "In parallel, trace the retry call graph, review the service for concurrency bugs, and propose two alternative public APIs for progress reporting. These are independent tracks; synthesize their results and do not edit files.",
    acceptableAgents: ["scout", "reviewer", "brainstorm"],
    expectedParallelCalls: 3,
  },
  {
    id: "fanout-doc-test-review",
    stratum: "parallel-fanout",
    prompt: "Assess three independent things at once: whether the README matches the exports, whether the retry tests miss edge cases, and whether the architecture note reflects the service code. Return one combined report; do not edit.",
    acceptableAgents: ["scribe", "reviewer", "scout"],
    expectedParallelCalls: 3,
  },
]

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback
  const parsed = Number(value)
  return parsed > 0 ? parsed : fallback
}

function parseCommand(value: string | undefined, fallback: Array<string>): Array<string> {
  if (!value) return fallback
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((v) => typeof v !== "string")) {
    throw new Error("arm commands must be JSON arrays of non-empty strings")
  }
  return parsed as Array<string>
}

function armEnv(baseUrl: string, configDir: string | undefined): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: "delegation-eval",
  }
  if (configDir) env.CLAUDE_CONFIG_DIR = path.resolve(configDir)
  return env
}

function hashSeed(seed: string): number {
  let h = 2166136261
  for (const char of seed) {
    h ^= char.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function seededRandom(seed: string): () => number {
  let state = hashSeed(seed) || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function shuffle<T>(values: ReadonlyArray<T>, random: () => number): Array<T> {
  const out = [...values]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function stripAnsi(text: string): string {
  const escape = String.fromCharCode(27)
  return text.replace(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "")
}

function parseStreamObject(
  value: unknown,
  state: { taskCalls: Array<TaskCall>; startedAgentIds: Set<string>; assistantMessage: number },
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const obj = value as Record<string, unknown>
  const parent = obj.parent_tool_use_id
  const isTopLevel = parent === undefined || parent === null || parent === ""
  if (obj.type === "assistant" && isTopLevel) {
    state.assistantMessage += 1
    const message = obj.message
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const content = (message as Record<string, unknown>).content
      if (Array.isArray(content)) {
        let batchPosition = 0
        for (const block of content) {
          if (!block || typeof block !== "object" || Array.isArray(block)) continue
          const record = block as Record<string, unknown>
          if (record.type !== "tool_use" || (record.name !== "Task" && record.name !== "Agent")) continue
          const input = record.input
          if (!input || typeof input !== "object" || Array.isArray(input)) continue
          const subagentType = (input as Record<string, unknown>).subagent_type
          if (typeof subagentType !== "string") continue
          state.taskCalls.push({
            order: state.taskCalls.length + 1,
            assistantMessage: state.assistantMessage,
            batchPosition: batchPosition++,
            toolName: record.name,
            subagentType,
            toolUseId: typeof record.id === "string" ? record.id : undefined,
          })
        }
      }
    }
  }
}

export function parseTranscript(text: string): ParsedTranscript {
  const state = {
    taskCalls: [] as Array<TaskCall>,
    startedAgentIds: new Set<string>(),
    assistantMessage: 0,
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trim()
    const agentMatch = line.match(/\[fields\].*\sagent=([^\s]+)/)
    if (agentMatch?.[1] && agentMatch[1] !== "-") state.startedAgentIds.add(agentMatch[1])
    if (!line.startsWith("{")) continue
    try {
      parseStreamObject(JSON.parse(line) as unknown, state)
    } catch {
      // stdout also contains non-JSON launch/log lines; only JSONL events count.
    }
  }
  return { taskCalls: state.taskCalls, startedAgentIds: [...state.startedAgentIds] }
}

export function wilson95(successes: number, denominator: number): Rate {
  if (denominator === 0) {
    return { successes, denominator, rate: null, wilson95: null }
  }
  const z = 1.959963984540054
  const p = successes / denominator
  const z2 = z * z
  const divisor = 1 + z2 / denominator
  const center = (p + z2 / (2 * denominator)) / divisor
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * denominator)) / denominator) / divisor
  return {
    successes,
    denominator,
    rate: p,
    wilson95: { low: Math.max(0, center - margin), high: Math.min(1, center + margin) },
  }
}

function routingPass(result: RunResult): boolean {
  return result.taskCalls.length > 0
    && result.taskCalls.every((call) => result.acceptableAgents.includes(call.subagentType))
}

function fanoutPass(result: RunResult): boolean {
  if (!result.expectedParallelCalls || result.taskCalls.length === 0) return false
  const firstMessage = result.taskCalls[0].assistantMessage
  const firstBatch = result.taskCalls.filter((call) => call.assistantMessage === firstMessage)
  return firstBatch.length >= result.expectedParallelCalls
    && firstBatch.every((call) => result.acceptableAgents.includes(call.subagentType))
}

export function scoreResults(results: ReadonlyArray<RunResult>): ScoreSummary {
  const armResults = (arm: ArmName) => results.filter((result) => result.arm === arm)
  const rateByArm = (predicate: (result: RunResult) => boolean, eligible: (result: RunResult) => boolean) =>
    Object.fromEntries((["A", "B"] as const).map((arm) => {
      const denominator = armResults(arm).filter(eligible)
      return [arm, wilson95(denominator.filter(predicate).length, denominator.length)]
    })) as Record<ArmName, Rate>

  const spontaneousEligible = (result: RunResult) =>
    result.stratum !== "negative-control" && result.stratum !== "parallel-fanout"
  const delegated = (result: RunResult) => result.taskCalls.length > 0
  const paired = new Map<string, Partial<Record<ArmName, RunResult>>>()
  for (const result of results) {
    const pair = paired.get(result.promptId) ?? {}
    pair[result.arm] = result
    paired.set(result.promptId, pair)
  }
  const transitions = {
    noDelegationToDelegation: 0,
    delegationToNoDelegation: 0,
    bothDelegated: 0,
    neitherDelegated: 0,
  }
  for (const pair of paired.values()) {
    if (!pair.A || !pair.B || !spontaneousEligible(pair.A)) continue
    const a = delegated(pair.A)
    const b = delegated(pair.B)
    if (!a && b) transitions.noDelegationToDelegation += 1
    else if (a && !b) transitions.delegationToNoDelegation += 1
    else if (a && b) transitions.bothDelegated += 1
    else transitions.neitherDelegated += 1
  }

  return {
    spontaneousDelegation: rateByArm(delegated, spontaneousEligible),
    routingConditionalOnDelegation: rateByArm(
      routingPass,
      (r) => r.stratum !== "negative-control" && delegated(r),
    ),
    restraint: rateByArm((r) => !delegated(r), (r) => r.stratum === "negative-control"),
    parallelFanout: rateByArm(fanoutPass, (r) => r.stratum === "parallel-fanout"),
    complexImplementationDelegation: rateByArm(
      (r) => r.taskCalls.some((call) => call.subagentType === "implementer"),
      (r) => r.stratum === "complex-implementation",
    ),
    pairedTransitions: transitions,
  }
}

function fixtureCopy(): string {
  const parent = mkdtempSync(path.join(tmpdir(), "delegation-eval-"))
  const fixture = path.join(parent, "repo")
  cpSync(FIXTURE_SOURCE, fixture, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes(".eval"),
  })
  const init = Bun.spawnSync(
    ["git", "init", "-q"],
    { cwd: fixture, stdout: "ignore", stderr: "pipe" },
  )
  if (init.exitCode !== 0) throw new Error(`fixture git init failed: ${init.stderr.toString()}`)
  for (const command of [
    ["git", "add", "-A"],
    ["git", "-c", "user.name=delegation-eval", "-c", "user.email=delegation-eval@local", "commit", "-qm", "fixture"],
  ]) {
    const proc = Bun.spawnSync(command, { cwd: fixture, stdout: "ignore", stderr: "pipe" })
    if (proc.exitCode !== 0) throw new Error(`fixture setup failed: ${proc.stderr.toString()}`)
  }
  return fixture
}

function resetFixture(fixture: string): void {
  for (const command of [
    ["git", "reset", "--hard", "HEAD"],
    ["git", "clean", "-fdx"],
  ]) {
    const proc = Bun.spawnSync(command, { cwd: fixture, stdout: "ignore", stderr: "pipe" })
    if (proc.exitCode !== 0) throw new Error(`fixture reset failed: ${proc.stderr.toString()}`)
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
  while (true) {
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

async function runOne(
  instance: EvalInstance,
  arm: ArmConfig,
  fixture: string,
  cliVersion: string,
): Promise<RunResult> {
  resetFixture(fixture)
  const args = [
    ...arm.command,
    "--no-auto-update",
    "--no-self-update",
    "--model",
    MODEL,
    "--print",
    "--output-format",
    "stream-json",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    instance.prompt,
  ]
  const startedAt = new Date()
  const proc = Bun.spawn(args, {
    cwd: fixture,
    env: {
      ...process.env,
      ...arm.env,
      GH_ROUTER_NO_SELF_UPDATE: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const liveState = {
    taskCalls: [] as Array<TaskCall>,
    startedAgentIds: new Set<string>(),
    assistantMessage: 0,
  }
  let firstTaskMs: number | undefined
  let killedAfterTask = false
  const onLine = (line: string) => {
    const before = liveState.taskCalls.length
    const clean = stripAnsi(line).trim()
    const agentMatch = clean.match(/\[fields\].*\sagent=([^\s]+)/)
    if (agentMatch?.[1] && agentMatch[1] !== "-") liveState.startedAgentIds.add(agentMatch[1])
    if (clean.startsWith("{")) {
      try {
        parseStreamObject(JSON.parse(clean) as unknown, liveState)
      } catch {
        // Non-JSON launch output is ignored.
      }
    }
    if (before === 0 && liveState.taskCalls.length > 0) {
      firstTaskMs = Date.now() - startedAt.getTime()
      killedAfterTask = true
      proc.kill()
    }
  }
  const stdoutPromise = consumeLines(proc.stdout, onLine)
  const stderrPromise = consumeLines(proc.stderr, onLine)
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, RUN_TIMEOUT_MS)
  const exitCode = await proc.exited
  clearTimeout(timeout)
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  const endedAt = new Date()
  const taskCalls = liveState.taskCalls
  const startedAgentIds = [...liveState.startedAgentIds]
  return {
    promptId: instance.id,
    stratum: instance.stratum,
    arm: arm.name,
    acceptableAgents: instance.acceptableAgents,
    expectedParallelCalls: instance.expectedParallelCalls,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    elapsedMs: endedAt.getTime() - startedAt.getTime(),
    firstTaskMs,
    exitCode,
    timedOut,
    killedAfterTask,
    requestedButNeverStarted: taskCalls.length > 0 && startedAgentIds.length === 0,
    taskCalls,
    startedAgentIds,
    stdoutTail: stdout.slice(-2_000),
    stderrTail: stderr.slice(-2_000),
    model: MODEL,
    cliVersion,
    proxyRevision: arm.revision,
    proxyCommand: arm.command,
  }
}

function commandOutput(command: Array<string>, cwd = REPO_ROOT): string {
  const proc = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) return `unavailable (${proc.stderr.toString().trim()})`
  return proc.stdout.toString().trim()
}

function currentRevision(): string {
  return commandOutput(["git", "rev-parse", "HEAD"])
}

function formatRate(rate: Rate): string {
  if (rate.rate === null || !rate.wilson95) return `n=0`
  return `${rate.successes}/${rate.denominator} ${(rate.rate * 100).toFixed(1)}% (Wilson 95% ${(rate.wilson95.low * 100).toFixed(1)}–${(rate.wilson95.high * 100).toFixed(1)}%)`
}

function printSummary(summary: ScoreSummary): void {
  for (const [name, rates] of Object.entries(summary).filter(([name]) => name !== "pairedTransitions")) {
    const typed = rates as Record<ArmName, Rate>
    console.log(`${name}: A ${formatRate(typed.A)}; B ${formatRate(typed.B)}`)
  }
  console.log(`pairedTransitions: ${JSON.stringify(summary.pairedTransitions)}`)
}

function syntheticResult(
  promptId: string,
  stratum: Stratum,
  arm: ArmName,
  taskCalls: Array<TaskCall>,
  acceptableAgents: ReadonlyArray<string>,
  expectedParallelCalls?: number,
): RunResult {
  return {
    promptId,
    stratum,
    arm,
    taskCalls,
    acceptableAgents,
    expectedParallelCalls,
    startedAgentIds: taskCalls.length > 0 ? ["agent-synthetic"] : [],
    startedAt: "2026-08-11T00:00:00.000Z",
    endedAt: "2026-08-11T00:00:01.000Z",
    elapsedMs: 1_000,
    exitCode: 0,
    timedOut: false,
    killedAfterTask: taskCalls.length > 0,
    requestedButNeverStarted: false,
    stdoutTail: "",
    stderrTail: "",
    model: MODEL,
    cliVersion: "synthetic",
    proxyRevision: "synthetic",
    proxyCommand: ["synthetic"],
  }
}

function selfTest(): void {
  const transcript = readFileSync(SYNTHETIC_TRANSCRIPT, "utf8")
  const parsed = parseTranscript(transcript)
  if (parsed.taskCalls.length !== 3) throw new Error(`expected 3 Task calls, got ${parsed.taskCalls.length}`)
  if (parsed.taskCalls.map((call) => call.subagentType).join(",") !== "scout,reviewer,brainstorm") {
    throw new Error(`unexpected call order: ${JSON.stringify(parsed.taskCalls)}`)
  }
  if (parsed.taskCalls.some((call) => call.assistantMessage !== 1)) {
    throw new Error("parallel calls were not grouped in one assistant message")
  }
  if (parsed.startedAgentIds.join(",") !== "agent-scout,agent-reviewer") {
    throw new Error(`unexpected started-agent cross-check: ${parsed.startedAgentIds.join(",")}`)
  }
  const calls = parsed.taskCalls
  const results = [
    syntheticResult("positive", "specialist", "A", [], ["scout"]),
    syntheticResult("positive", "specialist", "B", [calls[0]], ["scout"]),
    syntheticResult("negative", "negative-control", "A", [], []),
    syntheticResult("negative", "negative-control", "B", [], []),
    syntheticResult("fanout", "parallel-fanout", "A", [calls[0]], ["scout", "reviewer", "brainstorm"], 3),
    syntheticResult("fanout", "parallel-fanout", "B", calls, ["scout", "reviewer", "brainstorm"], 3),
  ]
  const score = scoreResults(results)
  if (score.spontaneousDelegation.B.successes !== 1 || score.restraint.B.successes !== 1) {
    throw new Error(`unexpected score: ${JSON.stringify(score)}`)
  }
  if (score.parallelFanout.A.successes !== 0 || score.parallelFanout.B.successes !== 1) {
    throw new Error(`unexpected fanout score: ${JSON.stringify(score.parallelFanout)}`)
  }
  if (!score.spontaneousDelegation.B.wilson95) throw new Error("Wilson interval missing")
  console.log("delegation eval self-test passed: JSONL parser, ordering, start cross-check, fanout scoring, and Wilson intervals")
}

async function main(): Promise<void> {
  if (process.env.GH_ROUTER_RUN_DELEGATION_EVAL !== "1") {
    console.log("delegation eval is gated; set GH_ROUTER_RUN_DELEGATION_EVAL=1 (live mode costs real Copilot budget).")
    return
  }
  if (process.argv.includes("--self-test")) {
    selfTest()
    return
  }

  const armA: ArmConfig = {
    name: "A",
    command: parseCommand(process.env.GH_ROUTER_DELEGATION_ARM_A_COMMAND, ["claude"]),
    revision: process.env.GH_ROUTER_DELEGATION_ARM_A_REVISION ?? "baseline-config",
    env: armEnv(
      process.env.GH_ROUTER_DELEGATION_ARM_A_BASE_URL ?? BASE_URL,
      process.env.GH_ROUTER_DELEGATION_ARM_A_CONFIG_DIR,
    ),
  }
  const armB: ArmConfig = {
    name: "B",
    command: parseCommand(process.env.GH_ROUTER_DELEGATION_ARM_B_COMMAND, ["claude"]),
    revision: process.env.GH_ROUTER_DELEGATION_ARM_B_REVISION ?? currentRevision(),
    env: armEnv(
      process.env.GH_ROUTER_DELEGATION_ARM_B_BASE_URL ?? BASE_URL,
      process.env.GH_ROUTER_DELEGATION_ARM_B_CONFIG_DIR,
    ),
  }
  const cliVersion = commandOutput(["claude", "--version"])
  const random = seededRandom(SEED)
  const schedule = shuffle(BATTERY, random).flatMap((instance) =>
    shuffle([armA, armB], random).map((arm) => ({ instance, arm })),
  )
  const fixture = fixtureCopy()
  const results: Array<RunResult> = []
  try {
    console.log(`delegation eval: ${schedule.length} interleaved runs; seed=${SEED}; model=${MODEL}; CLI=${cliVersion}`)
    for (const [index, item] of schedule.entries()) {
      console.log(`[${index + 1}/${schedule.length}] ${item.instance.id} arm ${item.arm.name}`)
      const result = await runOne(item.instance, item.arm, fixture, cliVersion)
      results.push(result)
      console.log(`  Task=[${result.taskCalls.map((call) => call.subagentType).join(", ")}] started=[${result.startedAgentIds.join(", ")}] ${result.elapsedMs}ms`)
    }
  } finally {
    rmSync(path.dirname(fixture), { recursive: true, force: true })
  }

  const summary = scoreResults(results)
  const output = process.env.GH_ROUTER_DELEGATION_EVAL_OUTPUT
    ? path.resolve(process.env.GH_ROUTER_DELEGATION_EVAL_OUTPUT)
    : path.join(tmpdir(), `github-router-delegation-eval-${Date.now()}.json`)
  mkdirSync(path.dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    seed: SEED,
    model: MODEL,
    cliVersion,
    proxyWorkingRevision: currentRevision(),
    arms: { A: armA, B: armB },
    battery: BATTERY,
    results,
    summary,
  }, null, 2)}\n`)
  printSummary(summary)
  console.log(`full result: ${output}`)
}

if (import.meta.main) await main()
