import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import nodePath from "node:path"

import { parseBoolEnv } from "~/lib/exec"

import { callMcpTool, type HookMcpRuntime, type McpToolResult } from "./hook-mcp-client"
import {
  isSubagentContext,
  type FindingsStore,
  type ReviewDebounce,
} from "./stop-gate-policy"

/** Minimum finalized-plan size worth spending a model review on. */
export const PLAN_REVIEW_MIN_CHARS = 220

/** Hard wall-clock for the advisory plan critic. */
export const PLAN_REVIEW_TIMEOUT_MS = 25_000

/** Cap the plan embedded in the critic brief so a huge plan file cannot dominate. */
const MAX_REVIEWED_PLAN_CHARS = 80 * 1024

export interface PlanReviewSpawnContext {
  sessionId: string
  cwd: string
  plan: string
  planHash: string
}

export type PlanReviewDecision =
  | { kind: "skip"; reason: string }
  | ({ kind: "spawn" } & PlanReviewSpawnContext)

/** Default-on advisory plan review. Opt out with GH_ROUTER_DISABLE_PLAN_REVIEW=1. */
export function planReviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBoolEnv(env.GH_ROUTER_DISABLE_PLAN_REVIEW) !== true
}

/** File-backed per-session debounce for finalized plans, separate from Stop diff hashes. */
export function filePlanReviewDebounce(stateDir: string): ReviewDebounce {
  const fileFor = (sid: string): string =>
    nodePath.join(stateDir, `plan-review-hash-${createHash("sha256").update(sid).digest("hex").slice(0, 32)}`)
  const readLast = async (sid: string): Promise<string> => {
    try {
      return (await fs.readFile(fileFor(sid), "utf8")).trim()
    } catch {
      return ""
    }
  }
  return {
    async shouldReview(sid, planHash) {
      if (planHash.length === 0) return false
      return (await readLast(sid)) !== planHash
    },
    async markReviewed(sid, planHash) {
      await fs.mkdir(stateDir, { recursive: true })
      await fs.writeFile(fileFor(sid), planHash, { mode: 0o600 })
    },
  }
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    /* malformed hook payload -> skip */
  }
  return undefined
}

async function resolvePlanText(
  toolInput: unknown,
  readFile: (filePath: string) => Promise<string>,
): Promise<string> {
  if (!toolInput || typeof toolInput !== "object") return ""
  const ti = toolInput as { planFilePath?: unknown; plan?: unknown }
  const planFilePath = typeof ti.planFilePath === "string" && ti.planFilePath.trim().length > 0
    ? ti.planFilePath.trim()
    : ""
  if (planFilePath.length > 0) {
    try {
      const fromFile = await readFile(planFilePath)
      if (fromFile.trim().length > 0) return fromFile
    } catch {
      /* fall through to inline plan */
    }
  }
  return typeof ti.plan === "string" ? ti.plan : ""
}

/**
 * Decide whether the ExitPlanMode PostToolUse hook should spawn a detached review.
 * Pure aside from injected file reads + debounce store. Fail-open: any malformed
 * payload, missing runtime, subagent context, trivial/absent plan, or store error
 * returns a skip decision.
 */
export async function decidePlanReviewHook(input: {
  stdin: string
  runtimeAvailable: boolean
  debounce: ReviewDebounce
  fallbackCwd: string
  minChars?: number
  readFile?: (filePath: string) => Promise<string>
}): Promise<PlanReviewDecision> {
  try {
    if (!input.runtimeAvailable) return { kind: "skip", reason: "missing-runtime" }
    const payload = parseObject(input.stdin)
    if (!payload) return { kind: "skip", reason: "bad-payload" }
    if (isSubagentContext(payload)) return { kind: "skip", reason: "subagent" }

    const sessionId = typeof payload.session_id === "string" && payload.session_id.length > 0 ? payload.session_id : ""
    if (!sessionId) return { kind: "skip", reason: "missing-session" }
    const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : input.fallbackCwd
    const plan = await resolvePlanText(
      payload.tool_input,
      input.readFile ?? ((filePath: string) => fs.readFile(filePath, "utf8")),
    )
    const trimmed = plan.trim()
    if (trimmed.length < (input.minChars ?? PLAN_REVIEW_MIN_CHARS)) return { kind: "skip", reason: "trivial-plan" }

    const planHash = createHash("sha256").update(trimmed).digest("hex")
    if (!(await input.debounce.shouldReview(sessionId, planHash))) return { kind: "skip", reason: "debounced" }
    await input.debounce.markReviewed(sessionId, planHash)
    return { kind: "spawn", sessionId, cwd, plan: trimmed, planHash }
  } catch {
    return { kind: "skip", reason: "error" }
  }
}

function reviewBrief(plan: string, cwd: string): string {
  const embeddedPlan =
    plan.length > MAX_REVIEWED_PLAN_CHARS
      ? `${plan.slice(0, MAX_REVIEWED_PLAN_CHARS)}\n\n[plan truncated at ${MAX_REVIEWED_PLAN_CHARS} characters]`
      : plan
  return (
    "You are an independent plan reviewer. A coding agent has just finalized a plan with ExitPlanMode. "
    + "Your job is to find load-bearing risks before implementation starts: unstated assumptions, missing "
    + "failure modes, gaps in verification, dangerous sequencing, or places where the plan could satisfy the "
    + "letter of the request while missing the user's likely intent.\n\n"
    + "Be concise and skeptical. Do NOT rewrite the plan, do NOT praise it, and do NOT invent new product "
    + "requirements. Report only material objections that would change what the agent should do next. Include "
    + "file:line anchors when the plan names concrete files or when the risk depends on repo code. If the plan "
    + "is sound, say exactly: \"no material objection\".\n\n"
    + `Workspace: ${cwd}\n\n`
    + "FINALIZED PLAN:\n"
    + embeddedPlan
  )
}

function hasMaterialFinding(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/g, "")
  return normalized.length > 0 && normalized !== "no material objection" && normalized !== "no material objections"
}

function framePlanFindings(text: string): string {
  return (
    "PLAN REVIEW: an independent cross-lab critic reviewed the finalized plan and found "
    + "the following material concern(s).\n"
    + text.trim()
  )
}

/** Run the bounded critic call and write material findings to the shared findings store. */
export async function runPlanReview(input: {
  runtime: HookMcpRuntime
  sessionId: string
  cwd: string
  plan: string
  findingsStore: FindingsStore
  timeoutMs?: number
  callReview?: (brief: string, signal: AbortSignal) => Promise<McpToolResult>
}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? PLAN_REVIEW_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  try {
    const brief = reviewBrief(input.plan, input.cwd)
    const review = (input.callReview ?? ((prompt: string, signal: AbortSignal) => callMcpTool({
      runtime: input.runtime,
      group: "peers",
      tool: "codex_critic",
      args: { prompt, effort: "high" },
      timeoutMs,
      signal,
    })))(brief, controller.signal)
    review.catch(() => {})
    const raced = await Promise.race<McpToolResult | "timeout">([
      review,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs)
      }),
    ])
    if (raced === "timeout" || raced.isError || !hasMaterialFinding(raced.text)) return

    const framed = framePlanFindings(raced.text)
    const existing = await input.findingsStore.read(input.sessionId).catch(() => null)
    const next = existing && existing.trim().length > 0 ? `${existing.trim()}\n\n${framed}` : framed
    await input.findingsStore.write(input.sessionId, next)
  } catch {
    /* advisory layer must never surface an error */
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
  }
}

/** Build the command registered for PostToolUse(ExitPlanMode). */
export function buildPlanReviewHookCommand(execPath: string, scriptPath: string | undefined): string {
  const q = (s: string): string => `"${s}"`
  if (scriptPath && scriptPath !== execPath) {
    return `${q(execPath)} ${q(scriptPath)} internal-plan-review`
  }
  return `${q(execPath)} internal-plan-review`
}
