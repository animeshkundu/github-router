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
