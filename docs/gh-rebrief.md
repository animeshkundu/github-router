# `/gh-rebrief` — on-demand cheapest re-brief

User-only escape hatch for `-m cheapest` sessions that have drifted past the
first-prompt rewrite. Sol consults over the original ask, done-so-far digest,
transcript tail, repo context, and the **current** user prompt — then hands
Luna a `<course_correction>` framing it executes.

## When to use

- Luna loops, contradicts earlier decisions, or loses what "done" means.
- You restated the ask and want a course-corrected, grounded next ask without restarting.
- Post-review resume: prior-turn findings + fresh grounding in one block.

Non-cheapest profiles: use `/gh-research` instead (the binary refuses and
says so — rebrief reuses the cheapest Sol/medium identity).

## What it does

```
User types /gh-rebrief <refined ask>            # --ask is REQUIRED, else refuse + no spend
  → GH_ROUTER_REBRIEF_USER_INVOKED=1 github-router internal-rebrief --ask "..."
  → static pack (AGENTS.md/CLAUDE.md closest-first + structure + VERIFY COMMAND)
   + done-so-far (deterministic digest + one concise Luna consult, <=2K)
   + 4K session context (extractive transcript tail, untrusted data)
   + grounding code search (lexical + semantic when enabled)
  → same adaptive loop as the first-prompt rewrite: one gpt-5.6-sol/medium
    inference, extended to a second ONLY when Sol flags needs_deep_grounding
    + names a follow-up query, <=30s wall-clock
  → <course_correction> framing for Luna (outcome, done_so_far, grounding,
    constraints, success_criteria, next_action, open_questions)
```

- Never replaces the user prompt; the framing is additive context.
- Always exits 0 (fail-open to the regex goal + search tip + prior findings).
- No per-session invocation cap: every invoke is explicit, self-bounded, and user-driven.
- Findings surface regardless (prior-turn review is never gated).

## The 4K context policy

Extractive only (CliffCompaction / Paritok-4B rule): select verbatim spans,
never rephrase; never compact-a-compaction (each run reads the live tail).
Priority: original ask pinned verbatim > refined ask / last assistant brief >
error tool results > Task/Agent/WebFetch summaries > last turns raw >
file:line cites. Bulk `Write`/`Edit` inputs collapse to path+size markers.
`[TRUNCATED: N excerpt(s) omitted]` marks budget cuts. Cap: 4K tokens
(~16K chars) vs the 24K advisor default.

## Invocation control

`disable-model-invocation: true` + `user-invocable: true`: the skill is
hidden from the model context (no auto-trigger, no listing tax on the 200K
Luna window) and appears in the user's `/` menu. Defense in depth, not a
sandbox: the binary additionally refuses without
`GH_ROUTER_REBRIEF_USER_INVOKED=1` (default-on; opt out with
`GH_ROUTER_REBRIEF_REQUIRE_USER_INVOKED=0`), which the skill wrapper always
sets. Residual: the marker is env-settable, so a model that guesses the
binary name *and* sets the marker can still spend — bounded per invoke to
≤2 Sol calls + 1 Luna summary, with no per-session cap by product decision
(each invoke is user-triggered and self-bounded). Luna may *suggest*
`/gh-rebrief` when stuck but cannot run it through the skill surface.

The binary takes `--ask` only. Session id, transcript path, and workspace
come exclusively from the hook payload stdin — there are no path/session
overrides, so one session can never read or clear another's findings.

For the skill-invoked Bash path the UserPromptSubmit hook refreshes a
per-workspace binding (`stopReviewStateDir()/rebrief-binding-<sha(cwd)>.json`,
fields: sessionId + transcriptPath + cwd + atMs, 24h TTL) on EVERY prompt;
`internal-rebrief` reads that binding when stdin carries no payload, so the
transcript tail / done digest are the live session even though the skill
spawns the command with no hook input. If the binding is missing or stale
(e.g. first launch before any prompt was submitted), the consult still runs
on static-pack + search facts, with transcript context simply empty.

`$ARGUMENTS` is interpolated as text by the skill runner, not re-escaped for
a shell — the command receives its argv directly via citty, so quotes/spaces
in the ask are preserved; instruct the model composing the Bash call to pass
the ask verbatim.

## Cost

Per invoke: ≤2 Sol/medium calls (extension only on Sol's explicit
`needs_deep_grounding` flag + named follow-up) + 1 concise Luna summary +
grounding search, ≤30s wall-clock. No per-session cap; same model identity
as the first-prompt rewrite and cheapest advisor.
Opt out entirely: `GH_ROUTER_DISABLE_CHEAPEST_REWRITE=1`.
