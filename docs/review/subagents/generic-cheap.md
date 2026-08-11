# Subagent: `generic-cheap` (native)

> The native lowest-cost catch-all subagent. It takes high-volume or long-running, cost-sensitive work using a 1M-context model and the full inherited toolset in a separate, non-lead context.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `generic-cheap` |
| Subagent's OWN model | `gpt-5.6-luna` only, when its catalog entry advertises `tool_calls` and at least 1M context |
| Gate | Conditionally emitted. It is omitted entirely when Luna does not resolve, rather than inheriting the lead's model. |
| Registered via | `buildPeerAgentDefinitions` in `src/lib/codex-mcp-config.ts` |
| Description source | Inline native-agent definition in `buildPeerAgentDefinitions` |
| System prompt | Shared `genericPromptFor` inline helper in `buildPeerAgentDefinitions` |
| Tools | No `tools:` declaration, so it inherits the parent's full toolset, including Agent. |

It is one of eight native agents: `implementer`, `reviewer`, `brainstorm`, `scout`, `scribe`, `generic`, `generic-fast`, and `generic-cheap`. The resolver is `genericCheapModel()` in `src/lib/mcp-capabilities.ts`; it calls the shared catalog walk with `requireToolCalls: true` and `minContextTokens: ONE_M_TOKENS`.

## 2. Description (verbatim)

> Catch-all subagent running `gpt-5.6-luna` (1M context, the lowest-cost model in the catalog, and unlike the flash tier it carries the full reasoning-effort ladder so an effort selection above high still applies). Use for high-volume or long-running work where cost dominates. Runs in its own context on a non-lead model. Model is overridable at spawn.

The single-entry chain is deliberate. Luna is the lowest-cost catalog model, with catalog prices of input 20 and output 120, versus 150/750 for `gemini-3.6-flash` and 200/1200 for `gpt-5.6-terra`. It advertises a 1.05M context window and the `none` through `max` reasoning-effort ladder. No `-mini`, `-lite`, or `-haiku` catalog model has 1M context; the cheapest such tier tops out at 400K `gpt-5.4-mini`, so the cheap catch-all uses a `gpt-5.6-*` slug instead.

Luna is not reused as `generic-fast`'s fallback. Sharing it would make both agents resolve to the same model during a degraded catalog, eliminating their separate roster roles. Its resolved frontmatter receives the catalog-gated `[1m]` suffix through `withOneMSuffix`.

## 3. System-prompt summary

The shared prompt directs the agent to determine what the delegated task needs, carry it through end to end, and verify against the repository and runtime rather than assumptions. It requires dedicated file and search tools, reserves Bash for builds, tests, and git, asks it not to spawn subagents, and requires a report of work performed, verification, and unresolved points.

The full inherited toolset is intentional. Unlike the read-only `scout` and `brainstorm`, this catch-all can finish the mixed read-and-edit task it receives. The prompt's no-spawn sentence remains a request rather than an enforcement boundary because the inherited toolset includes Agent.

## 4. Routing-trigger assessment

- **States trigger.** It applies to high-volume or long-running work where cost dominates.
- **Specific not vague.** The cost-first scope differentiates it from the mid-tier, Gemini Flash, and specialist routes.
- **Accurately previews the body.** The shared end-to-end prompt and full toolset can complete the cost-sensitive task instead of merely researching it.
- **Overtrigger risk.** Cost dominates only for the stated workload shape. It does not redefine the project's normal quality-first engineering standard.

## 5. Don't-nerf / right-balance

`generic-cheap` is a full-toolset catch-all, not a read-only scout variant. It is dropped rather than inherited from the lead when Luna is unavailable, preserving the promise that the delegation reduces rather than silently increases model cost. Reasoning effort is selected through Claude Code's normal effort picker and translated downstream, not set per agent; because Luna advertises the full ladder, an explicit choice above `high` still propagates.

## 6. Findings + verdict

- **No material routing defect found.** The single-entry resolver keeps the cheap role distinct from `generic-fast`, enforces both `tool_calls` and the 1M floor, and drops independently if Luna is unavailable.

**Verdict: Y.** The description gives a precise cost-first trigger while preserving a capable full-toolset path.
