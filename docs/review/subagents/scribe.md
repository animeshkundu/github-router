# Subagent: `scribe` (native)

> The native documentation subagent. It reads the code before updating prose that trails it and reports any claim it could not verify.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `scribe` |
| Subagent's OWN model | `gpt-5.6-terra` preferred, then the OpenAI frontier chain, when a catalog entry advertises `tool_calls`; otherwise the `model:` frontmatter is omitted and it inherits the lead's model |
| Gate | Always emitted. Model resolution affects only its optional `model:` frontmatter, not whether the agent exists. |
| Registered via | `buildPeerAgentDefinitions` in `src/lib/codex-mcp-config.ts` |
| Description source | Inline native-agent definition in `buildPeerAgentDefinitions` |
| System prompt | Inline native-agent definition in `buildPeerAgentDefinitions` |
| Tools | No `tools:` declaration, so it inherits the parent's full toolset |

It is one of eight native agents: `implementer`, `implementer-fast`, `reviewer`, `brainstorm`, `scout`, `scribe`, `generic-fast`, and `generic-cheap`.

## 2. Description (verbatim)

The emitted wording depends on whether `scribeModel()` resolves a catalog model:

> Documentation subagent running `<resolved model>`. Use proactively for prose that trails the code: docs, ADRs, CLAUDE.md sections, changelog entries, and README updates that have gone stale. Keeps low-glamour upkeep off the lead's context. Model is overridable at spawn.

Without a resolved preferred model, the description instead says it runs on the lead's model in its own context.

## 3. System-prompt summary

The prompt requires every written claim to be checkable against the current repository, preservation of the surrounding document's voice and structure, updates to existing documents where possible, and removal of stale statements rather than additive corrections. It directs use of dedicated file and search tools, prohibits further subagent spawning, and requires a report of changed documents and unverifiable claims.

## 4. Routing-trigger assessment

- **States trigger.** It applies to stale documentation, ADRs, CLAUDE.md sections, changelog entries, and README material.
- **Specific not vague.** It explicitly limits its scope to prose that follows code.
- **Accurately previews the body.** The description's documentation-maintenance claim matches the source-grounded prompt.
- **Overtrigger risk.** It excludes code implementation, exploration, and feedback work.

## 5. Don't-nerf / right-balance

This agent keeps documentation maintenance separate from implementation. It can edit the relevant prose directly, but only after grounding its claims in the repository. It remains available when the preferred documentation model is absent by inheriting the lead's model.

## 6. Findings + verdict

- **No material routing defect found.** The native roster does not disappear when the preferred chain misses: `scribe` omits `model:` and inherits the lead, while only `scout` is conditionally omitted.

**Verdict: Y.** The description has a precise prose-maintenance trigger and accurately predicts repository-grounded documentation work.
