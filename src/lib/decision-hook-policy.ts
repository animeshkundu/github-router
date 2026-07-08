/**
 * ai-or-die mobile-mode Channel 1: Claude Code PreToolUse decision hook.
 *
 * This module is the testable policy/core for the blocking hook. The thin
 * `internal-decision-hook` command owns stdin + credential-file plumbing; this
 * file owns:
 *   - PreToolUse payload -> decision packet construction,
 *   - control-plane POST + long-poll client shaping, and
 *   - the fail-closed watchdog/choice mapping.
 *
 * ALLOW follows the repo's existing PreToolUse convention (`worker-guard`):
 * print nothing and exit 0. DENY prints hookSpecificOutput JSON and exits 0.
 */

import { applyInsecureTls } from "./insecure-tls"

export const DECISION_HOOK_TOOLS = ["Bash", "Write", "Edit", "ExitPlanMode"] as const
export type DecisionHookTool = (typeof DECISION_HOOK_TOOLS)[number]

/** Claude Code hook matcher used at registration time. */
export const DECISION_HOOK_TOOL_MATCHER = "^(Bash|Write|Edit|ExitPlanMode)$"

/** Claude host hook timeout. The hook's own watchdog must return before this. */
export const DECISION_HOOK_CLAUDE_TIMEOUT_SEC = 7_200

/** Default human wait budget: long enough for a phone approval, bounded at 20m. */
export const DEFAULT_DECISION_HOOK_MAX_HUMAN_WAIT_MS = 20 * 60 * 1_000

/** Server long-poll cap requested from /await. */
export const DEFAULT_DECISION_HOOK_POLL_TIMEOUT_MS = 25_000

/** Self-deadline sits one minute below the registered Claude timeout. */
export const DEFAULT_DECISION_HOOK_SELF_DEADLINE_MS = (DECISION_HOOK_CLAUDE_TIMEOUT_SEC - 60) * 1_000

const DEFAULT_DECISION_HOOK_RETURN_MARGIN_MS = 1_000
const DEFAULT_DECISION_HOOK_REPOLL_DELAY_MS = 250
const DEFAULT_DECISION_POST_TIMEOUT_MS = 15_000
const DECISION_AWAIT_ABORT_MARGIN_MS = 5_000

const ALLOW_CHOICES = new Set(["accept", "approve", "yes", "allow"])

export interface ToolApprovalPacket {
  kind: "tool_approval"
  tool: "Bash" | "Write" | "Edit"
  command: string
  cwd: string
}

export interface PlanApprovalPacket {
  kind: "plan_approval"
  plan: string
}

export type DecisionPacket = ToolApprovalPacket | PlanApprovalPacket

export interface DecisionAwaitAnswered {
  answered: true
  choice: unknown
  optionValue?: unknown
}

export interface DecisionAwaitPending {
  answered: false
  viewers: number
}

export type DecisionAwaitResponse = DecisionAwaitAnswered | DecisionAwaitPending

export interface DecisionHookHttpCallOptions {
  signal?: AbortSignal
}

export interface DecisionHookHttp {
  createDecision: (packet: DecisionPacket, options?: DecisionHookHttpCallOptions) => Promise<{ decisionId: string }>
  awaitDecision: (decisionId: string, timeoutMs: number, options?: DecisionHookHttpCallOptions) => Promise<unknown>
  /** Signal that a gated tool actually ran (PostToolUse), so ai-or-die clears any
   *  pending decision for the session (the human answered Claude's native prompt). */
  resolveSession: (options?: DecisionHookHttpCallOptions) => Promise<unknown>
}

export interface DecisionHookHttpOptions {
  baseUrl: string
  token: string
  sessionId: string
  fetchFn?: typeof fetch
  insecureTLS?: boolean
  postTimeoutMs?: number
}

export interface DecisionHookPolicyInput {
  /** Raw Claude Code PreToolUse stdin JSON. */
  stdin: string
  /** Injected HTTP client (mocked in tests; live command uses createDecisionHookHttp). */
  http: DecisionHookHttp
  /** cwd to place in tool_approval packets when the payload omits `cwd`. */
  fallbackCwd: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  maxHumanWaitMs?: number
  hardDeadlineMs?: number
  pollTimeoutMs?: number
  returnMarginMs?: number
  repollDelayMs?: number
}

export type DecisionHookVerdict =
  | "allow-passthrough"
  | "allow-approved"
  | "deny-malformed"
  | "deny-http-error"
  | "deny-no-reviewer"
  | "deny-budget-expired"
  | "deny-self-deadline"
  | "deny-rejected"

export interface DecisionHookResult {
  /** JSON to print to stdout (deny), or null to allow (print nothing). */
  output: string | null
  verdict: DecisionHookVerdict
  reason: string
  packet?: DecisionPacket
}

type PacketBuildResult =
  | { action: "intercept"; packet: DecisionPacket }
  | { action: "allow-passthrough"; reason: string }
  | { action: "deny-malformed"; reason: string }

interface PreToolUsePayload {
  tool_name?: unknown
  tool_input?: unknown
  cwd?: unknown
  /** Claude's effective permission mode for this call (read fresh per invocation).
   *  In "bypassPermissions" Claude prompts for nothing, so we stand down. */
  permission_mode?: unknown
}

/** Permission modes in which Claude Code does NOT surface a permission prompt, so
 *  the mobile approval must stand down — mirror "only pop a sheet if Claude itself
 *  would prompt". bypassPermissions === --dangerously-skip-permissions (the
 *  github-router launch default); dontAsk / auto likewise suppress the prompt.
 *  Unknown/absent modes fall through to the normal gated behavior. */
const NON_PROMPTING_PERMISSION_MODES = new Set(["bypassPermissions", "dontAsk", "auto"])

/** The stdout JSON a PreToolUse hook prints to DENY a tool call. */
export function decisionHookDenyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })
}

export function isDecisionHookTool(toolName: string): toolName is DecisionHookTool {
  return (DECISION_HOOK_TOOLS as ReadonlyArray<string>).includes(toolName)
}

/**
 * Build the ai-or-die decision packet from Claude's PreToolUse payload.
 *
 * Unknown tools are a non-interference allow. Malformed payloads for this matched
 * hook are fail-closed: the launcher matcher should only invoke us for tools we
 * gate, so an unreadable/missing tool name is not safe to pass through.
 */
export function buildDecisionPacketFromStdin(
  stdin: string,
  fallbackCwd: string,
  options?: { ignorePermissionMode?: boolean },
): PacketBuildResult {
  let payload: PreToolUsePayload
  try {
    const parsed: unknown = JSON.parse(stdin)
    if (!isRecord(parsed)) return { action: "deny-malformed", reason: "invalid PreToolUse payload" }
    payload = parsed
  } catch {
    return { action: "deny-malformed", reason: "invalid PreToolUse payload" }
  }

  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : undefined
  if (!toolName) return { action: "deny-malformed", reason: "missing PreToolUse tool_name" }
  if (!isDecisionHookTool(toolName)) {
    return { action: "allow-passthrough", reason: `tool ${toolName} is not gated by mobile approvals` }
  }

  // Only mirror a decision to the phone when Claude itself would prompt. When the
  // session is in a non-prompting permission mode (bypassPermissions — the launch
  // default — or dontAsk/auto), Claude runs the tool with no dialog, so we stand
  // down and let Claude's own flow proceed. Read fresh per call, so a runtime
  // Shift+Tab into/out of bypass is honored on the next tool. (Carve-outs that
  // still prompt under bypass, e.g. the rm -rf circuit-breaker, are surfaced by
  // Claude in the terminal regardless; a PreToolUse hook cannot see them.)
  //
  // The PermissionRequest notifier passes ignorePermissionMode: the event only
  // fires when a dialog actually appears, so it IS the "would prompt" signal and
  // the coarse mode check would wrongly drop e.g. ExitPlanMode approvals in bypass.
  const permissionMode = typeof payload.permission_mode === "string" ? payload.permission_mode : undefined
  if (!options?.ignorePermissionMode && permissionMode && NON_PROMPTING_PERMISSION_MODES.has(permissionMode)) {
    return {
      action: "allow-passthrough",
      reason: `permission_mode ${permissionMode}: Claude does not prompt; mobile approval stands down`,
    }
  }

  // TODO(askuserquestion): AskUserQuestion needs a separate answer-injection
  // mechanism. A PreToolUse allow/deny hook cannot convey a multi-option
  // selection, so it is intentionally not intercepted in this Channel-1 MVP.

  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {}
  const cwd = nonEmptyString(payload.cwd) ?? fallbackCwd

  if (toolName === "Bash") {
    const command = nonEmptyString(toolInput.command)
    if (!command) return { action: "deny-malformed", reason: "Bash tool_input.command is missing" }
    return { action: "intercept", packet: { kind: "tool_approval", tool: "Bash", command, cwd } }
  }

  if (toolName === "Write") {
    const filePath = nonEmptyString(toolInput.file_path)
    if (!filePath) return { action: "deny-malformed", reason: "Write tool_input.file_path is missing" }
    return {
      action: "intercept",
      packet: {
        kind: "tool_approval",
        tool: "Write",
        command: summarizeWrite(filePath, toolInput),
        cwd,
      },
    }
  }

  if (toolName === "Edit") {
    const filePath = nonEmptyString(toolInput.file_path)
    if (!filePath) return { action: "deny-malformed", reason: "Edit tool_input.file_path is missing" }
    return {
      action: "intercept",
      packet: {
        kind: "tool_approval",
        tool: "Edit",
        command: summarizeEdit(filePath, toolInput),
        cwd,
      },
    }
  }

  const plan = typeof toolInput.plan === "string" ? toolInput.plan : undefined
  if (plan === undefined) return { action: "deny-malformed", reason: "ExitPlanMode tool_input.plan is missing" }
  return { action: "intercept", packet: { kind: "plan_approval", plan } }
}

/**
 * End-to-end policy: build packet, POST it, poll until answered, and return the
 * PreToolUse stdout convention (null for allow; deny JSON for deny).
 */
export async function runDecisionHookPolicy(input: DecisionHookPolicyInput): Promise<DecisionHookResult> {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? realSleep
  const maxHumanWaitMs = positiveFinite(input.maxHumanWaitMs, DEFAULT_DECISION_HOOK_MAX_HUMAN_WAIT_MS)
  const hardDeadlineMs = positiveFinite(input.hardDeadlineMs, DEFAULT_DECISION_HOOK_SELF_DEADLINE_MS)
  const pollTimeoutMs = positiveFinite(input.pollTimeoutMs, DEFAULT_DECISION_HOOK_POLL_TIMEOUT_MS)
  const returnMarginMs = nonNegativeFinite(input.returnMarginMs, DEFAULT_DECISION_HOOK_RETURN_MARGIN_MS)
  const repollDelayMs = nonNegativeFinite(input.repollDelayMs, DEFAULT_DECISION_HOOK_REPOLL_DELAY_MS)

  const built = buildDecisionPacketFromStdin(input.stdin, input.fallbackCwd)
  if (built.action === "allow-passthrough") {
    return { output: null, verdict: "allow-passthrough", reason: built.reason }
  }
  if (built.action === "deny-malformed") {
    return deny("deny-malformed", built.reason)
  }

  const startedAt = now()
  const budgetDeadline = startedAt + maxHumanWaitMs
  const hardDeadline = startedAt + hardDeadlineMs
  const packet = built.packet

  let decisionId: string
  try {
    const created = await callWithPolicyWatchdog({
      now,
      startedAt,
      budgetDeadline,
      hardDeadline,
      returnMarginMs,
      run: (signal) => input.http.createDecision(packet, { signal }),
    })
    decisionId = nonEmptyString(created.decisionId) ?? ""
    if (!decisionId) throw new Error("decision endpoint returned no decisionId")
  } catch (err) {
    if (err instanceof DecisionHookDeadlineError) return deny(err.deadline.verdict, err.deadline.reason, packet)
    return deny("deny-http-error", "mobile approval request failed; denying fail-closed", packet)
  }

  for (;;) {
    const deadline = deadlineState(now(), startedAt, budgetDeadline, hardDeadline, returnMarginMs)
    if (deadline) return deny(deadline.verdict, deadline.reason, packet)

    const remainingMs = Math.min(budgetDeadline, hardDeadline) - now()
    const timeoutMs = Math.max(1, Math.min(pollTimeoutMs, Math.floor(remainingMs - returnMarginMs)))

    let response: DecisionAwaitResponse
    try {
      const raw = await callWithPolicyWatchdog({
        now,
        startedAt,
        budgetDeadline,
        hardDeadline,
        returnMarginMs,
        run: (signal) => input.http.awaitDecision(decisionId, timeoutMs, { signal }),
      })
      response = normalizeAwaitResponse(raw)
    } catch (err) {
      if (err instanceof DecisionHookDeadlineError) return deny(err.deadline.verdict, err.deadline.reason, packet)
      return deny("deny-http-error", "mobile approval await failed; denying fail-closed", packet)
    }

    const afterPollDeadline = deadlineState(now(), startedAt, budgetDeadline, hardDeadline, returnMarginMs)
    if (afterPollDeadline) return deny(afterPollDeadline.verdict, afterPollDeadline.reason, packet)

    if (response.answered) {
      if (choiceAllows(response.choice)) {
        return {
          output: null,
          verdict: "allow-approved",
          reason: `mobile reviewer approved (${String(response.choice)})`,
          packet,
        }
      }
      return deny("deny-rejected", rejectedReason(response.choice, response.optionValue), packet)
    }

    if (response.viewers === 0) {
      return deny("deny-no-reviewer", "no mobile reviewer connected; denying fail-closed", packet)
    }

    if (repollDelayMs > 0) {
      const delayMs = Math.min(repollDelayMs, Math.max(0, Math.min(budgetDeadline, hardDeadline) - now() - returnMarginMs))
      if (delayMs > 0) await sleep(delayMs)
    }
  }
}

export function createDecisionHookHttp(options: DecisionHookHttpOptions): DecisionHookHttp {
  const baseUrl = options.baseUrl.replace(/\/+$/, "")
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
  const postTimeoutMs = positiveFinite(options.postTimeoutMs, DEFAULT_DECISION_POST_TIMEOUT_MS)

  async function requestJson(args: {
    method: "GET" | "POST"
    pathname: string
    query?: Record<string, string | undefined>
    body?: unknown
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<unknown> {
    let url: URL
    try {
      url = new URL(args.pathname, `${baseUrl}/`)
    } catch (err) {
      throw new Error(`decision API URL is invalid: ${String(err)}`)
    }
    if (args.query) {
      for (const [key, value] of Object.entries(args.query)) {
        if (value !== undefined) url.searchParams.set(key, value)
      }
    }

    const timeout = timeoutSignal(args.timeoutMs, args.signal)
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${options.token}` }
      if (args.body !== undefined) headers["Content-Type"] = "application/json"
      const init: RequestInit = {
        method: args.method,
        headers,
        body: args.body === undefined ? undefined : JSON.stringify(args.body),
        redirect: "error",
        signal: timeout.signal,
      }
      if (options.insecureTLS === true) applyInsecureTls(init as unknown as Record<string, unknown>)

      const response = await fetchFn(url.toString(), init)
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`decision API HTTP ${response.status}: ${text.slice(0, 500)}`)
      }
      try {
        return text ? JSON.parse(text) as unknown : {}
      } catch (err) {
        throw new Error(`decision API returned non-JSON: ${String(err)}`)
      }
    } finally {
      timeout.cleanup()
    }
  }

  return {
    async createDecision(packet, callOptions) {
      const parsed = await requestJson({
        method: "POST",
        pathname: `/api/control/sessions/${encodeURIComponent(options.sessionId)}/decision`,
        body: packet,
        timeoutMs: postTimeoutMs,
        signal: callOptions?.signal,
      })
      if (!isRecord(parsed)) throw new Error("decision endpoint returned no decisionId")
      const decisionId = nonEmptyString(parsed.decisionId)
      if (!decisionId) throw new Error("decision endpoint returned no decisionId")
      return { decisionId }
    },
    async awaitDecision(decisionId, timeoutMs, callOptions) {
      return requestJson({
        method: "GET",
        pathname: `/api/control/decisions/${encodeURIComponent(decisionId)}/await`,
        query: { timeoutMs: String(Math.max(1, Math.floor(timeoutMs))) },
        timeoutMs: Math.max(1, Math.floor(timeoutMs)) + DECISION_AWAIT_ABORT_MARGIN_MS,
        signal: callOptions?.signal,
      })
    },
    async resolveSession(callOptions) {
      return requestJson({
        method: "POST",
        pathname: `/api/control/sessions/${encodeURIComponent(options.sessionId)}/decision-resolved`,
        body: {},
        timeoutMs: postTimeoutMs,
        signal: callOptions?.signal,
      })
    },
  }
}

function normalizeAwaitResponse(value: unknown): DecisionAwaitResponse {
  if (!isRecord(value)) throw new Error("decision await response is not an object")
  if (value.answered === true) return { answered: true, choice: value.choice, optionValue: value.optionValue }
  if (value.answered === false) {
    if (typeof value.viewers !== "number" || !Number.isFinite(value.viewers) || value.viewers < 0) {
      throw new Error("decision await response has invalid viewers")
    }
    return { answered: false, viewers: value.viewers }
  }
  throw new Error("decision await response has invalid answered flag")
}

interface DecisionHookDeadline {
  verdict: "deny-budget-expired" | "deny-self-deadline"
  reason: string
}

class DecisionHookDeadlineError extends Error {
  readonly deadline: DecisionHookDeadline

  constructor(deadline: DecisionHookDeadline) {
    super(deadline.reason)
    this.name = "DecisionHookDeadlineError"
    this.deadline = deadline
  }
}

async function callWithPolicyWatchdog<T>(input: {
  now: () => number
  startedAt: number
  budgetDeadline: number
  hardDeadline: number
  returnMarginMs: number
  run: (signal: AbortSignal) => Promise<T>
}): Promise<T> {
  const before = deadlineState(
    input.now(),
    input.startedAt,
    input.budgetDeadline,
    input.hardDeadline,
    input.returnMarginMs,
  )
  if (before) throw new DecisionHookDeadlineError(before)

  const controller = new AbortController()
  const limit = Math.min(input.budgetDeadline, input.hardDeadline)
  const delayMs = Math.max(0, Math.ceil(limit - input.now() - input.returnMarginMs))

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const deadline = deadlineState(
        input.now(),
        input.startedAt,
        input.budgetDeadline,
        input.hardDeadline,
        input.returnMarginMs,
      ) ?? deadlineForLimit(input.startedAt, input.budgetDeadline, input.hardDeadline)
      reject(new DecisionHookDeadlineError(deadline))
      controller.abort(new DOMException(deadline.reason, "TimeoutError"))
    }, delayMs)
  })

  try {
    return await Promise.race([input.run(controller.signal), deadlinePromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function deadlineForLimit(startedAt: number, budgetDeadline: number, hardDeadline: number): DecisionHookDeadline {
  if (hardDeadline <= budgetDeadline) {
    return {
      verdict: "deny-self-deadline",
      reason: "mobile approval hook self-deadline reached before Claude hook timeout; denying fail-closed",
    }
  }
  return {
    verdict: "deny-budget-expired",
    reason: `mobile approval timed out after ${formatDurationMs(budgetDeadline - startedAt)}; denying fail-closed`,
  }
}

function deadlineState(
  nowMs: number,
  startedAt: number,
  budgetDeadline: number,
  hardDeadline: number,
  returnMarginMs: number,
): DecisionHookDeadline | null {
  if (nowMs + returnMarginMs >= hardDeadline) {
    return {
      verdict: "deny-self-deadline",
      reason: "mobile approval hook self-deadline reached before Claude hook timeout; denying fail-closed",
    }
  }
  if (nowMs + returnMarginMs >= budgetDeadline) {
    return {
      verdict: "deny-budget-expired",
      reason: `mobile approval timed out after ${formatDurationMs(budgetDeadline - startedAt)}; denying fail-closed`,
    }
  }
  return null
}

function deny(verdict: Exclude<DecisionHookVerdict, "allow-passthrough" | "allow-approved">, reason: string, packet?: DecisionPacket): DecisionHookResult {
  return { output: decisionHookDenyOutput(reason), verdict, reason, packet }
}

function choiceAllows(choice: unknown): boolean {
  return typeof choice === "string" && ALLOW_CHOICES.has(choice.trim().toLowerCase())
}

function rejectedReason(choice: unknown, optionValue: unknown): string {
  const normalized = typeof choice === "string" && choice.trim() ? choice.trim() : "unknown"
  const option = typeof optionValue === "string" && optionValue.trim() ? ` (${optionValue.trim()})` : ""
  return `mobile reviewer did not approve (choice=${normalized}${option}); denying fail-closed`
}

function summarizeWrite(filePath: string, toolInput: Record<string, unknown>): string {
  const content = typeof toolInput.content === "string" ? `, ${toolInput.content.length} chars` : ""
  return `${filePath} — write${content}`
}

function summarizeEdit(filePath: string, toolInput: Record<string, unknown>): string {
  const oldLen = typeof toolInput.old_string === "string" ? toolInput.old_string.length : undefined
  const newLen = typeof toolInput.new_string === "string" ? toolInput.new_string.length : undefined
  const lengths = oldLen !== undefined && newLen !== undefined ? `, ${oldLen}→${newLen} chars` : ""
  const replaceAll = toolInput.replace_all === true ? ", replace_all" : ""
  return `${filePath} — edit${lengths}${replaceAll}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function positiveFinite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeFinite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function formatDurationMs(ms: number): string {
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rem = minutes % 60
  return rem > 0 ? `${hours}h${rem}m` : `${hours}h`
}

function timeoutSignal(timeoutMs: number, parentSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const abortFromParent = (): void => {
    controller.abort(parentSignal?.reason ?? new DOMException("decision API request aborted", "AbortError"))
  }
  const timer = setTimeout(() => {
    controller.abort(new DOMException("decision API request timed out", "TimeoutError"))
  }, Math.max(1, Math.floor(timeoutMs)))
  timer.unref?.()
  if (parentSignal?.aborted) {
    abortFromParent()
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      parentSignal?.removeEventListener("abort", abortFromParent)
    },
  }
}

function realSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}
