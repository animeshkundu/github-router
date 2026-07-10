# Subagent: `implementer` (native, gpt-5.6-sol)

> The native implementation subagent. Unlike the peer critics (thin routers to a verdict model via MCP, themselves running on the inherited Claude model), this subagent prefers gpt-5.6-sol and falls back to gpt-5.5 via the `/v1/messages` translation shim.

## 1. Identity

| Field | Value |
|---|---|
| Subagent name | `implementer` |
| Subagent's OWN model | `gpt-5.6-sol` preferred (`model:` frontmatter emitted), with `gpt-5.5` fallback (`src/lib/codex-mcp-config.ts:314`) |
| Gate | injected iff `implementerModel` is present, which is set by `implementerSubagentModel()` only when the live catalog has `gpt-5.6-sol` or `gpt-5.5` with `tool_calls` (`codex-mcp-config.ts:308-316`; repo CLAUDE.md "Native implementation subagent") |
| Registered via | `buildPeerAgentDefinitions` (`codex-mcp-config.ts:308-316`) |
| Description source | inline literal (`codex-mcp-config.ts:310-311`) — NOT a `PersonaSpec`, NOT shared with any tool |
| System prompt | inline literal (`codex-mcp-config.ts:312-313`) |
| Tools | none declared → inherits the parent's full toolset (Edit/Write/Bash/Read/Grep/Glob…); pinned by `tests/codex-mcp-config.test.ts:320` (`"tools" in implementer` is false) |

Distinct from every other injected subagent: it carries a `model:` frontmatter line so its main loop prefers gpt-5.6-sol and falls back to gpt-5.5 (through the shim), and it inherits the full toolset (it does real file edits itself, not via an MCP relay).

## 2. Description (verbatim)

`codex-mcp-config.ts:310-311`:

> Bounded implementation subagent running gpt-5.6-sol (strong non-Claude coder, high reasoning; gpt-5.5 fallback). Use for well-scoped coding tasks — edits, small features, fixes — you want implemented in an integrated subagent. Model is overridable at spawn.

## 3. System-prompt summary

`codex-mcp-config.ts:312-313`: "You are a bounded implementation subagent for well-scoped coding tasks. Implement the requested change surgically, matching the surrounding code style and minimizing unrelated churn. Use the dedicated Edit/Write/Read tools for file changes and Grep/Glob for search; reserve Bash for running builds, tests, and git — do not shell out (sed/awk/python/here-docs) to read or edit files. Verify with the project's build or tests where applicable. Do the work yourself — do not spawn further subagents. Report exactly what changed and any risks."

Terminal (no sub-agent spawning), tool-hygiene guidance (prefer Edit/Write over shelling out), and a verify-then-report contract.

## 4. Routing-trigger assessment

- **States trigger — good.** "Use for well-scoped coding tasks — edits, small features, fixes — you want implemented in an integrated subagent" is an explicit "Use for…" trigger that names the artifact class (edits/features/fixes) and the scope boundary (well-scoped, bounded, integrated). Clearer than codex-implementer's thin line.
- **Specific not vague — good.** Names the model (gpt-5.6-sol, with gpt-5.5 fallback), the reasoning tier, the task class, and "integrated subagent" (contrasting the non-blocking worker path). "Model is overridable at spawn" is a genuine capability note (frontmatter `model:` is resolution rank #3, so a per-invocation `model` param wins — repo CLAUDE.md "Native implementation subagent"), pinned by `tests/codex-mcp-config.test.ts:321`.
- **Accurately previews the body — yes.** "bounded", "well-scoped", "integrated subagent", surgical implementation all map to the system prompt.
- **Overtrigger risk — LOW.** "Use for well-scoped coding tasks" is scoped by "bounded" and "integrated"; it does not say "always implement via this subagent". On Opus 4.5+ the "Use for X" phrasing is measured, not blanket.

## 5. Don't-nerf / right-balance

This is the intended common-case implementation surface (repo CLAUDE.md: "reducing reliance on `worker_implement` for the common case; workers stay for long / autonomous / worktree-isolated runs"). The description correctly carves that niche: integrated + bounded here, autonomous/long/worktree for the worker. Raises the floor (a strong non-Claude coder as a first-class subagent) without nerfing the worker path. The "integrated subagent" phrase is the load-bearing differentiator from `worker-implement`.

## 6. Findings + verdict

- **[Important] Part of S3 (three-way implement overlap).** This is the middle of three write-capable implementation surfaces. It differentiates from `worker-implement` reasonably well ("integrated subagent" vs "non-blocking… background"), but it does NOT differentiate from `codex-implementer` (both gpt-family, both integrated, both foreground). Under `--codex-cli` a lead sees both `implementer` (gpt-5.6-sol, gpt-5.5 fallback) and `codex-implementer` (gpt-5.3-codex) with near-identical scope framing and no cross-reference. Recommend one description name the other (e.g. native implementer: "prefer over codex-implementer unless you need Codex-CLI sandboxing"). See README S3.
- **[Suggestion]** The description does not state the subagent runs its OWN loop on gpt-5.6-sol (with gpt-5.5 fallback) (vs the critics which relay to a peer model). "running gpt-5.6-sol" implies it but a reader could conflate it with the relay pattern. Minor; the "integrated subagent" phrase already signals it does the work itself.

**Verdict: Y (with the S3 overlap caveat).** The strongest "Use for…" trigger among the implementation subagents, correctly scoped, accurate body preview, low overtrigger. The only real issue is shared with S3: no differentiation from codex-implementer under `--codex-cli`.
