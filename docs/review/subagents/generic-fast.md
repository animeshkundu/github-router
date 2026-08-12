# Subagent: `generic-fast` (native)

> The native Gemini flash-tier catch-all subagent. It handles well-specified work that does not need frontier-model reasoning, using the full inherited toolset in a separate, non-lead context.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `generic-fast` |
| Subagent's OWN model | `gemini-3.6-flash` preferred, then `gemini-3.5-flash`, only when the catalog entry advertises `tool_calls` and at least 1M context |
| Gate | Conditionally emitted. It is omitted entirely when neither chain member resolves, rather than inheriting the lead's model. |
| Registered via | `buildPeerAgentDefinitions` in `src/lib/codex-mcp-config.ts` |
| Description source | Inline native-agent definition in `buildPeerAgentDefinitions` |
| System prompt | Shared `genericPromptFor` inline helper in `buildPeerAgentDefinitions` |
| Tools | No `tools:` declaration, so it inherits the parent's full toolset, including Agent. |

It is one of eight native agents: `implementer`, `implementer-fast`, `reviewer`, `brainstorm`, `scout`, `scribe`, `generic-fast`, and `generic-cheap`. The resolver is `genericFastModel()` in `src/lib/mcp-capabilities.ts`; it passes both `requireToolCalls: true` and `minContextTokens: ONE_M_TOKENS` to the shared catalog walk. The 1M floor keeps the context promise honest if a catalog entry's advertised window changes.

## 2. Description (verbatim)

> Catch-all subagent running `<resolved model>` (1M context, Gemini flash tier — low cost, reasoning effort tops out at high). Use for well-specified work that does not need a frontier model's reasoning. Runs in its own context on a non-lead model. Model is overridable at spawn.

The resolver prefers `gemini-3.6-flash` and falls back to `gemini-3.5-flash`. It intentionally does not fall back to `gpt-5.6-luna`: Luna is `genericCheapModel()`'s sole entry, and sharing it would collapse two catch-all entries onto one model in a degraded catalog. The model frontmatter receives a catalog-gated `[1m]` suffix through `withOneMSuffix`.

## 3. System-prompt summary

The shared prompt directs the agent to determine what the delegated task needs, carry it through end to end, and verify against the repository and runtime rather than assumptions. It requires dedicated file and search tools, reserves Bash for builds, tests, and git, asks it not to spawn subagents, and requires a report of work performed, verification, and unresolved points.

The full inherited toolset is intentional. Unlike `scout` and `brainstorm`, this catch-all can complete write-capable work rather than handing it back after exploration. The prompt's no-spawn sentence is not enforced because the inherited toolset includes Agent.

## 4. Routing-trigger assessment

- **States trigger.** It applies to well-specified work that does not need frontier-model reasoning.
- **Specific not vague.** It separates light, defined tasks from the mid-tier catch-all, specialist natives, and the cost-first cheap tier.
- **Accurately previews the body.** The general-purpose end-to-end prompt is appropriate for delegated light work.
- **Overtrigger risk.** The `fast` name does not promise a measured latency result. The emitted description identifies a Gemini flash tier and its effort ceiling instead.

## 5. Don't-nerf / right-balance

`generic-fast` remains a full-toolset catch-all, not a read-only scout variant. It is dropped rather than silently inheriting an expensive lead model when neither qualifying Flash model is live. Its reasoning effort is not a per-agent setting: the Claude Code effort picker flows through the translation shim, and Gemini's advertised capability clamps a higher selection at `high`.

The name's speed claim remains an open question. The repository has not benchmarked Flash against Luna on this role. Luna is cheaper, has a larger advertised context window, and offers a fuller effort ladder; Flash's current differentiators are vendor diversity and its established agentic tool-calling role in this repository as the `EXPLORE_DEFAULT_MODEL` behind `worker-explore` and `scout`. The recorded follow-up is to benchmark Flash and Luna with an identical trivial tool-calling task.

## 6. Findings + verdict

- **Known open question.** `generic-fast` is a tier name, not evidence of measured speed. Two cross-lab peer critics recommended a two-agent rather than three-agent roster; the three-agent roster was an explicit user decision with that objection considered.
- **No material routing defect found.** The resolver preserves a distinct Gemini Flash fallback and drops the agent independently when no qualifying entry exists.

**Verdict: Y.** The description gives an honest trigger for well-specified, lower-cost work without claiming unmeasured latency.
