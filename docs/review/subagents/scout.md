# Subagent: `scout` (native)

> The native low-cost repository exploration subagent. It investigates broadly, then returns conclusions with file and line references rather than raw search output.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `scout` |
| Subagent's OWN model | `gemini-3.6-flash` preferred, then `gpt-5.4-mini`, only when a catalog entry advertises `tool_calls` |
| Gate | Conditionally emitted. It is omitted entirely when neither cheap-tier model resolves, rather than inheriting the lead's model. |
| Registered via | `buildPeerAgentDefinitions` in `src/lib/codex-mcp-config.ts` |
| Description source | Inline native-agent definition in `buildPeerAgentDefinitions` |
| System prompt | Inline native-agent definition in `buildPeerAgentDefinitions` |
| Tools | Read-only allowlist: Read, Grep, Glob, Bash, WebFetch, WebSearch, and the resolved `search` MCP server |

It is one of five native agents: `implementer`, `reviewer`, `brainstorm`, `scout`, and `scribe`. Its cheap-tier-only model policy is deliberate: silently inheriting an expensive lead model would defeat the purpose of a low-cost lookup agent.

## 2. Description (verbatim)

> Read-only exploration subagent running `<resolved model>` (fast and cheap, so repository lookups do not run at the lead's model rates). Use proactively to find or understand something in the codebase: it sweeps widely and returns conclusions with file:line references rather than file dumps. Model is overridable at spawn.

This description is emitted only when `scoutModel()` resolves a cheap-tier catalog model.

## 3. System-prompt summary

The prompt directs a broad-then-narrow repository investigation. It requires conclusions rather than raw material, `file:line` citations for load-bearing claims, an explicit absence conclusion when appropriate, and read-only tool behavior without subagent spawning.

## 4. Routing-trigger assessment

- **States trigger.** It applies to finding or understanding repository code.
- **Specific not vague.** It promises broad exploration and evidence-bearing conclusions, not generic research.
- **Accurately previews the body.** The sweep, narrowing, citations, and concise conclusion match the prompt.
- **Overtrigger risk.** The read-only lookup scope excludes implementation, review, and documentation maintenance.

## 5. Don't-nerf / right-balance

`scout` is the cheap path for repository discovery. If its inexpensive model tier is unavailable, the agent is absent and the lead can use the normal Explore path instead of unknowingly paying lead-model rates. The `tools:` allowlist supports read and search work but is not a hard sandbox because Bash remains available.

## 6. Findings + verdict

- **No material routing defect found.** The conditional roster behavior is intentional and unique to `scout`: it is dropped rather than downgraded when its cheap-tier chain is unavailable.

**Verdict: Y.** The description gives a clear, cost-aware trigger for evidence-backed repository exploration.
