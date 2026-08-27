# Default models and fast profile

`github-router claude` defaults to `claude-opus-5`; `github-router codex` defaults to `gpt-5.6-sol`. Full model fallback and slug-translation behavior is implemented in `src/lib/port.ts` and `src/lib/utils.ts`.

## Standard launch

Plain `github-router claude` keeps the standard surface: Opus 5 lead, the full catalog-driven native roster, all normally gated MCP groups/personas, picker-controlled native effort, the standard Sol Advisor at xhigh with a high floor, and every existing hook/skill. Direct `-m gpt-5.6-luna` is also a standard launch. Fast behavior is never inferred from a resolved model id.

## Fast launch profile (`-m fast`)

Only the trimmed raw alias `fast` selects this profile. It is a Luna-led, role-specialized session with a narrow MCP surface and fixed per-role efforts.

| Surface | Model | Effort | Job |
|---|---|---:|---|
| Lead | `gpt-5.6-luna[1m]` | max | Primary working loop |
| `scout` | `gpt-5.6-luna[1m]` | high | Broad read-only repository discovery |
| `implementer` | `gpt-5.6-luna[1m]` | max | Approved mechanical implementation |
| `reviewer` | `grok-4.6` | medium | Repository-aware review/reproduction/tests |
| `planner` | `gpt-5.6-sol[1m]` | high | Plan consultant and approver after Luna drafts |
| `critic` | `gemini-3.7-flash[1m]` | medium | Fresh-context cross-lab challenge of plans, designs, diffs, or decisions |
| Advisor | `gemini-3.7-flash` | high | Transcript-aware brainstorming/sounding board/fresh look |
| `oracle` | `claude-opus-5[1m]` | high | Stateless last-resort guidance |

All five catalog models are mandatory, even though Gemini serves both the critic and Advisor. Startup fails with an actionable list rather than substituting a model or shipping a partial surface. Grok stays bare because its live limits are 500K total, 372K prompt, and 128K output.

### Plan workflow

Luna performs the repository legwork and drafts. The lead then gives `planner` a handcrafted evidence packet containing the goal, acceptance criteria, constraints, `file:line` and command/test evidence, settled decisions, the complete draft, and one focused question. `planner` returns `APPROVE`, `REVISE`, or `NEED_MORE_CONTEXT`; implementation waits for `APPROVE`.

`planner` has repository read/search/command tools so it can verify disputed citations or fill a narrow evidence gap. Its native delegation is ACL-scoped: it may call `reviewer`, `scout`, or `critic`, but no other subagent. `implementer` may call `reviewer` or `critic`; `reviewer`, `scout`, and `critic` are terminal. These Task/Agent edges are enforced by a fast-only PreToolUse hook. Planner's no-edit/no-plan-execution guidance and the lead's `APPROVE` gate remain prompt contracts, not a state machine. Bash remains a general execution primitive, so shell-launched nested processes are outside the in-session ACL.

### MCP and browser

Fast mode serves:

- `search`: `code` and `web`;
- `peers`: only `oracle`;
- `browser`: only when the existing `--browse`/installed-browser gates pass.

It hard-denies workers, orchestrate, decide, fleet, first-mate, standard peer critics, the coordinator, dispatcher agents, and related skills. `--codex-cli` is ignored with a visible note so it cannot widen the profile.

`oracle` is exact Opus 5 with native 1M context and high effort. Its schema is only required `query` and `context`; it receives no transcript, tools, images, continuation loop, or execution authority. Input over 256 KiB is refused rather than truncated.

### No Stop hooks

Fast mode injects no github-router Stop-lifecycle automation: no structural Stop gate, detached Stop/plan review, ExitPlanMode auto-review, artifact auto-open, or review UserPromptSubmit hook. One concise instruction replaces it: obtain `planner` approval before implementation; before declaring done, run the relevant build/tests and ask `reviewer` to verify.

Standard launches retain their hooks unchanged.

### Fixed effort and aliases

Claude Code 2.1.245 supports `effort:` in custom-agent frontmatter, overriding the session picker. The five native fast agents use that field. Router-owned model aliases retain role provenance until the authenticated request boundary:

| Alias | Canonical model | Effort |
|---|---|---:|
| `gh-router-luna-driver-max` | Luna | max |
| `gh-router-luna-scout-high` | Luna | high |
| `gh-router-luna-implementer-max` | Luna | max |
| `gh-router-fast-critic-medium` | Gemini 3.7 Flash | medium |
| `gh-router-luna-sonnet-xhigh` | Luna | xhigh |
| `gh-router-luna-haiku-high` | Luna | high |

Authenticated fast policy overrides request effort and thinking budgets for the fixed role. Aliases are canonicalized before Copilot and rejected on standard/unbound traffic. `/v1/messages/count_tokens` applies the same launch identity, model, and effort preprocessing.

### Context-window safety

Claude Code's `[1m]` marker unlocks local accounting against a 1,000,000-token **total** window, but Copilot enforces a smaller **prompt** ceiling that reserves output space: Luna 1.05M total / 922K prompt / 128K output, Opus 5 1M / 872K, Gemini 3.7 Flash 1M / 936K, Grok 4.6 500K / 372K. The client's own compaction threshold is `window - min(maxOutput, 20_000) - 13_000`, roughly 967K, which sits **above** both 1M-model ceilings. So a long session sends a request Copilot rejects before the client ever decides to compact.

The observed 2026-08-26 overflow was the top-level Luna lead (`isSidechain:false`), not a native subagent or `/responses/compact`: the session had reached about 919,814 input tokens before Copilot rejected the next `/responses` request. **This is not fast-specific** — the default standard-profile Opus 5 lead has the same 1M-vs-872K gap.

Every launch therefore presence-guards `CLAUDE_CODE_AUTO_COMPACT_WINDOW` with a **catalog-derived decimal integer** that puts the client's reactive trigger at 85% of the tightest prompt ceiling the launch can reach:

```
window = floor(min_reachable_max_prompt_tokens * 0.85) + 20_000 + 13_000
```

Luna-only reach gives `816700`; once the Opus 5 tier row is reachable its 872K ceiling binds and the value is `774200`. The derivation lives in `computeConservativeCompactionTrigger` / `deriveAutoCompactWindowTokens` (`src/lib/grok-context.ts`) and only `[1m]`-decorated candidates participate, since a bare row already budgets at the client's conservative 200K default. Missing or unusable catalog limits omit the variable entirely rather than export a guess.

Two properties make one launch-global value safe. The client resolves the variable as `Math.min(modelWindow, value)`, so it can only ever **lower** a window: Grok and Haiku 4.5 keep their own 200K and are unaffected, which is what retires the earlier objection to a global override. And the value **must be a plain decimal integer** — that env path uses `parseInt`, not the suffix-aware `/config` parser, so `"1m"` parses to `1`, is floored to the client's 100,000 minimum, and would compact a 1M session roughly every 52K tokens. A regression test pins the integer shape.

`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is deliberately **not** set: with an honest window the client's built-in reserves are already correct, and the percentage interacts with a separate 20% precompute buffer. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` was rejected as the lever because the client applies it only to ids that do not start with `claude-`, so it cannot fix the Opus 5 default lead. Operator-set values always win.

As the recovery half of the fix, the proxy maps an upstream overflow onto Claude Code's gateway capability-rejection contract — see [`gateway-error-contract.md`](gateway-error-contract.md).

### Advisor

The user-facing role is Advisor. In fast Luna sessions it is available only to the primary lead, uses Gemini 3.7 Flash via chat completions at fixed high effort by default, and sees the lead's bounded recent transcript. An operator model pin changes only the Advisor model, not this fast consultative policy. Fast Task subagents have all Advisor tool forms stripped; their narrower transcripts are not the session context Advisor exists to assess. Advisor is optional, non-binding consultation for consequential unresolved uncertainty, conflicting evidence, a genuinely non-converging approach, materially changed assumptions, or an explicit request for a fresh perspective. It is not used for routine progress, waiting, directly verifiable facts, planner approval, reviewer verification, or completion ritual. The lead retains decision ownership and may consult again when materially new evidence creates a different question. Luna continuations reuse the translation shim and existing SSE lifecycle.

Oracle remains separate and stateless. It is available to the lead, reviewer, and planner as a last resort for one focused unresolved question, and remains unavailable to scout and implementer. Fast launches keep the proxy MCP servers out of the shared mirrored config: the lead receives them through its launch-only MCP config, while reviewer/planner/scout receive only their role-scoped inline servers. This prevents the unrestricted implementer from inheriting Oracle through persistent MCP scope.

Standard Advisor behavior is unchanged: Sol/xhigh (high floor) on the normal Opus path and Opus escalation for lighter Claude leads.

## 1M context accounting

Claude Code locally recognizes the literal `[1m]` suffix. The proxy adds it only when the live catalog advertises at least 1M and strips it before upstream dispatch. `CLAUDE_CODE_DISABLE_1M_CONTEXT` remains a presence-based opt-out. Grok remains bare because its window is below 1M.

## Gateway picker

The gateway cache advertises live-catalog-present rows for Sol, Luna, Gemini 3.7 Flash, and Grok 4.6. Missing rows are omitted, not substituted. This picker inventory is global, but selecting a row does not change a launch profile’s roster or MCP scope.
