# Subagent: `implementer-fast` (native)

> The cheaper implementation subagent. It handles well-specified, mechanical coding changes with the full inherited toolset in a separate, non-lead context.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `implementer-fast` |
| Subagent's OWN model | `gpt-5.6-terra` preferred, then `gemini-3.1-pro-preview`, only when the catalog entry advertises `tool_calls` and at least 1M context |
| Gate | Conditionally emitted. It is omitted entirely when neither chain member resolves, rather than inheriting the lead's model. |
| Registered via | `buildPeerAgentDefinitions` in `src/lib/codex-mcp-config.ts` |
| Description source | Inline native-agent definition in `buildPeerAgentDefinitions` |
| System prompt | Shared `genericPromptFor` inline helper in `buildPeerAgentDefinitions` |
| Tools | No `tools:` declaration, so it inherits the parent's full toolset, including Agent. |

It is one of seven native agents: `implementer`, `implementer-fast`, `reviewer`, `brainstorm`, `scout`, `scribe`, and `general-purpose-fast`. The resolver is `implementerFastModel()` in `src/lib/mcp-capabilities.ts`; it passes both `requireToolCalls: true` and `minContextTokens: ONE_M_TOKENS` to the shared catalog walk.

## 2. Description

The description carries the load-bearing "Use proactively" trigger and draws a reciprocal boundary with `implementer`: this agent owns well-specified, mechanical coding changes, while `implementer` owns changes that need judgment or have ambiguous scope.

The model-specific framing branches honestly. When Terra resolves, the description identifies it as the cheaper, faster implementation tier. When the Gemini Pro fallback resolves, the description uses the neutral phrase "a non-lead implementation model" and does not claim Terra's speed, cost, or `max` effort properties. The resolved frontmatter model receives a catalog-gated `[1m]` suffix through `withOneMSuffix`.

## 3. System-prompt summary

The shared prompt frames the delegated work as a well-specified, mechanical coding change, directs the agent to complete it end to end, and requires verification against the repository and runtime. It prefers dedicated file and search tools, reserves Bash for builds, tests, and git, asks the agent not to spawn subagents, and requires a report of work performed, verification, and unresolved points.

The full inherited toolset is intentional. Unlike read-only `scout` and `brainstorm`, this agent can implement and verify its change itself. Its no-spawn sentence is a request, not an enforcement boundary, because the inherited toolset includes Agent.

## 4. Routing-trigger assessment

- **States trigger.** "Use proactively" gives Claude Code's delegation rubric the idiom it keys on.
- **Specific not vague.** The mechanical / well-specified boundary distinguishes it from `implementer`'s judgment-heavy or ambiguous work.
- **Reciprocal split.** Both implementation descriptions name the same boundary from opposite sides, reducing overlap rather than relying on the agent name alone.
- **Accurately previews the body.** The end-to-end implementation and verification framing matches the shared prompt.

## 5. Don't-nerf / right-balance

`implementer-fast` adds a lower-tier path without weakening the frontier `implementer`. If neither qualifying model is live, it is absent rather than silently inheriting the lead. Its description does not make claims that are false on the Gemini fallback.

## 6. Findings + verdict

- **Resolved routing gap.** The former `generic` catch-all lacked the "Use proactively" trigger and overlapped weakly with several roles. The renamed agent now has a crisp implementation-specific boundary.
- **Accepted naming trade-off.** The static `-fast` name remains when Gemini Pro is the fallback; the dynamic description is neutral in that case.

**Verdict: Y.** The description is an explicit, honest delegation trigger for well-specified mechanical changes and preserves `implementer` for work that needs judgment.
