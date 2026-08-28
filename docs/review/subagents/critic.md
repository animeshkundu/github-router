# Fast-profile critic

The fast launch profile's `critic` native subagent runs `gemini-3.7-flash` with a 1M-context `[1m]` frontmatter id and medium effort. It is a fresh-context, cross-lab reviewer for plans, designs, diffs, and decisions. Its tools are Read, Grep, Glob, Bash, and the resolved search MCP wildcard. Bash is available for evidence commands, but the dispatch hook is only an in-session Task/Agent ACL, not a shell sandbox.

The fast delegation graph is lead → all five roles; planner → reviewer/Explore/critic; implementer → reviewer/critic; reviewer, Explore, and critic → no native subagents. Capitalized `Explore` is the sole fast exploration role and replaces fast `scout`. The compiled PreToolUse guard accepts both `Task` and `Agent`, supports snake/camel target aliases, denies unknown or malformed caller/target identities, and removes invocation-level model overrides from allowed dispatches so fixed frontmatter wins. Standard launches and direct `-m gpt-5.6-luna` do not register this role or guard.

The fast profile requires the critic's live catalog shape: exact `gemini-3.7-flash`, tool calls, at least 1M context, medium effort, and a chat-completions endpoint. There is no fallback.

## Verification

- `tests/fast-dispatch-acl.test.ts` covers the graph, aliases, malformed identity, and unrelated hook pass-through.
- `tests/fast-dispatch-hook.test.ts` covers stable command construction and fast-only fatal installation.
- `tests/mcp-capabilities-fast-profile.test.ts` covers the exact resolver and no-fallback behavior.
- `tests/isolated/codex-mcp-config.test.ts` covers fast role tool sets and `[1m]` frontmatter.
- `scripts/probe-copilot-compat.sh` includes the `fast_gemini37flash_chat_reasoning_medium` upstream shape row.

No shell sandbox guarantee is implied by the Bash allowlist. The hook controls only native Task/Agent delegation edges.

Standard launches retain their existing definitions, MCP groups, prompts, and hooks.

## Review inventory

This page documents the fast-only native role and does not replace the standard peer-critic inventory. The standard `gemini-critic` MCP persona remains separate and is not registered by the fast profile.

The fast profile's live prerequisite also retains Gemini's independent high-effort Advisor requirement. The critic's additional medium-effort/tool-call checks are applied only to the fast profile prerequisite and exact critic resolver.

The role is intentionally named `critic`, not `brainstorm`, `gemini-critic`, or `reviewer`; this keeps native ACL identities distinct from MCP persona names and standard native roles.

The planner's Task/Agent tools are paired with the runtime ACL. Tool visibility alone is not the authority boundary: the compiled hook remains the enforcement path, and its install failure is fatal before Claude Code is spawned.

The implementer keeps the inherited full toolset for edits and verification. Its native dispatch authority remains limited to `reviewer` and `critic` by the same hook.

The lead receives the fast MCP config without persistent mirror injection. Inline server keys continue to use the collision-resolved keys from the launch.

The `critic` model is decorated with `[1m]` because its resolver requires the advertised 1M context; the upstream request uses the bare catalog id after normal model preprocessing.

No attribution markers are included.
