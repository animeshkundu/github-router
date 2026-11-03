# Default models and launch profiles

`github-router claude` defaults to `claude-opus-5.5`; `github-router codex` defaults to `gpt-5.6-sol`. Full model fallback and slug-translation behavior is implemented in `src/lib/port.ts` and `src/lib/utils.ts`.

## Max launch profile (`-m max`)

Only the trimmed raw alias `max` selects this profile. It starts on
`gpt-5.6-sol[1m]` at high effort and accepts controlled lead switches only among
Sol, Luna, Gemini 3.8 Flash, and Opus 5. Grok 4.6 is not a Max lead or picker
row because its advertised context is below 1M.

Max emits the native roles `Explore`, `Plan`, `general-purpose`, `implementer`,
`reviewer`, `brainstorm`, and `peer-review-coordinator`. Their assignments are
Luna/high, Sol/high, Luna/max, Gemini 3.8 Flash/high, Claude Sonnet 5 1M/xhigh,
Claude Opus 5.5 1M/high, and Luna/max. Max peer MCP names are
`sol_critic`, `codex_reviewer` (or `sonnet_reviewer` if Codex is unavailable), optional `opus_critic`, Gemini critic/reviewer,
and Grok critic/reviewer when their catalog capabilities are usable. `peer-review-coordinator` sees the live peer tool list and chooses the smallest sufficient set of distinct lenses; it does not call every reviewer by default.

Claude Code's public Agent schema requires a built-in `sonnet|opus|haiku|fable`
model value even for a custom agent whose frontmatter already pins its model.
The Max PreToolUse guard treats those four values only as schema placeholders
and strips them before dispatch, so the role's fixed frontmatter model wins.
Clients able to send catalog ids may explicitly override only to Luna 1M,
Gemini 3.8 Flash 1M, or bare Grok 4.6; Sol and Opus remain unavailable as native
subagent overrides. Grok remains rejected for lead traffic, while authenticated
max subagent requests may use it at their role effort. Max Advisor is optional,
non-binding counsel for a focused consequential uncertainty that direct evidence,
Plan, reviewer, or peers cannot settle. It is not a supervisor, approver, or
routine pre-work/completion gate; the lead keeps decision ownership and consults
again only when materially new evidence creates a different question.

Max prompt guidance is deliberately layered rather than repeated. The resident
operating digest contains only high-salience execution policy: begin with direct
evidence, handle narrow work directly, delegate broad or context-heavy work, batch
independent non-overlapping workstreams, serialize real dependencies or conflicting
side effects, and verify the synthesis. The resident awareness summary names the
native roster once so Agent routing remains salient. The mirrored `CLAUDE.md`
directive carries briefing and anti-redundancy guidance, while its awareness block
is the single gate-aware inventory of resolved tools and peers. Native Agent and MCP
descriptions own detailed what/when/when-not routing; prompt bodies own scope,
deliverables, stop conditions, and verification. This avoids a mandatory
Explore → Plan → implement → review pipeline and keeps model output as input to
verification rather than a vote.

The native role boundaries are:

- `Explore`: broad, multi-file or multi-source discovery, not a narrow lookup,
  planning pass, or edit.
- `Plan`: interfaces, ordering, migrations, invariants, risks, and acceptance
  criteria, not routine decomposition or approval.
- `general-purpose`: one bounded mixed investigation-and-execution outcome, not
  the default when direct work or one specialist fits.
- `implementer`: settled behavior and constraints with remaining coding judgment,
  not an unresolved product or architecture choice.
- `reviewer`: repository navigation, commands, tests, and reproduction, not a
  stateless review of an already self-contained artifact.
- `brainstorm`: materially different repository-feasible approaches before the
  approach is settled.
- `peer-review-coordinator`: several distinct unresolved risk lenses on a
  self-contained consequential artifact, not routine or duplicate review.

The coordinator has peer tools only and cannot inspect the repository. It selects
the smallest sufficient peer set, gives each peer a distinct lens, preserves
provenance and disagreement, and returns the cheapest repository check that can
settle each dispute. Fresh-context peers see only supplied material. The native
reviewer is the path when repository or runtime evidence is needed. Advisor sees
the transcript and is useful for framing drift or changed assumptions, but that
same context means it is not independent verification.

Where a retained Max path that formerly used Gemini 3.1 Pro requires a high-effort
third-lab replacement, Max chooses Grok 4.6/high when usable and otherwise Gemini
3.8 Flash 1M/high. This includes `stand_in` and first-mate model pins; persisted
first-mate intent remains unchanged and the Max replacement is derived again at
dispatch. Standard and Fast keep their existing resolvers. Configured role models
remain intentional defaults; an override is justified by a concrete task-model
mismatch rather than speculation.

Max exposes search, optional browser control, browse-only workers, optional
stand-in, fleet, and first-mate surfaces. It never exposes orchestration or core
worker modes, and it does not inject `/gh-research`, `/gh-orchestrate`,
`/gh-floor-keeper`, or `/gh-worker`. First-mate operator skills remain conditional
on the first-mate capability. Advisor is lead-only and defaults to Opus 5/high
over native Messages; `GH_ROUTER_ADVISOR_MODEL=gpt-5.6-sol` selects Sol instead. Native
subagents and browse workers do not receive Advisor. Max rejects `--codex-cli`,
`--no-codex-mcp`, and arbitrary lead models before creating launch artifacts.

The picker cache is restricted to Sol, Luna, Gemini 3.8 Flash, and Opus 5, with
`[1m]` attached only when the live catalog advertises at least 1M context. The
existing catalog-derived `CLAUDE_CODE_AUTO_COMPACT_WINDOW` formula remains the
source of truth across every reachable Max `[1m]` model.

## Standard launch

Plain `github-router claude` keeps the standard surface: Opus 5 lead, the full catalog-driven native roster, all normally gated MCP groups/personas, picker-controlled native effort, the standard Sol Advisor at xhigh with a high floor, and every existing hook/skill. Direct `-m gpt-6-luna` is also a standard launch. Fast behavior is never inferred from a resolved model id.

## Fast launch profile (`-m fast`)

Only the trimmed raw alias `fast` selects this profile. It is a Gemini-led, role-specialized session with a narrow MCP surface and fixed per-role efforts.

| Surface | Model | Effort | Job |
|---|---|---:|---|
| Lead | `gemini-3.8-flash[1m]` | high | Primary working loop |
| `Explore` | `gpt-6-luna[1m]` | high | Broad read-only repository discovery |
| `Plan` | `gpt-5.6-sol[1m]` | high | Implementation planning consultant (non-mandatory gate) |
| `general-purpose` | `gpt-6-luna[1m]` | max | Fast, economical catch-all for mixed/unusual work |
| `implementer` | `gemini-3.8-flash[1m]` | high | Bounded coding implementation |
| `reviewer` | `claude-sonnet-5[1m]` | xhigh | Repository-aware review/reproduction/tests |
| Advisor | `gpt-5.6-sol[1m]` | high | Transcript-aware brainstorming/sounding board/fresh look |
| `oracle` | `claude-opus-5.5[1m]` | high | Stateless last-resort guidance (lead & Plan only) |
| `astra` | `gpt-6-astra` | high | Stateless terminal escalation (200K window, lead only) |

All required catalog models are mandatory. Startup fails with an actionable list rather than substituting a model or shipping a partial surface. Grok stays bare because its live limits are 500K total, 372K prompt, and 128K output. There is no separate `critic` subagent in Fast; Gemini 3.8 Flash serves the native `implementer` role at high effort.

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
- `peers`: `oracle` (scoped to lead and `Plan`), plus `astra` when present (scoped strictly to the lead);
- `workers`: conditional `worker-browse` when the browser gate passes;
- `artifact`: `artifact_*` panel tools and `PostToolUse(ExitPlanMode)` auto-open when inside an ai-or-die tab environment;
- `browser`: only when `--browse` and installed browser gates pass.

It hard-denies core filesystem workers (explore, implement, review, plan, test), orchestrate, decide (`stand_in`), fleet, first-mate, standard peer critics, the coordinator, non-browser dispatcher agents, and related skills. `--codex-cli` is ignored with a visible note so it cannot widen the profile.

`oracle` is exact Opus 5 with native 1M context and high effort. Its schema is only required `query` and `context`; it receives no transcript, tools, images, continuation loop, or execution authority. Input over 256 KiB is refused rather than truncated.

`astra` is OpenAI GPT-6 Astra at fixed high reasoning effort via `/responses`. It enforces a 200,000-token policy window and is strictly lead-only. Consulted as a last resort only when direct empirical evidence, Advisor, and Oracle cannot produce a defensible path. Returns concise, structured Markdown (`PATH_FOUND` | `NEED_EVIDENCE` | `NO_DEFENSIBLE_PATH`). Expected consultation: at most 1-2 calls per decision.

### Prompt engineering and official guidance sources

Fast and Max profiles apply current first-party guidance from the model providers:

- **Menus, not pipelines**: system instructions present roles and tools as affordances rather than a mandatory multi-agent sequence.
- **Clear routing contracts**: Agent and MCP descriptions state what the capability does, when and when not to use it, what it cannot see, and what it returns.
- **Concrete execution contracts**: role prompts define the outcome, scope, evidence, success checks, and stop condition without requesting hidden reasoning traces.
- **Dependency-aware parallelism**: independent, non-overlapping work may be issued together; dependencies, shared state, and conflicting side effects remain sequential.
- **Selective breadth**: multi-agent coverage is for complex or genuinely multi-perspective work, not narrow or speed-sensitive tasks, because every additional agent consumes time and tokens.
- **Empirical revision**: prompt changes are versioned and evaluated for routing, restraint, correctness, and latency rather than accepted by prose inspection.

Current references: [Anthropic prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices), [Anthropic tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools), [Anthropic parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use), [OpenAI reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices), [OpenAI prompting](https://developers.openai.com/api/docs/guides/prompting), [Google Gemini prompting strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies), and [xAI multi-agent guidance](https://docs.x.ai/developers/model-capabilities/text/multi-agent). The preregistered Max protocol is [`review/subagents/MAX-PROMPT-EVAL.md`](review/subagents/MAX-PROMPT-EVAL.md).

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

Claude Code's `[1m]` marker unlocks local accounting against a 1,000,000-token **total** window, but Copilot may enforce a smaller **prompt** ceiling that reserves output space: Luna/Sol 1.05M total / 922K prompt / 128K output, Opus/Sonnet 1M / 936K / 64K, Gemini 3.8 Flash 1,048,576 / 983,040 / 65,536 (low/medium/high reasoning efforts, Chat endpoint), Grok 4.6 500K / 372K / 128K (live catalog, 2026-09-03). The client's own 1M compaction threshold is `window - min(maxOutput, 20_000) - 13_000`, roughly 967K. That sits **above** the Luna/Sol and Opus/Sonnet prompt ceilings, so a long session on those models can send a request Copilot rejects before the client decides to compact. Gemini 3.8's 983,040-token prompt ceiling is above the uncorrected trigger, but it still participates safely in the shared launch-wide derivation.

The observed 2026-08-26 overflow was the top-level Luna lead (`isSidechain:false`), not a native subagent or `/responses/compact`: the session had reached about 919,814 input tokens before Copilot rejected the next `/responses` request. **This is not fast-specific** — any 1M-accounted lead whose provider prompt ceiling is below the client's uncorrected ~967K threshold has the same defect class.

Every launch therefore presence-guards `CLAUDE_CODE_AUTO_COMPACT_WINDOW` with a **catalog-derived decimal integer**. For each reachable `[1m]` lead candidate (active model, tier/custom rows, and settings-injected picker rows), it derives:

```
window(model) = floor(model.max_prompt_tokens * 0.85)
              + min(model.max_output_tokens, 20_000)
              + 13_000
launch window = min(window(model) for every reachable [1m] model)
```

The current fast/standard catalog derives `816700` because Luna/Sol bind at a 783.7K trigger. Opus/Sonnet individually derive `828600`; Gemini 3.8 derives `868584` from its 983,040-token prompt ceiling. The calculation minimizes the **complete expression**, not the prompt field alone, because output reserve participates. Missing/unusable limits omit that candidate; if no usable `[1m]` candidate remains, the variable is omitted rather than guessed.

`/model` does **not** change the environment; the value is fixed at process launch. This is safe and conservative because the client resolves an effective window as `Math.min(locallyRecognizedModelWindow, launchWindow)`. Switching from Luna to a 936K-prompt Opus/Sonnet model keeps `816700`, 11.9K (about 1.4%) below that model's individual optimum; switching to Gemini 3.8 keeps the same launch value, 51,884 (about 6.0%) below its `868584` individual optimum. Native subagents inherit the same env; their frontmatter model controls the locally recognized window. A true 200K model therefore stays about 200K. Grok advertises 500K but carries no `[1m]` marker because the client has no 500K declaration, so Claude Code conservatively treats it as about 200K and compacts early. The fixed fast roster has no true 200K role — every fast role except Grok is `[1m]`-decorated. The `cheap`, the cheapest family (`cheapest`/`cheapest2`), and the balanced family (`balanced`/`balanced2`) are strict-200K instead: they seed `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`, which gates the client's `[1m]` unlock entirely, carry no decorated picker rows at all (a "(1M)" label would lie about the actual budget), and therefore omit the launch bound — the client holds its 200K default. `cheap1m` keeps the historical surface (decorated Luna opt-in row, bound derived from it at `816700`) because its Gemini lead intentionally runs 1M.

The value is a **plain decimal integer**, and stays one. Through 2.1.311 that env path used `parseInt`, not the suffix-aware `/config` parser, so `"1m"` parsed to `1`, was floored to the client's 100,000 minimum, and compacted a 1M session roughly every 52K tokens. Claude Code 2.1.312 replaced the parser with a suffix-aware one (`200k` and `1m` are accepted, so `"1m"` is 1,000,000) that clamps an out-of-range value to the same 100,000 floor and 1,000,000 cap. An integer is `in_range` on both parsers, which is why the emitted shape did not change and why builds older than 2.1.312 still need it. Regression tests pin both the integer shape and the settings-injected `/model` switch case, and `tests/canaries/overflow-contract.test.ts` pins the parser contract against the installed client (the 2.1.312 and 2.1.314 groups assert the suffix parser and the bound-clamp rather than the retired `parseInt` call site; 2.1.314 changed only the clamp's bound identifiers).

`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is deliberately **not** set: with an honest window the client's built-in reserves are already correct, and the percentage interacts with a separate 20% precompute buffer. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` was rejected as the lever because the client applies it only to ids that do not start with `claude-`, so it cannot fix the Opus 5 default lead. Operator-set values always win.

As the recovery half of the fix, the proxy maps an upstream overflow onto Claude Code's gateway capability-rejection contract — see [`gateway-error-contract.md`](gateway-error-contract.md).

### Advisor

The user-facing role is Advisor. In an authenticated fast launch it remains available only to the primary lead across every fixed `/model` selection (Luna, Sol, Grok 4.6, Gemini 3.8 Flash, or Opus 5), uses GPT-5.6 Sol via Responses at fixed high effort, and sees the lead's bounded recent transcript. The launcher passes `--advisor gpt-5.6-sol[1m]`, overriding a mirrored standard Advisor preference only for this session, so Claude Code's native tool schema, UI label, and JSONL identify the same model the proxy actually dispatches. Fast selection is fixed: `GH_ROUTER_ADVISOR_MODEL` and forwarded `--advisor` values cannot change it, and a missing/wrong-endpoint Sol runtime invariant fails visibly rather than silently falling back. An in-session `/advisor` mismatch is rejected with a restoration command. In a cheap or cheap1m launch the same fixed Sol Advisory runs at the 200K cost class: the launcher pins the **bare** `gpt-5.6-sol` slug (no `[1m]`), and the proxy caps the transcript at 200K tokens while keeping the original user ask pinned through seat-backward truncation. Standard launches retain operator pins and fallback behavior unchanged. Fast and cheap Task subagents have all Advisor tool forms stripped; their narrower transcripts are not the session context Advisor exists to assess. (The cheapest family is the one exception: its Luna/max `reviewer` receives the Advisor as a capped protege grant — at most 5 advisor rounds per review invocation; every other cheapest subagent stays stripped.) Advisor is optional, non-binding consultation for consequential unresolved uncertainty, conflicting evidence, a genuinely non-converging approach, materially changed assumptions, or an explicit request for a fresh perspective. It is not used for routine progress, waiting, directly verifiable facts, planner approval, reviewer verification, or completion ritual. The lead retains decision ownership and may consult again when materially new evidence creates a different question. Non-Claude continuations reuse the selected lead's translation shim/endpoint and existing SSE lifecycle.

Oracle remains separate and stateless. It is available to the lead and `Plan` as a last resort for one focused unresolved question on profiles with a `Plan` role (fast, cheap, cheap1m); on the cheapest and balanced families — which have no `Plan` role — it is lead-only. It remains unavailable to `reviewer`, `implementer`, `Explore`, and `general-purpose`. Fast launches keep the proxy MCP servers out of the shared mirrored config: the lead receives them through its launch-only MCP config, while `Plan` receives its role-scoped inline servers. This prevents other natives from inheriting Oracle.

Standard Advisor behavior is unchanged: Sol/xhigh (high floor) on the normal Opus path and Opus escalation for lighter Claude leads.

In a cheapest launch the Advisor is `gpt-5.6-sol` at medium effort via Responses, pinned to the bare slug at the 200K cost class like cheap (transcript capped at 200K with the original ask pinned). In a `cheapest2` launch it is `gpt-6.1-sol` at **high** effort — the same family wiring, the 6.1 Sol tier, and an effort declaration that matches the high effort the Claude path already forces on the wire for this family (Pi reads the declared value). Cheapest has no `Plan` subagent: the lead plans directly and reviews the final plan with the Advisor (advisory, non-binding — the lead retains decision ownership) before presenting it to the user; the lead prompt carries this as an injected directive. The cheapest `reviewer` runs `gpt-6-luna` at max effort (bare alias `gh-router-cheapest-reviewer-max`) and, as the profile's protege, may itself consult the Advisor — capped at 5 advisor rounds per review invocation with a mentor system prompt — while `Explore` and `General-Purpose` stay Advisor-free.

## Cheap launch profiles (`-m cheap`, `-m cheap1m`)

The literal raw aliases `cheap` and `cheap1m` select the **cost-classed sibling of fast**: identical roster shape, delegation graph, MCP surface, and fixed per-role efforts, but every subagent and peer runs at the bare 200K default window (no `[1m]` decoration). Subagent frontmatter carries bare router-owned alias ids (`gh-router-cheap-*`, never real catalog ids): Claude Code resolves a bare real id against the live catalog and upgrades the subagent to `[1m]` accounting when the entry advertises >=1M — an alias matches no catalog entry, so the client holds the 200K default while the proxy canonicalizes to the real model upstream. The one identity swap is `reviewer`: Luna at max effort instead of fast's Sonnet 5 at xhigh. The two aliases differ only on the **leader**:

- **`-m cheap`** — the whole profile runs at the 200K cost class: the Gemini 3.8 Flash **leader is bare too**, and the only peer is a Grok 4.6 Oracle. There is no `astra` peer (`personaAllowlist` is Oracle-only; the MCP peers surface exposes Oracle exclusively).
- **`-m cheap1m`** — the named successor of the original cheap launch: the leader keeps its full 1M window (`[1m]`), and the `astra` peer (`gpt-6-astra`) remains available next to Oracle. Subagents and both peers still run at bare 200K.

### `-m cheap` (200K leader)

The lead is `gemini-3.8-flash` bare.

| Surface | Model | Effort | Window |
|---|---|---|---|
| Lead | `gemini-3.8-flash` | high | 200K |
| `Explore` | `gpt-6-luna` | high | 200K |
| `Plan` | `gpt-5.6-sol` | high | 200K |
| `general-purpose` | `gpt-6-luna` | max | 200K |
| `implementer` | `gemini-3.8-flash` | high | 200K |
| `reviewer` | `gpt-6-luna` | max | 200K |
| Advisor | `gpt-5.6-sol` | high | 200K |
| `oracle` | `grok-4.6` | medium | 200K |

### `-m cheap1m` (1M leader)

The lead is `gemini-3.8-flash[1m]`, decorated only when the live catalog serves 1M.

| Surface | Model | Effort | Window |
|---|---|---|---|
| Lead | `gemini-3.8-flash[1m]` | high | 1M |
| `Explore` | `gpt-6-luna` | high | 200K |
| `Plan` | `gpt-5.6-sol` | high | 200K |
| `general-purpose` | `gpt-6-luna` | max | 200K |
| `implementer` | `gemini-3.8-flash` | high | 200K |
| `reviewer` | `gpt-6-luna` | max | 200K |
| Advisor | `gpt-5.6-sol` | high | 200K |
| `oracle` | `grok-4.6` | medium | 200K |
| `astra` | `gpt-6-astra` | medium | 200K |

### Cost levers and validation (shared family)

- **Cost lever**: the curated picker flags every cheap row `neverOneM`, the agent/MCP wiring emits bare router-owned alias ids (never bare real slugs), and the launcher pins Claude Code's Advisor to the bare `gpt-5.6-sol` — and, decisively, seeds `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`. Bare ids alone do NOT deliver 200K: every row maps via `behavesAs` onto a known Claude model whose client-side profile is native-1M (verified against Claude Code 2.1.288 — a bare `gpt-6-luna` lead reports `contextWindow: 1000000` in `--output-format json`, and neither `CLAUDE_CODE_MAX_CONTEXT_TOKENS` nor `CLAUDE_CODE_AUTO_COMPACT_WINDOW` moves it), so the flag is the only lever that holds the 200K default. Because the flag also gates `[1m]`-decorated rows, cheap carries no Luna 1M opt-in row at all. `-m cheap1m` is the exception that keeps one: its Gemini lead intentionally runs 1M and it does not seed the flag, so its Luna row stays decoratable and a `/model` switch to Luna keeps 1M like the fixed lead. The proxy caps the Advisor transcript at 200K tokens (`CHEAP_PROFILE_ADVISOR_CONTEXT_TOKENS`) while keeping the original user ask pinned.
- **Oracle**: swaps Fast's exact Opus 5 for Grok 4.6 (`/responses`, medium) — the cheaper cross-lab second set of eyes, scoped to the lead and `Plan` like Fast. **Astra** (cheap1m only) is GPT-6 Astra at medium effort, lead-only, 200K policy window.
- **Prerequisites**: `validateCheapProfilePrerequisites` gates the leader at the 200K floor; `validateCheap1mProfilePrerequisites` gates the same leader at 1M. Every other role needs just its fixed effort, tool-calling (where relevant), and a supported endpoint. `astra` is optional (exposed only when the catalog serves it); every other role in the roster is mandatory, and startup fails with an actionable list rather than substituting a model.
- Delegation edges, Oracle scoping, MCP surface and hard-denies, and picker rows are otherwise identical to Fast.

## Cheapest launch profile (`-m cheapest`, `-m cheapest2`)

The raw aliases `cheapest` and `cheapest2` select the Luna-led 200K tier: a `gpt-6-luna`/max lead, a three-agent surface (`Explore`/`General-Purpose`/`reviewer`, all Luna — no `Plan`: the lead plans directly), an Oracle-only peer set, and the server-side Advisor described above. `cheapest2` is derived from `cheapest` by contract spread, so only the declared rows below can differ; every other identity, window, transcript budget, graph edge, and prompt is inherited.

| Surface | `cheapest` | `cheapest2` |
|---|---|---|
| Lead / `Explore` / `General-Purpose` / `reviewer` | `gpt-6-luna` | same |
| Advisor model / effort | `gpt-5.6-sol` / medium | `gpt-6.1-sol` / **high** |
| Oracle model / effort | `gpt-5.6-sol` / high | `gpt-6.1-sol` / high |
| Prompt-rewrite brief (`internal-prompt-submit`) | `gpt-5.6-sol` | `gpt-6.1-sol` |
| Windows / roster / peers / graph | 200K / three natives / Oracle only | same |

## Balanced launch profile (`-m balanced`, `-m balanced2`)

The literal raw alias `balanced` selects the Sol-led 200K tier: a `gpt-5.6-sol`/medium lead at the bare 200K default window, a three-agent surface (`Explore`/`General-Purpose`/`reviewer` — no `Plan`: the lead owns planning directly), and an Oracle-only peer set (no `astra`, no Advisor surface).

| Surface | Model | Effort | Window |
|---|---|---|---|
| Lead | `gpt-5.6-sol` | medium | 200K |
| `Explore` | `gpt-6-luna` | high | 200K |
| `General-Purpose` | `gpt-6-luna` | max | 200K |
| `reviewer` | `gpt-5.6-sol` | high | 200K |
| `oracle` | `grok-4.6` | medium | 200K |

`balanced2` is derived from `balanced` by contract spread and moves three identities only: the **lead and `reviewer` to `gpt-6.1-sol`**, and the **Oracle to `grok-4.7`** (still `/responses`, still medium effort). `Explore` and `General-Purpose` stay Luna, the lead effort stays medium, the profile stays advisor-free, and the `reviewer` → `Explore` edge is inherited. The declarative `astra` slot is inherited unchanged (`gpt-6-astra`): no balanced launch exposes an `astra` tool, so altering it would change nothing callable and would add a capability plain `balanced` does not have.

Two deliberate divergences from the fast/cheap delegation graph:

- **`reviewer` may invoke `Explore`** for targeted discovery (the only graph edge no other pinned profile has). The reviewer narrows scope with `code` + `web` search first, then delegates scoped evidence questions; the in-session ACL enforces this via a balanced graph variant selected by the persisted hook command.
- **Search-first funnel, no Advisor.** Unknowns funnel cheapest-first: `code_search` + `web` search narrow scope and rule out hypotheses first, `Explore` only when search is insufficient, `oracle` as a second opinion for precise, self-contained trade-offs that search and `Explore` cannot settle. Oracle is a second opinion on a framed question, never a discovery tool. The awareness snippet, summary, directive, and digest name no Advisor for this profile.
- **Lead owns by default.** The lead plans, implements, and verifies itself: it delegates FREELY to the Luna-powered `Explore` (targeted breadth) and `General-Purpose` (multi-step execution), and to `reviewer` ONLY when genuinely needed (behavior-changing review). Enforcement is soft — the ACL graph permits all three edges and the directive, descriptions, and roster clauses carry the policy.

## Local launch profiles (`-m local`, `-m local2`)

The raw aliases `local` and `local2` point the MAIN agent loop at a local inference endpoint running on the operator's machine instead of at Copilot. These profiles assume nothing about the endpoint beyond its base URL: not what serves it, not which model answers, not its model list, and no wire dialect beyond the Anthropic Messages API that Claude Code itself already speaks to it.

| Surface | `local` | `local2` |
|---|---|---|
| Lead / `reviewer` | `opus` | same |
| `Explore` | `haiku` | same |
| `General-Purpose` | `sonnet` | same |
| Advisor | none (the tool is disabled, see below) | `gpt-6.1-sol` / high, served by Copilot |
| Oracle peer | none | `gpt-6.1-sol` / high, served by Copilot |
| Window / roster | 200K / the three natives above, no `Plan`, no coordinator | same |
| MCP groups | `peers` (artifact tools only), `search`, `browser`, `ado`, `kusto`, `cloudagent` | same, and `peers` also answers the Oracle |
| Prompts | the local family's own, assumption-free | same |

Local is a third family, not a cheapest sibling: its egress and model ids differ, its roster and per-role efforts are inherited from `CHEAPEST_PROFILE_CONTRACT`, and its prompt surfaces are rendered for the local family so they name only the agents and tools it emits and make no claim about the endpoint, the model behind it, its speed or its cost.

### What may reach Copilot

`local` runs no Copilot model inference on an agent turn. Every Claude Code surface funnels to the local endpoint: the lead, the native Task subagents, and agent-team teammates. A teammate cannot read `ANTHROPIC_CUSTOM_HEADERS` (the agent-teams env allowlist drops it), so the per-launch synthetic credential's bearer is the channel that binds it to the launch and therefore to the local egress.

`local2` adds exactly two Copilot consumers: the Advisor and the Oracle, both `gpt-6.1-sol`.

That is a runtime guard, not prompt guidance. `src/lib/copilot-model-policy.ts` derives a process policy from the launch registry (`activeCopilotModelPolicy`, most restrictive wins) and every Copilot egress asserts it: `createChatCompletions`, `createResponses`, `createMessages`/`countTokens` (via `assertCopilotMessagesBodyAllowed`), and the MCP `dispatchModelCall`. Under `local` the verdict is `forbidden`, and under `local2` it is the hardcoded family set `{sol, luna}` (`LOCAL2_COPILOT_MODEL_FAMILIES`). `forbidden` admits one named surface carve-out, `browse`: the `--browse` extension's page compressor runs a Copilot model over page text, which is a browser feature rather than a subagent, and it stays available on both profiles. Everything else that is Copilot-backed carries no model and is untouched: `web` search (GitHub PAT), the `browser_*` tools' own mechanics, and the `ado`/`kusto`/`cloudagent` data groups.

The `workers` group is absent on both, because a worker subagent resolves and runs a Copilot model. `peers` stays permitted for the artifact review tools (human review, not inference) and is published only while the artifact panel is enabled; `local2`'s Oracle rides the same group.

### Endpoint configuration

The default is `https://localhost:11111/v1`. Resolution order, highest first:

1. `--localurl <url>`
2. `--localport <port>`
3. `GH_ROUTER_LOCAL_BASE_URL`
4. `GH_ROUTER_LOCAL_PORT`
5. the default

`--localport` replaces only the port of the base URL resolved by the layers beneath it. `--localurl` sets scheme, host and path, keeps any path given, and appends `/v1` when the path is bare, so `--localurl http://localhost:11111` and `--localurl http://localhost:11111/v1` mean the same thing. Passing both flags is a launch error rather than a silent precedence; a non-integer or out-of-range port fails the launch. Both flags exist on `claude` and `pi` only (`start`, `codex` and `serve` never accept them), and on any other profile they are inert with one warning. **`GH_ROUTER_LOCAL_PORT` is the local model server's port, not the proxy's own listen port** (`-p/--port`, default 8787).

The default scheme is https because that is the only endpoint measured. A plain-HTTP server needs an explicit `--localurl http://...`; inferring the scheme from the port number would be exactly the guess these profiles refuse to make. At launch the router prints `[local] upstream <resolved base URL>`, so a wrong spelling is visible immediately instead of as a TLS or connection error.

No request is issued to the endpoint other than the client's own turns: no `/models` fetch, no reachability probe, no capability check. A wrong port therefore surfaces as the upstream failure Claude Code already reports, and the proxy adds no second failure channel.

### Passthrough contract

`/v1/messages` and `/v1/messages/count_tokens` forward to `{base}/messages` and `{base}/messages/count_tokens`, with no `?beta=true` query. The body model is forwarded verbatim: `opus`, `sonnet` and `haiku` reach the server untouched. They never pass through `resolveModel` (which would rewrite `opus` to `claude-opus-5.5` and strip fields the local server may understand) and are never `[1m]`-decorated. Forwarded headers are `content-type`, the client's own `anthropic-version` (default `2023-06-01`), the client's **unfiltered** `anthropic-beta` minus any `advisor-tool-` value the proxy consumes itself, and `x-claude-code-session-id`. No `Authorization`, no `copilot-integration-id` / `editor-version` / `X-Initiator` / `X-Interaction-Id`, and no Copilot token is required for a local turn. The beta allowlist is deliberately not applied: it is a Copilot capability list, and these profiles refuse to assume what the endpoint supports. The rest of the request pipeline (web-search fulfilment, body sanitization, the advisor-tool strip, the body guard) still applies, because it is part of the harness rather than of any one upstream.

The session id is the client's own `x-claude-code-session-id`, trimmed, with `state.sessionId` as the fallback when the client sends none. It is never synthesized per request: the header exists for upstream routing and prompt caching, so a random value would defeat it. The Pi launcher populates the same header from its `models.json` tier rows, so `github-router pi -m local` presents the same identity. Those rows also carry `X-GH-Router-Launch-Secret` with the value `/mcp` registration holds: the proxy derives the local profile from the launch bound to that header, so without it Pi's lead traffic is unbound BYO and the bare `opus` id is sent to Copilot, which answers "The requested model is not supported". Claude Code gets the header through `ANTHROPIC_CUSTOM_HEADERS`; `models.json` is Pi's only equivalent channel. Copilot-served rows never carry either header.

### 200K, picker and effort

Both profiles run at the 200K default window, enforced client-side by the seeded `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`. The tier rows are the bare ids: `ANTHROPIC_MODEL=opus`, `ANTHROPIC_DEFAULT_OPUS_MODEL=opus`, `ANTHROPIC_DEFAULT_SONNET_MODEL=sonnet`, `ANTHROPIC_DEFAULT_HAIKU_MODEL=haiku`, `ANTHROPIC_SMALL_FAST_MODEL=haiku`, each with a matching bare `*_MODEL_NAME`, and the `/model` picker offers the same three rows with no decoration. `CLAUDE_CODE_EFFORT_LEVEL` is deliberately not seeded: the endpoint's effort ladder is unknown, so the client's picker decides, and the per-role efforts ride only on the native subagents' frontmatter.

### Advisor

`local` never passes `--advisor` and seeds `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` (unless the operator set it), because the launcher enables the advisor tool for every launch and a router-owned tool must not be forwarded to a server whose behaviour is unmeasured. `local2` keeps the tool and pins `--advisor gpt-6.1-sol` at effort `high`, with the same curated ("small digest") transcript budget as the cheapest family. The Advisor's own turns are Copilot requests and are priced as such. Launch fails loudly when `gpt-6.1-sol` is absent from the live catalog; `local` needs no catalog entry at all.

`local2` inherits both curated grants, not just the lead one, because "all of the subagents as cheapest mode" includes what the reviewer may do. The lead gets the full Advisor tool; the `reviewer` subagent gets the capped protege variant (`CHEAPEST_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS`: at most 5 advisor rounds, mentor posture) over the same small-digest transcript, which is exactly what the emitted reviewer `.md` promises. Every other local subagent is stripped, and `local` grants nothing to anyone. Two strip rules back this up on a local lead: a request whose advisor behaviour is off carries neither the injected `__anthropic_advisor` tool nor Claude Code's native `advisor_*` typed tool, because the local endpoint is never assumed to understand the Anthropic server-tool type. `tests/local-reviewer-advisor.test.ts` pins all three directions: the reviewer grant, the lead grant, and the local strip.

### AIC

A local lead turn costs nothing, and the ledger says so rather than staying silent. Each accepted lead request is recorded once through `recordZeroCostRequest`, keyed on the **raw** tier id, so a free local `opus` is never attributed to `claude-opus-5.5`. The local path also skips the AIC tap, so a `copilot_usage` block from the endpoint cannot double count the turn. The status line therefore reads `[AIC 0.00]` and `~$0.00` (a measured zero, not the `~$--` unknown placeholder), and the exit summary reads `0 credits across N requests`. `local2`'s Advisor and the Oracle peer are Copilot-served and their credits land in the same ledger beside the lead's zeros: the picture is lead free, consult billed. The display guard changed from `totalNanoAiu <= 0` to `requests === 0` for every profile; that is the one intentional cross-profile display change, and the only way a local zero can be shown at all.

### Pi

`github-router pi -m local [--localport <port> | --localurl <url>]` configures the endpoint through the same resolver, so both subcommands accept the same spellings. Pi's `models.json` provider speaks `anthropic-messages`, the tier rows are the three bare ids at a 200K window carrying the launch's session id as a per-model header, and no `cost` or `thinkingLevelMap` is emitted for them (the ladder is unknown, so it is omitted rather than guessed). Copilot-served rows (the Oracle, and the `local2` advisor) are pinned to `openai-responses`, because a Copilot row left on the local provider default would send a real Copilot id to the local server.

### Non-assumptions

Written down so a later change does not "improve" these profiles into guessing:

- **No endpoint detection.** Never probe the endpoint (capability, model-list, or version routes) to decide what is serving it or which model answers. The only configured fact is the base URL.
- **No model discovery, and no launch-time call of any kind.** The proxy never issues `GET /models`. The launched ids are the fixed `opus` / `sonnet` / `haiku`; whatever the server's own list says is never read.
- **No capability probing** for vision, structured output, effort, or 1M context. If the server supports something, it supports it silently; the proxy neither advertises nor strips for it.
- **No fallback to Copilot** when the local endpoint is unreachable. A local profile that silently spent Copilot quota would be the worst failure mode available.
- **No catalog registration** of the local ids, so they never leak into Standard `/model` rows, peer resolution, or the worker gate.

## 200K context efficiency

Every role in `cheap`, the cheapest family (`cheapest`/`cheapest2`), the balanced family (`balanced`/`balanced2`), and the local family (`local`/`local2`) — and every subagent in `cheap1m` — runs at the 200K default window. The `cheap`, cheapest-family, balanced-family, and local-family budget is enforced client-side by the launcher-seeded `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` (presence-guarded; an operator-set value wins), because bare model ids alone do not hold 200K against the client's native-1M `behavesAs` profiles. Lead effort is enforced the same way: the launcher seeds `CLAUDE_CODE_EFFORT_LEVEL` to the contracted lead effort — `max` on the cheapest family, `medium` on the balanced family (presence-guarded; whitespace-only counts as unset) — because the client stamps its session-default `high` onto lead requests and the proxy keeps explicit lead effort, so without the seed the wire would run high regardless of contract. The local family is the exception to the effort seed: its endpoint's ladder is unknown, so no `CLAUDE_CODE_EFFORT_LEVEL` is seeded and the client's own picker decides. `cheap`/`cheap1m` leads run at the de-facto `high` (preprocessor mapping, client default, and docs agree; the stale contract constant was aligned) and receive no seed. Known accepted consequence: background-tier ops (session titles, summaries — and compaction summaries, which run on the main-loop model) inherit the session level rather than their contracted tier effort, and `/effort` changes report "not applied" while the var is set. All lead-facing surfaces (directive, digest, awareness snippet, summary, agent descriptions and prompts) carry the same one-line discipline: prefer targeted reads (search, Grep, Read specific files) over full file reads. The launcher additionally sets `ENABLE_TOOL_SEARCH=auto` on every launch (presence-guarded; an operator-set value wins) so MCP tool schemas load on demand instead of upfront. Auto-compaction (~167K), micro-compaction of old tool results, and `/compact` remain Claude Code built-ins underneath.

## 1M context accounting

Claude Code locally recognizes the literal `[1m]` suffix. The proxy adds it only when the live catalog advertises at least 1M and strips it before upstream dispatch. `CLAUDE_CODE_DISABLE_1M_CONTEXT` remains a presence-based opt-out — and the `cheap`, cheapest-family, balanced-family, and local-family launcher seeds it to `1` itself (the pinned-200K profiles need it; bare ids don't hold 200K, and the local ids have no catalog entry to consult at all). Grok remains bare because its window is below 1M.

## Curated model picker

The per-launch mirror's supported `modelPicker` setting advertises only live-catalog-present rows. Standard and Fast expose Sol, Luna, Gemini 3.8 Flash, and Grok 4.6; Max exposes Sol, Luna, Gemini 3.8 Flash, and Opus 5 so every row is an allowed Max lead; Cheap, the cheapest family, the balanced family, and the local family expose only bare rows (`neverOneM` everywhere — no decorated opt-in row, since the seeded `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` would clamp it to 200K anyway), with each sibling's rows built from its own contract. The local family's rows are the three bare tier ids `opus`/`sonnet`/`haiku`, and they are the one set emitted without catalog consultation, because a local id has no catalog entry to filter on. The catalog-built sibling rows are unchanged: `cheapest2` offers GPT-6.1 Sol + Luna, and `balanced2` offers GPT-6.1 Sol + Luna + Grok 4.7; Cheap1m exposes the same four with only the Luna row decoratable, so a `/model` switch to Luna keeps 1M accounting like its 1M Gemini lead. On 200K-lead traffic the request preprocessor still strips it upstream and subagents run on bare aliases. A Luna switch also runs at `max` effort per the shared bare-model fallback, so it is the highest-cost combination in these profiles — reachable only by explicit `/model` choice, never by default. Missing rows are omitted, not substituted. Selecting a row changes the active lead model but does not change the launch profile's roster or MCP scope. Existing user `modelPicker` configuration wins wholesale, and its valid `[1m]` rows still participate in the compaction bound. Claude Code 2.1.260 requires `behavesAs` to offer otherwise-unknown ids, so Sol/Luna use the Opus 5 client profile and Gemini/Grok use Sonnet 5 while labels and wire ids remain unchanged. Gateway discovery stays disabled because the same client filters its refresh to Claude/Anthropic ids and replaces its cache.

`github-router serve` intentionally uses the Standard roster, ACL, and picker. Every non-standard alias (`fast`, `cheap`, `cheap1m`, `cheapest`, `cheapest2`, `max`, `balanced`, `balanced2`, `local`, `local2`) is rejected there with an actionable message; use `github-router claude -m <alias>` for those profiles, or pass an explicit model id to `serve` while retaining its Standard enhancement surface.
