# Review: `mcp__peers__opus_critic`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__peers__opus_critic` |
| Group / server | `peers` (serverInfo `github-router-peers`) |
| Wire tool name | `opus_critic` |
| Definition | `src/lib/peer-mcp-personas.ts:398-420` |
| Always-on? | yes (`requiresHttp: true`, no separate catalog-registration gate) |
| Capability gate | none (`requiresGeminiCatalog` is undefined; `personasFor` never drops it) |
| Backing model / endpoint | prefers `claude-opus-5` (native 1M), falling back to `claude-opus-4.6-1m` then `claude-opus-4-6`, via `/v1/messages` |
| Write-capable | no |

Model resolution is dynamic: `activePersonas()` applies `resolveOpusCriticModel()`, which exact-matches `claude-opus-5` first. If absent, it prefers the version-anchored Opus 4.6 `-1m` sibling and finally the 200K base slug. `allowedEfforts` is `["low","medium","high","xhigh"]`; `defaultEffort` stays `high` to preserve the prior latency profile while letting Opus 5 callers opt into xhigh.

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

`personas.ts:403-404`:

> Adversarial same-lab critic backed by fresh-context Opus 5, with limited blind-spot diversity compared with cross-lab critics. It reviews plans, designs, or code tradeoffs for cognitive momentum, sunk-cost reasoning, and confabulated assumptions, then returns a calibrated objection or no material objection. Use when a same-family sanity check can catch lead-context drift or when comparing against codex_critic / gemini_critic findings. Not a substitute for cross-lab review on security-sensitive or high-risk changes; use codex_critic or gemini_critic for stronger diversity. Runs with the full 1M-context Opus 5 window (native, no -1m sibling needed). Pass artifact verbatim.

Input-schema fields (built in `handler.ts:295-330`, shared across all personas):
- `prompt` (string, required): "The lead's brief — the artifact under review plus constraints."
- `context` (string, optional): "Optional additional context (extra file content, prior decisions). Concatenated to the brief before sending."
- `effort` (string, optional; enum `low|medium|high|xhigh`): per-persona effort tier; defaults to high.

Subagent `agentPrompt` is empty (`personas.ts:406`); the subagent system prompt is `OPUS_CRITIC_BASE` (`personas.ts:322-330`) wrapped by `buildAgentPrompt` (`personas.ts:487-499`).

### 2b. System prompt (`--append-system-prompt`)

`buildPeerAwarenessSnippet` builds `criticList` and pushes opus_critic at `personas.ts:585`:

> ``criticList.push("`opus_critic` (Opus 5)")``

Rendered clause (`personas.ts:642`): opus_critic appears inside the parenthesized critic list under ``Cross-lab peer critics under `mcp__peers__*` (…, `opus_critic` (Opus 5)) are available at your discretion for adversarial review.`` The snippet names the tool but delegates the "when to use / when not" routing to the tool's own `description` (line 642: "Each tool's description explains its scope and when it applies.").

Subagent system prompt (`OPUS_CRITIC_BASE`, `personas.ts:322-330`):

> You are opus-critic, a fresh-context same-lab adversarial reviewer running on Opus 5. The lead orchestrator that just delegated to you runs Opus-family context too, but you are NOT the lead. You did not see the lead's reasoning trace. You only see the brief.
>
> Your job is to spot what the lead missed because of cognitive momentum, sunk-cost on a plan, or motivated reasoning toward a particular fix. Your blind-spot diversification is LIMITED compared to codex-critic (gpt-5.6-sol) and gemini-critic (gemini-3.1-pro) — same training, same lab, same RLHF priors. …

Followed by `COLD_START_CONTRACT` (`personas.ts:220-227`) and `CRITIC_RUBRIC` (`personas.ts:193-218`).

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

Covering block: **peer-awareness** (marker pair `PEER_MARKER_OPEN`/`_CLOSE`, `claude-md-injection.ts:20-22`). `appendPeerAwarenessToMirroredClaudeMd` (`claude-md-injection.ts:653-663`) writes the exact `buildPeerAwarenessSnippet` output — so the mirrored CLAUDE.md carries the identical ``opus_critic` (Opus 5)`` string from surface 2b. No separate opus_critic text; the mirror and the `--append-system-prompt` share one source.

Checked-in root `CLAUDE.md` and the awareness snippet both identify opus_critic as Opus 5. The handler prefers the native-1M `claude-opus-5` catalog entry and retains the older 4.6-1m → 4.6 chain only as fallback behavior.

## 3. Assessment

### 3a. Description quality

- **Routing signal**: strong. "same lab as the lead, limited blind-spot diversity vs cross-lab critics" plus "Catches confabulation" gives a genuine when-to-use (same-lab confabulation catch) and an honest when-NOT (reach for cross-lab critics for genuine diversity). Differentiates cleanly from `codex_critic` ("different lab", "strongest reasoning") and `gemini_critic` ("third-lab triangulation"). This is the best-differentiated of the three critic descriptions on the diversity axis.
- **Accuracy vs implementation**: the preferred model is `claude-opus-5`, which is natively 1M and needs no `-1m` sibling. The older `claude-opus-4.6-1m` and `claude-opus-4-6` entries are fallbacks only, matching the dynamic resolution chain.
- **Schema minimality**: clean. `prompt` (required), `context` (optional, actionable — extends the brief), `effort` (model-tunable, gated to real tiers). No echoed-input or diagnostic-only fields. Compliant with the ruthlessly-minimal principle.

### 3b. System-prompt coverage

- **Named**: yes, in `criticList` (`personas.ts:585`), by design — it is one of the always-on critics the snippet contract pins (regression-pinned: `tests/peer-mcp-personas.test.ts:321` asserts the snippet contains `opus_critic`).
- **Accurate & non-redundant**: the snippet correctly defers routing to the description ("Each tool's description explains its scope") and labels the preferred Opus 5 model accurately.
- **Framing-constraint compliance**: compliant. The critic list is a pure capability inventory (tool name + model tag), with no imperatives, hedges, or anchors.

### 3c. CLAUDE.md coverage

- **Accurate / non-drifted**: the mirrored peer-awareness block inherits the preferred-model `(Opus 5)` label from 2b, matching the current resolution chain.
- **Injected block vs checked-in root CLAUDE.md**: both identify the preferred model as Opus 5 and retain the older 4.6 variants only as fallback behavior.

### 3d. Cross-surface consistency

The surfaces agree that `claude-opus-5` is the preferred, natively 1M backing model. The `claude-opus-4.6-1m` and `claude-opus-4-6` entries are fallback behavior, not a competing current identity.

## 4. Findings

- **[Resolved]** The previous Opus 4.6/4.7 drift is obsolete: the live persona now prefers `claude-opus-5`, which has a native 1M context window without a `-1m` sibling.
- **[Suggestion]** `OPUS_CRITIC_BASE` names `gemini-critic` unconditionally, but that persona is catalog-gated. The reference is illustrative rather than a routing instruction, so no change is required; if tightening lesser-tier accuracy, phrase it as "the cross-lab critics" rather than naming Gemini specifically.

## 5. Verdict

**Y (correct, minimal, consistent, well-routed).** The injected surface accurately identifies Opus 5 as the preferred same-lab critic and clearly records the limited blind-spot diversity relative to cross-lab critics. Older Opus 4.6 variants remain documented solely as fallback behavior.
