# Hook V2 (final, after two 3-lab reviews): deterministic gate + advisory-only cross-lab review

## Context

PR #69 shipped v1 hooks: the **Stop** hook is a deterministic executable gate (sealed `typecheck`/`test`/`lint` + baseline isolation); **UserPromptSubmit** is a regex heuristic + static goal + budget reset. v1 catches *regressions* but not **wrong-spec** or **vacuous tests**. V2 adds a cross-lab gpt-5.5 review to surface those — **as advisory information only.**

Two rounds of 3-lab adversarial review (gpt-5.5 + gemini-3.1-pro + opus) killed every *blocking* variant: a blocking LLM reviewer is **not monotone** (a confident-wrong or wrong-asserting test coerces Claude into degrading correct code under compliance pressure; the contest valve is rendered by the accused and loses), an executable-repro "deterministic block" is really LLM-reported-not-hook-verified, `worker_test worktree:true` reviews **stale HEAD** not the uncommitted diff, diff-hash debounce never fires (every stop has a new diff), and a 30-min synchronous hook fires on ~every substantive stop. The monotone design the reviews converge on, and the chosen one: **the deterministic gate is the only blocker; the LLM review never blocks — it informs.**

## Why this is monotone and safe

- The **deterministic gate** (regressions) is the *only* hard blocker — unchanged from v1, the proven floor.
- The **LLM review never blocks** → no coerced degradation, no split-brain deadlock, no host-timeout wedge.
- It runs **read-only on the live working tree** (`worker_review`, not `worker_test`) → it sees the *actual* uncommitted diff (no worktree-fidelity bug), mutates nothing, and never executes diff-supplied scripts.
- Findings are **non-authoritative**: Claude evaluates them (fix real ones, ignore wrong ones with no penalty); **you** are the accountability backstop via a findings log. Cross-lab review still happens on every substantive change — the accountability is preserved, the floor risk is gone.

## Stop hook V2 (advisory)

1. **No diff → nothing.**
2. **Deterministic sealed checks — the only hard blocker** (v1, unchanged): run first, baseline-isolated, a regression blocks **unconditionally** (not budgeted, not fail-open). This is the floor.
3. **If green + a substantive diff** (debounced so the identical tree isn't re-reviewed) → spawn a **detached, background `mcp__workers__review`** (read-only gpt-5.5) over the **live working tree** + the diff + the plan/docs + the **user's actual prompt(s)** + the raw `transcript_path` pointer (untrusted data). It surfaces advisory findings on **wrong-spec / vacuous-tests / incompleteness** and writes them to a per-session findings file. **The Stop hook returns exit 0 immediately** — it never waits and never blocks (so the 30-min concern is moot; the review finishes in the background under the worker engine's own wall-clock cap).
4. **Findings surface two ways**: (a) to **you** as an accountability log/notification; (b) injected on the **next `UserPromptSubmit`** as explicitly **NON-AUTHORITATIVE** advisory ("an independent gpt-5.5 reviewer of your last change noted X — evaluate; fix the real ones, ignore wrong ones with a one-line reason"). Claude is never coerced.
5. **Cost-bounded + on by default**: debounce by diff-hash + a per-task review budget; opt-out `GH_ROUTER_DISABLE_STOP_REVIEW=1` (keep the deterministic gate, drop the LLM layer) / `GH_ROUTER_DISABLE_STOP_GATE=1` (whole gate). No synchronous tax — the turn ends immediately; only background tokens are spent.

## UserPromptSubmit hook V2

1. **Budget reset** (for the deterministic gate, kept).
2. **Cheap classify first** — a trivial prompt gets only the static "search lexical+semantic in parallel before concluding" encouragement (+ any pending review findings) and returns. No model call, no latency tax on `git commit -m fix`.
3. **Substantive prompt → parallel lexical + semantic `code_search`** → **one gpt-5.5 inference call** (a single call, NOT a worker) over the **prompt + search results** → scope assessment + a goal **restated in the user's own terms** (user-derived, measurable — NOT a divergent synthesized AC) + a strong `/gh-research` + `/gh-orchestrate` nudge when scope is large. Inject that + the search grounding.
4. **Surface pending advisory findings** from the prior turn's background review here (the channel that brings the Stop review's notes back to Claude, non-authoritatively).
5. **No persisted/enforced AC.** Fail open to the v1 regex heuristic on any model/search error/timeout; keep the hook well under its timeout (the `UserPromptSubmit` command-hook default is 30s — raise via the hook's `timeout` field only as needed, fail-open on overrun).

## Honest residuals

- **Advisory has no enforcement** — Claude can ignore findings; the **user** is the backstop (the log). This is the deliberate trade for monotonicity (teeth were shown to cost the floor).
- **Next-turn delivery** — background findings surface on the next prompt; if there is no next turn, they live only in the log.
- **Vacuous-test detection from read-only inspection is weak** without execution-coverage data — feeding the reviewer coverage/mutation data is a future upgrade.
- **Cost** — a background gpt-5.5 review per substantive stop, bounded by debounce + the per-task budget.

## Shipped-skill optimizations (fold into this PR)

Two small `gh-orchestrate` SKILL.md edits (the drift test still guards tool names; `gh-research` is already well-parallelized and needs only a one-line "issue the parallel calls in a single turn" nudge):

1. **`decompose` ∥ `plan`** — Phases 3 and 4 are independent (`mcp__workers__plan` is called with the ask + AC + research pointer + blind-spot table, NOT the decompose IR), so fire them as one **parallel batch** instead of serially.
2. **pipeline-by-default Workflow composition** — Phase 5 must state: **default to `pipeline()`; use `parallel()` ONLY at a genuine barrier** (a stage needing all prior results). Without it the composed Workflows over-serialize at run time.

## Files (implementation)

- `src/lib/orchestration/stop-review.ts` (new) — the advisory review: the detached background `worker_review` invocation (read-only, live tree, gpt-5.5), context assembly (diff + plan + user prompt + transcript pointer), the per-session findings store, debounce by diff-hash, per-task budget. Pure-where-possible + a thin spawn wrapper.
- `src/lib/orchestration/stop-gate-hook.ts` — after the green deterministic pass, kick the background review (never blocks) and return; deterministic regression path unchanged (unconditional block).
- `src/lib/orchestration/prompt-submit-hook.ts` — cheap-classify gate, parallel `code_search`, the single gpt-5.5 scope/goal call (fail-open to the regex path), search-grounding injection, and surfacing pending review findings. No AC persistence.
- `src/internal-stop-hook.ts` / `src/internal-prompt-submit.ts` — wire the new stages; keep the always-exit-0 / fail-open wrappers.
- `src/claude.ts` — `GH_ROUTER_DISABLE_STOP_REVIEW` flag; possibly raise the `UserPromptSubmit` hook `timeout`; no other launcher change (hooks already registered).
- `src/lib/injected-skills/orchestrate-skill.ts` — the two optimizations; `research-skill.ts` — the one-line single-turn-parallel nudge.
- Tests (different-lab author): the deterministic-regression-still-unconditional invariant, the review-never-blocks invariant (Stop always exit 0 regardless of findings), debounce, findings-store round-trip + next-turn surfacing, the prompt-hook cheap-classify + fail-open, no-AC-store. Plus a fresh cross-lab review of the implementation before merge.

## Verification

End-to-end: (a) a real regression blocks via the deterministic pass; (b) a green change still ends the turn **immediately** (exit 0) while the advisory review runs in the background; (c) the review's findings surface on the next prompt as non-authoritative + in the log, and Claude can ignore a wrong one with no penalty; (d) a model-unavailable review is a silent no-op (no wedge, deterministic gate unaffected); (e) a refactor doesn't pay a synchronous tax at any stop; (f) UserPromptSubmit: a trivial prompt is instant, a substantive one injects a user-derived goal + grounding + any pending findings.
