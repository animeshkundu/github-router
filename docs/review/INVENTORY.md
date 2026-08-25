# The injection inventory: everything github-router puts in a Claude Code session

`github-router claude` does not just proxy requests. It can inject a large, multi-surface layer into a spawned Claude Code session: MCP tools, lifecycle hooks, skills, subagents, system-prompt / CLAUDE.md text blocks, and env/settings. Some of that layer is unconditional (it lands in every session); much of it is gated on a launch flag, a live-catalog model, or the ai-or-die tab environment. Section 1 catalogs the full possible surface; section 2 is the matrix that says which parts a given session actually exposes. Each surface has also been reviewed on its own (the six READMEs linked below); this document is the single cross-surface map, so the greater whole is visible in one place and no surface is planned in isolation. The governing lens throughout: **raise the floor, never nerf** and **the right thing, at the right time, in the right amount**. Over-injection is as harmful as under-injection: a steer that fires on every trivial prompt, a gate that reruns the whole suite on a plan-only turn, or a description naming a removed tool all spend the user's latency, tokens, and attention for no floor gain.

The per-surface reviews:

- MCP tools: [`mcp/README.md`](./mcp/README.md) + [`mcp/FINDINGS.md`](./mcp/FINDINGS.md) (71 tools, 9 groups)
- Hooks: [`hooks/README.md`](./hooks/README.md) (7 lifecycle hooks)
- Skills: [`skills/README.md`](./skills/README.md) (7 injected skills)
- Subagents: [`subagents/README.md`](./subagents/README.md) (peer critics, coordinator, seven native agents, worker dispatchers)
- Injected prompt blocks: [`injected-prompt/README.md`](./injected-prompt/README.md) (operating-defaults, style, peer-awareness, toolbelt, artifact directive)
- Env and settings: [`env-and-settings/README.md`](./env-and-settings/README.md) (feature gates, model defaults, MCP timeouts, gateway seed, config mirror)

## 1. Master surface table

Grouped by surface type. Each row: item · one-line function · gate/condition · detailed doc.

### MCP tools (71 tools, 9 groups)

| Group | Tools | What the group does | Gate | Doc |
|---|---|---|---|---|
| peers | codex_critic, gemini_critic, codex_reviewer, gemini_reviewer, opus_critic, codex_implementer | Cross-lab adversarial critics + reviewers (gpt-5.6-sol / gemini-3.1-pro / gpt-5.3-codex / Opus 5 with 4.6 fallback) | catalog per-model; gemini pair needs gemini catalog; codex_implementer needs `--codex-cli` | [mcp/README.md](./mcp/README.md) |
| search | web, code | Copilot web search; semantic-first (ColBERT + lexical fallback) code search | always-on | [mcp/search/code.md](./mcp/search/code.md) |
| workers | explore, implement, review, plan, test, browse | Autonomous Pi-runtime worker subagents (read-only / read-write / planner / test-author / browser) | `capability:"worker"` (browse: `browse_agent`) | [mcp/workers/](./mcp/workers/) |
| orchestrate | verify_workflow, decompose, run_workflow, attest_step | Compose / verify / run / audit a typed workflow IR through the frozen kernel | verify+attest always-on; decompose+run gated `worker` | [mcp/orchestrate/](./mcp/orchestrate/) |
| decide | stand_in | Server-side 3-lab consensus for away-mode decision tiebreak | `capability:"stand_in"` (3 models in catalog) | [mcp/decide/stand_in.md](./mcp/decide/stand_in.md) |
| browser | act, observe, extract, navigate, open_tab, screenshot (lead) + 13 power primitives | Drive a real Chrome/Edge browser via MV3 extension | `--browse` (6 lead); power primitives need `--power-browse`; observe/extract need compressor | [mcp/browser/](./mcp/browser/) |
| fleet | list_instances, list_sessions, read_session, session_status, send_message, send_keys, respond, create_session, stop_session, await_turn, drive_task, read_file, list_dir, search, git_show | Control remote ai-or-die fleet instances / sessions | `--fleet` / `capability:"fleet"` | [mcp/fleet/](./mcp/fleet/) |
| first-mate | start_mission, scaffold_repo, advance, board, merge_pr, close_pr, mark_ready, add_units, abandon_mission, mission_status | Drive GitHub cloud coding agents (missions, PR operator) | `--agents` + GitHub agent token / `capability:"agents"` | [mcp/first-mate/](./mcp/first-mate/) |
| artifact | artifact_open, update, refresh, await, dismiss, reply, end, poll | Live human-review panel (open, drain feedback, revise, end) | `capability:"artifact"` (ai-or-die tab env trio) | [mcp/artifact/](./mcp/artifact/) |

Full per-tool manifest with `file:line` and per-tool models in [`mcp/README.md`](./mcp/README.md). Naming note: `codex_implementer` (peers group) is not a live HTTP tool on the `tools/list` surface; its only real entry point is the `codex-implementer` subagent, which routes to a stdio Codex CLI under `--codex-cli`. The `mcp__peers__codex_implementer` HTTP path 404s, so the underscored tool name appears in the table for completeness but the dashed subagent name is what a session actually invokes (see finding S6 below).

### Hooks (7 lifecycle hooks)

| # | Event · matcher | What it does | Gate | Doc |
|---|---|---|---|---|
| 1 | `UserPromptSubmit` | Reset gate budget, inject grounded goal + prior-turn review findings + search tip | `workerToolsEnabled()` | [prompt-submit-steer](./hooks/prompt-submit-steer.md) |
| 2 | `PreToolUse` · raw `mcp__workers__*` | Deny raw worker call from main agent, redirect to `worker-*` dispatcher | `workerToolsEnabled()` + injected | [pretooluse-workers-guard](./hooks/pretooluse-workers-guard.md) |
| 3 | `PreToolUse` · `mcp__workers__*` / `mcp__orchestrate__*` | Operator-mode block by prefix (steers to cloud agents) | `--agents` | [pretooluse-operator-guard](./hooks/pretooluse-operator-guard.md) |
| 4 | `SessionStart` + `SessionEnd` | Bind the session to the ai-or-die tab (side-effect); one hook registered on both events | `AIORDIE_CLAUDE_BIND` set | [session-bind](./hooks/session-bind.md) |
| 5 | `PostToolUse` · `ExitPlanMode` | Open the finalized plan in the ai-or-die panel | `AIORDIE_SESSION_ID` set | [posttooluse-artifact-open](./hooks/posttooluse-artifact-open.md) |
| 6 | `Stop` | Structural gate: typecheck/test/lint + gate-weakening scan; blocks stop (max 2/prompt) | per-repo consent | [stop-structural-gate](./hooks/stop-structural-gate.md) |
| 7 | (detached, spawned by #6) | gpt-5.6-sol review of the live tree vs the user ask on a green gate → findings for next turn | `stopReviewEnabled()` + green gate + diff | [stop-review-detached](./hooks/stop-review-detached.md) |

All four non-guard hooks stand down inside any subagent/teammate context; the two PreToolUse guards are the deliberate inverse. Firing analysis in [`hooks/README.md`](./hooks/README.md).

### Skills (7 injected skills)

| Skill | What it routes to | Gate | Doc |
|---|---|---|---|
| gh-research | Bounded saturation research → confidence-tagged brief | `workerToolsEnabled()` | [gh-research](./skills/gh-research.md) |
| gh-orchestrate | Right-sized blind-spot-elimination pipeline | `workerToolsEnabled()` | [gh-orchestrate](./skills/gh-orchestrate.md) |
| gh-floor-keeper | Done-checkpoint cross-lab verification | `workerToolsEnabled()` | [gh-floor-keeper](./skills/gh-floor-keeper.md) |
| gh-worker | How to run workers without blocking the turn | `workerToolsEnabled()` | [gh-worker](./skills/gh-worker.md) |
| gh-first-mate | Operator protocol for GitHub cloud agents | worker + `agentToolsEnabled()` | [gh-first-mate](./skills/gh-first-mate.md) |
| gh-first-mate-scaffold | Seed a repo foundation through first-mate | worker + `agentToolsEnabled()` | [gh-first-mate-scaffold](./skills/gh-first-mate-scaffold.md) |
| gh-artifact-review | Author + drive the HTML review panel | `AIORDIE_SESSION_ID` (write) vs full trio (runtime) | [gh-artifact-review](./skills/gh-artifact-review.md) |

Description-line (routing) review in [`skills/README.md`](./skills/README.md).

### Subagents

| Subagent | Own model | Nature | Gate | Doc |
|---|---|---|---|---|
| codex-critic / codex-reviewer | inherited (Claude) | relay to gpt-5.6-sol / gpt-5.3-codex via MCP | always | [subagents/](./subagents/) |
| gemini-critic / gemini-reviewer | inherited | relay to gemini-3.1-pro via MCP | `requiresGeminiCatalog` | [subagents/](./subagents/) |
| opus-critic | inherited | relay to claude-opus-5 via MCP (Opus 4.6 variants fallback) | always | [opus-critic](./subagents/opus-critic.md) |
| codex-implementer | inherited | relay to gpt-5.3-codex writer (stdio) | `--codex-cli` | [codex-implementer](./subagents/codex-implementer.md) |
| implementer (native) | gpt-5.6-sol → gpt-5.5, else lead | implementation, full toolset | always emitted; frontier model only when it has `tool_calls` | [implementer](./subagents/implementer.md) |
| reviewer (native) | gemini-3.1-pro-preview → frontier, else lead | artifact assessment, full toolset; cross-lab from implementer by design | always emitted; preferred model only when it has `tool_calls` | [reviewer](./subagents/reviewer.md) |
| brainstorm (native) | gemini-3.1-pro-preview → frontier, else lead | read-only divergent options | always emitted; preferred model only when it has `tool_calls` | [brainstorm](./subagents/brainstorm.md) |
| scout (native) | gpt-5.6-luna → gemini-3.7-flash | read-only low-cost repository exploration | omitted unless a chain model has `tool_calls` and 1M context | [scout](./subagents/scout.md) |
| scribe (native) | gpt-5.6-terra → frontier, else lead | repository-grounded documentation, full toolset | always emitted; preferred model only when it has `tool_calls` | [scribe](./subagents/scribe.md) |
| implementer-fast (native) | gpt-5.6-terra → gemini-3.1-pro-preview | well-specified mechanical implementation, full toolset | omitted unless a chain model has `tool_calls` and 1M context | [implementer-fast](./subagents/implementer-fast.md) |
| reviewer-fast (native) | gemini-3.7-flash only | lower-stakes cross-lab assessment, full toolset | omitted unless Gemini 3.7 Flash has `tool_calls` and 1M context | (no per-agent page yet) |
| general-purpose-fast (native) | gpt-5.6-luna only | fastest measured, lowest-cost full-toolset catch-all | omitted unless Luna has `tool_calls` and 1M context | [general-purpose-fast](./subagents/general-purpose-fast.md) |
| peer-review-coordinator | inherited | fans out to critics, aggregates | always | [peer-review-coordinator](./subagents/peer-review-coordinator.md) |
| worker-explore/implement/review/plan/test/browse | inherited (dispatchers) | background non-blocking dispatch to the matching worker | worker / browse gate | [subagents/](./subagents/) |

Routing-line (delegation-trigger) review in [`subagents/README.md`](./subagents/README.md).

### System-prompt / CLAUDE.md text blocks

| Block | Surface | Gate | Doc |
|---|---|---|---|
| OPERATING_DEFAULTS_DIGEST / `buildOperatingDefaultsDirective` | digest: `--append-system-prompt` (leads); full directive: CLAUDE.md top | digest always; full directive names only emitted conditional natives | [operating-defaults-directive](./injected-prompt/operating-defaults-directive.md) |
| Peer-awareness snippet | `--append-system-prompt` (after defaults) + CLAUDE.md bottom | codex-mcp block; contents per live catalog | [peer-awareness-snippet](./injected-prompt/peer-awareness-snippet.md) |
| STYLE_DIRECTIVE | CLAUDE.md top | codex-mcp block | [style-directive](./injected-prompt/style-directive.md) |
| ARTIFACT_PANEL_DIRECTIVE | CLAUDE.md top | `AIORDIE_SESSION_ID` set | [artifact-panel-directive](./injected-prompt/artifact-panel-directive.md) |
| Toolbelt awareness line | CLAUDE.md bottom | `toolbeltEnabled()` + non-empty list | [toolbelt-awareness](./injected-prompt/toolbelt-awareness.md) |

Assembly and order map in [`injected-prompt/README.md`](./injected-prompt/README.md).

### Env / settings

| Var / setting | Injected value | Opt-out | Doc |
|---|---|---|---|
| `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` | `1` | presence-guard `=0` | [feature-gates](./env-and-settings/claude-code-feature-gates.md) |
| `CLAUDE_CODE_FORK_SUBAGENT` | `1` | presence-guard | [feature-gates](./env-and-settings/claude-code-feature-gates.md) |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `1` | presence-guard | [feature-gates](./env-and-settings/claude-code-feature-gates.md) |
| `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING` | `1` | presence-guard | [feature-gates](./env-and-settings/claude-code-feature-gates.md) |
| `CLAUDE_CODE_ENABLE_TASKS` | `1` | presence-guard | [feature-gates](./env-and-settings/claude-code-feature-gates.md) |
| `ANTHROPIC_MODEL` | `claude-opus-5[1m]` (enterprise, cap-aware) | `-m <model>` | [model-defaults](./env-and-settings/model-defaults-and-picker-seeds.md) |
| `ANTHROPIC_SMALL_FAST_MODEL` | `claude-sonnet-5` | presence-guard | [model-defaults](./env-and-settings/model-defaults-and-picker-seeds.md) |
| `ANTHROPIC_DEFAULT_{SONNET,HAIKU,OPUS}_MODEL` | sonnet-5 / sonnet-5 / opus-5 | presence-guard | [model-defaults](./env-and-settings/model-defaults-and-picker-seeds.md) |
| `MCP_TIMEOUT` / `MCP_TOOL_TIMEOUT` | `22_500_000` ms (6h15m) | `GH_ROUTER_MCP_TOOL_TIMEOUT_MS` | [mcp-timeout](./env-and-settings/mcp-tool-timeout.md) |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` (conditional, when seed lands) | presence-guard | [gateway-seed](./env-and-settings/gateway-model-cache-seed.md) |
| `CLAUDE_CODE_PLAN_V2_AGENT_COUNT` | `7` | presence-guard | [plan-agent-count](./env-and-settings/plan-mode-agent-count.md) |
| `DISABLE_NON_ESSENTIAL_MODEL_CALLS` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` / `DISABLE_TELEMETRY` | `1` | **unconditional** | [traffic-suppression](./env-and-settings/traffic-telemetry-suppression.md) |
| `CLAUDE_CONFIG_DIR` + synthetic cred + onboarding skip | per-launch mirror dir | by design | [config-mirror](./env-and-settings/claude-config-dir-mirror.md) |
| Toolbelt PATH prepend | `PATHS.TOOLBELT_BIN_DIR` | `GH_ROUTER_DISABLE_TOOLBELT=1` | [toolbelt-path](./env-and-settings/toolbelt-path.md) |
| `STRIPPED_PARENT_ENV_KEYS` | strips ~25 leak/conflict keys | by design | [stripped-keys](./env-and-settings/stripped-parent-env-keys.md) |

Also unconditional: `ANTHROPIC_BASE_URL` (route to proxy). Full inventory in [`env-and-settings/README.md`](./env-and-settings/README.md).

## 2. Conditional-surface matrix

What each launch flag / condition turns ON, so a reader can see exactly what a given session exposes. Every session gets the DEFAULT set (the first row, which enumerates the always-on surfaces: the peers critics, `search`, `orchestrate` verify+attest, the `worker-*` dispatchers, the coordinator, hooks #1/#2/#6/#7, the four worker-gated skills, and the always-pushed text blocks + env/settings); the remaining rows layer on top. Conditions are of four kinds, marked inline: launch flags (`--browse`, `--power-browse`, `--fleet`, `--agents`, `--codex-cli`), live-catalog model presence (worker-gate, gemini, stand_in, compressor), and the ai-or-die tab environment. The catalog conditions can INTERSECT a flag: `--browse` exposes 6 lead tools, but `observe`/`extract`/`act`-INTENT need a compressor in the catalog on top of `--browse`, so a `--browse` session on a compressor-less catalog is the documented `-32601` failure mode in section 3.

| Condition | Turns ON |
|---|---|
| **default** (`github-router claude`) | peers critics (codex_critic, codex_reviewer, opus_critic; gemini pair if catalog), `search` (web, code), `orchestrate` verify+attest, five non-blocking `worker-*` dispatchers when the worker gate passes, native `implementer` / `reviewer` / `brainstorm` / `scribe` (always emitted, inheriting the lead when their preferred model chain misses), plus `scout`, `implementer-fast`, and `general-purpose-fast` when their respective qualifying 1M chains resolve, `peer-review-coordinator`, hooks #1/#2/#6/#7, skills gh-research/gh-orchestrate/gh-floor-keeper/gh-worker, all 5 prompt/CLAUDE.md text blocks (toolbelt/style/artifact conditional), all env/settings above |
| **worker-gate present** (a `DEFAULT_MODEL_CHAIN` member, `gpt-5.6-luna` → `gpt-5.4-mini`, with `tool_calls` in the catalog) | workers group (explore/implement/review/plan/test), orchestrate decompose+run, prompt-submit steer #1, worker guard #2, worker skills, worker-* dispatchers. If ABSENT: the entire worker surface + the four worker-gated skills + hook #1 drop |
| **gemini catalog** (`gemini-3.x-pro`) | gemini_critic, gemini_reviewer tools + subagents |
| **stand_in catalog** (all 3 consensus models) | decide group (`stand_in`) |
| **compressor available** (`gpt-5.4-mini` / sonnet-4.6 / haiku-4.5 w/ tool_calls) | browser `observe`/`extract` + `act` INTENT mode (under `--browse`) |
| **`--browse`** | browser lead tools: act, observe, extract, navigate, screenshot, open_tab (6); worker-browse dispatcher; awareness-snippet browser clause |
| **`--power-browse`** (or `GH_ROUTER_ENABLE_POWER_BROWSE=1`) | the 13 browser power primitives (list_tabs, close_tab, read_page, scroll, keyboard, wait, eval_js, download, mouse, drag, type, diagnostics, find) |
| **`--fleet`** (`capability:"fleet"`) | fleet group (15 session-control tools). No awareness-snippet clause and no CLAUDE.md section today |
| **`--agents`** (+ GitHub agent token) | first-mate group (10 mission/PR tools), operator guard #3, gh-first-mate + gh-first-mate-scaffold skills, operator banner/skill steering |
| **`--codex-cli`** | codex_implementer (peers persona, stdio-routed via `codex-implementer` subagent) |
| **ai-or-die tab** (`AIORDIE_SESSION_ID` / bind / trio) | artifact group (8 tools), ARTIFACT_PANEL_DIRECTIVE, gh-artifact-review skill, session-bind hook #4, plan-open hook #5 |

## 3. Cross-surface systemic findings

The highest-severity issues that span more than one surface, ranked by severity, synthesized from the per-surface READMEs and [`mcp/FINDINGS.md`](./mcp/FINDINGS.md). Each links to the detailed adjudication rather than re-dumping it.

### Critical / conditional

- **The `mcp__peers__` hardcode drifts under a `peers` config-key collision** — spans MCP (artifact_open), injected-prompt (ARTIFACT_PANEL_DIRECTIVE), and hooks (plan-open #5). `ARTIFACT_PANEL_DIRECTIVE` (`src/lib/claude-md-injection.ts:48-53`) bakes in `mcp__peers__artifact_*`, but `resolveGroupKeysFromMirror` renames the router's `peers` server to `gh-router-peers` when a user already owns `mcpServers.peers`. On that path the directive routes the model to a server it does not own and the panel never opens. Every other surface threads the resolved key; this one static block breaks the invariant the collision machinery exists to guarantee. Fix: thread `peersKey` into the directive. Detail: [FINDINGS S1/§2](./mcp/FINDINGS.md), [artifact-panel-directive Finding 3](./injected-prompt/README.md). Low-probability precondition, so a maintainer may reasonably schedule as high-Important.

### Important — conditional-injection mismatches (the snippet advertises what the gate can drop)

These share one root class: a text surface (awareness snippet, root CLAUDE.md, or a tool description) advertises a tool the runtime gate can drop, so the fixes are distinct per surface but the review should treat them as one family. The `-32601`-from-drift items under "description / doc drift" below are the same class from the description side.

- **Compressor-backed browser tools advertised on the plain `--browse` gate** — spans injected-prompt (awareness snippet) and MCP (act/observe/extract/find). The snippet names `__act` INTENT / `__observe` / `__extract` whenever `browseEnabled`, but those are dropped from `tools/list` (or raw-throw for `act` INTENT) when no compressor is in the catalog. A `--browse` session on a compressor-less catalog reads the tool in its system prompt and gets `-32601`. Fix: thread `compoundBrowseAvailable` into `buildPeerAwarenessSnippet`. Detail: [FINDINGS S2](./mcp/FINDINGS.md).
- **Root CLAUDE.md describes all 19 browser tools as default `--browse`; only 6 lead tools ship there** — spans MCP (10 browser tools) and the root CLAUDE.md doc. Ground truth is the two-tier split in `docs/browser-mcp-design.md:371`. One CLAUDE.md edit closes ~10 findings. Detail: [FINDINGS S1](./mcp/FINDINGS.md).
- **Fleet has zero system-prompt and zero CLAUDE.md presence** — spans MCP (all 15 fleet tools), injected-prompt (no snippet clause), and env/settings (no design-doc index entry). Each fleet tool's ONLY routing surface is its own description, and several (stop_session, create_session, read_file, search) are under-specified for that load. Fix: add one gated `fleet` awareness clause + a root-CLAUDE.md section + harden the descriptions. Detail: [FINDINGS S7](./mcp/FINDINGS.md).

### Important — the plan-review lifecycle gap (hooks + subagents)

- **Stop-on-plan over-fire resolved; plan peer-review remains unwired** — spans hooks and subagents. Two halves of the same lifecycle:
  - **Resolved:** the `Stop` gate (#6) now short-circuits before typecheck/test/lint when the working tree has no tracked or untracked diff, so plan-only, Q&A, and read-only turns do not pay the suite cost. Untracked files correctly count as a diff and still enter the gate. Detail: [hooks README §synthesis 1 + cross-hook findings](./hooks/README.md).
  - **Open:** NO cross-lab review fires before a plan finalizes (`ExitPlanMode`), the cheapest leverage point. The team's own comment (`codex-mcp-config.ts:193-194`) scoped a default-on `PreToolUse(ExitPlanMode)` peer-review hook as the fallback if coordinator proactive-delegation falls under 7/10; it was never wired. The `peer-review-coordinator` description promises "use proactively before non-trivial plans" that the harness delivers at ~60% soft-steer, and "after non-trivial commits" has no hook anchor at all. Detail: [subagents S2](./subagents/README.md), [hooks README](./hooks/README.md).
- **Operator guard (#3) likely blocks the `worker-*` path it recommends** — a #2/#3 hook interaction. In `--agents` mode #3 denies any `mcp__workers__*` by prefix without checking the caller, so it also denies the dispatcher subagent that #2 exists to allow, breaking the delegation the operator banner recommends. Fix: #3 must allow the dispatcher `agent_type`. Detail: [hooks cross-hook findings](./hooks/README.md).

### Important — over-firing tips / steers (the right amount)

- **Resolved: prompt-submit tips are substantive-prompt-only** — primarily hooks, but they shape model turns. `isNonTrivialPrompt` now returns early for trivial commands and conversational acknowledgements such as `git commit -m fix`, "yes", and "thanks", so neither the static `PROMPT_SEARCH_TIP` nor V2 model-call enrichment fires on those turns. Substantive prompts still receive the search tip. Detail: [hooks synthesis 2](./hooks/README.md).
- **[Suggestion] Named-persona calibration bars in OPERATING_DEFAULTS** — injected-prompt. Grouped here because it is the same over-injection class (spending the highest-salience surface for no floor gain), but it is Suggestion-level per its own doc, not Important. The "aim high" principle appends celebrity calibration (Jobs/Ive, Gates, Bezos); each principle is already stated functionally, so the high-variance name vector can be dropped with no loss. Detail: [injected-prompt Finding 1](./injected-prompt/README.md).

### Important — description / doc drift (the model's mental model is wrong)

- **Worker + peer model defaults updated** — opus_critic now prefers Opus 5 (4.6 fallback), review stays gemini-3.1-pro-preview, explore defaults to gpt-5.6-luna/high, and plan defaults to Opus 5/xhigh. The worker model override remains a free string, with the documented sol/terra/flash 1M ladder.
- **Descriptions naming removed / non-surfaced tools produce `-32601`** — MCP. browser `type` routes to removed `browser_fill`; `codex_implementer` is documented as a peers HTTP tool but is stdio-only (404); `web`/`implement` error strings still say the old names. Detail: [FINDINGS S6](./mcp/FINDINGS.md).
- **`peer-mcp-design.md` model rows refreshed** — the design anchor now records Opus 5 for opus_critic and stand_in, gpt-5.6-luna/high for explore, Opus 5/xhigh for plan, and the worker override ladder.
- **worker-browse dispatcher/schema field mismatch (hard error)** — spans hooks/subagents and MCP. `dispatcherPrompt` passes `prompt`; the browse tool requires `task` and rejects unknown keys → hard `isError`. Detail: [FINDINGS S13](./mcp/FINDINGS.md), [subagents A3](./subagents/README.md).
- **Fast profile: a fast launch profile will replace the whole native/MCP/persona surface on `-m fast`.** A Luna-led (`gpt-5.6-luna`) profile is designed to drop `implementer`/`reviewer`/`brainstorm`/`scribe`/`general-purpose-fast`/the coordinator/all six worker dispatchers and the `workers`/`orchestrate` MCP groups from that profile, keeping only `scout`/`implementer-fast`/`reviewer-fast` (each pinned to a model AND effort via new frontmatter) and the `gemini-critic` persona. The fast-profile-specific roster and effort pins are implemented; keep the audit rows profile-aware rather than assuming the standard roster applies to fast sessions. See [`default-models.md`](../default-models.md) "Fast launch profile".

### Suggestion — minimality / schema-honesty

- **Untyped `...response` spreads + unenforced schema claims** — MCP. Artifact and fleet success paths spread raw upstream responses (index-signature leak risk); size caps ("Max 8 KB", "Max 100 KB") and `additionalProperties:false` are asserted but not enforced; inert schema fields (`read_session.format`, untyped `detection_overrides`). One "make the schema honest" pass. Detail: [FINDINGS S9/S10](./mcp/FINDINGS.md).
- **The toolbelt docstring lie + the unwired operator banner** — injected-prompt / hooks. The toolbelt append docstring claims a `--append-system-prompt` surface it does not have; `OPERATOR_MODE_BANNER` is a defined, test-asserted constant that reaches no model surface. Comment-only, but each could mislead a contributor. Detail: [injected-prompt Finding 2](./injected-prompt/README.md), [hooks cross-hook findings](./hooks/README.md).
- **Backward-only model-default walk + three unconditional traffic vars** — env/settings. The base Opus/Sonnet slugs are hardcoded and only fall backward (no forward walk to a newer Opus 4.9 / Sonnet 6); two of the three traffic vars are set unconditionally with no documented reason for breaking the presence-guard pattern. Detail: [env-and-settings Findings 1-2](./env-and-settings/README.md).

## 4. What raises the floor well today

The surfaces already excellent, so the plan preserves them rather than touching them:

- **The peer-awareness snippet** is the model block: factual present-tense capability inventory, negatively pinned against imperatives/arrows/hedges, with the routing signal correctly living in the tool descriptions. The framing split (snippet inventories, descriptions trigger) is coherent and tested. [injected-prompt README](./injected-prompt/README.md).
- **The Stop gate's monotone design** — a blocking LLM reviewer was rejected twice in 3-lab review as non-monotone; the shipped design is a deterministic hard gate (#6) + an advisory detached review (#7), so a confident-wrong reviewer can never coerce the model into degrading correct code. The over-fire on no-op turns is a tax to trim, not a design flaw. [hooks README](./hooks/README.md).
- **The env/settings presence-guard** — every feature gate, model default, timeout, and picker seed injects only when unset, so any user value (including an opt-out `0`) wins. Consistently applied; the cleanest surface reviewed, and `STRIPPED_PARENT_ENV_KEYS` removes only leak/conflict/noise. [env-and-settings README](./env-and-settings/README.md).
- **The subagent framing split** — imperatives live in the descriptions (where Claude Code's auto-delegation rubric wants them), forbidden in the awareness snippet, and the `worker-*` dispatchers are structurally bounded by the PreToolUse guard so "use this dispatcher" is a correctness steer, not overtrigger. [subagents README](./subagents/README.md).
- **The `code` and `stand_in` tools** — both came through the per-tool audit clean: `code`'s semantic-first + transparent lexical fallback and minimal `{file,line,snippet}` projection, and `stand_in`'s code-driven (not model-driven) consensus protocol with the advisor-not-decider bound holding against code. [mcp FINDINGS §4](./mcp/FINDINGS.md).
- **The overall health bar** — 55 of 71 MCP tools verdict Y. Most N verdicts are fixable description or doc defects; a few are genuine runtime-behavior defects (the worker-browse `prompt`/`task` hard error, the operator-guard/dispatcher block, the compressor-gated `act` raw throw), but none makes a tool unreachable in its DEFAULT config, no schema rejects a well-formed call in the default surface, and every security-relevant claim checked (fleet token-hiding, stand_in advisor-not-decider bound, first-mate write-token gate) held against code. [mcp FINDINGS §1](./mcp/FINDINGS.md).
