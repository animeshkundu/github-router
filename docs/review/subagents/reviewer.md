# Subagent: `reviewer` (native)

> The native feedback subagent. It assesses existing artifacts against the actual repository, reproducing failures and isolating root causes when needed.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `reviewer` |
| Subagent's OWN model | `gpt-5.6-sol` preferred, then `gpt-5.5`, when a catalog entry advertises `tool_calls`; otherwise the `model:` frontmatter is omitted and it inherits the lead's model |
| Gate | Always emitted. Model resolution affects only its optional `model:` frontmatter, not whether the agent exists. |
| Registered via | `buildPeerAgentDefinitions` in `src/lib/codex-mcp-config.ts` |
| Description source | Inline native-agent definition in `buildPeerAgentDefinitions` |
| System prompt | Inline native-agent definition in `buildPeerAgentDefinitions` |
| Tools | No `tools:` declaration, so it inherits the parent's full toolset |

It is one of eight native agents: `implementer`, `implementer-fast`, `reviewer`, `brainstorm`, `scout`, `scribe`, `generic-fast`, and `generic-cheap`. Its scope replaces the former split between `qa-engineer` and `debugger`: assessment includes the investigation needed to establish what is wrong.

## 2. Description (verbatim)

The emitted wording depends on whether `nativeSubagentModel()` resolves a catalog model:

> Feedback subagent running `<resolved model>` at maximum reasoning. Use proactively when something already exists and you want it assessed: a diff, a plan, a document, a failing test. It does whatever the assessment needs, including reproducing a failure and isolating its root cause, and keeps that work off the lead's context. Model is overridable at spawn.

Without a resolved frontier coder, the description instead says it uses native tools and runs on the lead's model in its own context.

## 3. System-prompt summary

The prompt requires repository-grounded assessment, failure reproduction as close to real use as possible, root-cause isolation rather than symptom treatment, and severity-ranked `file:line` findings. When warranted, it may author adversarial tests but must not change production code merely to make them pass. It ends with a clear go/no-go.

## 4. Routing-trigger assessment

- **States trigger.** It covers an existing diff, plan, document, or failure that needs assessment.
- **Specific not vague.** It names reproduction and root-cause isolation rather than promising generic review.
- **Accurately previews the body.** The description's assessment and investigation claims match the prompt.
- **Overtrigger risk.** The trigger applies to an existing artifact or failure, not to implementation or open-ended option generation.

## 5. Don't-nerf / right-balance

Use this agent for repository-aware feedback and diagnosis. Peer critics remain useful for fresh-context cross-lab critique, while this agent can inspect surrounding code and run a reproduction. The separate `worker-review` path remains a non-blocking worker option.

## 6. Findings + verdict

- **No material routing defect found.** The agent remains present on a thin catalog by inheriting the lead's model when the preferred frontier chain is unavailable.

**Verdict: Y.** The description gives a concrete trigger for assessment work and correctly forecasts a repository-grounded review or diagnosis.
