# Copilot compatibility matrix

Single source of truth for what GitHub Copilot's API accepts and rejects when fronted as Anthropic-shaped (`/v1/messages`) by `github-router`. Every row is empirically verified by `scripts/probe-copilot-compat.sh`.

**Rule** (enforced via [`CLAUDE.md`](../CLAUDE.md) Review checklist): every field, header, body shape, or tool type that any client (Claude Code, Codex, raw API users) emits MUST appear here, irrespective of accept/reject. The probe set grows monotonically; removing a row requires written justification in this file.

**Run**: `bun run probe:copilot` (strict mode) or `bash scripts/probe-copilot-compat.sh --report` (dev mode). See `bash scripts/probe-copilot-compat.sh --help`.

**Last full sweep**: 2026-05-13 (probes 1-13 captured during the long-horizon plan investigation).

## Discovery sources (legend)

| Source | Meaning |
|---|---|
| `claude-emits` | Observed in Claude Code traffic (request log under `GH_ROUTER_LOG_FIELDS=1`) |
| `codex-emits` | Observed in Codex traffic |
| `anthropic-docs` | Published in Anthropic API docs |
| `copilot-allowlist` | Extracted from a Copilot 400 error message (validator leaked the list) |
| `exploratory` | Speculative "let me see what Copilot does with X" |

## Tool types (`tools[i].type`)

Canonical Copilot tool-type allowlist (verbatim from a 400 in probe `tooltype_code_execution_20250825`): `bash_20250124`, `custom`, `memory_20250818`, `text_editor_20250124`, `text_editor_20250429`, `text_editor_20250728`, `tool_search_tool_bm25`, `tool_search_tool_regex` (truncated — Copilot's error message ended with `...`).

| `type` value | End-to-end status | Source | Probe id | Notes |
|---|---|---|---|---|
| (omitted) — bare custom tool | ✅ 200 | anthropic-docs | `tool_baseline_custom` | Default shape; no type discriminator |
| `custom` | ✅ 200 | anthropic-docs | `tool_baseline_custom_with_type` | Explicit discriminator; equivalent to omitted |
| `memory_20250818` | ✅ 200 | anthropic-docs | `tooltype_memory_20250818` | Opus emits `tool_use{name:memory, command:view, path:/memories}`. Requires `anthropic-beta: memory-2025-08-18`. Client must implement the file-ops handler — proxy does NOT today (deferred per long-horizon plan; raw API users implement client-side). |
| `text_editor_20250124` | ✅ 200 | copilot-allowlist | (TODO) | In Copilot allowlist — add probe |
| `text_editor_20250429` | ✅ 200 | copilot-allowlist | (TODO) | In Copilot allowlist — add probe |
| `text_editor_20250728` | ✅ 200 | anthropic-docs | `tooltype_text_editor_20250728` | Latest text editor version |
| `bash_20250124` | ✅ 200 | copilot-allowlist | `tooltype_bash_20250124` | Current bash version |
| `tool_search_tool_bm25` | ✅ 200 | copilot-allowlist | (TODO) | In Copilot allowlist — add probe |
| `tool_search_tool_regex` | ✅ 200 | copilot-allowlist | (TODO) | In Copilot allowlist — add probe |
| `web_search_20250305` | ⚠️ 200 (inconclusive) | anthropic-docs | `tooltype_web_search_20250305` | Body validator accepts; model never invoked the tool in the test prompt — needs a stronger probe to confirm functional acceptance |
| `bash_20241022` | ❌ 400 | copilot-allowlist | `tooltype_bash_20241022_legacy` | Legacy version rejected |
| `code_execution_20250825` | ❌ 400 | copilot-allowlist | `tooltype_code_execution_20250825` | Not in Copilot allowlist |
| `computer_20250124` | (untested) | anthropic-docs | (TODO) | Add probe — Anthropic ships this typed tool; status unknown |

## Per-tool fields (`tools[i].<field>`)

| Field | End-to-end status | Source | Probe id | Notes |
|---|---|---|---|---|
| `name`, `description`, `input_schema` | ✅ 200 | anthropic-docs | `tool_baseline_custom` | Required baseline |
| `eager_input_streaming` | ✅ 200 (proxy strips) | claude-emits | `eager_input_streaming_stripped` / `eager_input_streaming_with_type_custom_stripped` | Copilot 400s on raw field; proxy strips before forwarding (Phase 0 of long-horizon plan). Auto-emitted by Claude Code under `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1`. Strip disables only chunk-size optimization; correctness unaffected. |
| `cache_control: {type, ttl?}` | ✅ 200 | claude-emits | (TODO) | Standard Anthropic cache-control; preserved |
| `cache_control.scope` | ✅ 200 (proxy strips) | claude-emits | (TODO) | Copilot 400s on raw `.scope`; proxy strips via `sanitizeCacheControl`. Add probe. |

## Top-level body fields

| Field | End-to-end status | Source | Probe id | Notes |
|---|---|---|---|---|
| `model`, `max_tokens`, `messages` | ✅ 200 | anthropic-docs | (every probe) | Required baseline |
| `tools[]` | ✅ 200 | anthropic-docs | `tool_baseline_custom` | See per-type table above |
| `system` (string or array) | ✅ 200 | anthropic-docs | (TODO) | Standard system prompt; both shapes accepted |
| `thinking: {type:"enabled", budget_tokens}` | ✅ 200 (proxy translates on adaptive-thinking models) | claude-emits | (TODO) | Translated to `thinking:{type:"adaptive"}` + `output_config.effort` for adaptive-thinking models |
| `thinking: {type:"adaptive"}` | ✅ 200 | claude-emits | (TODO) | Native Copilot shape |
| `metadata: {user_id}` | ✅ 200 (passthrough) | claude-emits | (TODO) | Copilot 200s and ignores; not stripped per "preserve unknown fields unless documented" |
| `mcp_servers: []` (empty array) | ✅ 200 (proxy passthrough; Copilot may 400, but harmless) | exploratory | (TODO) | Edge case |
| `context_management.edits[].type=compact_20260112` | ✅ 200 | anthropic-docs | `compact_20260112` | Server-side compaction; `applied_edits:[]` returned. Need >50k input tokens to actually trigger — probe just confirms acceptance, not actual compaction firing |
| `context_management.edits[].type=clear_tool_uses_20250919` | ✅ 200 | anthropic-docs | `clear_tool_uses_20250919` | Context editing; clears old tool results |
| `budget: {total_tokens}` | ✅ 200 (proxy strips) | claude-emits | (TODO) | Copilot 400s; proxy strips body field; `task-budgets-` beta header preserved |
| `output_config: {schema}` (Structured Outputs full) | ✅ 200 (proxy strips schema, injects as system prompt) | claude-emits | (TODO) | Copilot 400s on `.schema`; proxy strips and injects schema-conforming instruction |
| `output_config: {type: "json_object"}` (short form) | ✅ 200 (proxy strips, injects) | claude-emits | (TODO) | Same strip path as `.schema` |
| `output_config: {effort}` | ✅ 200 (preserved) | proxy-internal | (TODO) | Proxy-set during `translateThinking`; required for adaptive-thinking models |
| `betas: ["..."]` (top-level array) | ✅ 200 (proxy strips) | claude-emits | (TODO) | Distinct from `anthropic-beta` header; Copilot 400s on body field; proxy strips, header preserves |
| `mcp_servers: [{...}]` (non-empty) | ❌ 400 (proxy fail-fast) | claude-emits | (TODO) | Phase G translate path was deferred; proxy fail-fasts with helpful error pointing at `~/.claude/mcp.json` |
| `stream: true` | ✅ 200 (SSE) | claude-emits | `stream_with_tools` | Streaming response with valid SSE event sequence |

## Anthropic-beta header prefixes

The proxy filters via `filterBetaHeader` in `src/lib/utils.ts`. Two lists:

- `EXTENDED_BETA_PREFIXES` (`utils.ts:50`): forwarded when `--extended-betas` is set (default for `claude` subcommand)
- `EXPLICITLY_STRIPPED_BETA_PREFIXES` (`utils.ts:92`): always stripped, even from extended

| Prefix | End-to-end status | Source | Probe id | Notes |
|---|---|---|---|---|
| `interleaved-thinking-` | ✅ 200 | claude-emits | (TODO) | VS Code core; always allowed |
| `context-management-` | ✅ 200 | claude-emits | (TODO) | VS Code core; always allowed |
| `advanced-tool-use-` | ✅ 200 | claude-emits | (TODO) | VS Code core; always allowed |
| `claude-code-` | ✅ 200 | claude-emits | (TODO) | Extended; required for Claude CLI features |
| `effort-` | ✅ 200 | anthropic-docs | (TODO) | Extended |
| `prompt-caching-` | ✅ 200 | anthropic-docs | (TODO) | Extended |
| `computer-use-` | ✅ 200 | anthropic-docs | (TODO) | Extended |
| `pdfs-` | ✅ 200 | anthropic-docs | (TODO) | Extended |
| `max-tokens-` | ✅ 200 | anthropic-docs | (TODO) | Extended |
| `token-counting-` | ✅ 200 | anthropic-docs | (TODO) | Extended |
| `compact-` | ✅ 200 | anthropic-docs | `compact_20260112` | Extended; verified live with `compact-2026-01-12` |
| `structured-outputs-` | ✅ 200 | anthropic-docs | (TODO) | Extended; body `output_config.schema` still stripped |
| `fast-mode-` | ✅ 200 | anthropic-docs | (TODO) | Extended |
| `mcp-client-` | ✅ 200 | anthropic-docs | (TODO) | Extended |
| `mcp-servers-` | ✅ 200 | anthropic-docs | (TODO) | Extended; body `mcp_servers` still fail-fast 400 |
| `redact-thinking-` | ✅ 200 | anthropic-docs | (TODO) | Extended |
| `web-search-` | ✅ 200 | anthropic-docs | (TODO) | Extended |
| `task-budgets-` | ✅ 200 | claude-emits | (TODO) | Extended; body `budget` still stripped |
| `token-efficient-tools-` | ✅ 200 | claude-emits | (TODO) | Extended |
| `summarize-connector-text-` | ✅ 200 | claude-emits | (TODO) | Anthropic-internal; allowlisted defensively |
| `afk-mode-` | ✅ 200 | claude-emits | (TODO) | Anthropic-internal |
| `cli-internal-` | ✅ 200 | claude-emits | (TODO) | Anthropic-internal |
| `oauth-` | ✅ 200 | claude-emits | (TODO) | Files-API path header |
| `memory-2025-08-18` | ✅ 200 | anthropic-docs | `tooltype_memory_20250818` | Required for `memory_20250818` tool; verified live |
| `advisor-tool-` | ❌ 400 (proxy strips) | claude-emits | (TODO) | Copilot 400s `unsupported beta header(s): advisor-tool-2026-03-01`; proxy strips header AND injects synthetic advisor flow server-side per `src/services/advisor/advisor.ts` |
| `context-1m-` | ❌ 400 (not in allowlist) | anthropic-docs | (TODO) | 1M context unlocked via model id `claude-opus-4.7-1m-internal`, not header |
| `skills-` | ❌ 400 (not in allowlist) | anthropic-docs | (TODO) | Anthropic Skills API not supported by Copilot |
| `files-api-` | ❌ 400 (not in allowlist) | anthropic-docs | (TODO) | Files API not supported by Copilot — see CLAUDE.md "Unsupported features" |
| `code-execution-` | ❌ 400 (not in allowlist) | anthropic-docs | (TODO) | Matches `code_execution_20250825` tool rejection |
| `output-128k-` | ❌ 400 (not in allowlist) | anthropic-docs | (TODO) | 128k output not supported |

## Models

| Model id | End-to-end status | Source | Probe id | Notes |
|---|---|---|---|---|
| `claude-opus-4-7` (Anthropic dashed slug) | ✅ 200 (proxy resolves) | claude-emits | (used by every claude probe) | Translates to `claude-opus-4.7-1m-internal` (enterprise) or `claude-opus-4.7` (Pro+) |
| `claude-haiku-4-5` | ✅ 200 (proxy resolves) | claude-emits | (used by baseline probes) | Default `ANTHROPIC_SMALL_FAST_MODEL` |
| `claude-sonnet-4-6` | (untested) | anthropic-docs | (TODO) | Add probe |
| `gpt-5.5` | (untested via this matrix — covered by codex-critic peer-MCP) | codex-emits | (TODO) | `/v1/responses` |
| `gpt-5.3-codex` | (untested via this matrix) | codex-emits | (TODO) | `/v1/responses` |
| `gemini-3.1-pro-preview` | (untested via this matrix) | exploratory | (TODO) | `/v1/chat/completions` |

## Endpoints covered

The probe currently exercises `/v1/messages`. TODO:
- `/v1/messages/count_tokens` — same Copilot validator, same strip logic in `count-tokens-handler.ts`. Add probes mirroring the body-field strips above.
- `/v1/chat/completions` — Codex/raw-OpenAI clients
- `/v1/responses` — gpt-5.x / o-series models
- `/v1/embeddings` — passthrough

## Adding a new probe

1. Pick an `id` (snake_case, descriptive — e.g. `tooltype_computer_20250124` or `cache_control_scope_stripped`).
2. Pick a `source` from the discovery legend above.
3. Add a row to the `PROBE_REGISTRY` array in `scripts/probe-copilot-compat.sh`.
4. Add a `probe_<id>()` function with the curl request and `assert_status` (and optionally `assert_body_contains`).
5. Add the corresponding row to this matrix doc with the empirical result.
6. Run `bash scripts/probe-copilot-compat.sh --probe <id>` to verify.
7. If you're adding a probe because you discovered a new field via `scripts/discover-new-fields.sh`, leave a `Source: claude-emits (discovered via discover-new-fields.sh on YYYY-MM-DD)` note.

## Drift detection

Two failure modes — both need attention:

- **Was rejected, now accepts**: a `❌ 400` row's probe fails (returns 200). Means Copilot has expanded support. Action: update the matrix; consider lifting any associated proxy strip.
- **Was accepted, now rejects**: a `✅ 200` row's probe fails (returns 4xx). Means Copilot has dropped or version-bumped support. Action: investigate; add strip / migrate / fail-fast as appropriate.

CI mode: a weekly GitHub Actions workflow (TODO) runs `bun run probe:copilot --strict` against an up-to-date proxy + live Copilot, opening an issue on any deviation.
