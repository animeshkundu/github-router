/**
 * Pure decision logic for the `UserPromptSubmit` hook (the front-end of the
 * floor-raising surface). It serves TWO duties on the one event:
 *
 *   1. Per-prompt budget reset — clears the Stop-gate's block counter for this
 *      session so `maxBlocks` is "per user prompt", not "per session lifetime"
 *      (the per-prompt scoping the Stop-gate relies on).
 *   2. Goal steer — for a NON-trivial prompt, inject an advisory GOAL directive
 *      (additive context, never blocking) pointing the model at `/gh-research`
 *      then `/gh-orchestrate`. It raises the prior; it does not force execution.
 *
 * Top-level only: like the Stop-gate, it stands down in a subagent/teammate
 * context (the payload carries `agent_type`/`agent_id` there) so it never
 * recurses into spawned workers. Fail-open and never blocking: any error or a
 * trivial prompt yields an empty injection.
 */

import { isSubagentContext } from "./stop-gate-policy"

/**
 * The advisory goal injected for a non-trivial prompt. Uses the skills' slash
 * invocation form. The model still decides whether to follow it; the Stop-gate
 * backstops correctness at the output end.
 */
export const PROMPT_STEER_GOAL =
  "GOAL (advisory): for a non-trivial task, FIRST run /gh-research on this ask to "
  + "information saturation — verify the load-bearing claims against the actual code "
  + "before planning, and do not plan or write code until research is saturated. THEN, "
  + "for an implementation or change task, run /gh-orchestrate to compose and run a "
  + "floor-raising workflow (it checkpoints before expensive work). Skip both for a "
  + "trivial ask; you may decline if they do not fit."

/**
 * Cheap, conservative complexity heuristic — a long prompt, an imperative
 * build/change verb, or an explicit multi-file scope. Trivial prompts get no
 * steer (no analysis-paralysis tax on quick asks).
 */
export function isNonTrivialPrompt(prompt: string): boolean {
  const p = prompt.trim()
  if (p.length === 0) return false
  if (p.length >= 280) return true
  const verb =
    /\b(implement|build|refactor|migrate|fix|debug|diagnose|design|add|create|rewrite|optimi[sz]e|integrate|architect|investigate|audit)\b/i
  if (verb.test(p)) return true
  // Multi-file / cross-cutting scope signal.
  return /\b(across|throughout|every|all)\b.*\b(file|module|test|route|component)s?\b/i.test(p)
}

export interface PromptSubmitDecision {
  /** Session whose Stop-gate block budget to reset (undefined = none). */
  resetSession?: string
  /** Text to print to stdout (added to the model's context). Empty = nothing. */
  inject: string
}

export function decidePromptSubmit(input: { stdin: string; steerEnabled: boolean }): PromptSubmitDecision {
  let payload: { session_id?: unknown; prompt?: unknown; agent_type?: unknown; agent_id?: unknown } = {}
  try {
    const p: unknown = JSON.parse(input.stdin)
    if (p && typeof p === "object") payload = p as typeof payload
  } catch {
    return { inject: "" }
  }
  // Top-level only: a subagent/teammate prompt gets neither reset nor steer.
  if (isSubagentContext(payload)) return { inject: "" }
  const decision: PromptSubmitDecision = { inject: "" }
  const sessionId = typeof payload.session_id === "string" && payload.session_id.length > 0 ? payload.session_id : ""
  if (sessionId) decision.resetSession = sessionId
  const prompt = typeof payload.prompt === "string" ? payload.prompt : ""
  if (input.steerEnabled && isNonTrivialPrompt(prompt)) decision.inject = PROMPT_STEER_GOAL
  return decision
}

// ─── UserPromptSubmit V2 (advisory: classify + grounded scope/goal) ──────────

/**
 * Static encouragement injected for a TRIVIAL prompt (no model call, no latency
 * tax): nudge parallel lexical+semantic search before concluding. Mirrors the v1
 * advisory tone — additive, never blocking.
 */
export const PROMPT_SEARCH_TIP =
  "TIP (advisory): when this task needs code context, search lexical + semantic in "
  + "parallel — one `mcp__search__code` call with mode:\"lexical\" and one with "
  + "mode:\"semantic\", issued in the same turn — before concluding."

/** System prompt for the single gpt-5.5 scope/goal inference. Steers a SHORT,
 *  user-derived (not invented) advisory note grounded in the search results. */
export const PROMPT_SCOPE_SYSTEM =
  "You are a scoping assistant for a coding agent about to act on a user's request. "
  + "You are given the user's request and the results of a lexical + semantic code search "
  + "over the relevant repository. Produce a SHORT advisory note (<= 120 words), plain text only:\n"
  + "1. SCOPE: one line — is this trivial, focused (one area), or large/cross-cutting — grounded in "
  + "what the search surfaced (reference the most relevant file(s) by name).\n"
  + "2. GOAL: restate the user's OWN ask as a single measurable objective, in THEIR terms. Do NOT "
  + "invent new requirements or acceptance criteria beyond what they asked.\n"
  + "3. Only if the task is large/cross-cutting, add a final line: \"Consider /gh-research first to "
  + "saturate understanding, then /gh-orchestrate to compose a floor-raising workflow.\" Omit it for a "
  + "focused or trivial task.\n"
  + "This is advisory — the agent decides whether to follow it. Be concrete and concise; no preamble."

/** Injected IO for V2, all best-effort. Each network call returns its text and
 *  never throws to the orchestrator (the orchestrator wraps the enrichment in a
 *  timeout + try/catch and falls open to the regex goal).
 *
 *  INVARIANT for live callers: each IO call MUST self-timeout (the live wiring
 *  passes a per-call timeoutMs to callMcpTool / callInference). The orchestrator's
 *  outer `timeoutMs` race only bounds how long it WAITS for a result before
 *  failing open — it does NOT abort the in-flight call. A non-self-timing-out IO
 *  would leave a socket open until the hook process's terminal `process.exit(0)`,
 *  which is the hard backstop but not a substitute for the per-call bound. */
export interface PromptSubmitV2IO {
  /** One `mcp__search__code` call; returns the raw result text ("" on failure).
   *  Receives the orchestrator's AbortSignal so a timed-out enrichment cancels
   *  the in-flight request (live callers thread it into the HTTP fetch). */
  searchCode: (query: string, mode: "lexical" | "semantic", signal?: AbortSignal) => Promise<string>
  /** One gpt-5.5 `/v1/responses` inference; returns assistant text ("" on failure).
   *  Receives the orchestrator's AbortSignal (see `searchCode`). */
  infer: (system: string, user: string, signal?: AbortSignal) => Promise<string>
  /** Pending advisory findings from the prior turn's background review. */
  readFindings: (sessionId: string) => Promise<string | null>
  clearFindings: (sessionId: string) => Promise<void>
  /** Stash this prompt so the next Stop review can judge the diff against it. */
  storePrompt: (sessionId: string, prompt: string) => Promise<void>
  /** Wall-clock budget for the substantive-prompt enrichment (search+infer);
   *  on overrun the decision falls open to the regex goal. Default 22s. */
  timeoutMs?: number
}

/** Max chars of each search-result blob fed into the scope inference. */
const SEARCH_CONTEXT_CAP = 6 * 1024

/** Wrap the prior-turn review findings in an explicitly NON-AUTHORITATIVE frame. */
function framePendingFindings(findings: string): string {
  return (
    "ADVISORY — independent review of your PREVIOUS change (NON-AUTHORITATIVE): an independent "
    + "gpt-5.5 reviewer flagged the following. Evaluate each on its merits — fix the real ones, and "
    + "ignore any wrong one with a one-line reason. You are NOT obligated to act on these.\n"
    + findings.trim()
  )
}

function joinSections(sections: Array<string>): string {
  return sections
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n")
}

/**
 * V2 decision: budget reset (via resetSession) + a grounded, user-derived scope
 * note + surfaced prior-turn findings. ASYNC and IO-driven, but every IO is
 * best-effort and the substantive enrichment is timeout-bounded with a fail-open
 * to the v1 regex goal — so this never blocks and never wedges the prompt.
 *
 *   - subagent/teammate  -> empty (top-level only, like v1).
 *   - findings           -> always surfaced (+ cleared) regardless of triviality.
 *   - trivial prompt     -> static search tip only (no model call).
 *   - substantive prompt -> parallel lexical+semantic search -> ONE gpt-5.5 call
 *                           -> grounded scope/goal note. Fail-open to PROMPT_STEER_GOAL.
 *   - steerEnabled=false -> findings only (no goal/tip).
 */
export async function decidePromptSubmitV2(input: {
  stdin: string
  steerEnabled: boolean
  io: PromptSubmitV2IO
}): Promise<PromptSubmitDecision> {
  let payload: { session_id?: unknown; prompt?: unknown; agent_type?: unknown; agent_id?: unknown } = {}
  try {
    const p: unknown = JSON.parse(input.stdin)
    if (p && typeof p === "object") payload = p as typeof payload
  } catch {
    return { inject: "" }
  }
  if (isSubagentContext(payload)) return { inject: "" }

  const decision: PromptSubmitDecision = { inject: "" }
  const sessionId = typeof payload.session_id === "string" && payload.session_id.length > 0 ? payload.session_id : ""
  if (sessionId) decision.resetSession = sessionId
  const prompt = typeof payload.prompt === "string" ? payload.prompt : ""

  // Stash the prompt for the next Stop review (best-effort, fire-and-await so a
  // slow disk doesn't matter — it's a tiny local write).
  if (sessionId) await input.io.storePrompt(sessionId, prompt).catch(() => {})

  // Read + clear any pending findings from the prior turn's background review.
  let findingsBlock = ""
  if (sessionId) {
    const pending = await input.io.readFindings(sessionId).catch(() => null)
    if (pending && pending.trim().length > 0) {
      findingsBlock = framePendingFindings(pending)
      await input.io.clearFindings(sessionId).catch(() => {})
    }
  }

  // steer disabled -> findings only.
  if (!input.steerEnabled) {
    decision.inject = findingsBlock
    return decision
  }

  // Trivial prompt -> static tip only, no model call.
  if (!isNonTrivialPrompt(prompt)) {
    decision.inject = joinSections([PROMPT_SEARCH_TIP, findingsBlock])
    return decision
  }

  // Substantive prompt -> grounded enrichment, timeout-bounded + fail-open.
  const timeoutMs = input.io.timeoutMs ?? 22_000
  let goal = PROMPT_STEER_GOAL // fail-open default.
  let timer: ReturnType<typeof setTimeout> | undefined
  // One controller cancels BOTH search calls + the inference when the race ends
  // (timeout OR success), so a lost-race fetch never keeps the short-lived hook
  // process alive past its decision. Aborting after success is a harmless no-op.
  const controller = new AbortController()
  try {
    const enrich = (async (): Promise<string> => {
      const [lexical, semantic] = await Promise.all([
        input.io.searchCode(prompt, "lexical", controller.signal).catch(() => ""),
        input.io.searchCode(prompt, "semantic", controller.signal).catch(() => ""),
      ])
      const searchContext =
        `Lexical search results:\n${lexical.slice(0, SEARCH_CONTEXT_CAP)}\n\n`
        + `Semantic search results:\n${semantic.slice(0, SEARCH_CONTEXT_CAP)}`
      const note = await input.io.infer(
        PROMPT_SCOPE_SYSTEM,
        `USER REQUEST:\n${prompt}\n\n${searchContext}`,
        controller.signal,
      )
      return note.trim()
    })()
    // Mark `enrich` handled so a post-race rejection (e.g. the inference aborting
    // after the timeout already won) can't surface as an unhandled rejection.
    enrich.catch(() => {})
    // The timer is cleared in `finally` (so when `enrich` wins, no live timer
    // lingers for the rest of `timeoutMs`).
    const raced = await Promise.race<string | "__timeout__">([
      enrich,
      new Promise<"__timeout__">((resolve) => {
        timer = setTimeout(() => resolve("__timeout__"), timeoutMs)
      }),
    ])
    if (raced !== "__timeout__" && raced.length > 0) goal = raced
  } catch {
    // keep the fail-open regex goal.
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
  }

  decision.inject = joinSections([goal, findingsBlock])
  return decision
}

/**
 * Build the shell command Claude Code runs for the `UserPromptSubmit` hook —
 * the running github-router via its node/bun binary so it works regardless of
 * PATH. Mirrors `buildStopHookCommand`.
 */
export function buildPromptSubmitHookCommand(execPath: string, scriptPath: string | undefined): string {
  const q = (s: string): string => `"${s}"`
  if (scriptPath && scriptPath !== execPath) {
    return `${q(execPath)} ${q(scriptPath)} internal-prompt-submit`
  }
  return `${q(execPath)} internal-prompt-submit`
}
