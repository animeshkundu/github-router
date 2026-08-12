# Subagent: `general-purpose-fast` (native)

> The native fast, economical catch-all. It handles work no specialist fits using the fastest measured and lowest-cost catch-all candidate, with a 1.05M context window and the full inherited toolset.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `general-purpose-fast` |
| Subagent's OWN model | `gpt-5.6-luna` only, when its catalog entry advertises `tool_calls` and at least 1M context |
| Gate | Conditionally emitted. It is omitted when Luna does not resolve, rather than inheriting the lead's model. |
| Registered via | `buildPeerAgentDefinitions` in `src/lib/codex-mcp-config.ts` |
| Resolver | `generalPurposeFastModel()` in `src/lib/mcp-capabilities.ts` |
| System prompt | Shared `genericPromptFor` helper in `buildPeerAgentDefinitions` |
| Tools | No `tools:` declaration, so it inherits the parent's full toolset, including Agent. |

It is one of seven native agents: `implementer`, `implementer-fast`, `reviewer`, `brainstorm`, `scout`, `scribe`, and `general-purpose-fast`. Its resolver calls the shared catalog walk with `requireToolCalls: true` and `minContextTokens: ONE_M_TOKENS`. The chain stays inside the function body because `mcp-capabilities.ts` participates in an import cycle with `worker-agent`; a module-level chain constant can read an imported binding while it is still in the temporal dead zone.

## 2. Description

The emitted description names Luna, its 1.05M context, its lowest-cost catalog position, its fastest measured catch-all result, and its full reasoning-effort ladder. It says: use proactively for work no specialist fits when a fast, economical non-lead model can finish it. The full toolset and model-override contract are explicit.

The single-entry chain makes every claim true on every resolution path. The model frontmatter receives a catalog-gated `[1m]` suffix through `withOneMSuffix`.

## 3. Measurement basis

A fixed prompt was run three times per candidate through this proxy on 2026-08-11. Approximate output throughput was 82 tokens/s for Luna, 34 for Gemini 3.6 Flash, and 24–35 for Gemini 3.5 Flash. Live-catalog prices per 1M tokens were respectively 20/120, 150/750, and 150/900 input/output, with context windows 1.05M, 1.00M, and 1.00M.

Luna therefore dominated the former `generic-fast` chain on measured speed, input price, output price, and context. The roster deleted `generic-fast` and renamed `generic-cheap` to this earned role.

## 4. Routing and tool balance

- **Trigger:** work no specialist fits, not mechanical coding (`implementer-fast`), repository lookup (`scout`), review, ideation, or docs.
- **Auto-delegation idiom:** the description includes `Use proactively`, matching the other native routes.
- **Full toolset:** the catch-all can finish mixed read/edit/run tasks rather than returning research only.
- **Drop-not-downgrade:** when Luna is absent, the agent is omitted instead of silently using the expensive lead model.
- **Effort:** Luna carries the full `none` through `max` ladder; effort still follows the caller's normal selection rather than a per-agent override.

## 5. Findings + verdict

- **Measurement resolved the former overlap.** One earned catch-all replaces two routes whose candidates were not competitive.
- **The name and trigger now align.** It is general-purpose, demonstrably fast among the compared catch-all candidates, and explicitly proactive.

**Verdict: Y.** The route is singular, measurable, availability-honest, and capable of completing the delegated work.
