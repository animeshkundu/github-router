# Subagent: `gemini-critic`

> Reviews the routing line as a DELEGATION TRIGGER. Tool-side review: `docs/review/mcp/peers/gemini_critic.md`.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `gemini-critic` |
| Backing peer model | `gemini-3.1-pro-preview` `/v1/chat/completions` (`src/lib/peer-mcp-personas.ts:350-351`) |
| Subagent's OWN model | inherited (Claude — no `model:` frontmatter) |
| Gate | `requiresGeminiCatalog: true` (`peer-mcp-personas.ts:358`) — dropped when `gemini-3.x-pro` is absent from the live catalog (`personasFor`, `peer-mcp-personas.ts:660`) |
| Registered via | `buildPeerAgentDefinitions` (`codex-mcp-config.ts:289-303`) |
| Description source | `PersonaSpec.description` (`peer-mcp-personas.ts:352-353`) — shared verbatim with `mcp__peers__gemini_critic` |
| System prompt | `buildAgentPrompt` → `GEMINI_CRITIC_BASE` (`peer-mcp-personas.ts:237-248`) |

When gemini is absent, this subagent is not written at all (`personasFor` filters it), and the coordinator's prompt substitutes "(NOT REGISTERED in this session)" for its routing lines (`codex-mcp-config.ts:237,240`; pinned by `tests/isolated/codex-mcp-config.test.ts:283`).

## 2. Description (verbatim)

`peer-mcp-personas.ts:352-353`:

> Adversarial second opinion. Backed by gemini-3.1-pro (Google) — third-lab triangulation, strong on formal reasoning, proofs, and invariants. Useful for cross-checking findings from codex_critic or codex_reviewer when you want a third perspective. Pass artifact verbatim.

## 3. System-prompt summary

`GEMINI_CRITIC_BASE` (`peer-mcp-personas.ts:237-248`): identity ("gemini-critic, an adversarial reviewer"), a "the lead routes a brief to you when it needs" list (long-context reasoning over large artifacts; math/proofs/invariants; a cross-check of another critic's verdict), the anti-sycophancy framing, the `COLD_START_CONTRACT`, and the `CRITIC_RUBRIC`. Routing block invokes `mcp__peers__gemini_critic` and relays verbatim.

## 4. Routing-trigger assessment

- **States trigger — good for a triangulation role.** Unlike the two codex critics, this description names its trigger more explicitly: "Useful for cross-checking findings from codex_critic or codex_reviewer when you want a third perspective" is a genuine when-clause, and "strong on formal reasoning, proofs, and invariants" is a specialization trigger. This is the strongest subagent trigger of the three critics.
- **Specific not vague — strong.** Third-lab, the two specializations (triangulation + formal reasoning), the input contract.
- **Accurately previews the body — yes.** "third-lab triangulation", "cross-checking… codex_critic or codex_reviewer", "formal reasoning, proofs, and invariants" all appear in `GEMINI_CRITIC_BASE`'s "the lead routes a brief to you when it needs" list.
- **No overtrigger imperatives — yes.** "Useful for…" is a scoped suggestion, not a mandate.

## 5. Don't-nerf / right-balance

Positions gemini as the triangulation/second-opinion layer rather than a first-choice architecture critic (that is codex_critic). Correct — it prevents gemini from competing with codex_critic on the primary route while keeping it reachable for the formal-reasoning and cross-check cases where it is genuinely differentiated. The catalog gate means the description is never shown when the model is unavailable, so it cannot mislead. Right balance.

## 6. Findings + verdict

- **[Suggestion, cross-surface]** The awareness snippet labels the panel as three labs and gemini as third-lab; the description says "third-lab triangulation" while codex is "cross-lab". Consistent. The adjacent opus label now correctly says Opus 5.
- No Critical/Important findings.

**Verdict: Y.** The best subagent trigger of the critic trio — an explicit "cross-checking… when you want a third perspective" when-clause plus a formal-reasoning specialization, correctly gated on catalog presence, no overtrigger.
