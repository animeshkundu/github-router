# Unsupported features (Copilot can't serve)

Anthropic API surfaces with no Copilot equivalent, and how the proxy degrades:
explicit Anthropic-format errors, server-side wiring (ADVISOR), or fail-fast 400s.
See [`../CLAUDE.md`](../CLAUDE.md) for project overview.

## Explicit limitations

- **Files API** (`/v1/files/*`): Copilot has no equivalent storage backend (verified via `cc-backup/src/services/api/filesApi.ts`). The proxy returns 404 with a descriptive error pointing users at the real Anthropic API for file uploads/downloads.

- **ADVISOR** (`advisor-tool-2026-03-01`): Copilot returns 400 "unsupported beta header" on this prefix. **Phase I (shipped, auto-enabled for `github-router claude`)**: the proxy injects a `__anthropic_advisor` tool into the body, intercepts the model's `tool_use` blocks for that tool name, runs an advisor model server-side (default **`gpt-5.5` at `xhigh` reasoning effort** via `/v1/responses` for cross-lab "second set of eyes"), and emits translated `server_tool_use{name:"advisor"}` + `advisor_tool_result` blocks back to the client on the same SSE connection. Per gemini-critic streaming-during-loop design — keeps Claude Code's `AdvisorMessage.tsx` UI responsive (no buffered hang), continues the conversation through up to 16 advisor turns. The `claude` subcommand sets `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1` automatically (without it, Claude Code's `JI()` gate falls back to the `tengu_sage_compass2` GrowthBook flag, which is off for non-Anthropic users). Three opt-out paths, all honored: `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` (documented Anthropic opt-out, checked first in `JI()`), `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=0` (proxy uses presence-based guard — any user-set value preserved), or `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` (global beta opt-out — proxy intentionally doesn't strip this from your shell). The advisor model is dispatched to `/v1/responses` with `reasoning.effort` for gpt-5.x / o-series / codex models, falls back to `/v1/messages` for claude-* models. If a future Claude Code version stops emitting `advisor-tool-` despite our inject, check whether Anthropic rotated the env name. See `src/services/advisor/advisor.ts`.

- **`mcp_servers` body field** (inline remote-managed MCP): Copilot 400s on this field. Phase G's planned proxy-side translate-path was deferred (codex-critic: structural design holes — continuation-after-pool-TTL not implementable from request alone, streaming buffer-and-resume creates incoherent SSE if any assistant deltas already forwarded, tool-name namespace `server:tool` regex unverified against Copilot). The proxy now **fail-fast 400**s requests with non-empty `mcp_servers` and points users at local stdio MCP via `~/.claude/mcp.json` (which works without the translate path). Empty `mcp_servers: []` arrays pass through (Copilot 400s but not the proxy's concern).

- **Bridge / CCR (Remote Sessions)**: requires `CLAUDE_CODE_REMOTE`/`CLAUDE_BRIDGE_*` env vars. Stripped from the spawned-child env (`STRIPPED_PARENT_ENV_KEYS`) so the remote-session code path never activates. Local sessions only.

- **Files API OAuth, account/settings, team-memory sync, user-settings sync, etc.**: gated by `DISABLE_NON_ESSENTIAL_MODEL_CALLS=1` + `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` + `DISABLE_TELEMETRY=1` (all set by `getClaudeCodeEnvVars`). Suppressed at the source.
