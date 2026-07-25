# Review: `mcp__peers__gemini_critic`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Cites `file:line`. Claims verified against code.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__peers__gemini_critic` |
| Group / server | `peers` (serverInfo `github-router-peers`) |
| Wire tool name | `gemini_critic` |
| Definition | `src/lib/peer-mcp-personas.ts:347-361` |
| Always-on? | gated by `requiresGeminiCatalog` |
| Capability gate | `requiresGeminiCatalog: true` → dropped by `personasFor` when `!geminiAvailable` (`src/lib/peer-mcp-personas.ts:358,660`); a `gemini-3.x-pro` model must be in the live catalog |
| Backing model / endpoint | `gemini-3.1-pro-preview` `/v1/chat/completions` (`src/lib/peer-mcp-personas.ts:350-351`) |
| Write-capable | no (`writeCapable: false`, `src/lib/peer-mcp-personas.ts:356`) |

Effort: `allowedEfforts: ["low","medium","high"]`, `defaultEffort: "high"` (`src/lib/peer-mcp-personas.ts:359-360`). No `xhigh` — Copilot's gemini route 400s on it (`reasoning_effort "xhigh" is not supported by model gemini-3.1-pro-preview; supported values: [low medium high]`, empirically verified 2026-05-14; `tests/peer-mcp-personas.test.ts:151-158`). A caller-supplied `xhigh` rejects at the MCP boundary with `-32602 RPC_INVALID_PARAMS` before any Copilot call (`src/routes/mcp/handler.ts:1054-1060`), so the gate is enforced upstream of the upstream, not just documented.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

> `src/lib/peer-mcp-personas.ts:352-353`

"Adversarial second opinion. Backed by gemini-3.1-pro (Google) — third-lab triangulation, strong on formal reasoning, proofs, and invariants. Useful for cross-checking findings from codex_critic or codex_reviewer when you want a third perspective. Pass artifact verbatim."

Input schema (`src/routes/mcp/handler.ts:295-324`), `required: ["prompt"]`, `additionalProperties: false`:
- `prompt` (string): "The lead's brief — the artifact under review plus constraints."
- `context` (string, optional): "Optional additional context (extra file content, prior decisions). Concatenated to the brief before sending."
- `effort` (string, optional): enum `[low | medium | high]`; "Reasoning depth (low | medium | high). Default \"high\". Higher tiers cost more wall-clock; lower tiers are quicker sanity checks. Note: for gemini routed via /v1/chat/completions, the upstream may silently ignore this knob." (the note is appended because `endpoint === "/v1/chat/completions"`, `src/routes/mcp/handler.ts:319-321`.)

Subagent system prompt = `GEMINI_CRITIC_BASE` (`src/lib/peer-mcp-personas.ts:237-248`) + `COLD_START_CONTRACT` + `CRITIC_RUBRIC`, wrapped by `buildAgentPrompt` (`:458-500`). The base frames three routing triggers the lead uses: long-context reasoning over large artifacts (>50k tokens), math/proofs/formal invariants, and cross-checking a conclusion another critic reached (the lead may forward both the artifact and codex-critic's verdict). It carries the anti-sycophancy / anti-manufactured-contrarianism guardrail.

### 2b. System prompt (`--append-system-prompt`)

> `buildPeerAwarenessSnippet`, `src/lib/peer-mcp-personas.ts:576-585,642`. `gemini_critic` is listed CONDITIONALLY — only when `geminiAvailable` (`:580-584`), pinned by `tests/peer-mcp-personas.test.ts:486-499`.

The tool is named inside the critic-list clause, not given its own sentence. When gemini is available the list is:

"Cross-lab peer critics under `mcp__peers__*` (`codex_critic` (gpt-5.6-sol), `codex_reviewer` (gpt-5.3-codex), `gemini_reviewer` (gemini-3.1-pro, line-level code review), `gemini_critic` (gemini-3.1-pro), `opus_critic` (Opus 5)) are available at your discretion for adversarial review. Each tool's description explains its scope and when it applies."

So the snippet names `gemini_critic` + its model `(gemini-3.1-pro)` and defers all scope/when-to-use to the description (`:642`, "Each tool's description explains its scope and when it applies"). No effort tier, no proofs/invariants framing here — by design (the snippet is a capability inventory; routing lives in the description).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering block: peer-awareness (the SAME text as 2b). The mirrored CLAUDE.md gets `buildPeerAwarenessSnippet`'s output verbatim via `appendPeerAwarenessToMirroredClaudeMd` (`src/lib/claude-md-injection.ts:653-663`); this is the descendant-reach surface for Agent-tool subagents / agent-teams teammates that inherit `CLAUDE_CONFIG_DIR` but not `--append-system-prompt`. So 2b and 2c are byte-identical for this tool.

Checked-in root `CLAUDE.md` documents the tool in two places, both consistent with the code: the design-doc pointer line (`CLAUDE.md:13`, "gemini_critic gemini-3.1-pro") and the peer-MCP integration section (`CLAUDE.md:127`, "gemini-critic gemini-3.1-pro-preview … registered alongside gemini-reviewer whenever a gemini-3.x-pro model is in the catalog"). The catalog-gate description matches `requiresGeminiCatalog` + `personasFor` exactly.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: The three routing triggers (third-lab triangulation, formal reasoning/proofs/invariants, cross-checking codex_critic/codex_reviewer) are distinct and actionable, and they match `GEMINI_CRITIC_BASE`'s stated strengths (`:237-243`). The differentiation from `codex_critic` is real: codex_critic = "strongest reasoning model, cross-lab diversity"; gemini_critic = "third-lab, proofs/invariants, cross-check a critic's finding." A model choosing between them has a usable signal.
- **Missing "when NOT"**: Every sibling critic states a redirect — codex_critic "Not for line-level code review (use codex_reviewer)"; codex_reviewer "Not suited for architecture… (use codex_critic)"; gemini_reviewer "Not for architecture (use codex_critic / gemini_critic)." gemini_critic has NO "when-not" clause. Anthropic's tool-use guidance (cited in `tests/peer-mcp-personas.test.ts:106-109`) wants scope + when-to-use + when-NOT-to-use for complex tools. This is the one routing-signal gap.
- **Accuracy vs implementation**: Model id in the description is "gemini-3.1-pro" while the code slug is "gemini-3.1-pro-preview" (`:350`). The `-preview` drop is deliberate and consistent across all human-facing surfaces (2a/2b/2c), and the design doc notes a GA rename auto-resolves through the gate (`docs/peer-mcp-design.md:512`). Not a defect. No stale default, gate, or behavior claim.
- **Effort tier**: The description says nothing about effort; the schema `effort` field carries the tiers + the honest "may silently ignore this knob" caveat (`src/routes/mcp/handler.ts:316-321`). Correct division — the effort knob is schema-level, not prose-level, and the caveat prevents the model from over-trusting a no-op.
- **Schema minimality**: `prompt` (required), `context` (the verbatim-artifact affordance the cold-start contract needs), `effort` (model-tunable, gated to the three tiers the model accepts). All three are required-to-call, tunable, or actionable. No echoed-input or diagnostic-only fields. Passes the "ruthlessly minimal" bar (`docs/peer-mcp-design.md`).

### 3b. System-prompt coverage

- **Named**, conditionally, only when `geminiAvailable` — correct: the snippet must never name a tool absent from the live `tools/list` (`src/lib/peer-mcp-personas.ts:535-536`), and the same gate drops the tool from `tools/list`. No gap.
- **Non-redundant**: The snippet gives only name + model and explicitly defers scope to the description (`:642`). It does not restate the proofs/invariants framing, so there is no drift risk between snippet and description.
- **Framing-constraint compliance**: The clause is a pure capability statement ("critics … are available at your discretion for adversarial review"). No imperative, no hedge, no anchor. Compliant with the negative pins in `tests/peer-mcp-personas.test.ts:516-552`.

### 3c. CLAUDE.md coverage

- Injected block (2c) is byte-identical to the system-prompt snippet, so it inherits the same accuracy and the same single gap (no "when-not"). Not drifted.
- Checked-in root CLAUDE.md agrees with the code on model, gate, and co-registration with gemini_reviewer (`CLAUDE.md:13,127`).

### 3d. Cross-surface consistency

The shared awareness snippet now lists `opus_critic (Opus 5)`, matching that persona's preferred runtime model. For gemini_critic itself, model, gate, effort tiers, and endpoint remain consistent across description ↔ snippet ↔ CLAUDE.md ↔ code.

## 4. Findings

- **[Important]** `src/lib/peer-mcp-personas.ts:352-353` — the description has no "when-NOT" redirect, the only critic/reviewer persona missing one. A model can misroute a concrete-diff line-level review here instead of to `gemini_reviewer`/`codex_reviewer`. Fix: add a short redirect mirroring the siblings, e.g. append "Not for line-level code review (use codex_reviewer / gemini_reviewer)." Keep it under the 400-char cap (`tests/peer-mcp-personas.test.ts:109`); current string is ~250 chars, so there is room.

- **[Suggestion]** `src/lib/peer-mcp-personas.ts:352` — the opener "Adversarial second opinion." is byte-identical to `codex_critic`'s "Adversarial second opinion on plans, designs, or code tradeoffs" prefix and gives no first-line differentiation; the distinguishing content ("third-lab triangulation", proofs/invariants, cross-check) only arrives in sentence two. Optional: lead with the differentiator (e.g. "Third-lab adversarial second opinion…") so the routing signal is front-loaded. Non-blocking.

- No adjacent opus_critic model-label finding remains: the shared snippet and preferred runtime model both say Opus 5.

## 5. Verdict

Y — gemini_critic's injected surface is correct, minimal, consistent across all three surfaces, and its model/gate/effort facts match the code (including the `-32602` rejection of `xhigh` and the honest "may silently ignore this knob" effort caveat). Single most important fix: add a "when-NOT" redirect to line-level code review in the description, so it is not the one critic persona that lets the model misroute a concrete diff.
