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
| Advisor | `gemini-3.7-flash` | high | Transcript-aware brainstorming/sounding board/fresh look |
| `oracle` | `claude-opus-5[1m]` | high | Stateless last-resort guidance |

All five catalog dependencies are mandatory. Startup fails with an actionable list rather than substituting a model or shipping a partial surface. Grok stays bare because its live limits are 500K total, 372K prompt, and 128K output.

### Plan workflow

Luna performs the repository legwork and drafts. The lead then gives `planner` a handcrafted evidence packet containing the goal, acceptance criteria, constraints, `file:line` and command/test evidence, settled decisions, the complete draft, and one focused question. `planner` returns `APPROVE`, `REVISE`, or `NEED_MORE_CONTEXT`; implementation waits for `APPROVE`.

`planner` has read/search tools only so it can verify a disputed citation or fill a narrow evidence gap. It does not edit or execute the plan. `reviewer` verifies implemented work by reading the repository and running the relevant checks.

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

Claude Code 2.1.245 supports `effort:` in custom-agent frontmatter, overriding the session picker. The four native fast agents use that field. Router-owned model aliases retain role provenance until the authenticated request boundary:

| Alias | Canonical model | Effort |
|---|---|---:|
| `gh-router-luna-driver-max` | Luna | max |
| `gh-router-luna-scout-high` | Luna | high |
| `gh-router-luna-implementer-max` | Luna | max |
| `gh-router-luna-sonnet-xhigh` | Luna | xhigh |
| `gh-router-luna-haiku-high` | Luna | high |

Authenticated fast policy overrides request effort and thinking budgets for the fixed role. Aliases are canonicalized before Copilot and rejected on standard/unbound traffic. `/v1/messages/count_tokens` applies the same launch identity, model, and effort preprocessing.

### Advisor

The user-facing role is Advisor. In fast Luna sessions it uses Gemini 3.7 Flash via chat completions at fixed high effort and sees the bounded recent transcript. It is suitable for brainstorming, a sounding board, a fresh look, uncertainty, or when stuck. Luna continuations reuse the translation shim and existing SSE lifecycle.

Standard Advisor behavior is unchanged: Sol/xhigh (high floor) on the normal Opus path and Opus escalation for lighter Claude leads.

## 1M context accounting

Claude Code locally recognizes the literal `[1m]` suffix. The proxy adds it only when the live catalog advertises at least 1M and strips it before upstream dispatch. `CLAUDE_CODE_DISABLE_1M_CONTEXT` remains a presence-based opt-out. Grok remains bare because its window is below 1M.

## Gateway picker

The gateway cache advertises live-catalog-present rows for Sol, Luna, Gemini 3.7 Flash, and Grok 4.6. Missing rows are omitted, not substituted. This picker inventory is global, but selecting a row does not change a launch profile’s roster or MCP scope.
