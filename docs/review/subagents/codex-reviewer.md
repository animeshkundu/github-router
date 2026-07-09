# Subagent: `codex-reviewer`

> Reviews the routing line as a DELEGATION TRIGGER. Tool-side review: `docs/review/mcp/peers/codex_reviewer.md`.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `codex-reviewer` |
| Backing peer model | `gpt-5.3-codex` `/v1/responses` (`src/lib/peer-mcp-personas.ts:365-366`) |
| Subagent's OWN model | inherited (Claude — no `model:` frontmatter) |
| Gate | always registered (no `requiresGeminiCatalog`) |
| Registered via | `buildPeerAgentDefinitions` (`codex-mcp-config.ts:289-303`) |
| Description source | `PersonaSpec.description` (`peer-mcp-personas.ts:367-368`) — shared verbatim with `mcp__peers__codex_reviewer` |
| System prompt | `buildAgentPrompt` → `REVIEWER_BASE` (`peer-mcp-personas.ts:250-271`) |

## 2. Description (verbatim)

`peer-mcp-personas.ts:367-368`:

> Line-level review of a concrete diff or single file. Backed by gpt-5.3-codex (OpenAI, ≈272K-token input window) — code-specialist, fastest critic (~16s). Surfaces bugs, edge cases, security issues, and idiom violations at specific line numbers. Not suited for architecture or design review (use codex_critic for plans). Pass artifact verbatim.

## 3. System-prompt summary

`REVIEWER_BASE` (`peer-mcp-personas.ts:250-271`): identity ("line-level code reviewer running on gpt-5.3-codex… the code-specialist persona"), an explicit self-redirect for out-of-scope briefs ("If the brief is a plan or a high-level design, redirect: 'this looks like architecture review; consider codex-critic or gemini-critic'"), the `COLD_START_CONTRACT`, a fixed reply format (Summary / Findings with severity + `file:line` + suggested fix), and a self-reminder ("Am I citing real code at real line numbers… If a finding doesn't have a concrete file:line citation, drop it"). The routing block invokes `mcp__peers__codex_reviewer` and relays verbatim.

## 4. Routing-trigger assessment

- **States trigger — partial (capability-blurb register).** "Line-level review of a concrete diff or single file" is a scoped capability, and "Not suited for architecture or design review (use codex_critic for plans)" is an explicit anti-trigger with redirect. Same soft-trigger property as codex-critic (S1): no literal "Use when…" idiom, but the artifact-type scoping is a clear routing signal for a diff.
- **Specific not vague — strong.** Names the exact input (concrete diff / single file), the output (bugs, edge cases, security, idiom violations at line numbers), the model, the speed, and the anti-scope.
- **Accurately previews the body — yes.** "line-level", "at specific line numbers", "Not suited for architecture" all map to `REVIEWER_BASE`'s magnifying-glass framing and the self-redirect it carries.
- **No overtrigger imperatives — yes.**

## 5. Don't-nerf / right-balance

Correctly narrows to the diff/file case and hands architecture to codex_critic, so the two never compete for the same artifact. The `~16s` speed note is a genuine routing input (cheap enough to run on small diffs). No forced invocation; fires only when the lead has a concrete diff. Right amount.

## 6. Findings + verdict

- **[Suggestion]** Same soft-trigger note as codex-critic: works as a tool description, reads as a capability blurb rather than an explicit subagent trigger. Acceptable under the coordinator-as-entry-point model, where the coordinator routes "concrete diff → codex-reviewer" (`codex-mcp-config.ts:231-234`).
- No Critical/Important findings.

**Verdict: Y (soft-trigger caveat).** Clean scope, explicit anti-scope with redirect, accurate body preview, no overtrigger.
