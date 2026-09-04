# Subagent: `scout` / fast `Explore` (native)

> The native low-cost repository exploration subagent. It investigates broadly, then returns conclusions with file and line references rather than raw search output.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | Standard: `scout`; fast profile: capitalized `Explore` |
| Subagent's OWN model | Standard: `gpt-5.6-luna` preferred, then `gemini-3.8-flash`; fast: exact Luna/high via `gh-router-luna-scout-high[1m]` |
| Gate | Standard `scout` is conditional. Fast `Explore` is mandatory under the fast-profile prerequisite and replaces fast `scout`. |
| Registered via | `buildPeerAgentDefinitions` in `src/lib/codex-mcp-config.ts` |
| Description source | Inline native-agent definition in `buildPeerAgentDefinitions` |
| System prompt | Inline native-agent definition in `buildPeerAgentDefinitions` |
| Tools | Read-only allowlist: Read, Grep, Glob, Bash, WebFetch, WebSearch, and the resolved `search` MCP server |

In standard launches, `scout` is one of seven native agents and its cheap-tier-only model policy is deliberate: silently inheriting an expensive lead model would defeat the purpose of a low-cost lookup agent. The resolver prefers Luna, falls back to Gemini Flash, and enforces a 1M context floor across both. In `-m fast`, the same job becomes the mandatory capitalized `Explore` role, fixed to Luna/high/1M with no fallback and no separate fast `scout`. The fast ACL strips invocation-level model overrides before spawn.

## 2. Description (verbatim)

> Read-only exploration subagent running `<resolved model>` (fast and cheap, so repository lookups do not run at the lead's model rates). Use proactively to find or understand something in the codebase: it sweeps widely and returns conclusions with file:line references rather than file dumps. Model is overridable at spawn.

This description is emitted for standard `scout` only when `scoutModel()` resolves a cheap-tier catalog model, and for fast `Explore` whenever the fail-closed fast prerequisite passes.

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

- **No material routing defect found.** The conditional roster behavior is intentional: `scout`, like `implementer-fast` and `general-purpose-fast`, is dropped rather than downgraded when its qualifying chain is unavailable.

**Verdict: Y.** The description gives a clear, cost-aware trigger for evidence-backed repository exploration.
