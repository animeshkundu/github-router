# Default models and fast profile

`github-router claude` defaults to `claude-opus-5`; `github-router codex` defaults to `gpt-5.6-sol`. Full model fallback and slug-translation behavior is implemented in `src/lib/port.ts` and `src/lib/utils.ts`.

## Max launch profile (`-m max`)

Only the trimmed raw alias `max` selects this profile. It starts on
`gpt-5.6-sol[1m]` at high effort and accepts controlled lead switches only among
Sol, Luna, Gemini 3.7 Flash, and Opus 5. Grok 4.6 is not a Max lead or picker
row because its advertised context is below 1M.

Max emits the native roles `Explore`, `Plan`, `general-purpose`, `implementer`,
`reviewer`, `brainstorm`, and `peer-review-coordinator`. Their assignments are
Luna/high, Sol/high, Luna/max, Gemini 3.7 Flash/high, Grok 4.6/high with exact Luna 1M/max fallback (no Gemini reviewer fallback),
Grok/medium with Gemini fallback, and Luna/max. Max peer MCP names are
`sol_critic`, `luna_reviewer`, optional `opus_critic`, Gemini critic/reviewer,
and Grok critic/reviewer when their catalog capabilities are usable.

Claude Code's public Agent schema requires a built-in `sonnet|opus|haiku|fable`
model value even for a custom agent whose frontmatter already pins its model.
The Max PreToolUse guard treats those four values only as schema placeholders
and strips them before dispatch, so the role's fixed frontmatter model wins.
Clients able to send catalog ids may explicitly override only to Luna 1M,
Gemini 3.7 Flash 1M, or bare Grok 4.6; Sol and Opus remain unavailable as native
subagent overrides. Grok remains rejected for lead traffic, while authenticated
max subagent requests may use it at their role effort. Max Advisor is optional,
non-binding counsel for a focused consequential uncertainty that direct evidence,
Plan, reviewer, or peers cannot settle. It is not a supervisor, approver, or
routine pre-work/completion gate; the lead keeps decision ownership and consults
again only when materially new evidence creates a different question.

Max's injected guidance presents its tools and roles as complementary affordances,
not a mandatory Explore → Plan → implement → review pipeline. It gives the lead
scope, capability, and evidence hints while leaving the reasoning and tool sequence
to the model. Hard constraints such as model allowlists, tool access, read-only
roles, and profile boundaries stay in code. Small or obvious tasks may be handled
directly; independent subagents and cross-family peers are useful when they improve
context isolation, latency, or coverage of a consequential uncertainty. Success is
measured by the resulting code, evidence, and checks, not by how many agents ran.

On every retained max
surface that would otherwise choose Gemini 3.1 Pro, max instead chooses Grok
4.6/high when usable and falls back to Gemini 3.7 Flash 1M/high. This includes
`stand_in` and first-mate model pins; persisted first-mate intent remains
unchanged and the max replacement is derived again at dispatch. Standard and
fast keep their existing resolvers. Injected max guidance treats each configured role model as the
intentional default and tells the lead to override only after a concrete failure
or task-model mismatch, never speculatively.

Max exposes search, optional browser control, browse-only workers, optional
stand-in, fleet, and first-mate surfaces. It never exposes orchestration or core
worker modes, and it does not inject `/gh-research`, `/gh-orchestrate`,
`/gh-floor-keeper`, or `/gh-worker`. First-mate operator skills remain conditional
on the first-mate capability. Advisor is lead-only and defaults to Opus 5/high
over native Messages; `GH_ROUTER_ADVISOR_MODEL=gpt-5.6-sol` selects Sol instead. Native
subagents and browse workers do not receive Advisor. Max rejects `--codex-cli`,
`--no-codex-mcp`, and arbitrary lead models before creating launch artifacts.

The picker cache is restricted to Sol, Luna, Gemini 3.7 Flash, and Opus 5, with
`[1m]` attached only when the live catalog advertises at least 1M context. The
existing catalog-derived `CLAUDE_CODE_AUTO_COMPACT_WINDOW` formula remains the
source of truth across every reachable Max `[1m]` model.

## Standard launch

Plain `github-router claude` keeps the standard surface: Opus 5 lead, the full catalog-driven native roster, all normally gated MCP groups/personas, picker-controlled native effort, the standard Sol Advisor at xhigh with a high floor, and every existing hook/skill. Direct `-m gpt-5.6-luna` is also a standard launch. Fast behavior is never inferred from a resolved model id.

## Fast launch profile (`-m fast`)

Only the trimmed raw alias `fast` selects this profile. It is a Luna-led, role-specialized session with a narrow MCP surface and fixed per-role efforts.

| Surface | Model | Effort | Job |
|---|---|---:|---|
| Lead | `gpt-5.6-luna[1m]` | max | Primary working loop |
| `Explore` | `gpt-5.6-luna[1m]` | high | Broad read-only repository discovery |
| `Plan` | `gpt-5.6-sol[1m]` | high | Implementation planning consultant (non-mandatory gate) |
| `general-purpose` | `gpt-5.6-luna[1m]` | max | Fast, economical catch-all for mixed/unusual work |
| `implementer` | `gemini-3.7-flash[1m]` | high | Bounded coding implementation |
| `reviewer` | `grok-4.6` | medium | Repository-aware review/reproduction/tests |
| Advisor | `gemini-3.7-flash` | high | Transcript-aware brainstorming/sounding board/fresh look |
| `oracle` | `claude-opus-5[1m]` | high | Stateless last-resort guidance (lead & Plan only) |

All required catalog models are mandatory. Startup fails with an actionable list rather than substituting a model or shipping a partial surface. Grok stays bare because its live limits are 500K total, 372K prompt, and 128K output. There is no separate `critic` subagent in Fast; Gemini 3.7 Flash serves the native `implementer` role at high effort.

### Planning and delegation workflow

Fast mode structures delegation as complementary affordances (a menu of capabilities), not an inflexible Explore → Plan → implement → review assembly line. The lead owns task framing, execution choices, and acceptance:

- **Planning with `Plan`**: The lead drafts with repository evidence and consults `Plan` when sequencing, architectural interfaces, migration risks, or concrete acceptance criteria benefit from a dedicated planning pass. `Plan` is **not a mandatory gate**; the lead owns plan acceptance and execution. `Plan` has read/search/command tools to verify citations and draft structured plans.
- **Balanced delegation graph**: The fast in-session ACL enforces permitted Task/Agent delegation edges:
  - The **lead** may invoke all five native roles (`Explore`, `Plan`, `general-purpose`, `implementer`, `reviewer`).
  - **`Plan`** may invoke `reviewer` or `Explore` for verification and discovery.
  - **`implementer`** and **`general-purpose`** may invoke `reviewer`.
  - **`reviewer`**, **`Explore`**, and conditional **`worker-browse`** are terminal and may not spawn subagents.
- **Oracle access**: `oracle` is available exclusively to the **lead** and **`Plan`** as a stateless last-resort advisor for precise, unresolved questions. `reviewer`, `implementer`, `Explore`, and other subagents **cannot call Oracle**.
- **Model pinning**: In-session PreToolUse hooks strip invocation-level `model` overrides on allowed edges so fixed role frontmatter remains authoritative.

### MCP, browser, and Artifact tools

Fast mode serves:

- `search`: `code` and `web`;
- `peers`: only `oracle` (scoped to lead and `Plan`);
- `workers`: conditional `worker-browse` when the browser gate passes;
- `artifact`: `artifact_*` panel tools and `PostToolUse(ExitPlanMode)` auto-open when inside an ai-or-die tab environment;
- `browser`: only when `--browse` and installed browser gates pass.

It hard-denies core filesystem workers (explore, implement, review, plan, test), orchestrate, decide (`stand_in`), fleet, first-mate, standard peer critics, the coordinator, non-browser dispatcher agents, and related skills. `--codex-cli` is ignored with a visible note so it cannot widen the profile.

`oracle` is exact Opus 5 with native 1M context and high effort. Its schema is only required `query` and `context`; it receives no transcript, tools, images, continuation loop, or execution authority. Input over 256 KiB is refused rather than truncated.

### Prompt engineering and official guidance sources

Fast and Max profiles apply modern prompt design based on official guidance from model providers (Anthropic Claude prompt engineering, OpenAI reasoning guidelines, Google Gemini structured prompting, xAI Grok instructions):
- **Menus, not pipelines**: System instructions present available roles and tools as affordances rather than enforcing rigid, sequential, multi-agent pipelines. The lead selects the right tool at the right time.
- **Clear roles, tool boundaries, and concrete deliverables**: Each agent prompt defines its specific scope, accessible tools (e.g. read-only file guidance), and expected output format with file:line citations and verification evidence.
- **No chain-of-thought requests**: Prompts ask for conclusions, evidence, checks, and concise rationale rather than hidden reasoning traces or a hand-authored reasoning procedure.

Current references: [Anthropic prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices), [OpenAI reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices), [Google Gemini prompting strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies), and [xAI multi-agent guidance](https://docs.x.ai/developers/model-capabilities/text/multi-agent).

### Lifecycle hooks

Fast keeps structural Stop gates, detached/advisory plan review, and review UserPromptSubmit automation disabled. Inside an ai-or-die tab it does register the Artifact `PostToolUse(ExitPlanMode)` auto-open hook, matching the enabled Artifact tools and skill. Its native roles remain capabilities rather than mandatory planning or review gates.

Standard launches retain their existing hooks unchanged.

### Fixed effort and aliases

Claude Code 2.1.245 supports `effort:` in custom-agent frontmatter, overriding the session picker. The five native fast agents use that field. Router-owned model aliases retain role provenance until the authenticated request boundary:

| Alias | Canonical model | Effort |
|---|---|---:|
| `gh-router-luna-driver-max` | Luna | max |
| `gh-router-luna-scout-high` | Luna | high |
| `gh-router-luna-sonnet-xhigh` | Luna | xhigh |
| `gh-router-luna-haiku-high` | Luna | high |

Authenticated Fast policy overrides request effort and thinking budgets for fixed roles. Active aliases are canonicalized before Copilot and rejected on standard/unbound traffic; aliases retired with the old Luna implementer and Gemini critic are rejected even on Fast so a stale client cannot acquire changed semantics. `/v1/messages/count_tokens` applies the same launch identity, model, and effort preprocessing.

### Context-window safety

Claude Code's `[1m]` marker unlocks local accounting against a 1,000,000-token **total** window, but Copilot enforces a smaller **prompt** ceiling that reserves output space: Luna/Sol 1.05M total / 922K prompt / 128K output, Opus/Sonnet/Gemini 3.7 Flash 1M / 936K / 64K, Grok 4.6 500K / 372K / 128K (live catalog, 2026-08-27). The client's own 1M compaction threshold is `window - min(maxOutput, 20_000) - 13_000`, roughly 967K, which sits **above** every 1M model's real prompt ceiling. So a long session can send a request Copilot rejects before the client decides to compact.

The observed 2026-08-26 overflow was the top-level Luna lead (`isSidechain:false`), not a native subagent or `/responses/compact`: the session had reached about 919,814 input tokens before Copilot rejected the next `/responses` request. **This is not fast-specific** — any 1M-accounted lead whose provider prompt ceiling is below the client's uncorrected ~967K threshold has the same defect class.

Every launch therefore presence-guards `CLAUDE_CODE_AUTO_COMPACT_WINDOW` with a **catalog-derived decimal integer**. For each reachable `[1m]` lead candidate (active model, tier/custom rows, and gateway-discovered rows), it derives:

```
window(model) = floor(model.max_prompt_tokens * 0.85)
              + min(model.max_output_tokens, 20_000)
              + 13_000
launch window = min(window(model) for every reachable [1m] model)
```

The current fast/standard catalog derives `816700` because Luna/Sol bind at a 783.7K trigger; Opus/Sonnet/Gemini individually derive `828600`. The calculation minimizes the **complete expression**, not the prompt field alone, because output reserve participates. Missing/unusable limits omit that candidate; if no usable `[1m]` candidate remains, the variable is omitted rather than guessed.

`/model` does **not** change the environment; the value is fixed at process launch. This is safe and only slightly conservative because the client resolves an effective window as `Math.min(locallyRecognizedModelWindow, launchWindow)`. Switching from Luna to a 936K-prompt model keeps `816700`, only 11.9K (about 1.4%) below that model's individual optimum. Native subagents inherit the same env; their frontmatter model controls the locally recognized window. A true 200K model therefore stays about 200K. Grok advertises 500K but carries no `[1m]` marker because the client has no 500K declaration, so Claude Code conservatively treats it as about 200K and compacts early. The fixed fast roster has no true 200K role.

The value **must be a plain decimal integer**: that env path uses `parseInt`, not the suffix-aware `/config` parser, so `"1m"` parses to `1`, is floored to the client's 100,000 minimum, and would compact a 1M session roughly every 52K tokens. Regression tests pin both the integer shape and the gateway-model `/model` switch case.

`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is deliberately **not** set: with an honest window the client's built-in reserves are already correct, and the percentage interacts with a separate 20% precompute buffer. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` was rejected as the lever because the client applies it only to ids that do not start with `claude-`, so it cannot fix the Opus 5 default lead. Operator-set values always win.

As the recovery half of the fix, the proxy maps an upstream overflow onto Claude Code's gateway capability-rejection contract — see [`gateway-error-contract.md`](gateway-error-contract.md).

### Advisor

The user-facing role is Advisor. In an authenticated fast launch it remains available only to the primary lead across every fixed `/model` selection (Luna, Sol, Grok 4.6, Gemini 3.7 Flash, or Opus 5), uses Gemini 3.7 Flash via chat completions at fixed high effort, and sees the lead's bounded recent transcript. The launcher passes `--advisor gemini-3.7-flash[1m]`, overriding a mirrored standard Advisor preference only for this session, so Claude Code's native tool schema, UI label, and JSONL identify the same model the proxy actually dispatches. Fast selection is fixed: `GH_ROUTER_ADVISOR_MODEL` and forwarded `--advisor` values cannot change it, and a missing/wrong-endpoint Gemini runtime invariant fails visibly rather than silently falling back to Sol or Opus. An in-session `/advisor` mismatch is rejected with a restoration command. Standard launches retain operator pins and fallback behavior unchanged. Fast Task subagents have all Advisor tool forms stripped; their narrower transcripts are not the session context Advisor exists to assess. Advisor is optional, non-binding consultation for consequential unresolved uncertainty, conflicting evidence, a genuinely non-converging approach, materially changed assumptions, or an explicit request for a fresh perspective. It is not used for routine progress, waiting, directly verifiable facts, planner approval, reviewer verification, or completion ritual. The lead retains decision ownership and may consult again when materially new evidence creates a different question. Non-Claude continuations reuse the selected lead's translation shim/endpoint and existing SSE lifecycle.

Oracle remains separate and stateless. It is available to the lead and `Plan` as a last resort for one focused unresolved question, and remains unavailable to `reviewer`, `implementer`, `Explore`, and `general-purpose`. Fast launches keep the proxy MCP servers out of the shared mirrored config: the lead receives them through its launch-only MCP config, while `Plan` receives its role-scoped inline servers. This prevents other natives from inheriting Oracle.

Standard Advisor behavior is unchanged: Sol/xhigh (high floor) on the normal Opus path and Opus escalation for lighter Claude leads.

## 1M context accounting

Claude Code locally recognizes the literal `[1m]` suffix. The proxy adds it only when the live catalog advertises at least 1M and strips it before upstream dispatch. `CLAUDE_CODE_DISABLE_1M_CONTEXT` remains a presence-based opt-out. Grok remains bare because its window is below 1M.

## Gateway picker

The gateway cache advertises live-catalog-present rows for Sol, Luna, Gemini 3.7 Flash, and Grok 4.6. Missing rows are omitted, not substituted. This picker inventory is global, but selecting a row does not change a launch profile’s roster or MCP scope.
