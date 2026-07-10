# Review: `mcp__peers__gemini_reviewer`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__peers__gemini_reviewer` |
| Group / server | `peers` (serverInfo `github-router-peers`) |
| Wire tool name | `gemini_reviewer` |
| Definition | `src/lib/peer-mcp-personas.ts:376-397` |
| Always-on? | gated by `requiresGeminiCatalog` (gemini-3.x-pro in live catalog) + `requiresHttp` |
| Capability gate | `requiresGeminiCatalog` → `personasFor()` drops it when `!geminiAvailable` (`src/lib/peer-mcp-personas.ts:660`); `requiresHttp` → excluded from codex-cli stdio bridge |
| Backing model / endpoint | `gemini-3.1-pro-preview` `/v1/chat/completions` |
| Write-capable | no (`writeCapable: false`, `peer-mcp-personas.ts:385`) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/peer-mcp-personas.ts:382`):

> "Line-level review of a concrete diff or single file on gemini-3.1-pro (Google, high reasoning): a second-lab code reviewer that catches a different slice of defects than codex_reviewer (OpenAI). Use alongside codex_reviewer for cross-lab coverage of a diff. Not for architecture (use codex_critic / gemini_critic for plans). Pass artifact verbatim."

Input schema (persona-shared, `src/routes/mcp/handler.ts:295-324`), `required: ["prompt"]`, `additionalProperties: false`:
- `prompt` (string): "The lead's brief — the artifact under review plus constraints."
- `context` (string, optional): "Optional additional context (extra file content, prior decisions). Concatenated to the brief before sending."
- `effort` (string, optional): enum `[...p.allowedEfforts]` = `low | medium | high`; description built at `handler.ts:316-321`: "Reasoning depth (low | medium | high). Default \"high\". Higher tiers cost more wall-clock; lower tiers are quicker sanity checks. Note: for gemini routed via /v1/chat/completions, the upstream may silently ignore this knob." (the trailing note is appended because `endpoint === "/v1/chat/completions"`).

### 2b. System prompt (`--append-system-prompt`)

Named in `buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:582`). When `geminiAvailable`, the `criticList` pushes gemini_reviewer BEFORE gemini_critic (`peer-mcp-personas.ts:580-584`). The rendered clause inside the paragraph-1 critic list (`peer-mcp-personas.ts:642`) is verbatim:

> `gemini_reviewer` (gemini-3.1-pro, line-level code review)

Surrounding sentence (`peer-mcp-personas.ts:642`): "Cross-lab peer critics under `mcp__peers__*` (`codex_critic` (gpt-5.6-sol), `codex_reviewer` (gpt-5.3-codex), `gemini_reviewer` (gemini-3.1-pro, line-level code review), `gemini_critic` (gemini-3.1-pro), `opus_critic` (Opus 4.7)) are available at your discretion for adversarial review. Each tool's description explains its scope and when it applies."

So the snippet names the tool + a 4-word scope tag and explicitly defers the when/when-not to the tool `description`. This matches the documented framing constraint (`peer-mcp-personas.ts:516-521`): capability inventory only, routing signal lives in the description.

Subagent system prompt (`GEMINI_REVIEWER_BASE`, `peer-mcp-personas.ts:273-294`, wrapped by `buildAgentPrompt` at `peer-mcp-personas.ts:487-499`): line-level reviewer role, "magnifying glass, not the wide-angle lens", redirects architecture briefs ("this looks like architecture review, not line-level code review"), embeds `COLD_START_CONTRACT` and a fixed markdown reply format (Summary / Findings with `severity — title` / location / issue / suggested fix). Routing block instructs invoking `mcp__<peersKey>__gemini_reviewer` with `{prompt, context}` and "Do NOT pass model or instructions — they are server-baked into this tool."

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

The peer-awareness marker block covers this tool: the mirrored CLAUDE.md receives the SAME `buildPeerAwarenessSnippet` text as surface 2b (`appendPeerAwarenessToMirroredClaudeMd`, `src/lib/claude-md-injection.ts:653-658`). So the CLAUDE.md clause is byte-identical to 2b: "`gemini_reviewer` (gemini-3.1-pro, line-level code review)".

Checked-in repo `CLAUDE.md` (project root) documents the tool in two places, both accurate to code:
- `CLAUDE.md:127` — "and `gemini-reviewer` gemini-3.1-pro-preview at highest reasoning — a second-lab line-level reviewer, registered alongside `gemini-critic` whenever a `gemini-3.x-pro` model is in the catalog". Agrees with `requiresGeminiCatalog` gate and `defaultEffort: high` (highest tier gemini exposes).
- `CLAUDE.md:129` — the server-split paragraph lists `peers` as "(the critics + `gemini_reviewer` when a `gemini-3.x-pro` model is served + `codex_implementer` in `--codex-cli`)". Agrees.
- `CLAUDE.md:123` — the `REVIEW_DEFAULT_MODEL` decorrelation note (the `review` WORKER default moved to gemini-3.1-pro-preview so the reviewer's lab is decorrelated from the gpt-5.6-sol implementer). This is the WORKER `review` mode, a sibling surface, not this tool; consistent framing (cross-lab reviewer decorrelated from OpenAI implementer) but a distinct code path.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal**: strong. The description carries three routing axes correctly: (1) WHAT — "line-level review of a concrete diff or single file"; (2) when-NOT — "Not for architecture (use codex_critic / gemini_critic for plans)", which matches `GEMINI_REVIEWER_BASE`'s own architecture-redirect (`peer-mcp-personas.ts:275`); (3) differentiation from the sibling reviewer — "a second-lab code reviewer that catches a different slice of defects than codex_reviewer (OpenAI). Use alongside codex_reviewer for cross-lab coverage." This is the load-bearing distinction and it is stated plainly: same job as codex_reviewer, different lab, run BOTH for coverage. A model reading only descriptions can route correctly: line-level → reviewer (codex or gemini or both), architecture → critic. The gemini_reviewer-vs-gemini_critic split (same model, different prompt) is disambiguated by "line-level review … Not for architecture (use … gemini_critic for plans)".
- **Accuracy vs implementation**: accurate. Model id `gemini-3.1-pro` matches `model: "gemini-3.1-pro-preview"` (`peer-mcp-personas.ts:379`; the description's shortened "gemini-3.1-pro" is the conventional display form used across all surfaces and is pinned by test `peer-mcp-personas.test.ts:91`). "high reasoning" matches `defaultEffort: "high"` / `allowedEfforts: [low, medium, high]` (`peer-mcp-personas.ts:395-396`). Lab attribution "Google" and "OpenAI" (for codex_reviewer) correct. No stale model/default/gate.
- **Schema minimality**: compliant. `prompt` (required, the artifact), `context` (optional additive brief), `effort` (model-tunable, enum-constrained to the persona's `allowedEfforts`). No echoed-input or diagnostic-only field. The `effort` note "the upstream may silently ignore this knob" is directly actionable (tells the model not to expect deterministic effort control), not diagnostic padding. Length 348 chars, under the 400-char cap pinned by `peer-mcp-personas.test.ts:109`.

### 3b. System-prompt coverage

- **Named**: yes, at `peer-mcp-personas.ts:582`, and ordered before gemini_critic in the list. Naming the tool is correct — a gated tool that IS present in the live catalog should appear in the awareness snippet (test `peer-mcp-personas.test.ts:227-233` pins that gemini-critic AND gemini-reviewer gate together on `geminiAvailable`, so when the snippet's `geminiAvailable` is true the tool is genuinely served).
- **Accurate & non-redundant**: the snippet clause is a 4-word scope tag ("line-level code review"), not a re-statement of the full description. It defers when/when-not to the description ("Each tool's description explains its scope and when it applies"). No redundancy.
- **Framing-constraint compliance**: compliant. No imperative, no hedge, no anchor. The tag "line-level code review" is a factual scope label, consistent with the negative pins in `tests/peer-mcp-personas.test.ts:526-536` (no "Lead with", "cheapest first move", etc.). The snippet is a capability inventory per `peer-mcp-personas.ts:516-521`.

### 3c. CLAUDE.md coverage

- **Mirrored block**: identical to surface 2b (same `buildPeerAwarenessSnippet` output), so accurate and non-drifted by construction.
- **Checked-in root CLAUDE.md**: accurate at `CLAUDE.md:127` and `:129` (see 2c). Both agree with the code's gate and default-effort. No drift.
- **Design doc gap**: `docs/peer-mcp-design.md` does NOT mention gemini_reviewer anywhere (verified: zero matches for `gemini_reviewer` / `gemini-reviewer` / "second-lab" / "cross-lab coverage" / "different slice"). Its persona lists (`peer-mcp-design.md:12`, `:29-30`, `:155`, `:322`), the auto-inject sentence (`:155` still says "three peer-model review tools"), the latency-by-effort matrix (`:174-190`), and the predictedTooLong cap table (`:197-199`) all predate this persona and omit it. The tool `description` and both CLAUDE.md surfaces point the reader at `docs/peer-mcp-design.md` for scope, but that doc has no gemini_reviewer row. This is a documentation-drift gap, not a model-facing correctness bug (the model routes off the description, which is complete), but it violates the "single source of truth" intent and the design-doc-is-authoritative convention in `CLAUDE.md:127-129`.

### 3d. Cross-surface consistency

- Description ↔ system prompt ↔ mirrored CLAUDE.md ↔ root CLAUDE.md ↔ code: consistent on model id, endpoint, gate, default effort, and line-level-reviewer role.
- One asymmetry: every model-facing surface (description, snippet, both CLAUDE.md) names and scopes the tool correctly, but the referenced design doc (`docs/peer-mcp-design.md`) is silent on it. A human following the description's "use codex_critic / gemini_critic for plans" or the CLAUDE.md pointer into the design doc will not find gemini_reviewer documented there.

## 4. Findings

- **[Important]** `docs/peer-mcp-design.md` never documents gemini_reviewer. `peer-mcp-design.md:12,29-30` list only `codex_critic / codex_reviewer / gemini_critic / opus_critic`; `:155` still says "auto-injects three peer-model review tools"; the latency matrix (`:174-190`), cap table (`:197-199`), and the minimal-surface rule enumeration (`:322`, which lists `codex_critic, codex_reviewer, opus_critic, gemini_critic` and omits gemini_reviewer) are all stale. The tool description and root CLAUDE.md both cite this doc as the scope reference. Fix: add a gemini_reviewer row to the persona/critic list and the cap table (or state it explicitly inherits codex_reviewer-class treatment), and update the "three peer-model review tools" count to four. No repro needed (documentation, not runtime).
- **[Suggestion]** The persona-count sentence at `peer-mcp-design.md:155` ("auto-injects three peer-model review tools as Claude Code subagents (codex-critic … codex-reviewer … gemini-critic …)") disagrees with the current code, which injects codex-critic, codex-reviewer, gemini-critic, gemini-reviewer, opus-critic (+ implementer + coordinator). Bring the count and roster in line while addressing the Important finding above.
- **[Suggestion]** `predictedTooLong` (`src/routes/mcp/handler.ts:493-495`) defines briefBytes caps for `codex_critic` (8KB), `codex_reviewer` (12KB), `opus_critic` (6KB) but not gemini_reviewer or gemini_critic — those get no cap (consistent with gemini being long-context-strong, matching the design doc's gemini_critic "(no cap)" row at `:199`). This is intentional and correct; no change needed, but the design-doc cap table should record gemini_reviewer's no-cap status when the Important finding is fixed so a future editor does not assume it was overlooked.

## 5. Verdict

Y — the model-facing surface is correct, minimal, consistent, and well-routed: the description cleanly differentiates gemini_reviewer from codex_reviewer (same job, different lab, run both for cross-lab coverage) and from gemini_critic (line-level vs architecture), the schema is minimal, and the system-prompt / CLAUDE.md surfaces name and scope it without drift. Single most important fix: add gemini_reviewer to `docs/peer-mcp-design.md` (persona list, cap table, and the stale "three peer-model review tools" count), which every model-facing surface points to but which currently omits this tool entirely.
