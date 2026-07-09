# CLAUDE.md injection vs the base Claude Code system prompt

A skeptical, redundancy-first evaluation of what `github-router claude` prepends/appends into the **mirrored CLAUDE.md** (read by the main agent AND every descendant that inherits `CLAUDE_CONFIG_DIR`). Distinct from the sibling files in this directory, which grade prompt-engineering *register* (positive vs prohibitive, overtrigger, enforcement claims). This file asks three narrower questions per block:

1. **Redundancy vs the base prompt** — does Claude Code's DEFAULT built-in system prompt already elicit this? Classify REDUNDANT / COMPLEMENTARY / NECESSARY / POTENTIALLY-CONFLICTING.
2. **Required per Anthropic's memory guidance?** — does putting THIS in CLAUDE.md follow [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory) and the prompt-engineering docs, or should it live elsewhere (system prompt / tools/list) or be dropped?
3. **Duplication across our two surfaces** — the system prompt gets a digest + a ~300-tok capability summary; CLAUDE.md gets the full directive + the full peer inventory. Is the CLAUDE.md copy well-placed?

## What is actually injected (verified in source)

Verified against `src/lib/claude-md-injection.ts`, `src/lib/peer-mcp-personas.ts`, `src/lib/toolbelt/index.ts`, and the wiring in `src/claude.ts`. The five CLAUDE.md blocks, in final top-to-bottom order:

| # | Block | Constant / builder | CLAUDE.md position | Also on system prompt? | Gate |
|---|---|---|---|---|---|
| 1 | OPERATING_DEFAULTS_DIRECTIVE | `claude-md-injection.ts:112-137` | top | Yes — DIGEST leads the single `--append-system-prompt` (`claude.ts:1123-1128`) | unconditional |
| 2 | STYLE_DIRECTIVE | `claude-md-injection.ts:75-80` | top (below #1) | No | best-effort, default path |
| 3 | ARTIFACT_PANEL_DIRECTIVE | `claude-md-injection.ts:48-60` | top (only in ai-or-die tab) | No | `artifactToolsEnabled()` (ai-or-die env trio) |
| 4 | Toolbelt awareness line | `toolbelt/index.ts:89-97` | bottom | No | `toolbeltEnabled()` + non-empty tool list |
| 5 | Peer-awareness inventory | `buildPeerAwarenessSnippet`, `peer-mcp-personas.ts:555-666` | bottom | A ~300-tok SUMMARY (`buildPeerAwarenessSummary`) rides after the digest (`claude.ts:1123-1128`) | codex-mcp block; contents gated per live catalog |

Two blocks reach the main agent on both surfaces (OPERATING_DEFAULTS as full-in-CLAUDE.md / digest-in-system-prompt; peer inventory as full-in-CLAUDE.md / summary-in-system-prompt). The marker fences are HTML comments (`<!-- gh-router ... -->`), and Anthropic's memory doc confirms **block-level HTML comments are stripped before injection** — so the fences cost zero context tokens. Good.

**Staleness note on the sibling audit:** `operating-defaults-directive.md` in this directory quotes an OLDER "Aim high" text carrying the Jobs/Ive/Gates/Bezos names and a `no impersonation, name-dropping, or theatrics` guardrail, and its headline recommendation is "drop the names." The **current** source (`claude-md-injection.ts:122-137`, design comment at `:98-100`) has ALREADY dropped the names — the "Aim high" paragraph is now fully functional prose. That recommendation is implemented; treat the sibling file's Finding 1 as historical.

## Grounding: what the base prompt covers, and what Anthropic says belongs in CLAUDE.md

Authoritative sources: [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory) (the memory doc) and the [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices) page. Load-bearing facts used throughout:

- **CLAUDE.md is a USER message delivered AFTER the system prompt**, not part of it ("CLAUDE.md content is delivered as a user message after the system prompt"). So the base system prompt is the higher-authority surface, and `--append-system-prompt` is Anthropic's recommended lever for "instructions you want at the system-prompt level."
- **Keep it concise; target under 200 lines**; "longer files consume more context and reduce adherence." "The more specific and concise your instructions, the more consistently Claude follows them." The best-practices page is blunter: *"Keep it concise. For each line, ask: 'Would removing this cause Claude to make mistakes?' If not, cut it. Bloated CLAUDE.md files cause Claude to ignore your actual instructions!"* — this is the test applied to every REDUNDANT verdict below.
- **What belongs**: "Coding standards, workflows, project architecture", "build commands, conventions, project layout, 'always do X' rules" — i.e. project-specific things the model would otherwise re-explain, that it can't infer.
- **What does NOT belong**: "If an entry is a multi-step procedure or only matters for one part of the codebase, move it to a skill or a path-scoped rule."
- **Consistency is explicit**: "if two rules contradict each other, Claude may pick one arbitrarily." This is the test for POTENTIALLY-CONFLICTING.
- **Tool routing** belongs in the tool's own description (tools/list), which Claude receives every turn; the peer-awareness builders' own docstrings already commit to this ("tool descriptions carry the routing signal (when/when-not); the awareness snippet should describe capabilities in factual present tense").
- **Base-prompt coverage** (confirmed via the claude-code-guide agent + the memory doc's framing): Claude Code's built-in system prompt already pushes concision/direct answers ("minimize output tokens ... only address the specific query or task at hand"), parallel tool calls for independent ops (provable directly — the live harness preamble says "if there are no dependencies between the calls, make all of the independent calls in the same block"), plan-mode *mechanism*, destructive-op caution (partly a permission-system safety net, partly base-prompt language), and general tool-usage hygiene. It does **NOT** contain an anti-em-dash rule, and it **DOES** self-attribute by default: Claude Code appends `Co-Authored-By: Claude` to commits and a "Generated with Claude Code" line to PRs unless disabled via the `attribution` settings key (`{"commit": "", "pr": ""}`). Note the base "delegate" posture is "delegate when it clearly helps," so the proxy's stronger orchestrate default is a genuine escalation, not a restatement.

## Summary table

| Block | Classification | Base-prompt overlap | Anthropic-guideline alignment | Recommendation |
|---|---|---|---|---|
| **1. OPERATING_DEFAULTS "Orchestrate"** | COMPLEMENTARY | Partial — base elicits parallel tool use + some delegation, but not proxy-specific worker/critic surface | Aligned. Project-specific "always do X" default; names the proxy's own delegation surface the base can't know | **Keep** |
| **1. OPERATING_DEFAULTS "Aim high"** | REDUNDANT (leaning) | High — generic good-agent posture the base already elicits; nothing proxy-specific | Weak. Not project-specific; it's a quality exhortation, not a convention the model can't infer | **Trim** — lowest-value block |
| **1. OPERATING_DEFAULTS "Engineering excellence"** | POTENTIALLY-CONFLICTING | Conflicts with base concision/minimalism posture | Risky per the consistency rule; "fix any lint/test/flake on sight, give little weight to dev cost" is a deliberate expansion the base actively counters | **Keep but scope tightly** (highest-value finding) |
| **2. STYLE — concise / natural voice** | REDUNDANT | High — base already pushes concision | Redundant restatement of base behavior | **Trim** (fold into the two necessary clauses) |
| **2. STYLE — no em dashes / no attribution** | NECESSARY | None — base has no em-dash rule and DEFAULTS to self-attribution | Textbook CLAUDE.md content: user-specific config the model can't infer and that overrides a base default | **Keep** |
| **3. ARTIFACT_PANEL_DIRECTIVE** | NECESSARY (when gated on) | None — environment-specific, base can't know the ai-or-die panel exists | Borderline: it's a multi-step playbook, which the memory doc says to move to a skill. A skill (`gh-artifact-review`) already exists | **Trim to a pointer** at the skill; keep the one-line "default to the panel" steer |
| **4. Toolbelt awareness** | NECESSARY | None — runtime fact (which CLIs are on PATH) the base can't know | Aligned: concise, factual, project/environment-specific | **Keep** |
| **5. Peer-awareness inventory** | COMPLEMENTARY | None for the specific tools; but see caveat | Aligned as a capability MAP; the per-tool WHEN-to-use routing is (correctly) left to tools/list. The higher-level "which tool for which job" framing adds real value | **Keep** (it is the model block) |

## Per-block detail

### 1. OPERATING_DEFAULTS_DIRECTIVE

Three sub-directives with sharply different verdicts. Treating them as one block hides that.

**"Orchestrate" — COMPLEMENTARY, keep.** The base prompt already elicits parallel tool calls and some delegation instinct, but it cannot know this proxy ships `worker-*` background agents, peer critics, and orchestrate tools. Naming that surface and giving a default posture ("delegate the heavy/parallel/context-heavy work, do last-mile directly") is exactly project-specific "always do X" context the model can't infer. The explicit carve-out ("Do trivial, surgical, and last-mile work directly") is load-bearing: without it a precise-following model over-delegates, which the base prompt's own subagent-overuse hazard warns against. This is well-placed and additive.

**"Aim high" — REDUNDANT (leaning), trim.** "Radical simplicity", "first principles", "work backwards from the outcome the user actually needs", "question every assumption" is generic good-agent posture. It names nothing proxy-specific and nothing the model can't infer; it is a quality exhortation. The memory doc's specificity test ("write instructions that are concrete enough to verify") fails here — there is no verifiable behavior, unlike "run `npm test` before committing." This is the lowest-value paragraph in the whole injected set. It is not harmful (no conflict, no overtrigger register), but it spends top-of-file salience on a platitude. Candidate to drop or compress to a single clause.

**"Engineering excellence" — POTENTIALLY-CONFLICTING, keep but scope tightly. This is the highest-value finding.** Two clauses cut directly against the base prompt:

- *"When making technical decisions, give little weight to development cost; prefer quality, simplicity, robustness, scalability, and long-term maintainability."* The base Claude Code prompt pushes doing what's asked and not gold-plating (the "don't add features/tests/docs not requested" minimalism that the harness is known for). "Give little weight to development cost" is a deliberate inversion.
- *"a lint error, a failing test, or a flaky test is worth fixing the moment you see it, whoever introduced it and whether or not it touches your current work."* This explicitly authorizes scope expansion beyond the requested task — the exact thing the base prompt discourages.

Per the memory doc, "if two rules contradict each other, Claude may pick one arbitrarily." The override header ("apply when the user has not specified otherwise; the user's explicit direction ... always override") mitigates but does not resolve the *internal* tension: within a single task the base says "stay in scope / minimal" and this says "expand scope to fix unrelated breakage." A precise-following Opus 4.8 can land on either.

This is a genuine, intentional user preference (it mirrors the user's own `~/.claude/CLAUDE.md`), so the recommendation is NOT to drop it — it's to make the expansion boundary unambiguous so the model doesn't have to guess. Concretely: keep the "reproduce a bug end-to-end before fixing" and "pixel-perfect UI" clauses (those are quality bars, not scope expansions and don't conflict), and tie the "fix lint/test/flake on sight" clause to a clear trigger ("when you touch a file / run the suite and see a failure") rather than the unbounded "whether or not it touches your current work," which is what collides with base minimalism. Severity: Important (a real contradiction the consistency rule flags), not Critical (no correctness/security/data-loss).

**Duplication:** the CLAUDE.md copy is the full statement; the system prompt gets `OPERATING_DEFAULTS_DIGEST`. This split is correct — the digest wins main-agent salience, the full copy reaches descendants. The double exposure is cheap (short block) and justified.

### 2. STYLE_DIRECTIVE

Four clauses, two verdicts.

**"Write concisely without losing detail. Use a natural human voice." — REDUNDANT.** The base Claude Code prompt already pushes concision hard (it is one of the most-remarked base behaviors). Restating it in CLAUDE.md adds little. "Natural human voice" is mild anti-corporate-slop steering; marginal but nearly free.

**"Avoid em dashes. Do not attribute work to Claude/AI/LLM/Anthropic anywhere (commits, PRs, issues, code, comments, docs)." — NECESSARY.** This is the clearest-cut NECESSARY block in the set. The base prompt has no em-dash rule, and Claude Code **self-attributes by default** (`Co-authored-by: Claude`, "Generated with Claude Code"). So the anti-attribution clause overrides a live base default — precisely "project-specific things the model can't infer" and the canonical CLAUDE.md use. The enumerated scope keeps a precise-following model from over-generalizing.

**Guideline alignment / placement:** CLAUDE.md-only is correct (house-style context, needs descendant reach so a teammate committing code also suppresses attribution, doesn't need to win over user instructions). One caveat worth flagging beyond the sibling file: the anti-attribution rule is *context, not enforcement* per the memory doc. If suppressing the trailer matters as hard as the user's config implies, the durable lever is the Claude Code `attribution` settings key (`{"commit": "", "pr": ""}`), not a CLAUDE.md sentence Claude "tries to follow." Recommendation: keep the CLAUDE.md clause AND set the deterministic `attribution` key so attribution can't leak on a turn where the model forgets. Trim the redundant concision clause (or merge it so the block is just the two necessary rules + natural-voice).

### 3. ARTIFACT_PANEL_DIRECTIVE

**Classification: NECESSARY when gated on, but mis-shaped.** It only injects inside an ai-or-die tab (`artifactToolsEnabled()`), where the `mcp__peers__artifact_*` panel genuinely exists and the base prompt can't know about it. So the *awareness* is necessary. But the block is a ~2KB multi-step playbook (author self-contained HTML, open, drain feedback with `await`+cursor, revise, reply, end; per-type cheatsheet; `data-aod-*` control syntax). The memory doc is explicit: **"If an entry is a multi-step procedure ... move it to a skill."** And that skill already exists — the block's own last line points at `gh-artifact-review`.

So the full playbook in CLAUDE.md duplicates the skill and violates the move-procedures-to-skills guidance. Recommendation: **trim to a pointer** — one or two lines ("You are in an ai-or-die tab; default to an HTML artifact in the `mcp__<peers>__artifact_*` panel for anything the user should review before you proceed. The `gh-artifact-review` skill carries the playbook.") and let the skill carry the mechanics. This also shrinks the highest-salience top-of-file region.

(The sibling `artifact-panel-directive.md` separately flags the hardcoded `mcp__peers__` prefix / group-key drift; the current source parameterizes on `peersKey` at `claude-md-injection.ts:48-49` and the caller passes `groupKeys.peers` at `claude.ts:816`, so that specific finding appears resolved. Not re-litigated here.)

### 4. Toolbelt awareness line

**Classification: NECESSARY, keep.** One line: "Fast CLI tools are available on your PATH; prefer them when applicable: rg ..., fd ..., ...". This is a pure runtime fact — *which* gap-filled CLIs the launcher materialized onto PATH this session — that the base prompt cannot know. Concise, factual, present-tense, exactly what the memory doc's "build commands / tooling" bucket is for. CLAUDE.md-only is correct (descendant workers share the PATH). No conflict, no redundancy. The only nit (documented in the sibling file) is a stale docstring claiming it also rides `--append-system-prompt`; it does not. Comment-only.

### 5. Peer-awareness inventory

**Classification: COMPLEMENTARY, keep — this is the model block.** The adversarial question: *is restating a tool catalog in CLAUDE.md redundant with the tools/list descriptions Claude gets every turn?* Answer: **no, because the two carry different information.**

- tools/list gives Claude, per tool, a self-contained description with WHEN/WHEN-NOT routing (verified: each persona's `description` field and each `NonPersonaMcpTool.description` are rich and routing-complete). That is the right home for per-tool routing, and the builders deliberately keep it there.
- The CLAUDE.md inventory does NOT restate per-tool routing (its docstring forbids imperatives/anchors, pinned by negative tests). It provides the *cross-tool map* — the relationships tools/list structurally cannot express: that `worker-*` are non-blocking background dispatchers, that the raw `mcp__workers__*` are guarded plumbing the dispatchers call (not a main-agent interface), that `decompose`/`run_workflow` compose+run what workers execute, that subagents inherit the whole surface via the mirrored `.claude.json`, and which skills exist. tools/list has no slot for "these five tools relate like so" or "spawned subagents also see all of this." That inheritance fact is load-bearing UX the per-tool descriptions can't carry.

So it is COMPLEMENTARY, not REDUNDANT. It also correctly gates its contents on the live catalog (never names a tool tools/list dropped), which is the discipline that keeps a map from lying.

**One caveat — length.** At ~1.1k tokens the full inventory is the largest single block and lives at the bottom of CLAUDE.md. The design already mitigates the *system-prompt* cost by sending only the ~300-tok summary there, keeping the full inventory out of every-turn context (it rides in the CLAUDE.md user message, loaded once). This split is the right call and matches Anthropic's "keep the high-salience surface small" instinct. The residual question is whether the full inventory earns its ~1.1k tokens of the sub-200-line CLAUDE.md budget on every session, or whether a large slice of it (the skills paragraph, the orchestrate paragraph, the browse tiers) could itself become a skill/rule loaded on demand. Given it is a stable map read once and gated to real capabilities, keeping it is defensible; it is the single biggest lever if the CLAUDE.md budget is ever pressured. Suggestion-level.

## Highest-value recommendation

**Resolve the "Engineering excellence" scope conflict (block 1).** It is the only POTENTIALLY-CONFLICTING block: "give little weight to development cost" and "fix lint/test/flake whether or not it touches your current work" contradict the base prompt's stay-in-scope/minimalism posture, and the memory doc says contradictory rules make Claude choose arbitrarily. Keep the user's intent but bound the scope-expansion clause to a concrete trigger (a failure you hit while touching a file / running the suite) instead of the unbounded "whether or not it touches your current work," so a precise-following model doesn't have to guess which rule wins mid-task.

Secondary, lower-effort trims that raise signal-to-noise without removing capability: drop/compress the REDUNDANT "Aim high" platitude and the redundant STYLE concision clause; reduce the ARTIFACT playbook to a pointer at the `gh-artifact-review` skill (per the move-procedures-to-skills rule); and pair the NECESSARY anti-attribution rule with the deterministic `attribution: {"commit": "", "pr": ""}` settings key so it can't leak on a forgetful turn. Every one of these passes the best-practices "would removing this cause Claude to make mistakes?" test — the trims remove lines whose removal would NOT.

## Sources

- [Claude Code memory (CLAUDE.md) doc](https://code.claude.com/docs/en/memory) — CLAUDE.md-is-a-user-message-after-the-system-prompt, sub-200-line/concise target, what-belongs (standards/workflows/architecture/"always do X"), move-multi-step-procedures-to-skills, consistency (contradictions → arbitrary pick), HTML-comment stripping.
- [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices) — specificity ("concrete enough to verify"), positive-over-prohibitive, functional roles, dial-back-aggressive-language overtrigger, subagent-overuse hazard.
- [Claude Code best practices](https://code.claude.com/docs/en/best-practices) — "Keep it concise. For each line, ask: 'Would removing this cause Claude to make mistakes?' If not, cut it. Bloated CLAUDE.md files cause Claude to ignore your actual instructions!"; delegate-to-subagents guidance.
- [Tool-use / Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use) — routing signal ("what it does, when it should be used, and when it shouldn't") belongs in each tool's `description`, delivered per turn via tools/list.
- [Settings reference — `attribution` key](https://code.claude.com/docs/en/settings) — the deterministic `{"commit":"","pr":""}` backstop for the anti-attribution rule.
- Base-prompt behavior (concision, parallel tool calls, plan mode, destructive-op care as base defaults; no em-dash rule; default `Co-Authored-By: Claude` / "Generated with Claude Code" attribution) — confirmed via the claude-code-guide agent and Anthropic docs.
- Source of truth for the injected blocks: `src/lib/claude-md-injection.ts`, `src/lib/peer-mcp-personas.ts` (`buildPeerAwarenessSnippet` / `buildPeerAwarenessSummary`), `src/lib/toolbelt/index.ts` (`buildToolbeltAwareness`), wiring in `src/claude.ts` (~L468-505, ~L807-819, ~L1038-1137).
- Sibling audits in this directory (`README.md`, per-block files) — register/overtrigger/enforcement grading and the group-key-drift findings; note the operating-defaults file quotes a superseded (named-persona) version of "Aim high."
