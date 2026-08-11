# Subagent: `generic` (native)

> The native mid-tier catch-all subagent. It takes an end-to-end task that fits none of the specialist natives, using the full inherited toolset in a separate, non-lead context.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `generic` |
| Subagent's OWN model | `gpt-5.6-terra` preferred, then `gemini-3.1-pro-preview`, only when the catalog entry advertises `tool_calls` and at least 1M context |
| Gate | Conditionally emitted. It is omitted entirely when neither chain member resolves, rather than inheriting the lead's model. |
| Registered via | `buildPeerAgentDefinitions` in `src/lib/codex-mcp-config.ts` |
| Description source | Inline native-agent definition in `buildPeerAgentDefinitions` |
| System prompt | Shared `genericPromptFor` inline helper in `buildPeerAgentDefinitions` |
| Tools | No `tools:` declaration, so it inherits the parent's full toolset, including Agent. |

It is one of eight native agents: `implementer`, `reviewer`, `brainstorm`, `scout`, `scribe`, `generic`, `generic-fast`, and `generic-cheap`. The resolver is `genericModel()` in `src/lib/mcp-capabilities.ts`; it passes both `requireToolCalls: true` and `minContextTokens: ONE_M_TOKENS` to the shared catalog walk. The 1M floor makes the description's context-window claim fail closed if an advertised model window shrinks.

## 2. Description (verbatim)

> Catch-all subagent running `<resolved model>` (1M context, broad general capability). Use for work that no specialist native fits and that you would otherwise do inline: multi-step tasks, mixed read-and-edit work, one-off investigations that end in a change. Runs in its own context on a non-lead model. Model is overridable at spawn.

The resolver prefers `gpt-5.6-terra` and falls back to `gemini-3.1-pro-preview`. `gpt-5.6-sol` is deliberately absent: the OpenAI frontier coder is already `implementer`'s job, and including it would defeat this mid-tier agent's purpose. The description names the model that actually resolved, while its frontmatter model receives a catalog-gated `[1m]` suffix through `withOneMSuffix`.

## 3. System-prompt summary

The shared prompt directs the agent to determine what the delegated task needs, carry it through end to end, and verify against the repository and runtime rather than assumptions. It requires dedicated file and search tools, reserves Bash for builds, tests, and git, asks it not to spawn subagents, and requires a report of work performed, verification, and unresolved points.

The full inherited toolset is intentional. Unlike the read-only `scout` and `brainstorm`, this catch-all can finish mixed investigation and editing work itself. Its no-spawn sentence is a request, not an enforcement boundary, because the inherited toolset includes Agent.

## 4. Routing-trigger assessment

- **States trigger.** It applies when no specialist native fits a multi-step, mixed read-and-edit, or investigation-to-change task.
- **Specific not vague.** It distinguishes catch-all work from implementation, review, ideation, exploration, and documentation maintenance.
- **Accurately previews the body.** The end-to-end and verification framing matches the shared general-purpose prompt.
- **Overtrigger risk.** The description limits this path to work the lead would otherwise do inline, not every task that merely lacks a perfect specialist label.

## 5. Don't-nerf / right-balance

`generic` provides a mid-tier non-lead path without turning a thin catalog into an expensive inherited-lead delegation. If neither qualifying model is live, it is absent rather than downgraded. The full toolset makes it a real catch-all rather than a second scout, while the prompt asks it not to recurse through subagents.

## 6. Findings + verdict

- **No material routing defect found.** `generic`'s resolver keeps the 1M and `tool_calls` requirements explicit, drops the agent independently when neither chain member qualifies, and keeps the frontier coding model reserved for `implementer`.

**Verdict: Y.** The description gives a clear mid-tier trigger for end-to-end work no specialist native owns.
