# Review: `mcp__peers__codex_reviewer`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__peers__codex_reviewer` |
| Group / server | `peers` (serverInfo `github-router-peers`) |
| Wire tool name | `codex_reviewer` |
| Definition | `src/lib/peer-mcp-personas.ts:362-375` (spec); description at `:368` |
| Always-on? | yes (no `requiresGeminiCatalog`; `requiresHttp: false`, so it survives even in `--codex-cli` stdio mode) |
| Capability gate | none (unconditionally in `PERSONAS_READ`; `personasFor` only filters on `requiresGeminiCatalog` — `peer-mcp-personas.ts:660`) |
| Backing model / endpoint | `gpt-5.3-codex` `/v1/responses` (`:365-366`) |
| Write-capable | no (`writeCapable: false`, `:371`) |

Effort surface: `allowedEfforts: ["low","medium","high","xhigh"]`, `defaultEffort: "xhigh"` (`:373-374`), confirmed by `tests/peer-mcp-personas.test.ts:135,142`.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/peer-mcp-personas.ts:368`):

> "Line-level review of a concrete diff or single file. Backed by gpt-5.3-codex (OpenAI, ≈272K-token input window) — code-specialist, fastest critic (~16s). Surfaces bugs, edge cases, security issues, and idiom violations at specific line numbers. Not suited for architecture or design review (use codex_critic for plans). Pass artifact verbatim."

Input schema (built in `src/routes/mcp/handler.ts:295-324`; identical shape for every persona):

- `prompt` (string, **required**): "The lead's brief — the artifact under review plus constraints."
- `context` (string, optional): "Optional additional context (extra file content, prior decisions). Concatenated to the brief before sending."
- `effort` (string, optional, `enum: ["low","medium","high","xhigh"]`): "Reasoning depth (low | medium | high | xhigh). Default \"xhigh\". Higher tiers cost more wall-clock; lower tiers are quicker sanity checks. " (the gemini `/v1/chat/completions` "may silently ignore this knob" clause is NOT appended — codex_reviewer is `/v1/responses`, `handler.ts:319-321`).

### 2b. System prompt (`--append-system-prompt`)

`buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:576-579`) names this tool in the always-on critic list, verbatim:

> "`codex_reviewer` (gpt-5.3-codex)"

That is the ONLY mention in the awareness snippet — model id only, no scope/routing clause. This is by design: the snippet is a pure capability inventory and defers the when/when-not routing to each tool's own `description` (`:507-528`; regression-pinned that the snippet merely names `codex_reviewer` at `tests/peer-mcp-personas.test.ts:320`). Paragraph 1 adds the shared clause "Each tool's description explains its scope and when it applies" (`:642`), which is what carries the reader from the bare name to surface 2a.

Subagent system prompt — `codex_reviewer` is ALSO auto-injected as a Claude Code subagent (`agentName: "codex-reviewer"`). `buildAgentPrompt` (`:487-499`) wraps `REVIEWER_BASE` (`:250-271`):

> "You are codex-reviewer, a line-level code reviewer running on gpt-5.3-codex. You are the code-specialist persona — your job is to read concrete code (diffs, single files, function bodies) and surface bugs, edge cases, security issues, and idiom violations. You are not a critic-of-architecture. If the brief is a plan or a high-level design, redirect: 'this looks like architecture review; consider codex-critic or gemini-critic.' Your tool is the magnifying glass, not the wide-angle lens." (+ `COLD_START_CONTRACT` + a `## Summary` / `## Findings` reply-format block + a self-reminder to cite real `file:line` and rank by impact-in-this-codebase.)

The subagent `.md` `description:` field (Task-tool enum surface) is the same string as 2a — `buildPeerAgentDefinitions` passes `persona.description` through (`codex-mcp-config.ts:289-301`, `buildAgentMd` at `:450-473`).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering block: **peer-awareness** (marker `gh-router peer-mcp awareness`). `appendPeerAwarenessToMirroredClaudeMd` (`src/lib/claude-md-injection.ts:653-663`) writes the SAME `buildPeerAwarenessSnippet` text as surface 2b into the mirror, so the mirrored coverage of this tool is identical to 2b: the bare `` `codex_reviewer` (gpt-5.3-codex) `` list entry. No separate CLAUDE.md-only clause exists for this tool.

Checked-in root `CLAUDE.md`: the tool is documented in the "Peer-model MCP integration" section (`CLAUDE.md`, the paragraph beginning "The `claude` subcommand auto-injects peer-model review tools…"), naming `codex-reviewer gpt-5.3-codex` and the peers group split. It agrees with the code (model id, group, always-on). The root doc pointer at `CLAUDE.md:13` also lists "codex_reviewer gpt-5.3-codex". The empirical latency + effort matrix backing the "~16s" and "xhigh default" claims lives in `docs/peer-mcp-design.md:174,186` (probed 2026-05-14).

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: strong. "Line-level review of a concrete diff or single file" + "at specific line numbers" gives a sharp positive trigger; "Not suited for architecture or design review (use codex_critic for plans)" gives an explicit when-NOT with a redirect target. The `REVIEWER_BASE` subagent prompt reinforces the same boundary ("magnifying glass, not the wide-angle lens").
- **Differentiation from `codex_critic`**: clean. codex_critic is "plans, designs, or code tradeoffs … Not for line-level code review (use codex_reviewer)"; codex_reviewer is the mirror image. The two descriptions cross-reference each other, so the pair reads as a matched split.
- **Differentiation from `gemini_reviewer` (the OTHER line-level reviewer)**: this is the weak seam. codex_reviewer's description gives the model NO signal that a second line-level reviewer exists or when to prefer one lab over the other. gemini_reviewer's own description does the work unilaterally ("catches a different slice of defects than codex_reviewer (OpenAI)", "Use alongside codex_reviewer for cross-lab coverage", `:382`), but codex_reviewer is silent on the cross-lab pairing. A model reading only codex_reviewer's card cannot learn that pairing it with gemini_reviewer buys blind-spot coverage. See Finding 2.
- **Accuracy vs implementation**: model id `gpt-5.3-codex` ✅ (`:365`, pinned `tests/…:51,90`). Endpoint `/v1/responses` ✅. "≈272K-token input window" ✅ — this is the model's `max_prompt_tokens` (input window), consistent with `codex-mcp-config.ts:235,246`; it is a DIFFERENT measure from the 400k TOTAL context cited in `docs/anthropic-translation-shim.md:46,349`, so the two figures do not conflict (input window vs input+output). "fastest critic (~16s)" and the `xhigh` default — see Finding 1 (the 16s is a `high`-effort measurement, but the default effort is `xhigh`).
- **Schema minimality**: compliant. `prompt` (required to call), `context` (model-tunable — extra artifact bytes), `effort` (model-tunable, `enum` scoped to `allowedEfforts`). No echoed inputs, no diagnostic-only fields. Meets the "ruthlessly minimal MCP tool surface" bar (`docs/peer-mcp-design.md` §"ruthlessly minimal").

### 3b. System-prompt coverage

- **Named**: yes, in the always-on critic list (`:578`), model id only. Correct by the snippet's design — routing is delegated to the description.
- **Accurate & non-redundant**: yes. It does not restate the description's scope, so no duplication cost.
- **Framing-constraint compliance**: passes. The list entry is a bare backticked name + model, no imperative / hedge / anchor. The negative pins in `tests/peer-mcp-personas.test.ts:516-552` (no `Lead with`, no `Reach for`, no em dash, no `→`) hold for this entry.

### 3c. CLAUDE.md coverage

- **Accurate, non-drifted**: the injected peer-awareness block is byte-identical to 2b (same builder), so it cannot drift from the system prompt. The checked-in root `CLAUDE.md` prose agrees with the code on model id, group, and always-on status.
- **Injected vs checked-in consistency**: consistent. No contradiction between the mirrored block and the root doc.

### 3d. Cross-surface consistency

One real cross-surface conflict, internal to the docs rather than the tool card: `docs/peer-mcp-design.md:163` still asserts the persona default effort is **`high`** ("default **`high`** … raise to `xhigh` for explicit deep dives"), which contradicts the actual `defaultEffort: "xhigh"` in code (`:374`), the doc's OWN effort table (`:186`, xhigh), and the tool schema's "Default xhigh" text. The model-facing surfaces (description, schema, snippet) are self-consistent at `xhigh`; the stale `high` lives only in design-doc prose. Low blast radius (docs, not the injected surface) but it is exactly the kind of drift a future editor would copy back into a description. See Finding 3.

## 4. Findings

- **[Important]** `src/lib/peer-mcp-personas.ts:368` — the description's "(~16s)" is a `high`-effort latency, but the tool's default effort is `xhigh`. The only measured number in `docs/peer-mcp-design.md:174` is `codex_reviewer / high / 16.0s`; there is no `xhigh` measurement for this persona, and codex_critic's own high→xhigh jump (23.8s → 56.3s, `:172,171`) shows xhigh is materially slower. A model reading "fastest critic (~16s)" and then invoking at the `xhigh` default will routinely see 2-3x that wall-clock, undercutting the one quantitative routing signal the card offers. Fix: either qualify the figure ("~16s at `high`") or drop the parenthetical and keep the qualitative "fastest critic" (the relative ranking is robust; the absolute number pinned to the wrong effort is not).

- **[Important]** `src/lib/peer-mcp-personas.ts:368` — codex_reviewer's description does not mention `gemini_reviewer`, the co-registered second line-level reviewer, so the cross-lab-coverage routing lives one-directionally in gemini_reviewer's card only (`:382`). A model that reaches for line-level review by reading codex_reviewer alone gets no signal that a decorrelated second-lab reviewer exists or that pairing them buys blind-spot diversity. Fix: add a short symmetric clause, e.g. "For cross-lab coverage of the same diff, pair with `gemini_reviewer` (Google)." Keep it descriptive (no imperative) to stay within the framing constraint. Note this only applies when `gemini_reviewer` is registered (its `requiresGeminiCatalog` gate); phrase so the mention is harmless when gemini is absent, or accept that the tool card is static while registration is conditional (a known, tolerated asymmetry — the snippet gates gemini, the description cannot).

- **[Suggestion]** `docs/peer-mcp-design.md:163` — stale "default `high`" prose contradicts the shipped `defaultEffort: "xhigh"` (`peer-mcp-personas.ts:374`), the doc's own table (`:186`), and every model-facing surface. Not part of the injected surface, so it does not misroute the model today, but it is a drift trap for the next editor. Fix: update the sentence to say the codex personas default to `xhigh` (SSE-streamed, off the per-tool-call clock), matching the table two paragraphs down.

- **[Suggestion]** Description consistency polish — codex_critic and opus_critic descriptions carry an explicit "(OpenAI …)" / lab tag inline; codex_reviewer says "(OpenAI, ≈272K-token input window)" which already carries the lab. No change needed, noted only to confirm the lab-attribution is present and consistent across the peers group (relevant to the Finding 2 pairing clause, which would add "(Google)" for gemini symmetry).

## 5. Verdict

**Y (correct, minimal, consistent, well-routed) with one nuance.** The injected surface is accurate on model / endpoint / window / gate, schema-minimal, framing-compliant, and sharply differentiated from `codex_critic`. Single most important fix: correct or qualify the "~16s" latency, which is measured at `high` but the tool defaults to `xhigh` (Finding 1); a close second is adding the symmetric `gemini_reviewer` cross-lab-pairing clause so line-level routing is not one-directional (Finding 2).
