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
- **Accuracy vs implementation**: model version "4.6" is CORRECT (matches `claude-opus-4-6` / the `OPUS_1M_RE` 4.6-anchored resolver). The ≈936K figure matches the 1M variant's documented `max_prompt_tokens` (`handler.ts:250-251`). BUT "Pinned one minor behind the default Opus" is WRONG: the default is `claude-opus-4-8` (root `CLAUDE.md:119`), opus_critic is 4.6 — that is **two** minor versions behind (4.8 → 4.7 → 4.6), not one. The design doc says the same thing more precisely: "pinned one minor behind the spawned-Claude-Code default" was written when the default was 4.7; it has drifted since the default moved to 4.8.
- **Schema minimality**: clean. `prompt` (required), `context` (optional, actionable — extends the brief), `effort` (model-tunable, gated to real tiers). No echoed-input or diagnostic-only fields. Compliant with the ruthlessly-minimal principle.

### 3b. System-prompt coverage

- **Named**: yes, in `criticList` (`personas.ts:585`), by design — it is one of the always-on critics the snippet contract pins (regression-pinned: `tests/peer-mcp-personas.test.ts:321` asserts the snippet contains `opus_critic`).
- **Accurate & non-redundant**: the snippet correctly defers routing to the description ("Each tool's description explains its scope"), so it is non-redundant. But the parenthetical model tag `(Opus 5)` CONTRADICTS the tool description's `Opus 4.6` — the two surfaces disagree on the model version (see Finding 1).
- **Framing-constraint compliance**: compliant. The critic list is a pure capability inventory (tool name + model tag), no imperatives, no hedges, no anchors. The version tag is a factual label, not a steer — the defect is that the fact is wrong, not that it violates framing.

### 3c. CLAUDE.md coverage

- **Accurate / non-drifted**: the mirrored peer-awareness block inherits the same `(Opus 5)` error from 2b — so it is drifted from the code's ground-truth model (`claude-opus-4-6`).
- **Injected block vs checked-in root CLAUDE.md**: the root CLAUDE.md peer-review sentence matches the injected snippet string (both say 4.7), so they agree with each other but both disagree with `claude-md-injection` is not the source — `personas.ts:585` is. Notably the root CLAUDE.md is self-contradictory: line 9 says opus_critic's pinned model is `claude-opus-4.6-1m` while the peer-review sentence says "(Opus 5)". Fixing `personas.ts:585` resolves the injected surface; the root-CLAUDE.md peer-review sentence needs the same 4.6 correction.

### 3d. Cross-surface consistency

The model version is inconsistent across surfaces. Ground truth (`personas.ts:401` model `claude-opus-4-6`; `handler.ts:261-265` 4.6-anchored resolver; test pin `tests/peer-mcp-personas.test.ts:63` `expect(model).toBe("claude-opus-4-6")`; root `CLAUDE.md:9` "opus_critic's pinned model = claude-opus-4.6-1m") is unambiguously **4.6**.

| Surface | Says | Correct? |
|---|---|---|
| Tool `description` (`personas.ts:404`) | Opus 4.6 | ✅ |
| Awareness snippet / mirrored CLAUDE.md (`personas.ts:585`) | Opus 5 | ❌ |
| Subagent prompt `OPUS_CRITIC_BASE` (`personas.ts:322,324`) | Claude Opus 5 | ❌ |
| Window-guard hint (`handler.ts:575`) | Opus 5 1M ≈ 936K | ❌ |
| Design doc Phase B (`docs/peer-mcp-design.md:205`) | Opus 5 | ❌ |
| Design doc window-guard example (`docs/peer-mcp-design.md:203`) | opus_critic Opus 5-1M ≈936K | ❌ |
| Design doc latency/model table (`docs/peer-mcp-design.md:175,177`) | claude-opus-4.6 | ✅ |

The description (the surface Opus 4.8 is told to trust for routing) is correct; four other surfaces including the subagent's OWN system prompt tell it it is 4.7.

## 4. Findings

### [Important] — Model-version mismatch: five surfaces say "4.7", ground truth is 4.6

- `src/lib/peer-mcp-personas.ts:585` — snippet pushes ``"`opus_critic` (Opus 5)"``; model is `claude-opus-4-6` (`personas.ts:401`).
- `src/lib/peer-mcp-personas.ts:322` and `:324` — `OPUS_CRITIC_BASE` tells the subagent it is "running on Claude Opus 5". This is the subagent's own identity statement, so the peer critic asserts a false version about itself in its reply framing.
- `src/routes/mcp/handler.ts:575` — window-guard hint routes overflow to "`opus_critic` (Opus 5 1M ≈ 936K tokens)".
- `docs/peer-mcp-design.md:203,205` — Phase B writeup and the window-guard example both say 4.7.

Why it matters: the description (`personas.ts:404`) correctly says 4.6, so the model-facing surface is self-contradictory — the tool card says 4.6, the system prompt and the subagent's self-identity say 4.7. This is a factual-accuracy defect, not a misroute (the tool still dispatches to `claude-opus-4-6` regardless of the label; `personas.ts:401` + `handler.ts:262-265` are the load-bearing path, and the version string is cosmetic to routing). It does not silently misroute a call, which is why it is Important, not Critical. But a same-lab critic that misstates its own model undercuts the one thing this tool exists to convey honestly (its limited blind-spot diversity is a function of WHICH model it is), and the repo already contradicts itself between root `CLAUDE.md:9` (4.6) and the peer-review sentence (4.7).

Fix: replace "Opus 5" → "Opus 4.6" at `personas.ts:585`, `personas.ts:322`, `personas.ts:324`, `handler.ts:575`, and `docs/peer-mcp-design.md:203,205`, and the peer-review sentence in root `CLAUDE.md`. Root cause is almost certainly a default-bump: these strings were written when the spawned-Claude default was 4.7 and opus_critic was "one minor behind"; the default moved to 4.8 and opus_critic stayed on 4.6, but the "4.7" labels were not swept.

### [Important] — "Pinned one minor behind the default Opus" is now two minors behind

- `src/lib/peer-mcp-personas.ts:404` (description) — "Pinned one minor behind the default Opus so the panel spans more of the version curve."
- The main default and opus_critic preferred model are both Opus 5; the 4.6 variants remain fallback-only.

Why it matters: same root cause as Finding 1 (default drift from 4.7 to 4.8). The claim reads as a precise design rationale, so a stale "one minor" is a concrete wrong fact in the routing-authoritative surface. Fix: change to "Pinned two minors behind the default Opus" (or drop the count: "Pinned behind the default Opus so the panel spans more of the version curve"). The design doc `docs/peer-mcp-design.md:177` already hedges this correctly ("pinned one minor behind the spawned-Claude-Code default" is itself now stale there too and should read "two").

### [Suggestion] — `OPUS_CRITIC_BASE` names `gemini-critic` unconditionally, but that persona is catalog-gated

- `src/lib/peer-mcp-personas.ts:324` — "Your blind-spot diversification is LIMITED compared to codex-critic (gpt-5.6-sol) and gemini-critic (gemini-3.1-pro)".
- `gemini-critic` is dropped from the live surface when the gemini-3.x-pro family is absent from the catalog (`personasFor`/`activePersonas` gate on `requiresGeminiCatalog`, `personas.ts:660` / `handler.ts:278-279`).

Why it's only a Suggestion: this is a subagent-internal system prompt, not the model-facing tool card, and the reference is illustrative ("compared to X and Y") rather than a routing instruction — naming a possibly-absent sibling as a diversity contrast does not break anything. The snippet surface already correctly gates the gemini mention (`personas.ts:580`). No change required unless tightening for lesser-tier accuracy; if changed, phrase as "the cross-lab critics" rather than naming gemini specifically.

### [Suggestion] — Description omits the effort default / cap, unlike the codex siblings' implicit signal

- `src/lib/peer-mcp-personas.ts:404` — the description does not state defaultEffort `high` or that xhigh is unavailable.

Why it's only a Suggestion: the schema `enum` already advertises `low|medium|high` (no xhigh), so a caller cannot request an invalid tier — the constraint is enforced structurally, and echoing it in prose would be redundant per the minimality principle. The codex critics also omit it. No change; noted for completeness so a future editor does not "fix" it by adding redundant effort prose.

## 5. Verdict

**N** — the injected surface is minimal, well-routed, and honestly conveys the same-lab diversity limitation, but it is factually inconsistent on the model version: the description correctly says Opus 4.6 while the awareness snippet, the mirrored CLAUDE.md, the subagent's own system prompt, the window-guard hint, and the design doc all say 4.7, and the description's "one minor behind" is now two. Single most important fix: sweep "Opus 5" → "Opus 4.6" (and "one minor" → "two minors") across `personas.ts:322,324,585`, `handler.ts:575`, `docs/peer-mcp-design.md:203,205`, and root `CLAUDE.md`, so every surface agrees with the `claude-opus-4-6` the tool actually dispatches to.
