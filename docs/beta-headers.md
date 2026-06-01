# Beta header filtering & stealth-vs-leverage policy

How the proxy filters Anthropic `anthropic-beta` headers, the stripped deny-list, and
why `github-router claude` defaults to leverage mode rather than VS Code stealth. See
[`../CLAUDE.md`](../CLAUDE.md) for project overview.

## Beta header filtering

The `--extended-betas` shared flag controls VS Code stealth vs Claude CLI leverage. The **`claude` subcommand defaults to leverage mode** (extended-betas ON; see "Stealth vs leverage policy" below) — opt back into stealth via `claude --stealth`. The `start` and `codex` subcommands default to stealth.

- **Default for `start`/`codex` (VS Code stealth)**: Only forward 3 beta prefixes the VS Code extension sends (`interleaved-thinking-`, `context-management-`, `advanced-tool-use-`). Wire fingerprint matches VS Code Copilot Chat.
- **Extended/leverage (`--extended-betas`, default for `claude`)**: Forward 20 beta prefixes covering the full Claude CLI feature surface (`claude-code-`, `effort-`, `prompt-caching-`, `computer-use-`, `pdfs-`, `max-tokens-`, `token-counting-`, `compact-`, `structured-outputs-`, `fast-mode-`, `mcp-client-`, `mcp-servers-`, `redact-thinking-`, `web-search-`, `task-budgets-`, `token-efficient-tools-`, plus 4 Anthropic-internal flags). Empirically validated against `api.enterprise.githubcopilot.com` 2026-05-11 — every prefix returns 200 from Copilot.

The router strips `context-1m-`, `skills-`, `files-api-`, `code-execution-`, `output-128k-`, and **`advisor-tool-`** from every outgoing `anthropic-beta` value — Copilot returns 400 ("unsupported beta header") on each. The strip list lives in `EXPLICITLY_STRIPPED_BETA_PREFIXES` (`src/lib/utils.ts`) — defensive deny-list that catches even future allowlist broadenings. 1M context for Opus 4.7 is unlocked by selecting the `claude-opus-4.7-1m-internal` model id (enterprise tier only), not via a beta header.

The router also strips body-level `budget`, `output_config.schema`, `betas` (array), and `speed` (string) from `/v1/messages` and `/v1/messages/count_tokens` (Phase B; Copilot 400s on each — verified live). The corresponding `anthropic-beta` headers (`task-budgets-`, `structured-outputs-`, `fast-mode-`) are preserved so the *intent* still flows; only the per-request enforcement field is dropped. (`speed: "fast"` is the fast-mode latency hint — Copilot has no fast-mode backend, so the body field is dropped and the hint is NOT enforced upstream; end-to-end coverage in probes `speed_fast_stripped` / `speed_fast_count_tokens_stripped`.)

The router strips per-tool `eager_input_streaming` from `tools[i]` (Fine-Grained Tool Streaming). Auto-emitted by Claude Code under `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1` (proxy-default in `getClaudeCodeEnvVars`); Copilot 400s on `tools.0.custom.eager_input_streaming`. Strip disables only the chunk-size optimization — `input_json_delta` events still flow normally with `partial_json:""` instead of populated chunks. End-to-end coverage in probes `eager_input_streaming_stripped` / `eager_input_streaming_with_type_custom_stripped` (`scripts/probe-copilot-compat.sh`).

## Stealth vs leverage policy

`github-router claude` defaults to **leverage** (extended-betas ON, all stripped/preserved fields per the "Beta header filtering" section). Rationale: the spawned Claude Code already identifies itself via UA, editor-version, and Claude-specific request headers — partial stealth doesn't meaningfully reduce the wire-fingerprint diff, and stealth's cost is losing the features the user explicitly chose to install Claude Code for (cost-budget enforcement, prompt caching, MCP, structured outputs, etc.).

Opt-out: `claude --stealth` reverts to the 3-prefix VS Code-only filter for users who specifically prioritize wire similarity over feature surface.

The `start` and `codex` subcommands continue to default to VS Code stealth — they're for raw API users / Codex users who don't need the Claude CLI feature set.

## Related docs

- [`claude-env-injection.md`](claude-env-injection.md) — the experimental env vars the
  `claude` subcommand auto-enables alongside this leverage policy.
- [`copilot-compat-matrix.md`](copilot-compat-matrix.md) — empirical accept/reject matrix
  per beta prefix and body field.
