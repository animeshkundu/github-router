# Subagent: `opus-critic`

> Reviews the routing line as a DELEGATION TRIGGER. Tool-side review: `docs/review/mcp/peers/opus_critic.md`.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `opus-critic` |
| Backing peer model | prefers `claude-opus-5` (native 1M), falling back to `claude-opus-4.6-1m` then `claude-opus-4-6`, via `/v1/messages` |
| Subagent's OWN model | inherited (Claude — no `model:` frontmatter) |
| Gate | always registered (`requiresHttp: true` but `requiresGeminiCatalog` false — Anthropic models always in catalog for supported tiers, `peer-mcp-personas.ts:408-413`) |
| Registered via | `buildPeerAgentDefinitions` (`codex-mcp-config.ts:289-303`) |
| Description source | `PersonaSpec.description` (`peer-mcp-personas.ts:403-404`) — shared verbatim with `mcp__peers__opus_critic` |
| System prompt | `buildAgentPrompt` → `OPUS_CRITIC_BASE` (`peer-mcp-personas.ts:322-330`) |

`requiresHttp: true` means opus-critic always routes via the HTTP backend even under `--codex-cli` (the stdio bridge speaks gpt-5/codex only); pinned by `tests/codex-mcp-config.test.ts:249-253`.

## 2. Description (verbatim)

`peer-mcp-personas.ts:403-404`:

> Adversarial same-lab critic backed by fresh-context Opus 5, with limited blind-spot diversity compared with cross-lab critics. It reviews plans, designs, or code tradeoffs for cognitive momentum, sunk-cost reasoning, and confabulated assumptions, then returns a calibrated objection or no material objection. Use when a same-family sanity check can catch lead-context drift or when comparing against codex_critic / gemini_critic findings. Not a substitute for cross-lab review on security-sensitive or high-risk changes; use codex_critic or gemini_critic for stronger diversity. Runs with the full 1M-context Opus 5 window (native, no -1m sibling needed). Pass artifact verbatim.

## 3. System-prompt summary

`OPUS_CRITIC_BASE` (`peer-mcp-personas.ts:322-330`): identity ("opus-critic, a fresh-context same-lab adversarial reviewer running on Opus 5"), the honesty framing about LIMITED blind-spot diversity, the anti-sycophancy line, the `COLD_START_CONTRACT`, and the `CRITIC_RUBRIC`. Routing block invokes `mcp__peers__opus_critic` and relays verbatim.

## 4. Routing-trigger assessment

- **States trigger — partial, with an honesty hedge.** "Catches confabulation" is the trigger; "same lab as the lead, limited blind-spot diversity vs cross-lab critics" is an honest DE-emphasis that steers the lead toward the cross-lab critics first. This is unusual and correct: the description tells Opus when NOT to prefer this critic. As a routing line it is specific about its niche (fresh-context confabulation-catch, large window) without overselling.
- **Specific not vague — strong.** Names the model, the fresh-context value, the window sizes (enterprise vs not), and the version-curve rationale.
- **Accurately previews the body — MOSTLY, with one drift.** The description says "Opus 4.6" and the code pins `claude-opus-4-6` (`peer-mcp-personas.ts:401`), so the description/model agree. BUT `OPUS_CRITIC_BASE` (the system prompt, `peer-mcp-personas.ts:322`) says "running on Claude Opus 5", AND the awareness snippet's critic list labels it "(Opus 5)" (`peer-mcp-personas.ts:585`). So three surfaces disagree: description "Opus 4.6" + model `claude-opus-4-6` (agree) vs system-prompt "Opus 5" + snippet "(Opus 5)" (disagree). See finding F1.
- **No overtrigger imperatives — yes.** The description actively discourages over-preference.

## 5. Don't-nerf / right-balance

The self-deprecating "limited blind-spot diversity" framing is the right call: it raises the floor (a large-window fresh-context confabulation catcher is genuinely useful) without letting opus-critic crowd out the cross-lab critics it is weaker than. It never forces invocation. The one issue is not balance but accuracy (F1): the version label drifts across surfaces.

## 6. Findings + verdict

- **[Important] F1 — model-label drift across surfaces.** The subagent description and the pinned model are `claude-opus-4-6` / "Opus 4.6", but the system prompt `OPUS_CRITIC_BASE` says "running on Claude Opus 5" (`peer-mcp-personas.ts:322,324`) and the awareness snippet says "(Opus 5)" (`peer-mcp-personas.ts:585`). The invoked model is 4.6, so the description is the correct surface and the system-prompt + snippet are stale at "4.7". Impact: the persona is told it is running on 4.7 while actually running on 4.6, and the lead's awareness snippet advertises 4.7. This is a factual defect in the injected prompt, not a routing-trigger flaw. Fix: change `OPUS_CRITIC_BASE:322` and the snippet label at `585` to "Opus 4.6" (or bump the model to 4.7 if that was the intent — but the description, the `model:` field, and the comment at `408-413` all say 4.6, so 4.6 is authoritative). Confirmed also flagged in the codex_critic tool doc (`docs/review/mcp/peers/codex_critic.md:85`).
- **[Suggestion]** The 4.7-vs-4.6 confusion is aggravated by "Pinned one minor behind the default Opus" — a reader must know the current default to decode "one minor behind". Since the default Opus is now 4.8 (per repo CLAUDE.md), "one minor behind" would be 4.7, contradicting the 4.6 model id. The phrase is now two minors behind and the relative wording has gone stale. Fix: state the absolute version ("Opus 4.6") and drop the relative "one minor behind" claim.

**Verdict: N (blocked on F1).** The routing trigger itself is sound (honest niche, no overtrigger), but the injected surfaces disagree on the model version (4.6 vs 4.7), which is an Important accuracy defect the model is exposed to. Resolve F1 before treating this subagent's surface as clean.
