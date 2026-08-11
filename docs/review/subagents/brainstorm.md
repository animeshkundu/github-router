# Subagent: `brainstorm` (native)

> The native divergent-options subagent. It investigates the repository read-only and proposes materially different approaches before an implementation direction is chosen.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `brainstorm` |
| Subagent's OWN model | `gemini-3.1-pro-preview` preferred, then the OpenAI frontier chain, when a catalog entry advertises `tool_calls`; otherwise the `model:` frontmatter is omitted and it inherits the lead's model |
| Gate | Always emitted. Model resolution affects only its optional `model:` frontmatter, not whether the agent exists. |
| Registered via | `buildPeerAgentDefinitions` in `src/lib/codex-mcp-config.ts` |
| Description source | Inline native-agent definition in `buildPeerAgentDefinitions` |
| System prompt | Inline native-agent definition in `buildPeerAgentDefinitions` |
| Tools | Read-only allowlist: Read, Grep, Glob, Bash, WebFetch, WebSearch, and the resolved `search` MCP server |

It is one of eight native agents: `implementer`, `reviewer`, `brainstorm`, `scout`, `scribe`, `generic`, `generic-fast`, and `generic-cheap`. Its `tools:` field is a positive allowlist, so it deliberately does not inherit write tools, Agent, worker tools, orchestrate tools, or future tools not listed there.

## 2. Description (verbatim)

The emitted wording depends on whether `brainstormModel()` resolves a catalog model:

> Divergent-options subagent running `<resolved model>` (third lab, for approaches the lead would not generate). Use proactively BEFORE an approach is chosen: it returns several materially different options with trade-offs and a recommendation. Read-only; it proposes, then hands off to implementer. Model is overridable at spawn.

Without a resolved preferred model, the description instead says it runs on the lead's model in its own context.

## 3. System-prompt summary

The prompt requires three to five approaches that differ in mechanism, with each option's operation, cost, decisive failure mode, and condition where it becomes right. It requires a recommendation, rejects padded near-duplicates, and grounds the alternatives in repository evidence before proposing them.

## 4. Routing-trigger assessment

- **States trigger.** It applies before an approach is selected.
- **Specific not vague.** It asks for divergent mechanisms and trade-offs, rather than a generic plan.
- **Accurately previews the body.** The description's options, trade-offs, and recommendation match the prompt.
- **Overtrigger risk.** The before-decision boundary excludes routine implementation and artifact review.

## 5. Don't-nerf / right-balance

The agent is intentionally read-only and exploratory. It provides a separate perspective before the lead commits to an approach, then hands implementation to `implementer`. It is not a substitute for an ordered implementation plan after the direction is settled.

## 6. Findings + verdict

- **No material routing defect found.** A missing preferred model preserves the agent by omitting `model:` and inheriting the lead's model; only `scout` is dropped when its model chain misses.

**Verdict: Y.** The description provides a narrow, pre-decision trigger and a faithful preview of divergent, repository-grounded option generation.
