# Subagent: `codex-critic`

> Per-subagent audit of the Claude Code subagents github-router injects into the spawned session. Subagents pre-load only `name` + `description` (the routing tier); the body/system-prompt loads on invocation. This doc reviews the routing line as a DELEGATION TRIGGER, not as a tool description (that review lives in `docs/review/mcp/peers/codex_critic.md`).

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `codex-critic` |
| Backing model (of the peer it routes to) | `gpt-5.5` `/v1/responses` (`src/lib/peer-mcp-personas.ts:336-337`) |
| Subagent's OWN model | inherited (Claude — no `model:` frontmatter emitted; `agentPrompt: ""`, model server-baked into the MCP tool) |
| Gate | always registered (no `requiresGeminiCatalog`) — `personasFor` includes it unconditionally (`peer-mcp-personas.ts:653-666`) |
| Registered via | `buildPeerAgentDefinitions` (`src/lib/codex-mcp-config.ts:289-303`), one `.md` per persona written by `writePeerAgentMdFiles` (`codex-mcp-config.ts:492-544`) |
| Description source | `PersonaSpec.description` (`peer-mcp-personas.ts:338-339`) — SHARED verbatim with the `mcp__peers__codex_critic` tool description |
| System prompt source | `buildAgentPrompt(persona, {codexCli, peersKey})` (`peer-mcp-personas.ts:458-500`) |

The registered subagent is a THIN routing shim: its system prompt tells it to invoke `mcp__<peersKey>__codex_critic` with `{prompt (verbatim), context (optional)}` and surface the reply verbatim. The subagent itself runs on the inherited Claude model; the gpt-5.5 reasoning happens server-side inside the MCP tool call.

## 2. Description (verbatim)

`peer-mcp-personas.ts:338-339`:

> Adversarial second opinion on plans, designs, or code tradeoffs. Backed by gpt-5.5 (OpenAI, ≈922K-token input window) — strongest reasoning model in the critic lineup, different lab than Opus. Best for architecture decisions, design reviews, and tradeoff analysis where cross-lab diversity matters. Not for line-level code review (use codex_reviewer). Pass artifact verbatim.

This SAME string is the `mcp__peers__codex_critic` tool description. There is exactly one source of truth (`PersonaSpec.description`); it is emitted into both the `.md` frontmatter (this subagent) and the `tools/list` payload (the tool).

## 3. System-prompt summary

`buildAgentPrompt` returns (`peer-mcp-personas.ts:487-499`):

- `# Subagent: codex-critic` header.
- `CRITIC_BASE` verbatim (`peer-mcp-personas.ts:229-235`): identity ("adversarial reviewer running on gpt-5.5"), the anti-sycophancy framing ("You are NOT a helpful assistant… Sycophancy is the failure mode you exist to fight. Manufactured contrarianism is a different failure of the same shape"), the `COLD_START_CONTRACT` (paste a self-contained brief; the persona has no scrollback), and the `CRITIC_RUBRIC` (1-5 scores on assumption-soundness / failure-mode coverage / alternative-considered; "no material objection" when all axes >=4).
- A routing block: "Always invoke the `mcp__peers__codex_critic` tool… `prompt`: the lead's brief, copied verbatim; `context` (optional)… Do NOT pass model or instructions — they are server-baked."
- Closing: "surface its output to the lead verbatim. Do not summarize, paraphrase, or add your own commentary."

The subagent is a relay; the graded critique is produced by the server-baked `CRITIC_BASE` running on gpt-5.5.

## 4. Routing-trigger assessment (Anthropic subagent rubric)

Rubric: third person, states the delegation TRIGGER, specific not vague, accurately previews the body, no overtrigger imperatives.

- **Third person / states trigger — partial.** The description is written as a capability blurb ("Adversarial second opinion on plans, designs, or code tradeoffs"), not as an explicit trigger sentence ("Use when weighing an architecture decision"). It DOES carry a strong implicit trigger via the "Best for architecture decisions, design reviews, and tradeoff analysis where cross-lab diversity matters" clause and an explicit anti-trigger ("Not for line-level code review (use codex_reviewer)"). For Opus this reads as a routing signal, but it lacks the literal "Use when…" / "Use proactively" idiom that Claude Code's auto-delegation loop keys on most reliably. This is a deliberate design tradeoff: the string doubles as a tool description, and the tool-description register ("Adversarial second opinion on X") is the correct register for a tool but a weaker register for a subagent trigger. See systemic finding S1 in the README.
- **Specific not vague — strong.** Names the model (gpt-5.5), the lab-diversity value, the artifact types it fits (plans/designs/tradeoffs) and the one it does not (line-level diffs), with a redirect. A reader can route confidently.
- **Accurately previews the body — yes.** "Adversarial second opinion", "cross-lab", "Pass artifact verbatim" all map directly to `CRITIC_BASE` (adversarial critic, gpt-5.5, cold-start-contract "paste a self-contained brief").
- **No overtrigger imperatives — yes.** No "always", no "before every". The "Best for…" framing is scoped, not blanket. Low overtrigger risk.

## 5. Don't-nerf / right-balance

Raises the floor without nerfing: the description gives Opus a real cross-lab critic it can reach at its discretion, and the explicit "Not for line-level code review (use codex_reviewer)" prevents the most likely misroute. It does not force invocation (no "always review with codex-critic"), so it will not fire on trivial work — the right amount. The one balance question is whether a subagent trigger should be MORE imperative than a tool description; here the shared string errs toward the tool register, which is slightly under-triggering for a subagent (S1).

## 6. Findings + verdict

- **[Suggestion]** The description works well as a tool description but is a soft subagent trigger — it lacks the "Use when…" idiom the auto-delegation loop prefers. Because the string is shared with the tool, changing it affects both surfaces. If the coordinator (which DOES carry "use proactively") is the intended entry point for critic fan-out, this is fine as-is: Opus is meant to route architecture review through `peer-review-coordinator`, and codex-critic is a leaf the coordinator selects. Treat the soft trigger as intentional given that routing model. See README S1.
- **[Suggestion]** "strongest reasoning model in the critic lineup" is a superlative that goes stale if the lineup changes; durability nit only (mirrors the tool-doc finding).
- No Critical or Important findings. The description accurately previews the body, differentiates cleanly from the other three critics, and carries no overtrigger imperative.

**Verdict: Y (with a soft-trigger caveat).** Correct, specific, non-overtriggering. As a subagent routing line it is a capability blurb rather than an explicit trigger, which is acceptable under the coordinator-as-entry-point model but is the weakest axis of the rubric.
