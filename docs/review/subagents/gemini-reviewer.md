# Subagent: `gemini-reviewer`

> Reviews the routing line as a DELEGATION TRIGGER. Tool-side review: `docs/review/mcp/peers/gemini_reviewer.md`.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `gemini-reviewer` |
| Backing peer model | `gemini-3.1-pro-preview` `/v1/chat/completions` (`src/lib/peer-mcp-personas.ts:379-380`) |
| Subagent's OWN model | inherited (Claude — no `model:` frontmatter) |
| Gate | `requiresGeminiCatalog: true` (`peer-mcp-personas.ts:392`) — same gate as gemini-critic |
| Registered via | `buildPeerAgentDefinitions` (`codex-mcp-config.ts:289-303`) |
| Description source | `PersonaSpec.description` (`peer-mcp-personas.ts:381-382`) — shared verbatim with `mcp__peers__gemini_reviewer` |
| System prompt | `buildAgentPrompt` → `GEMINI_REVIEWER_BASE` (`peer-mcp-personas.ts:273-294`) |

Same model as gemini-critic (`gemini-3.1-pro-preview`), different prompt (reviewer register vs critic register) — the two are distinguished only by `baseInstructions`.

## 2. Description (verbatim)

`peer-mcp-personas.ts:381-382`:

> Line-level review of a concrete diff or single file on gemini-3.1-pro (Google, high reasoning): a second-lab code reviewer that catches a different slice of defects than codex_reviewer (OpenAI). Use alongside codex_reviewer for cross-lab coverage of a diff. Not for architecture (use codex_critic / gemini_critic for plans). Pass artifact verbatim.

## 3. System-prompt summary

`GEMINI_REVIEWER_BASE` (`peer-mcp-personas.ts:273-294`): near-identical to `REVIEWER_BASE` but lab-neutral in the opening ("You are a line-level code reviewer"), same magnifying-glass framing, same self-redirect for plans ("this looks like architecture review, not line-level code review"), same `COLD_START_CONTRACT`, same Summary/Findings reply format and self-reminder. Routing block invokes `mcp__peers__gemini_reviewer` and relays verbatim.

## 4. Routing-trigger assessment

- **States trigger — good.** Carries an explicit pairing trigger: "Use alongside codex_reviewer for cross-lab coverage of a diff." This is the clearest "use" imperative among the reviewers, and it correctly frames gemini-reviewer as an ADDITIVE second-lab pass rather than a substitute. Plus an explicit anti-trigger ("Not for architecture").
- **Specific not vague — strong.** Names the model, the second-lab value ("a different slice of defects than codex_reviewer"), the input (concrete diff / single file), and the anti-scope.
- **Accurately previews the body — yes.** "second-lab", "line-level", "Not for architecture" map to `GEMINI_REVIEWER_BASE`.
- **No overtrigger imperatives — yes.** "Use alongside… for cross-lab coverage" is scoped to the diff-review case, not blanket.

## 5. Don't-nerf / right-balance

The "Use alongside codex_reviewer" framing is exactly right: it raises the floor (cross-lab diff coverage) without nerfing codex_reviewer (it does not claim to replace it, and both stay independently routable). The "different slice of defects" claim is the honest reason to run both. Catalog-gated so it never shows when unavailable. Right amount.

## 6. Findings + verdict

- No Critical/Important/Suggestion findings specific to this subagent. Of the five critics this description is the closest to an ideal subagent trigger: explicit pairing "use" clause, honest additive value, explicit anti-scope, catalog-gated.

**Verdict: Y.** Strong, additive, correctly gated. Model the other critics' triggers on this one if S1 is ever addressed.
