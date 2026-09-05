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
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "..")
const FIXTURE_SOURCE = path.join(REPO_ROOT, "tests", "fixtures", "delegation-repo")
const SYNTHETIC_TRANSCRIPT = path.join(FIXTURE_SOURCE, ".eval", "synthetic-stream.jsonl")
const MODEL = process.env.GH_ROUTER_DELEGATION_EVAL_MODEL ?? "claude-opus-5"
const BASE_URL = process.env.GH_ROUTER_DELEGATION_EVAL_BASE_URL ?? "http://127.0.0.1:8787"
const RUN_TIMEOUT_MS = positiveInt(process.env.GH_ROUTER_DELEGATION_EVAL_TIMEOUT_MS, 120_000)
const SEED = process.env.GH_ROUTER_DELEGATION_EVAL_SEED ?? new Date().toISOString().slice(0, 10)

export type ArmName = "A" | "B"
type AnyRecord = Record<string, unknown>
export type Stratum =
  | "cheap-implementation"
  | "complex-implementation"
  | "specialist"
  | "ambiguous"
  | "negative-control"
  | "parallel-fanout"
  | "max-native"
  | "max-peer"
  | "max-coordinator"
  | "max-advisor"

export type RouteKind = "direct" | "native" | "peer" | "advisor"

export interface EvalInstance {
  id: string
  stratum: Stratum
  prompt: string
  acceptableAgents: ReadonlyArray<string>
  expectedParallelCalls?: number
  expectedRoute?: RouteKind
  expectedActionCount?: number
  acceptablePeers?: ReadonlyArray<string>
}

export interface ObservedAction {
  order: number
  assistantMessage: number
  batchPosition: number
  kind: Exclude<RouteKind, "direct">
  name: string
  toolUseId?: string
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
  actions: Array<ObservedAction>
  startedAgentIds: Array<string>
  /** Largest tool_use batch in any top-level assistant message, across all tools. */
  maxToolBatch: number
}

export interface RunResult extends ParsedTranscript {
  promptId: string
  stratum: Stratum
  arm: ArmName
  acceptableAgents: ReadonlyArray<string>
  expectedParallelCalls?: number
  expectedRoute?: RouteKind
  expectedActionCount?: number
  acceptablePeers?: ReadonlyArray<string>
  startedAt: string
  endedAt: string
  elapsedMs: number
  /** First native Agent/Task dispatch; retained for historical reports. */
  firstTaskMs?: number
  /** First native, peer, or Advisor routing action. */
  firstActionMs?: number
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

function reportableCommand(command: ReadonlyArray<string>): Array<string> {
  const out: string[] = []
  for (let i = 0; i < command.length; i++) {
    const arg = command[i]
    if (arg === "--github-token" || arg === "-g") {
      out.push(arg, "[REDACTED]")
      i++
    } else if (arg.startsWith("--github-token=")) {
      out.push("--github-token=[REDACTED]")
    } else {
      out.push(arg)
    }
  }
  return out
}

export function reportableArm(arm: ArmConfig): Omit<ArmConfig, "env"> & {
  baseUrl?: string
  configDir?: string
} {
  return {
    name: arm.name,
    command: reportableCommand(arm.command),
    revision: arm.revision,
    baseUrl: arm.env.ANTHROPIC_BASE_URL,
    configDir: arm.env.CLAUDE_CONFIG_DIR,
  }
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
  parallelFanoutInconclusive: Record<ArmName, number>
  parallelFanoutErrored: Record<ArmName, number>
  complexImplementationDelegation: Record<ArmName, Rate>
  maxRouteSelection: Record<ArmName, Rate>
  maxPeerSelection: Record<ArmName, Rate>
  maxCoordinatorSelection: Record<ArmName, Rate>
  maxAdvisorSelection: Record<ArmName, Rate>
  maxAdvisorRestraint: Record<ArmName, Rate>
  /** Runs excluded from the NON-fan-out endpoints above because the CLI
   *  invocation itself failed or timed out (see `erroredRun`). Reported so a
   *  systematic invocation failure is visible as an exclusion count rather than
   *  silently folded into "no delegation" / "restrained". */
  nonFanoutErrored: Record<ArmName, number>
  pairedTransitions: {
    noDelegationToDelegation: number
    delegationToNoDelegation: number
    bothDelegated: number
    neitherDelegated: number
  }
}

export const MAX_BATTERY: ReadonlyArray<EvalInstance> = [
  {
    id: "max-direct-version",
    stratum: "negative-control",
    prompt: "What version is in package.json? Reply with only the version.",
    acceptableAgents: [],
    expectedRoute: "direct",
  },
  {
    id: "max-native-explore",
    stratum: "max-native",
    prompt: "Trace where retry delays are calculated, which tests pin them, and every production caller. Return file and line evidence; do not edit.",
    acceptableAgents: ["Explore"],
    expectedRoute: "native",
  },
  {
    id: "max-native-plan",
    stratum: "max-native",
    prompt: "Design a backwards-compatible migration from numeric retry errors to structured diagnostics across callers. Include interfaces, ordering, invariants, acceptance criteria, and verification; do not implement.",
    acceptableAgents: ["Plan"],
    expectedRoute: "native",
  },
  {
    id: "max-direct-trivial-edit",
    stratum: "negative-control",
    prompt: "Rename the local variable `raw` to `input` in src/parser.ts and update nothing else.",
    acceptableAgents: [],
    expectedRoute: "direct",
  },
  {
    id: "max-native-implementer",
    stratum: "max-native",
    prompt: "Add an exported formatAttempt helper with specified behavior and a focused test. The desired API is settled; implement and verify it.",
    acceptableAgents: ["implementer"],
    expectedRoute: "native",
  },
  {
    id: "max-native-general-purpose",
    stratum: "max-native",
    prompt: "Investigate the mismatch between the retry documentation and runtime behavior, correct whichever code and documentation are wrong, and verify the resulting public contract.",
    acceptableAgents: ["general-purpose"],
    expectedRoute: "native",
  },
  {
    id: "max-native-reviewer",
    stratum: "max-native",
    prompt: "Reproduce and review the retry cancellation race against the current code and tests. Report concrete findings with severity and file:line evidence; do not edit.",
    acceptableAgents: ["reviewer"],
    expectedRoute: "native",
  },
  {
    id: "max-native-brainstorm",
    stratum: "max-native",
    prompt: "We need retry progress without coupling callers to timers. Compare materially different repository-feasible API mechanisms and identify evidence that would discriminate among them; do not plan or implement.",
    acceptableAgents: ["brainstorm"],
    expectedRoute: "native",
  },
  {
    id: "max-peer-single",
    stratum: "max-peer",
    prompt: "Review this self-contained diff for concurrency defects. I need exactly one independent assessment and do not need repository inspection or execution.\n```diff\n-export function release(lock) { lock.owner = null; lock.waiters.shift()?.resolve() }\n+export async function release(lock) { lock.owner = null; await Promise.resolve(); lock.waiters.shift()?.resolve() }\n```",
    acceptableAgents: [],
    expectedRoute: "peer",
    expectedActionCount: 1,
    acceptablePeers: ["codex_reviewer", "sonnet_reviewer", "gemini_reviewer", "grok_reviewer"],
  },
  {
    id: "max-peer-coordinator",
    stratum: "max-coordinator",
    prompt: "Review this self-contained authentication migration. Three independent risks remain: security invariants, compatibility, and concurrent cutover. Obtain distinct fresh-context lenses and synthesize disagreements; do not inspect the repository.\n\nContract: existing HMAC session cookies remain accepted for 30 days; new sessions use opaque random IDs stored with a 24-hour TTL; reads fall back to HMAC only when no opaque record exists; writes emit only opaque IDs; logout must revoke both forms; deployment may briefly run old and new binaries concurrently.\n\n```diff\n-const session = verifyHmac(cookie)\n+const session = await store.get(cookie) ?? verifyHmac(cookie)\n```",
    acceptableAgents: ["peer-review-coordinator"],
    expectedRoute: "native",
  },
  {
    id: "max-advisor-positive",
    stratum: "max-advisor",
    prompt: "Direct tests support two incompatible rollout strategies and the decision is hard to reverse. Use the transcript-aware consultation available to you for the single question of which assumption should decide between them.",
    acceptableAgents: [],
    expectedRoute: "advisor",
  },
  {
    id: "max-advisor-restraint",
    stratum: "negative-control",
    prompt: "All requested checks passed and no uncertainty remains. Report the verified result concisely.",
    acceptableAgents: [],
    expectedRoute: "direct",
  },
]

export const BATTERY: ReadonlyArray<EvalInstance> = [
  {
    id: "cheap-add-format-helper",
    stratum: "cheap-implementation",
    prompt: "Add an exported formatAttempt(attempt: number) helper that returns `attempt-<n>`, with one focused test.",
    acceptableAgents: ["implementer-fast", "implementer", "general-purpose", "general-purpose-fast"],
  },
  {
    id: "cheap-rename-parser-local",
    stratum: "cheap-implementation",
    prompt: "Rename the local variable `raw` to `input` in src/parser.ts and update nothing else.",
    acceptableAgents: ["implementer-fast", "implementer", "general-purpose", "general-purpose-fast"],
  },
  {
    id: "cheap-add-readme-example",
    stratum: "cheap-implementation",
    prompt: "Add one README example showing parsePort('8080') returning 8080. Keep the edit minimal.",
    acceptableAgents: ["implementer-fast", "implementer", "scribe", "general-purpose", "general-purpose-fast"],
  },
  {
    id: "complex-retry-cancellation",
    stratum: "complex-implementation",
    prompt: "Extend the retry helper so callers can cancel an in-progress backoff with AbortSignal. Preserve the existing retry semantics and add race-focused tests.",
    acceptableAgents: ["implementer", "Plan", "planner"],
  },
  {
    id: "complex-config-reload",
    stratum: "complex-implementation",
    prompt: "Implement atomic runtime config reload for the service. Concurrent readers must see either the old complete config or the new complete config, never a partial update. Add tests for failed reload and concurrent reads.",
    acceptableAgents: ["implementer", "Plan", "planner"],
  },
  {
    id: "complex-parser-diagnostics",
    stratum: "complex-implementation",
    prompt: "Redesign parsePort to return structured diagnostics without breaking existing callers, migrate the service, and add compatibility tests. Make the API maintainable rather than patching one call site.",
    acceptableAgents: ["implementer", "Plan", "planner"],
  },
  {
    id: "specialist-find-retry",
    stratum: "specialist",
    prompt: "Where is retry delay calculated, which tests pin it, and what calls it? Give me file and line references; do not change anything.",
    acceptableAgents: ["scout", "Explore"],
  },
  {
    id: "specialist-review-race",
    stratum: "specialist",
    prompt: "Review the retry and service code for real cancellation or concurrency bugs. Verify findings against the tests and report severity with file and line references. Do not edit.",
    acceptableAgents: ["reviewer", "reviewer-fast", "peer-review-coordinator"],
  },
  {
    id: "specialist-brainstorm-api",
    stratum: "specialist",
    prompt: "We need to expose retry progress without coupling callers to timers. Generate genuinely different API designs, challenge the obvious callback approach, and recommend one. Do not implement it.",
    acceptableAgents: ["brainstorm", "Plan", "planner"],
  },
  {
    id: "specialist-document-retries",
    stratum: "specialist",
    prompt: "Document the retry policy for maintainers: defaults, terminal conditions, and the contract callers can rely on. Keep the documentation grounded in the current code.",
    acceptableAgents: ["scribe", "general-purpose", "general-purpose-fast", "implementer-fast", "implementer"],
  },
  {
    id: "ambiguous-investigate-failure",
    stratum: "ambiguous",
    prompt: "The retry test intermittently reports one extra attempt. Investigate the likely cause and tell me the smallest justified fix; make the fix if the evidence is conclusive.",
    acceptableAgents: ["reviewer", "reviewer-fast", "implementer", "scout", "Explore", "general-purpose", "general-purpose-fast"],
  },
  {
    id: "ambiguous-small-doc-code",
    stratum: "ambiguous",
    prompt: "Add a short public example for the retry helper and fix any obvious mismatch you find between that example and the exported API.",
    acceptableAgents: ["scribe", "implementer-fast", "implementer", "general-purpose", "general-purpose-fast"],
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
    acceptableAgents: ["scout", "Explore", "reviewer", "reviewer-fast", "brainstorm", "Plan", "planner", "peer-review-coordinator"],
    expectedParallelCalls: 3,
  },
  {
    id: "fanout-doc-test-review",
    stratum: "parallel-fanout",
    prompt: "Assess three independent things at once: whether the README matches the exports, whether the retry tests miss edge cases, and whether the architecture note reflects the service code. Return one combined report; do not edit.",
    acceptableAgents: ["scribe", "reviewer", "reviewer-fast", "scout", "Explore", "general-purpose", "general-purpose-fast"],
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

/**
 * Env keys that must be scrubbed from the harness's OWN process env before it
 * spawns a test CLI, not merely left unset in `arm.env`. Both are injected as
 * real process-env vars into a `github-router claude` child
 * (`getClaudeCodeEnvVars` in `src/lib/server-setup.ts`, presence-guarded, not
 * `--print`-aware) and/or a user's real `~/.claude/settings.json` `env` block,
 * which the mirror faithfully copies forward. So a harness invoked from
 * *inside* an active `github-router claude` session — exactly how this file
 * is normally run — inherits them ambiently through `...process.env` in
 * `armEnv` below, contaminating every arm regardless of `arm.env`.
 *
 * Measured directly against the installed CLI (2.1.229): with EITHER var
 * present, `claude --print --output-format stream-json` collapses the
 * session's own tool list from the full native+MCP set down to exactly
 * `["Task","SendMessage","TaskStop","Workflow"]` — no Read, Write, Edit,
 * Bash, Grep, or Glob, and no MCP tools. That is not "avoids delegating"; it
 * is "cannot do anything BUT attempt to delegate", and since a fire-and-forget
 * `Task`/`Agent` dispatch under `--print` never resolves synchronously within
 * the same turn sequence, the observed behavior is a doomed retry loop across
 * `general-purpose-fast` → `scout` → `scout` (empty prompt) → `worker`, ending
 * in a stalling non-answer ("I've launched an agent... I'll report back once
 * it finishes") rather than a real result. Every prior invocation of this
 * harness from inside a live proxy session measured exactly that failure
 * mode, not genuine delegation behavior — this is what fixes it.
 *
 * This mirrors an already-shipped precedent: `docs/serve-control-plane.md`
 * documents stripping `CLAUDE_CODE_COORDINATOR_MODE` from the serve mirror for
 * the identical reason, and its own verification script "scrubs an ambient
 * `CLAUDE_CODE_COORDINATOR_MODE` from its probe env so it tests the mirror,
 * not the runner's shell" — the same scrub, applied here to the eval runner's
 * own shell instead of a mirror file.
 */
const AMBIENT_ENV_KEYS_TO_SCRUB = [
  "CLAUDE_CODE_COORDINATOR_MODE",
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
] as const

function armEnv(
  baseUrl: string,
  configDir: string | undefined,
  homeDir: string | undefined,
  githubToken: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: "delegation-eval",
  }
  // Empty string, not omission: `{...process.env, ...arm.env}` at the spawn
  // site only overrides a key that IS present in this object. Omitting the
  // key here would let an ambient non-empty value from `process.env` survive
  // into the child untouched.
  for (const key of AMBIENT_ENV_KEYS_TO_SCRUB) env[key] = ""
  if (configDir) env.CLAUDE_CONFIG_DIR = path.resolve(configDir)
  if (githubToken) env.GH_TOKEN = githubToken
  if (homeDir) {
    // A Max arm launches github-router, whose mirror source is os.homedir(), not
    // an inherited CLAUDE_CONFIG_DIR. Point HOME and USERPROFILE at the arm's
    // isolated source so the nested launcher cannot re-copy ambient settings.
    env.HOME = homeDir
    env.USERPROFILE = homeDir
  }
  return env
}

interface ScrubbedConfig {
  configDir?: string
  homeDir?: string
  cleanupDir?: string
}

function readSettings(configDir: string): AnyRecord | undefined {
  try {
    return JSON.parse(readFileSync(path.join(configDir, "settings.json"), "utf8")) as AnyRecord
  } catch {
    return undefined
  }
}

function scrubSettings(settings: AnyRecord | undefined): AnyRecord | undefined {
  if (!settings) return undefined
  const env = settings.env
  if (!env || typeof env !== "object" || Array.isArray(env)) return settings
  const scrubbedEnv = { ...(env as AnyRecord) }
  for (const key of AMBIENT_ENV_KEYS_TO_SCRUB) delete scrubbedEnv[key]
  return { ...settings, env: scrubbedEnv }
}

/**
 * Build an isolated config source for one arm. Raw Claude arms consume it via
 * CLAUDE_CONFIG_DIR. Max launcher arms consume the same source through HOME /
 * USERPROFILE because github-router creates its own per-process config mirror
 * from `<home>/.claude` and intentionally ignores a caller's CLAUDE_CONFIG_DIR.
 * Each arm gets a distinct copy so mutable session state cannot cross-contaminate
 * the randomized A/B sequence.
 */
export const ISOLATED_CONFIG_ENTRIES = new Set([
  ".credentials.json",
  ".credentials.json.lock",
  ".oauth_refresh.lock",
  ".github-router-managed",
  "statsig",
  "cache",
  "logs",
  "paste-cache",
  "jobs",
  "daemon",
  "daemon.log",
  "projects",
  "sessions",
  "tasks",
  "todos",
  "transcripts",
  "shell-snapshots",
  "shell_snapshots",
  "plans",
  "file-history",
  "backups",
])

function copyEvalConfig(source: string, configDir: string): void {
  cpSync(source, configDir, {
    recursive: true,
    filter: (candidate) => {
      const rel = path.relative(source, candidate)
      if (!rel) return true
      const topLevel = rel.split(path.sep)[0]
      return !ISOLATED_CONFIG_ENTRIES.has(topLevel)
    },
  })
}

export function isolatedArmConfig(
  explicitConfigDir: string | undefined,
  maxMode: boolean,
): ScrubbedConfig {
  const source = explicitConfigDir
    ?? (maxMode
      ? path.join(homedir(), ".claude")
      : process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"))
  if (explicitConfigDir && !existsSync(explicitConfigDir)) {
    throw new Error(`arm CLAUDE_CONFIG_DIR does not exist: ${explicitConfigDir}`)
  }
  const root = mkdtempSync(path.join(tmpdir(), "delegation-eval-config-"))
  const configDir = path.join(root, ".claude")
  if (existsSync(source)) copyEvalConfig(source, configDir)
  else mkdirSync(configDir, { recursive: true })
  const settings = scrubSettings(readSettings(configDir))
  if (settings) {
    writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(settings), { mode: 0o600 })
  }
  return { configDir, homeDir: root, cleanupDir: root }
}

function maxEvalGithubToken(): string {
  const fromEnv = process.env.GH_TOKEN?.trim()
  if (fromEnv) return fromEnv
  const tokenPath = path.join(homedir(), ".local", "share", "github-router", "github_token")
  try {
    const fromDisk = readFileSync(tokenPath, "utf8").trim()
    if (fromDisk) return fromDisk
  } catch {
    // The actionable error below covers missing and unreadable token files.
  }
  throw new Error(
    "Max eval requires GH_TOKEN or an existing github-router credential. Run `github-router auth` first.",
  )
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
  state: {
    taskCalls: Array<TaskCall>
    actions: Array<ObservedAction>
    startedAgentIds: Set<string>
    assistantMessage: number
    maxToolBatch: number
  },
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
        let toolBatch = 0
        for (const block of content) {
          if (!block || typeof block !== "object" || Array.isArray(block)) continue
          const record = block as Record<string, unknown>
          const id = typeof record.id === "string" ? record.id : undefined
          if (record.type === "server_tool_use" && record.name === "advisor") {
            state.actions.push({
              order: state.actions.length + 1,
              assistantMessage: state.assistantMessage,
              batchPosition: batchPosition++,
              kind: "advisor",
              name: "advisor",
              toolUseId: id,
            })
            continue
          }
          if (record.type !== "tool_use") continue
          toolBatch += 1
          if (typeof record.name === "string" && /^mcp__[^_]+__.+/.test(record.name)) {
            const peerName = record.name.replace(/^mcp__[^_]+__/, "")
            if (/_(?:critic|reviewer)$/.test(peerName)) {
              state.actions.push({
                order: state.actions.length + 1,
                assistantMessage: state.assistantMessage,
                batchPosition: batchPosition++,
                kind: "peer",
                name: peerName,
                toolUseId: id,
              })
            }
          }
          if (record.name !== "Task" && record.name !== "Agent") continue
          const input = record.input
          if (!input || typeof input !== "object" || Array.isArray(input)) continue
          const subagentType = (input as Record<string, unknown>).subagent_type
          if (typeof subagentType !== "string") continue
          const taskCall: TaskCall = {
            order: state.taskCalls.length + 1,
            assistantMessage: state.assistantMessage,
            batchPosition: batchPosition++,
            toolName: record.name,
            subagentType,
            toolUseId: id,
          }
          state.taskCalls.push(taskCall)
          state.actions.push({
            order: state.actions.length + 1,
            assistantMessage: state.assistantMessage,
            batchPosition: taskCall.batchPosition,
            kind: "native",
            name: subagentType,
            toolUseId: id,
          })
        }
        state.maxToolBatch = Math.max(state.maxToolBatch, toolBatch)
      }
    }
  }
}

export function parseTranscript(text: string): ParsedTranscript {
  const state = {
    taskCalls: [] as Array<TaskCall>,
    actions: [] as Array<ObservedAction>,
    startedAgentIds: new Set<string>(),
    assistantMessage: 0,
    maxToolBatch: 0,
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
  return {
    taskCalls: state.taskCalls,
    actions: state.actions,
    startedAgentIds: [...state.startedAgentIds],
    maxToolBatch: state.maxToolBatch,
  }
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

function maxRoutePass(result: RunResult): boolean {
  const expected = result.expectedRoute
  if (!expected) return false
  if (expected === "direct") return result.actions.length === 0
  if (
    result.actions.length === 0
    || result.actions.some((action) => action.kind !== expected)
    || (result.expectedActionCount !== undefined
      && result.actions.length !== result.expectedActionCount)
  ) {
    return false
  }
  if (expected === "native") {
    return result.actions.every((action) => result.acceptableAgents.includes(action.name))
  }
  if (expected === "peer") {
    return result.actions.every((action) => result.acceptablePeers?.includes(action.name) === true)
  }
  return result.actions.every((action) => action.name === "advisor")
}

/**
 * A run that timed out or died proves nothing about the model's choice — it
 * measures the harness or the CLI invocation, not delegation. `killedAfterTask`
 * is the harness's OWN intentional kill on the first Task event, so its
 * non-zero exit is expected and is not an error.
 *
 * This must gate every endpoint, not only fan-out. A run whose CLI invocation
 * fails before the model ever sees the prompt produces zero Task calls for a
 * reason that has nothing to do with delegation — and `spontaneousDelegation`
 * and `restraint` both key off `taskCalls.length === 0`. Without this filter a
 * systematic invocation failure (wrong flag, bad auth, crashed proxy) silently
 * reads as "the model chose not to delegate" and, on the negative-control
 * stratum, as a perfect restraint score — a fabricated result dressed up as a
 * measurement. This was caught live: every run in an eval invocation failed
 * identically on an unrecognized CLI flag, and the unfiltered scoring reported
 * 0% delegation / 100% restraint across the board before this fix.
 */
function erroredRun(result: RunResult): boolean {
  return result.timedOut || (result.exitCode !== 0 && !result.killedAfterTask)
}

type FanoutScore = "pass" | "fail" | "inconclusive" | "errored"

function fanoutScore(result: RunResult): FanoutScore {
  if (erroredRun(result)) return "errored"
  // Only a run that actually emitted a 2+ tool batch somewhere can distinguish
  // "the model chose to serialize" from "this execution mode cannot batch".
  if (result.maxToolBatch >= 2) {
    if (!result.expectedParallelCalls || result.taskCalls.length === 0) return "fail"
    const firstMessage = result.taskCalls[0].assistantMessage
    const firstBatch = result.taskCalls.filter((call) => call.assistantMessage === firstMessage)
    return firstBatch.length >= result.expectedParallelCalls
      && firstBatch.every((call) => result.acceptableAgents.includes(call.subagentType))
      ? "pass"
      : "fail"
  }
  // Exactly one tool call per assistant message throughout: the documented
  // headless-mode limitation, which no prompt can overcome. Not a model verdict.
  if (result.maxToolBatch === 1) return "inconclusive"
  // Zero tool calls on a clean run. The lead answered directly instead of
  // fanning out. That is a genuine fan-out FAILURE, not a mode limitation, and
  // must stay in the denominator or the rate silently inflates.
  return "fail"
}

export function scoreResults(results: ReadonlyArray<RunResult>): ScoreSummary {
  const armResults = (arm: ArmName) => results.filter((result) => result.arm === arm)
  const rateByArm = (predicate: (result: RunResult) => boolean, eligible: (result: RunResult) => boolean) =>
    Object.fromEntries((["A", "B"] as const).map((arm) => {
      const denominator = armResults(arm).filter(eligible)
      return [arm, wilson95(denominator.filter(predicate).length, denominator.length)]
    })) as Record<ArmName, Rate>

  // Every non-fan-out eligibility predicate below is ANDed with `!erroredRun`.
  // A crashed or timed-out CLI invocation produces zero Task calls for a reason
  // that says nothing about delegation, and must never be scored as "chose not
  // to delegate" or "restrained" — see `erroredRun`'s doc comment for the live
  // incident this guards against.
  const spontaneousEligible = (result: RunResult) =>
    result.stratum !== "negative-control"
    && result.stratum !== "parallel-fanout"
    && (result.expectedRoute === undefined || result.expectedRoute === "native")
    && !erroredRun(result)
  const delegated = (result: RunResult) => result.expectedRoute === undefined
    ? result.taskCalls.length > 0
    : result.actions.length > 0
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
    if (!pair.A || !pair.B) continue
    if (!spontaneousEligible(pair.A) || !spontaneousEligible(pair.B)) continue
    // Skip the pair (not just one side) when either arm errored: a transition
    // needs both sides to be a real measurement, or "delegation dropped" could
    // just mean "arm B's CLI invocation crashed this time".
    if (erroredRun(pair.A) || erroredRun(pair.B)) continue
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
      (r) => r.stratum !== "negative-control"
        && (r.expectedRoute === undefined || r.expectedRoute === "native")
        && !erroredRun(r)
        && delegated(r),
    ),
    restraint: rateByArm(
      (r) => !delegated(r),
      (r) => r.stratum === "negative-control" && !erroredRun(r),
    ),
    parallelFanout: rateByArm(
      (r) => fanoutScore(r) === "pass",
      (r) => r.stratum === "parallel-fanout"
        && fanoutScore(r) !== "inconclusive"
        && fanoutScore(r) !== "errored",
    ),
    parallelFanoutInconclusive: Object.fromEntries((['A', 'B'] as const).map((arm) => [
      arm,
      armResults(arm).filter((r) => r.stratum === "parallel-fanout" && fanoutScore(r) === "inconclusive").length,
    ])) as Record<ArmName, number>,
    parallelFanoutErrored: Object.fromEntries((['A', 'B'] as const).map((arm) => [
      arm,
      armResults(arm).filter((r) => r.stratum === "parallel-fanout" && fanoutScore(r) === "errored").length,
    ])) as Record<ArmName, number>,
    complexImplementationDelegation: rateByArm(
      (r) => r.taskCalls.some((call) => call.subagentType === "implementer"),
      (r) => r.stratum === "complex-implementation" && !erroredRun(r),
    ),
    maxRouteSelection: rateByArm(
      maxRoutePass,
      (r) => r.expectedRoute !== undefined && !erroredRun(r),
    ),
    maxPeerSelection: rateByArm(
      maxRoutePass,
      (r) => r.expectedRoute === "peer" && !erroredRun(r),
    ),
    maxCoordinatorSelection: rateByArm(
      maxRoutePass,
      (r) => r.stratum === "max-coordinator" && !erroredRun(r),
    ),
    maxAdvisorSelection: rateByArm(
      maxRoutePass,
      (r) => r.expectedRoute === "advisor" && !erroredRun(r),
    ),
    maxAdvisorRestraint: rateByArm(
      (r) => !r.actions.some((action) => action.kind === "advisor"),
      (r) => r.expectedRoute === "direct" && !erroredRun(r),
    ),
    nonFanoutErrored: Object.fromEntries((["A", "B"] as const).map((arm) => [
      arm,
      armResults(arm).filter((r) => r.stratum !== "parallel-fanout" && erroredRun(r)).length,
    ])) as Record<ArmName, number>,
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
  // `arm.command` invokes the CLI directly against an already-running proxy
  // (see DELEGATION-EVAL.md) — the DEFAULT is the raw `claude` binary, not
  // `github-router claude`. `--no-auto-update`/`--no-self-update` are
  // `github-router claude`'s OWN flags; the real Claude Code CLI does not
  // recognize them and exits 1 with "unknown option" before the prompt is ever
  // sent. That crash previously went undetected because the pre-fix scoring
  // counted a crashed run's zero Task calls as "chose not to delegate" — see
  // `erroredRun`. `GH_ROUTER_NO_SELF_UPDATE=1` below is the correct guard for
  // an arm that DOES point at `github-router claude` (a CLI flag would be
  // wrong there too, since that subcommand's own flag is `--no-self-update`,
  // not a proxy env var override of the SAME name coincidentally reused here);
  // it is a silently-ignored no-op env var against the raw `claude` binary.
  const maxMode = process.env.GH_ROUTER_DELEGATION_EVAL_PROFILE === "max"
  const args = [
    ...arm.command,
    ...(maxMode ? [] : ["--model", MODEL]),
    "--print",
    "--output-format",
    "stream-json",
    // The installed CLI (verified against 2.1.229) hard-rejects
    // `--print --output-format=stream-json` without `--verbose`: "Error: When
    // using --print, --output-format=stream-json requires --verbose". A second
    // real invocation failure this harness shipped with, caught the same way as
    // the flags fix above — every run crashed identically in ~3s and the
    // pre-fix scoring silently read that as "chose not to delegate" /
    // "restrained". `--verbose` only affects what the CLI prints in stream-json
    // mode, not the model's behavior, so it does not change what is measured.
    "--verbose",
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
    actions: [] as Array<ObservedAction>,
    startedAgentIds: new Set<string>(),
    assistantMessage: 0,
    maxToolBatch: 0,
  }
  let firstTaskMs: number | undefined
  let firstActionMs: number | undefined
  let killedAfterTask = false
  const onLine = (line: string) => {
    const before = maxMode ? liveState.actions.length : liveState.taskCalls.length
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
    const observedCount = maxMode ? liveState.actions.length : liveState.taskCalls.length
    if (before === 0 && observedCount > 0) {
      firstActionMs = Date.now() - startedAt.getTime()
      if (liveState.actions[0]?.kind === "native") firstTaskMs = firstActionMs
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
    expectedRoute: instance.expectedRoute,
    expectedActionCount: instance.expectedActionCount,
    acceptablePeers: instance.acceptablePeers,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    elapsedMs: endedAt.getTime() - startedAt.getTime(),
    firstTaskMs,
    firstActionMs,
    exitCode,
    timedOut,
    killedAfterTask,
    requestedButNeverStarted: liveState.actions.some((action) => action.kind === "native")
      && startedAgentIds.length === 0,
    taskCalls,
    actions: liveState.actions,
    startedAgentIds,
    maxToolBatch: liveState.maxToolBatch,
    stdoutTail: stdout.slice(-2_000),
    stderrTail: stderr.slice(-2_000),
    model: maxMode ? "max-profile-lead" : MODEL,
    cliVersion,
    proxyRevision: arm.revision,
    proxyCommand: reportableArm(arm).command,
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

function printSummary(summary: ScoreSummary, maxMode: boolean): void {
  for (const [name, rates] of Object.entries(summary).filter(
    ([name]) => name !== "pairedTransitions"
      && name !== "parallelFanoutInconclusive"
      && name !== "parallelFanoutErrored"
      && name !== "nonFanoutErrored"
      && (maxMode || !name.startsWith("max")),
  )) {
    const typed = rates as Record<ArmName, Rate>
    console.log(`${name}: A ${formatRate(typed.A)}; B ${formatRate(typed.B)}`)
  }
  const nonFanoutErrored = summary.nonFanoutErrored
  if (nonFanoutErrored.A > 0 || nonFanoutErrored.B > 0) {
    console.log(
      `spontaneousDelegation/restraint/complexImplementationDelegation: excluded A ${nonFanoutErrored.A}; B ${nonFanoutErrored.B} errored run(s) (timeout or non-zero exit before the CLI produced any signal), which measure neither the model's choice nor its restraint.`,
    )
  }
  const inconclusive = summary.parallelFanoutInconclusive
  if (inconclusive.A > 0 || inconclusive.B > 0) {
    console.log(
      `parallelFanout: excluded A ${inconclusive.A}; B ${inconclusive.B} inconclusive run(s) because every assistant message carried at most one tool call, so this execution mode could not demonstrate batching at all.`,
    )
  }
  const errored = summary.parallelFanoutErrored
  if (errored.A > 0 || errored.B > 0) {
    console.log(
      `parallelFanout: excluded A ${errored.A}; B ${errored.B} errored run(s) (timeout or non-zero exit), which measure neither the model's choice nor the mode's capability.`,
    )
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
  maxToolBatch = taskCalls.length,
): RunResult {
  return {
    promptId,
    stratum,
    arm,
    taskCalls,
    actions: taskCalls.map((call) => ({
      order: call.order,
      assistantMessage: call.assistantMessage,
      batchPosition: call.batchPosition,
      kind: "native" as const,
      name: call.subagentType,
      toolUseId: call.toolUseId,
    })),
    acceptableAgents,
    expectedParallelCalls,
    expectedActionCount: undefined,
    startedAgentIds: taskCalls.length > 0 ? ["agent-synthetic"] : [],
    maxToolBatch,
    startedAt: "2026-08-11T00:00:00.000Z",
    endedAt: "2026-08-11T00:00:01.000Z",
    elapsedMs: 1_000,
    firstActionMs: taskCalls.length > 0 ? 500 : undefined,
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
  if (parsed.maxToolBatch !== 3) {
    throw new Error(`expected maxToolBatch 3, got ${parsed.maxToolBatch}`)
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
    syntheticResult("fanout", "parallel-fanout", "A", [calls[0]], ["scout", "reviewer", "brainstorm"], 3, 1),
    syntheticResult("fanout", "parallel-fanout", "B", calls, ["scout", "reviewer", "brainstorm"], 3, 3),
    // Zero tool calls on a CLEAN run: the lead answered directly instead of
    // fanning out. That is a real failure and must stay in the denominator,
    // otherwise excluding it silently inflates the rate.
    syntheticResult("fanout-zero", "parallel-fanout", "A", [], ["scout", "reviewer", "brainstorm"], 3, 0),
    // A timed-out run measures neither the model's choice nor the mode's
    // capability, so it is excluded in its own bucket rather than as a failure.
    {
      ...syntheticResult("fanout-timeout", "parallel-fanout", "A", [], ["scout", "reviewer", "brainstorm"], 3, 0),
      timedOut: true,
    },
    // A crashed CLI invocation on a NON-fan-out stratum (no paired "B" run, so
    // it cannot register a paired transition either). Its zero Task calls must
    // be excluded from spontaneousDelegation's denominator rather than counted
    // as "chose not to delegate" — the live incident this guards against.
    {
      ...syntheticResult("crashed-specialist", "specialist", "A", [], ["scout"]),
      exitCode: 1,
    },
    // Same failure mode on the negative-control stratum: a crash must not be
    // counted as "restrained" — it never got the chance to act at all.
    {
      ...syntheticResult("crashed-negative", "negative-control", "A", [], []),
      exitCode: 1,
    },
  ]
  const score = scoreResults(results)
  if (score.spontaneousDelegation.B.successes !== 1 || score.restraint.B.successes !== 1) {
    throw new Error(`unexpected score: ${JSON.stringify(score)}`)
  }
  if (score.spontaneousDelegation.A.denominator !== 1) {
    throw new Error(
      `a crashed run must not enter the spontaneousDelegation denominator: ${JSON.stringify(score.spontaneousDelegation.A)}`,
    )
  }
  if (score.restraint.A.denominator !== 1) {
    throw new Error(
      `a crashed run must not enter the restraint denominator: ${JSON.stringify(score.restraint.A)}`,
    )
  }
  if (score.nonFanoutErrored.A !== 2 || score.nonFanoutErrored.B !== 0) {
    throw new Error(`non-fan-out errored exclusions must be counted: ${JSON.stringify(score.nonFanoutErrored)}`)
  }
  if (score.parallelFanout.A.denominator !== 1 || score.parallelFanout.A.successes !== 0) {
    throw new Error(`zero-tool run must count as a fan-out failure: ${JSON.stringify(score.parallelFanout.A)}`)
  }
  if (score.parallelFanout.B.denominator !== 1 || score.parallelFanout.B.successes !== 1) {
    throw new Error(`unexpected fanout score: ${JSON.stringify(score.parallelFanout)}`)
  }
  if (score.parallelFanoutInconclusive.A !== 1 || score.parallelFanoutInconclusive.B !== 0) {
    throw new Error(`unexpected fanout exclusions: ${JSON.stringify(score.parallelFanoutInconclusive)}`)
  }
  if (score.parallelFanoutErrored.A !== 1 || score.parallelFanoutErrored.B !== 0) {
    throw new Error(`errored runs must be excluded separately: ${JSON.stringify(score.parallelFanoutErrored)}`)
  }
  // maxToolBatch must count EVERY tool, not only Task/Agent. A run that batches
  // three ordinary tools proves the MODE can batch, which is exactly what
  // separates "the model chose to serialize" from "this mode cannot batch".
  // Without this the diagnostic could regress to Task-only and still pass.
  const ordinaryBatch = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "t1", name: "Read", input: {} },
        { type: "tool_use", id: "t2", name: "Read", input: {} },
        { type: "tool_use", id: "t3", name: "Grep", input: {} },
      ],
    },
  })
  const ordinaryParsed = parseTranscript(ordinaryBatch)
  if (ordinaryParsed.maxToolBatch !== 3) {
    throw new Error(`maxToolBatch must count non-Task tools, got ${ordinaryParsed.maxToolBatch}`)
  }
  if (ordinaryParsed.taskCalls.length !== 0) {
    throw new Error("ordinary tools must not register as Task calls")
  }
  const routingParsed = parseTranscript(JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "peer", name: "mcp__peers__grok_reviewer", input: {} },
        { type: "server_tool_use", id: "advisor", name: "advisor", input: {} },
      ],
    },
  }))
  if (
    routingParsed.actions.map((action) => `${action.kind}:${action.name}`).join(",")
    !== "peer:grok_reviewer,advisor:advisor"
  ) {
    throw new Error(`peer/advisor parsing failed: ${JSON.stringify(routingParsed.actions)}`)
  }
  const peerRoute: RunResult = {
    ...syntheticResult("max-peer", "max-peer", "A", [], []),
    expectedRoute: "peer",
    expectedActionCount: 1,
    acceptablePeers: ["grok_reviewer"],
    actions: [routingParsed.actions[0]],
  }
  const duplicatePeerRoute: RunResult = {
    ...peerRoute,
    promptId: "max-peer-duplicate",
    arm: "B",
    actions: [routingParsed.actions[0], { ...routingParsed.actions[0], order: 2 }],
  }
  const advisorRoute: RunResult = {
    ...syntheticResult("max-advisor", "max-advisor", "A", [], []),
    expectedRoute: "advisor",
    actions: [routingParsed.actions[1]],
  }
  const routeScore = scoreResults([peerRoute, duplicatePeerRoute, advisorRoute])
  if (
    routeScore.maxPeerSelection.A.successes !== 1
    || routeScore.maxPeerSelection.B.successes !== 0
    || routeScore.maxAdvisorSelection.A.successes !== 1
  ) {
    throw new Error(`Max peer/advisor route scoring failed: ${JSON.stringify(routeScore)}`)
  }
  if (!score.spontaneousDelegation.B.wilson95) throw new Error("Wilson interval missing")
  console.log("delegation eval self-test passed: JSONL parser, ordering, start cross-check, three-valued fanout scoring, and Wilson intervals")
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

  const maxMode = process.env.GH_ROUTER_DELEGATION_EVAL_PROFILE === "max"
  if (
    maxMode
    && (!process.env.GH_ROUTER_DELEGATION_ARM_A_COMMAND
      || !process.env.GH_ROUTER_DELEGATION_ARM_B_COMMAND)
  ) {
    throw new Error(
      "Max eval requires explicit A and B command prefixes ending in `--`, for example [\"github-router\",\"claude\",\"--model\",\"max\",\"--\"].",
    )
  }
  const parseArmCommand = (value: string | undefined): Array<string> => {
    const command = parseCommand(value, ["claude"])
    if (maxMode && command.at(-1) !== "--") {
      throw new Error("Each Max arm command must be the complete launcher prefix and end in `--`.")
    }
    return command
  }
  const githubToken = maxMode ? maxEvalGithubToken() : undefined

  const armConfigs: Array<ScrubbedConfig> = []
  try {
    const armAConfig = isolatedArmConfig(
      process.env.GH_ROUTER_DELEGATION_ARM_A_CONFIG_DIR,
      maxMode,
    )
    armConfigs.push(armAConfig)
    const armBConfig = isolatedArmConfig(
      process.env.GH_ROUTER_DELEGATION_ARM_B_CONFIG_DIR,
      maxMode,
    )
    armConfigs.push(armBConfig)
    console.log(
      `delegation eval: using separate scrubbed config sources for arms A and B (${maxMode ? "isolated launcher homes" : "CLAUDE_CONFIG_DIR copies"}).`,
    )

    const armA: ArmConfig = {
      name: "A",
      command: parseArmCommand(process.env.GH_ROUTER_DELEGATION_ARM_A_COMMAND),
      revision: process.env.GH_ROUTER_DELEGATION_ARM_A_REVISION ?? "baseline-config",
      env: armEnv(
        process.env.GH_ROUTER_DELEGATION_ARM_A_BASE_URL ?? BASE_URL,
        armAConfig.configDir,
        maxMode ? armAConfig.homeDir : undefined,
        githubToken,
      ),
    }
    const armB: ArmConfig = {
      name: "B",
      command: parseArmCommand(process.env.GH_ROUTER_DELEGATION_ARM_B_COMMAND),
      revision: process.env.GH_ROUTER_DELEGATION_ARM_B_REVISION ?? currentRevision(),
      env: armEnv(
        process.env.GH_ROUTER_DELEGATION_ARM_B_BASE_URL ?? BASE_URL,
        armBConfig.configDir,
        maxMode ? armBConfig.homeDir : undefined,
        githubToken,
      ),
    }
    const cliVersion = commandOutput(["claude", "--version"])
    const random = seededRandom(SEED)
    const battery = maxMode ? MAX_BATTERY : BATTERY
    const schedule = shuffle(battery, random).flatMap((instance) =>
      shuffle([armA, armB], random).map((arm) => ({ instance, arm })),
    )
    const fixture = fixtureCopy()
    const results: Array<RunResult> = []
    try {
      console.log(`delegation eval: ${schedule.length} interleaved runs; seed=${SEED}; profile=${maxMode ? "max" : "standard"}; model=${maxMode ? "max-profile-lead" : MODEL}; CLI=${cliVersion}`)
      for (const [index, item] of schedule.entries()) {
        console.log(`[${index + 1}/${schedule.length}] ${item.instance.id} arm ${item.arm.name}`)
        const result = await runOne(item.instance, item.arm, fixture, cliVersion)
        results.push(result)
        console.log(`  actions=[${result.actions.map((action) => `${action.kind}:${action.name}`).join(", ")}] started=[${result.startedAgentIds.join(", ")}] ${result.elapsedMs}ms`)
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
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      seed: SEED,
      profile: maxMode ? "max" : "standard",
      model: maxMode ? "max-profile-lead" : MODEL,
      cliVersion,
      proxyWorkingRevision: currentRevision(),
      arms: { A: reportableArm(armA), B: reportableArm(armB) },
      battery,
      results,
      summary,
    }, null, 2)}\n`)
    printSummary(summary, maxMode)
    console.log(`full result: ${output}`)
  } finally {
    for (const config of armConfigs) {
      if (config.cleanupDir) rmSync(config.cleanupDir, { recursive: true, force: true })
    }
  }
}

if (import.meta.main) await main()
