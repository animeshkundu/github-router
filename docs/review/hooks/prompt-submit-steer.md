# Hook 1: `UserPromptSubmit` steer

## 1. Identity

| Field | Value |
|---|---|
| Event | `UserPromptSubmit` (no matcher, fires on every user prompt) |
| Executable | `github-router internal-prompt-submit` (`src/internal-prompt-submit.ts`) |
| Decision logic | `decidePromptSubmit` (v1) / `decidePromptSubmitV2` (v2) in `src/lib/orchestration/prompt-submit-hook.ts` |
| Gate | `workerToolsEnabled()` (`src/claude.ts:670`) |
| Registration | `src/claude.ts:681-686`, host `timeout` 45s |
| Opt-out | `GH_ROUTER_DISABLE_PROMPT_STEER=1` (`src/internal-prompt-submit.ts:87`) |
| Blocks the turn? | No, always exit 0; stdout is added to the model's context |

Two duties on one event: (1) reset the Stop-gate's per-session block budget so `maxBlocks` is per-prompt not per-session (`src/internal-prompt-submit.ts:128-133`); (2) inject advisory steer text. The V2 path is used when the proxy URL/nonce is wired (`hookMcpRuntimeFromEnv()` truthy, `:88-91`); otherwise it falls open to the pure v1 regex path (`:123-125`).

## 2. Model-facing text (verbatim)

Four distinct strings can be injected, depending on the branch.

### 2a. `PROMPT_STEER_GOAL`: non-trivial prompt (v1 path, and v2 fail-open default): `prompt-submit-hook.ts:25-31`

> GOAL (advisory): for a non-trivial task, FIRST run /gh-research on this ask to information saturation — verify the load-bearing claims against the actual code before planning, and do not plan or write code until research is saturated. THEN, for an implementation or change task, run /gh-orchestrate to compose and run a floor-raising workflow (it checkpoints before expensive work). Skip both for a trivial ask; you may decline if they do not fit.

### 2b. `PROMPT_SEARCH_TIP`: trivial prompt (v2 path): `prompt-submit-hook.ts:81-84`

> TIP (advisory): when this task needs code context, search lexical + semantic in parallel — one `mcp__search__code` call with mode:"lexical" and one with mode:"semantic", issued in the same turn — before concluding.

### 2c. `PROMPT_SCOPE_SYSTEM`: the gpt-5.5 scope-inference system prompt (non-trivial, v2): `prompt-submit-hook.ts:88-99`

Not injected into the model directly; it steers a single gpt-5.5 call whose OUTPUT (a <=120-word grounded scope/goal note) is injected. It instructs the scoping model to restate the user's own ask as one measurable objective, reference the most relevant files by name, and NOT invent new requirements. It adds the `/gh-research` + `/gh-orchestrate` line only when the task is large/cross-cutting.

### 2d. `framePendingFindings`: prior-turn review findings wrapper (v2): `prompt-submit-hook.ts:133-140`

> ADVISORY — independent review of your PREVIOUS change (NON-AUTHORITATIVE): an independent gpt-5.5 reviewer flagged the following. Evaluate each on its merits — fix the real ones, and ignore any wrong one with a one-line reason. You are NOT obligated to act on these.

## 3. Firing logic

- Fires on EVERY user prompt (no matcher). Stands down immediately on a subagent/teammate payload (`decidePromptSubmitV2`, `:174`).
- Budget reset always happens when a `session_id` is present (`:177-178`), independent of triviality.
- Prior-turn findings are read + cleared and surfaced regardless of triviality (`:186-193`).
- Triviality split via `isNonTrivialPrompt` (`:38-47`): true if the prompt is >=280 chars, matches a build/change verb regex (`implement|build|refactor|migrate|fix|debug|…`), or a multi-file scope phrase.
  - **Trivial** → static `PROMPT_SEARCH_TIP` only, no model call (`:202-205`).
  - **Non-trivial** → parallel lexical+semantic `mcp__search__code` (limit 10) → one gpt-5.5 `/v1/responses` call at effort `low` → grounded scope note; the whole enrichment is timeout-bounded (22s default, per-call 8s search / 18s infer) with a fail-open to `PROMPT_STEER_GOAL` (`:207-248`).
- `steerEnabled=false` (opt-out) → findings only, no goal/tip (`:196-199`).

## 4. Firing-appropriateness verdict

**Mixed: correct on the enrichment axis, over-fires on the static tip.**

- The BUDGET RESET firing on every prompt is correct: it is the mechanism that makes the Stop gate's block budget per-prompt, and it is cheap (a local file unlink).
- The MODEL-CALL enrichment is correctly gated to non-trivial prompts (`isNonTrivialPrompt`), so a `git commit -m fix` pays no gpt-5.5 latency. Good.
- The STATIC `PROMPT_SEARCH_TIP` OVER-FIRES: it is injected on every trivial prompt (`:203`), including purely conversational ones ("yes", "thanks", "what did that do?") that will never touch code. It costs no network latency, but it spends the model's context window and attention on a non-sequitur nudge for a turn where searching code is irrelevant.
- **What should fire instead:** the trivial branch should suppress the tip on prompts that plausibly need no code context. A one-line bounded classifier (fail-open: on any doubt, keep the tip) or even a cheap heuristic (skip the tip for prompts under ~15 chars or matching a pure-acknowledgement pattern) would remove the noise without a network call.

## 5. Injected-text quality (5a)

- **Descriptive not coercive:** strong. Every string is tagged `(advisory)` / `NON-AUTHORITATIVE`, uses "you may decline", "evaluate each on its merits", "ignore any wrong one". This is the right register for injected context and matches the monotone design intent: the text explicitly refuses to coerce.
- **No over-trigger imperatives:** the goal uses `FIRST … THEN …` sequencing with an explicit "Skip both for a trivial ask" escape. It does contain one hard "do not plan or write code until research is saturated": a firm imperative, but scoped to "a non-trivial task" and softened by the trailing decline clause. Acceptable, borderline; a reviewer wanting maximum restraint would soften "do not … until saturated" to "prefer to saturate research before planning".
- **Conditional / when-to-use framing:** strong throughout: "for a non-trivial task", "for an implementation or change task", "when this task needs code context", "Only if the task is large/cross-cutting".
- **Right thing / right amount:** the non-trivial goal is well-sized. The `PROMPT_SEARCH_TIP` is the wrong AMOUNT on conversational turns (see §4). The findings frame is well-calibrated: it hands the model full authority to reject a wrong finding.

## 6. Intelligent-hook analysis

This hook is ALREADY the closest thing in the suite to the intelligent-hook pattern: a deterministic trigger (every prompt) + a bounded-inference gate (the 22s-bounded gpt-5.5 scope call) that decides how much context to add, with a fail-open to the regex goal. It honors all four non-negotiables: fail-open on timeout/error, advisory phrasing, bounded latency, widen-not-narrow (it only adds context).

The one gap the pattern would close: extend the bounded gate to the TRIVIAL branch. Today triviality is a pure regex heuristic and the trivial path emits a fixed tip. A cheap classify ("does this prompt need code grounding at all"): or simply not emitting the tip when the enrichment is skipped for a genuinely conversational prompt: would make the "right amount" hold on the low end too. This must stay fail-open (default to keeping the tip) so a misclassification never suppresses genuinely useful context.

## 7. Findings

- **[Important] `PROMPT_SEARCH_TIP` over-fires on conversational trivial prompts.** `prompt-submit-hook.ts:202-205` injects the search tip on every non-empty trivial prompt, including acknowledgements and questions that never touch code. Fix: gate the tip behind a cheap "needs-code-context" check (fail-open to keeping it), or suppress it for pure-acknowledgement / very-short prompts. Low cost, but it is context noise on the exact turns where it is irrelevant.
- **[Suggestion] Soften the one hard imperative in `PROMPT_STEER_GOAL`.** `prompt-submit-hook.ts:28` "do not plan or write code until research is saturated" is the only coercive clause in an otherwise advisory-framed goal. Consider "prefer to saturate research before planning" to keep the whole steer in the advisory register.
- **[Suggestion] The v1 fallback goal and the v2 grounded note can both be present.** When the enrichment times out, `goal` stays `PROMPT_STEER_GOAL` and is joined with findings (`:250`): correct. No defect, but worth a test asserting the fail-open path injects exactly the regex goal (the design doc's stated contract).

**Verdict:** Firing is mostly right and the text is well-calibrated for advisory injection; the one real fix is gating the static search tip so it stops firing on conversational trivial prompts.
