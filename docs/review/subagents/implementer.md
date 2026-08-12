# Subagent: `implementer` (native)

> The native implementation subagent. It runs in its own context, preferring the available OpenAI frontier coder and otherwise inheriting the lead's model.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `implementer` |
| Subagent's OWN model | `gpt-5.6-sol` preferred, then `gpt-5.5`, when a catalog entry advertises `tool_calls`; otherwise the `model:` frontmatter is omitted and it inherits the lead's model |
| Gate | Always emitted. Model resolution affects only its optional `model:` frontmatter, not whether the agent exists. |
| Registered via | `buildPeerAgentDefinitions` in `src/lib/codex-mcp-config.ts` |
| Description source | Inline native-agent definition in `buildPeerAgentDefinitions` |
| System prompt | Inline native-agent definition in `buildPeerAgentDefinitions` |
| Tools | No `tools:` declaration, so it inherits the parent's full toolset |

It is one of eight native agents: `implementer`, `implementer-fast`, `reviewer`, `brainstorm`, `scout`, `scribe`, `generic-fast`, and `generic-cheap`. Unlike peer critics, it does the work in its own agent loop rather than relaying a request through an MCP persona.

## 2. Description (verbatim)

The emitted wording depends on whether `nativeSubagentModel()` resolves a catalog model:

> Bounded implementation subagent running `<resolved model>` (strong non-Claude coder, maximum reasoning). Use proactively for well-scoped coding tasks: edits, small features, fixes, to keep the lead's context focused; runs in its own context. Model is overridable at spawn.

Without a resolved frontier coder, the description instead says it uses native tools and runs on the lead's model in its own context.

## 3. System-prompt summary

The prompt asks the agent to implement a well-scoped change surgically, match surrounding code style, minimize unrelated churn, use dedicated file and search tools, verify with relevant builds or tests, avoid spawning further subagents, and report changes and risks.

## 4. Routing-trigger assessment

- **States trigger.** The description directs well-scoped coding work, including edits, features, and fixes, to this agent.
- **Specific not vague.** It distinguishes bounded implementation from background workers by saying it runs in its own context, and it records that callers may override its model at spawn.
- **Accurately previews the body.** Surgical implementation, tool hygiene, verification, and self-contained execution all match the prompt.
- **Overtrigger risk.** The trigger is bounded by the task type and scope. It does not claim that every coding request requires delegation.

## 5. Don't-nerf / right-balance

This is the foreground implementation path for bounded work. The separate `worker-implement` path remains for autonomous, non-blocking, worktree-isolated work. The `codex-implementer` path appears only with `--codex-cli`; its Codex sandbox is the material reason to select it instead.

## 6. Findings + verdict

- **No material routing defect found.** The previous catalog gate claim was incorrect: a missing preferred model omits `model:` and preserves the agent by inheriting the lead's model.
- **Documentation constraint.** The agent's definition is emitted for every launch, while the `scout` agent alone is omitted when its cheap-tier model chain cannot resolve.

**Verdict: Y.** The native implementation agent has a clear bounded-work trigger and a graceful model fallback without disappearing from the roster.
