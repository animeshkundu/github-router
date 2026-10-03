import type { InjectedSkill } from "./index"

/**
 * User-only on-demand cheapest rebrief (`/gh-rebrief`).
 *
 * `disable-model-invocation: true` keeps the description OUT of the model
 * context (no auto-trigger, no listing tax on the 200K Luna window); the user
 * invokes it explicitly when Luna drifts, loops, or contradicts earlier
 * decisions. The body runs the deterministic `internal-rebrief` binary, which
 * reuses the Sol → Luna rewrite with a 4K extractive session excerpt.
 */
export function buildRebriefSkill(
  searchEnabled?: boolean,
  bluebirdEnabled: boolean = false,
): InjectedSkill {
  const semanticAvailable = (searchEnabled ?? false) || bluebirdEnabled
  const searchLine = bluebirdEnabled
    ? "Grounding uses Bluebird semantic + lexical code search (failures stay visible, no local fallback)."
    : semanticAvailable
      ? "Grounding uses local lexical + semantic code search in parallel."
      : "Grounding uses lexical code search only (no semantic backend this launch)."
  return {
    name: "gh-rebrief",
    md: `---
name: gh-rebrief
description: Produces a course-corrected prompt for Luna on the user's current ask: Sol grounds the original ask, done-so-far digest, and transcript tail, then frames the next step for Luna to execute. Use when the session has drifted, Luna loops, or the user wants to restate what done means. Requires an explicit refined ask: /gh-rebrief "<ask>".
user-invocable: true
disable-model-invocation: true
argument-hint: "[optional refined ask]"
allowed-tools: Bash, Read
---

# gh-rebrief: on-demand cheapest re-brief

Use this skill when the user types /gh-rebrief, optionally with a refined ask.
It re-runs the cheapest Sol rewrite mid-session with compressed recent context.
It is user-invoked only and never fires automatically.

${searchLine}

## Operating contract

- Objective: produce a short grounded EXECUTION BRIEF for the current ask with recent-transcript signal.
- The user's request (or the refined $ARGUMENTS ask) is authoritative; the brief is advisory counsel.
- Never replace or truncate the user prompt; the brief is additive context.
- Never read a full transcript into context; the binary supplies a 4K extractive excerpt.

## Procedure

1. Require $ARGUMENTS as the refined ask. If it is empty, tell the user to pass /gh-rebrief "<ask>" — do not run the command.
2. Run the deterministic command (bounded: up to 2 Sol medium calls + one Luna summary, ≤30s).
   Pass the ask verbatim — do not interpret shell metacharacters in it, and
   never add flags of your own (the command takes --ask only):
   GH_ROUTER_REBRIEF_USER_INVOKED=1 github-router internal-rebrief --ask "$ARGUMENTS"
3. Treat stdout as the advisory brief: INTENT, GROUNDING, CONSTRAINTS, VERIFY, OPEN QUESTIONS.
4. Verify load-bearing file:line cites with a direct Read before acting on them.
5. If the binary refuses (non-cheapest profile), use /gh-research instead.

## Return format

- Brief pointer: paste the returned EXECUTION BRIEF block (it is already capped).
- Staleness: note when the transcript was truncated ([TRUNCATED] marker present).
- Residuals: carry forward OPEN QUESTIONS verbatim; never fabricate answers.

## Non-goals

- Do not invoke without the user typing /gh-rebrief.
- Do not run in a forked subagent; the binary needs the session transcript path.
- Do not paste full file contents or the whole transcript.
- Do not prescribe step-by-step procedure; give facts, constraints, and the check.
`,
  }
}

export const REBRIEF_SKILL = buildRebriefSkill(true)
