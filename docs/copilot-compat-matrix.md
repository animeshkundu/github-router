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
| `web_search_20250305` | ⚠️ 200 (inconclusive) | anthropic-docs | `tooltype_web_search_20250305` | Body validator accepts; model never invoked the tool in the test prompt — needs a stronger probe to confirm functional acceptance. See `web_search_anthropic_tool_messages` row below for the resolved end-to-end behavior with a real trigger query. |
| `bash_20241022` | ❌ 400 | copilot-allowlist | `tooltype_bash_20241022_legacy` | Legacy version rejected |
| `code_execution_20250825` | ❌ 400 | copilot-allowlist | `tooltype_code_execution_20250825` | Not in Copilot allowlist |
| `computer_20250124` | (untested) | anthropic-docs | (TODO) | Add probe — Anthropic ships this typed tool; status unknown |

## Per-tool fields (`tools[i].<field>`)

| Field | End-to-end status | Source | Probe id | Notes |
|---|---|---|---|---|
| `name`, `description`, `input_schema` | ✅ 200 | anthropic-docs | `tool_baseline_custom` | Required baseline |
| `eager_input_streaming` | ✅ 200 (proxy strips) | claude-emits | `eager_input_streaming_stripped` / `eager_input_streaming_with_type_custom_stripped` | Copilot 400s on raw field; proxy strips before forwarding (Phase 0 of long-horizon plan). Auto-emitted by Claude Code under `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1`. Strip disables only chunk-size optimization; correctness unaffected. |
| `cache_control: {type, ttl?}` | ✅ 200 | claude-emits | `cache_control_ephemeral_1h` | Standard Anthropic cache-control; preserved. The probe covers both system and tool blocks; `ttl:"1h"` is accepted. |
| `cache_control.scope` | ✅ 200 (proxy strips) | claude-emits | `signed_thinking_cache_scope_stripped` | Copilot 400s on raw `.scope`. On a signed thinking/redacted-thinking block it rejects the whole `cache_control` object (`...thinking.cache_control: Extra inputs`), so the proxy removes that unsigned cache metadata while preserving thinking/signature/data exactly. The probe obtains a real signed thinking+tool response and verifies the replay remains valid. |

Claude accepts at most four `cache_control` blocks per request. Probe
`cache_control_marker_limit_5` asserts the fifth marker remains an upstream 400,
which is why the router-owned allocator is hard-bounded at four and never adds
markers when any caller-owned policy is present.

## Prompt-cache fields on OpenAI-shaped routes

| Field / shape | End-to-end status | Source | Probe id | Notes |
|---|---|---|---|---|
| GPT-5.6 `prompt_cache_key` + `prompt_cache_options:{mode:"explicit",ttl:"30m"}` + content `prompt_cache_breakpoint:{mode:"explicit"}` | ✅ 200 | copilot-cli | `gpt56_explicit_cache_breakpoint` | Exact explicit-cache arm used only by router-owned GPT-5.6 reusable-prefix/conversation calls. This probe confirms Copilot ACCEPTS the shape; it does not measure a cost benefit — that is pending the live evidence harness (see `prompt-caching.md`). |
| GPT-5.5 `prompt_cache_retention:"24h"` | ✅ 200 | vscode-source | `gpt55_cache_retention_24h` | Acceptance only. The router does not synthesize this field until a long-inactivity trial proves effectiveness. |
| `prompt_cache_key` alone | ✅ accepted, no measured incremental benefit | vscode-source | (covered by research harness, not strict probe) | Preserved for passthrough callers; not synthesized. |
| Chat message `copilot_cache_control` | ✅ accepted, no measured incremental benefit on tested GPT/Gemini models | vscode-source | (covered by research harness, not strict probe) | Preserved for passthrough callers; not synthesized. |

## Top-level body fields

| Field | End-to-end status | Source | Probe id | Notes |
|---|---|---|---|---|
| `model`, `max_tokens`, `messages` | ✅ 200 | anthropic-docs | (every probe) | Required baseline |
| `tools[]` | ✅ 200 | anthropic-docs | `tool_baseline_custom` | See per-type table above |
| `system` (string or array) | ✅ 200 | anthropic-docs | (TODO) | Standard system prompt; both shapes accepted |
| `thinking: {type:"enabled", budget_tokens}` | ✅ 200 (proxy translates on adaptive-thinking models) | claude-emits | (TODO) | Translated to `thinking:{type:"adaptive"}` + `output_config.effort` for adaptive-thinking models |
| `thinking: {type:"adaptive"}` | ✅ 200 | claude-emits | (TODO) | Native Copilot shape |
| Replayed signed thinking rejected as modified/invalid | ✅ request-time recovery after a known upstream integrity 400 | claude-emits | `thinking_history_invalid_signature_repaired` | The original request is always tried first because `thinking:""` is valid with omitted display. On `messages.N.content.M ... cannot be modified` or `Invalid signature in thinking block`, the proxy removes thinking/redacted-thinking blocks only from rejected assistant message N and retries, up to `MAX_THINKING_REPAIR_ATTEMPTS` (5) semantic repairs per request, stopping early if upstream re-names an already-repaired index. Index resolution tries the reported index directly, then a hoist-adjusted index when the client put a non-conversation role (e.g. `system`) inside `messages[]` and upstream dropped it before validating; the fallback is accepted only if the block upstream named is a signed block there. It never edits transcripts; failed recovery returns the original 400. |
| `metadata: {user_id}` | ✅ 200 (passthrough) | claude-emits | (TODO) | Copilot 200s and ignores; not stripped per "preserve unknown fields unless documented" |
| `mcp_servers: []` (empty array) | ✅ 200 (proxy passthrough; Copilot may 400, but harmless) | exploratory | (TODO) | Edge case |
| `context_management.edits[].type=compact_20260112` | ❌ 400 in stealth, ✅ 200 with leverage betas | anthropic-docs | `compact_20260112` | Requires `anthropic-beta: compact-2026-01-12` forwarded to upstream. Stealth-default `bun run start` strips the beta → Copilot's allowlist drops to `{clear_thinking_20251015, clear_tool_uses_20250919}` and the body field 400s. `github-router claude` (extended-betas) forwards the beta and gets 200 + `applied_edits:[]`. Probe asserts the stealth-mode 400; leverage-mode acceptance is implicit via the `compact-` beta-prefix row. Strip-rule follow-up tracked in a separate PR. |
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
| `context-1m-` | ❌ 400 (not in allowlist) | anthropic-docs | (TODO) | 1M context unlocked via 1M-capable model ids (`claude-opus-5`, `claude-opus-4.8`, `claude-opus-4.7-1m-internal`, `claude-opus-4.6-1m`), not header |
| `skills-` | ❌ 400 (not in allowlist) | anthropic-docs | (TODO) | Anthropic Skills API not supported by Copilot |
| `files-api-` | ❌ 400 (not in allowlist) | anthropic-docs | (TODO) | Files API not supported by Copilot — see CLAUDE.md "Unsupported features" |
| `code-execution-` | ❌ 400 (not in allowlist) | anthropic-docs | (TODO) | Matches `code_execution_20250825` tool rejection |
| `output-128k-` | ❌ 400 (not in allowlist) | anthropic-docs | (TODO) | 128k output not supported |

## Models

| Model id | End-to-end status | Source | Probe id | Notes |
|---|---|---|---|---|
| `claude-opus-5` (Anthropic dashed slug, default) | ✅ 200 (exact catalog match) | claude-emits | `fast_opus5_messages_reasoning_high` (+ every Claude baseline probe) | Single base slug, natively 1M; fast Oracle uses native Messages with adaptive thinking/high effort. |
| `claude-opus-4-8` (Anthropic dashed fallback) | ✅ 200 (proxy resolves) | claude-emits | (fallback probes) | Translates to `claude-opus-4.8` (single base slug already advertises 1M context) |
| `claude-opus-4-7` (Anthropic dashed slug) | ✅ 200 (proxy resolves) | claude-emits | (used by every claude probe) | Translates to `claude-opus-4.7-1m-internal` (enterprise) or `claude-opus-4.7` (Pro+) |
| `claude-haiku-4-5` | ✅ 200 (proxy resolves) | claude-emits | (used by baseline probes) | Request-shape probe carrier + `gpt-5.4-mini` browser fallback-chain tail. (No longer `ANTHROPIC_DEFAULT_HAIKU_MODEL` — the /model picker Haiku tier is now seeded to `claude-sonnet-5`.) |
| `claude-sonnet-5` | ✅ 200 (proxy resolves) | claude-emits | `smallfast_sonnet_baseline` | Default `ANTHROPIC_SMALL_FAST_MODEL` (emitted every session for background ops) + `ANTHROPIC_DEFAULT_SONNET_MODEL` + `ANTHROPIC_DEFAULT_HAIKU_MODEL` picker tiers. Exact-match resolve to Copilot `claude-sonnet-5` (no dotted variant); 1M context, cheaper than 4.6 (200/1000 vs 300/1500 multipliers). |
| `claude-sonnet-4-6` | ✅ 200 (proxy resolves) | claude-emits | (used by baseline probes) | Was default `ANTHROPIC_SMALL_FAST_MODEL` + `ANTHROPIC_DEFAULT_SONNET_MODEL`; superseded by `claude-sonnet-5`. Still resolves 200; `gpt-5.4-mini` browser fallback-chain member. |
| `claude-opus-5` + `thinking:{type:"adaptive"}` + `output_config.effort`, `stream:false` | ✅ 200 | claude-emits | `advisor_claude_adaptive_thinking` | The body `runAdvisor` emits when a budget lead escalates the advisor to Opus. This `/v1/messages` branch was unreachable while the advisor was always `gpt-5.6-sol` (which takes `/responses`), so every field in it is newly exercised. A 400 here means the escalated advisor silently loses its reasoning effort. |
| `claude-opus-5` `max_tokens: 16000`, `stream:false` | ✅ 200 | claude-emits | `advisor_claude_nonstreaming_cap` | The advertised `max_non_streaming_output_tokens`. The advisor sizes its output cap from this field. |
| `claude-opus-5` `max_tokens: 64000`, `stream:false` | ✅ 200 | exploratory | `advisor_claude_streaming_cap_accepted` | **Measured, and it corrected an assumption.** `max_non_streaming_output_tokens` (16000) is advertised but **not enforced** — Copilot accepts the full streaming ceiling (64000) on a non-streaming request. An earlier draft of this row asserted `❌ 400` from the catalog metadata alone and was wrong. The advisor still sizes from the non-streaming limit, by choice rather than necessity; if this row ever flips to 400, that conservatism is what keeps it working. |
| Authenticated fast lead selects Luna / Sol / Grok / Gemini 3.8 / Opus and invokes Advisor | fixed lead endpoint + Gemini 3.8 Chat/high Advisor + same-lead continuation | ✅ deterministic proxy-policy matrix | proxy-internal | `fast_advisor_all_leads_policy` | Executes the real `/v1/messages` handler with nonce-bound fast launch identity and mocked Copilot edge. Asserts Responses for Luna/Sol/Grok, Chat for Gemini, Messages for Opus, Gemini Chat/high Advisor on every row, and continuation on the selected lead's original model/endpoint. |
| Fast Advisor client identity + proxy dispatch | client `gemini-3.8-flash[1m]`; upstream bare `gemini-3.8-flash`, Chat/high | ✅ deterministic launcher + route tests | proxy-internal | `fast_advisor_all_leads_policy` | Fast launch strips forwarded Advisor values and pins Claude Code's native tool/UI/JSONL identity to the bracketed gateway row. The proxy strips the accounting suffix and sends exactly one nested Chat/high request on every fixed lead. |
| Fast Advisor beta with no `tools` field (compaction-style turn) | no proxy Advisor injection or Gemini lookup; original lead request passes through | ✅ deterministic policy test | proxy-internal | `fast_advisor_beta_without_tools` | Claude Code `/compact` and automatic compaction carry `advisor-tool-2026-03-01` but omit `tools`; the fast primary must not reject or invoke Gemini. The same no-tools behavior is asserted for translated and native Claude leads. |
| Fast Advisor with missing/wrong-endpoint Gemini or conflicting pin | fail closed; no Sol/Opus fallback or override | ✅ deterministic policy test | proxy-internal | `fast_advisor_endpoint_gate` | Fast startup requires Gemini Chat/high, runtime re-checks the invariant, `GH_ROUTER_ADVISOR_MODEL` is ignored in fast mode, and a conflicting native Advisor tool model is rejected visibly. Standard operator pins/fallbacks are unchanged. |
| Fast native Agent model override | PreToolUse removes only `tool_input.model` before spawn | ✅ deterministic ACL test + installed-client canary | proxy-internal | `fast_native_model_override` | Invocation-level model selection outranks custom-agent frontmatter in Claude Code. The fast ACL returns an allow `updatedInput` clone without that field so fixed role models remain authoritative. |
| Fast capitalized `Explore` | custom `Explore` → Luna/high/1M; no fast `scout` | ✅ deterministic agent-definition/ACL test + installed-client canary | proxy-internal | `fast_explore_fixed_model` | Replaces fast `scout` and intentionally shadows the client built-in only in `-m fast`. Standard lowercase `scout` and built-in Explore remain unchanged. |
| `gpt-5.6-sol` | ✅ 200 (`/v1/responses` accepts function `tools[]` + `reasoning:{effort:"high"|"xhigh"}`) | exploratory | `worker_gpt56sol_responses_tools_reasoning` / `fast_sol_responses_reasoning_high` | **Default/preferred** OpenAI model for the `implement`/`test` workers, standard native `implementer`, and codex CLI; fast `planner` uses high effort. 1.05M total / 922K max-prompt / 128K max-output. Fast policy fixes it to Responses even if a future catalog advertises both endpoints. |
| `gpt-5.5` | ✅ 200 (`/v1/responses` accepts function `tools[]` + `reasoning:{effort:"xhigh"}`) | exploratory | `worker_gpt5_responses_tools_reasoning` | **Retained compatibility probe** for OpenAI-role surfaces that explicitly use or can select `gpt-5.5` (default moved to `gpt-5.6-sol`). `/v1/responses`-only. Probe still load-bearing: gpt-5.5 is NOT a dual-gate input, so a body-shape regression breaks explicit gpt-5.5 worker calls while explore/review keep working. **Also served on Anthropic `/v1/messages` via the translation shim (→ `/responses`)** — see the shim section below (`shim_gpt55_messages*`). |
| `gpt-5.3-codex` | ✅ 200 via `/v1/messages` translation shim | codex-emits | `shim_gpt53codex_messages` | Served on Anthropic `/v1/messages` via the translation shim (→ `/responses`), live-verified. **400k context (NOT 1M).** See the shim section below. |
| `gemini-3.1-pro-preview` | ❌ 400 unavailable, live-verified 2026-09-03 | exploratory | `shim_gemini31pro_messages` | Retired preview id retained as a symmetric rejection probe. Google-first resolvers now fall through to Gemini 3.8 Flash; current runtime roles remain available through that catalog-gated fallback. |
| `gpt-5.4-mini` | (untested via this matrix) | exploratory | (none) | Browser-MCP inner compressor / extraction model — **chain head**, driven via **`/responses`** (gpt-5.4-mini is `/responses`-only; the compressor is endpoint-aware — see [`docs/browser-mcp-design.md`](browser-mcp-design.md)). `tool_calls` + vision; forced-tool-call verified live. Fallback chain `gpt-5.4-mini` → `claude-sonnet-4-6` → `claude-haiku-4-5`. |
| `gemini-3.5-flash` | ✅ 200 (`/v1/chat/completions` accepts `tools[]` + `reasoning_effort:"high"`) | exploratory | `worker_gemini_tools_reasoning` | Former worker default; the `gpt-5.4-mini` worker default carries the explore-shape (`gemini-3.1-pro-preview` carries gemini tool+reasoning). Kept as a valid-shape probe. Probe is load-bearing: the dual gate's catalog arm verifies presence + `tool_calls`; this probe verifies the request shape Copilot's validator accepts. The "early-stops on forced tool-calls" caveat that removed it from the browser-MCP compressor chain does NOT apply here — the worker drives it as an *autonomous* agent (`tool_choice:"auto"`, no forced single-call loop), and a test-drive confirmed multi-tool planning / parallel reads / no early-stop. `/chat/completions` + `tool_calls` + vision. **Also served on Anthropic `/v1/messages` via the translation shim (→ `/chat/completions`)** — see the shim section below (`shim_gemini35flash_messages`). |
| `gpt-5.6-luna` | ✅ 200 live-verified 2026-08-24 (`/v1/responses` function `tools[]` + `reasoning:{effort:"high"\|"max"}`) | exploratory | `fast_luna_responses_reasoning_high` / `fast_luna_responses_reasoning_max` / `max_luna_responses_reasoning_max` | **Fast profile:** the fast-launch-profile lead, `Explore` (high), and `general-purpose` (max) assignments — see [`default-models.md`](default-models.md) "Fast launch profile". **Max profile:** reviewer fallback assignment at max reasoning effort. 1.05M context, `/v1/responses`-capable, full `none..max` effort ladder. |
| `gemini-3.8-flash` | ✅ 200 live-verified (`/v1/chat/completions` tools + `reasoning_effort:"high"|"medium"`; `/v1/messages` shim tool-use with `max_tokens:512`) | exploratory | `fast_gemini38flash_chat_reasoning_high` / `fast_gemini38flash_chat_reasoning_medium` / `fast_gemini38flash_messages_tool_use` / `fast_gemini38flash_messages_reasoning_high` | Standard reviewer/brainstorm fallback and `reviewer-fast`; Fast native `implementer` at high reasoning effort; Fast primary-lead-only Advisor at high across every fixed `/model` selection; historical: former fast native critic at medium. This is a one-for-one model-generation ID migration preserving all four request-shape probes, satisfying the monotonic-probe policy. `low..high` effort, 1,048,576 context (983,040 max prompt, 65,536 max output, Chat endpoint). The forced high-effort tool-use probe needs at least 512 output tokens: at 50, Gemini 3.8 returns a valid empty `max_tokens` response before emitting the tool call. Prior empirical Gemini Flash measurements serve as conservative predecessor baselines carried forward for 3.8. |
| `grok-4.6` | ✅ 200 live-verified 2026-08-24 (`/v1/responses` function `tools[]` + `reasoning:{effort:"medium"|"high"}`) | exploratory | `fast_grok46_responses_reasoning_medium` / `max_grok46_responses_reasoning_high` | Fast profile: native `reviewer` assignment (medium). Max profile: native `reviewer` assignment (high). 500K total / **372K max-prompt** / 128K max-output, `low..xhigh` effort (no `max`). Kept bare (no `[1m]`) — see "Grok context accounting" in [`default-models.md`](default-models.md). Also served on Anthropic `/v1/messages` via the translation shim (→ `/responses`, generic `supported_endpoints` routing — see the shim section below, `shim_grok46_messages*`). |

## Anthropic-translation shim — non-Claude models on `/v1/messages`

`src/lib/anthropic-translate/` lets an Anthropic-shape client (Claude Code, raw `/v1/messages` users) name a **non-Claude** model on `/v1/messages`. The shim translates the Anthropic Messages request into the Copilot request the model actually serves, calls the existing streaming-capable client, and translates the reply back to the Anthropic wire shape — a single Messages object (non-streaming) or a synthesized Anthropic SSE sequence (`message_start → content_block_* → message_delta → message_stop`). Routing is by catalog endpoint (`classifyMessagesRoute`): `/responses` models take the Responses path, `/chat/completions` models take the chat path. Claude models are untouched (native `createMessages` passthrough, byte-for-byte). So these models are usable end-to-end from any Anthropic client, not just via the worker MCP tools.

All four models are **live-verified end-to-end** against real Copilot (HTTP 200 + well-formed Anthropic response) for non-streaming `/v1/messages`. Streaming (synthesized Anthropic SSE) and tool calling (`tool_use` block with non-empty `input`) have probe coverage on **both** shim paths — the Responses shim on `gpt-5.5` (`shim_gpt55_messages_streaming` / `shim_gpt55_messages_tool_use`, live-verified) and the chat shim on `gemini-3.5-flash` (`shim_gemini35flash_messages_streaming` / `shim_gemini35flash_messages_tool_use`, added for live verification). Both shims share the same egress synthesizers, so the two probe pairs cover the two synthesizer families.

**`grok-4.6` live verification:** `shim_grok46_messages` / `shim_grok46_messages_tool_use` exercise the same Responses shim path as `gpt-5.5` against the fast profile's Grok row. Both pass against the live proxy (2026-08-27 strict run); routing remains generic from catalog `supported_endpoints`, with no hardcoded shim slug list.

| Model id | Copilot endpoint (shim target) | End-to-end status | Source | Probe id | Notes / gaps |
|---|---|---|---|---|---|
| `gpt-5.5` | `/responses` | ✅ 200 via shim | exploratory | `shim_gpt55_messages` / `shim_gpt55_messages_streaming` / `shim_gpt55_messages_tool_use` | Non-stream + stream + forced tool-use all verified. 1M context native on the base slug (no `-1m` sibling). |
| `gpt-5.3-codex` | `/responses` | ✅ 200 via shim | exploratory | `shim_gpt53codex_messages` | Same Responses shim path as gpt-5.5. **400k context (NOT 1M).** |
| `gemini-3.5-flash` | `/chat/completions` | ✅ 200 via shim, live-verified 2026-08-27 | exploratory | `shim_gemini35flash_messages` / `shim_gemini35flash_messages_streaming` / `shim_gemini35flash_messages_tool_use` | Non-stream, synthesized stream, and tool-use probes all pass in the strict live suite. No `xhigh` (reasoning clamps to `high`); no `structured_outputs`. 1M context native on the base slug. Tool-use probe uses `tool_choice:auto` (not forced — this model early-stops on forced tool-calls; autonomous auto-mode is the working pattern). |
| `gemini-3.1-pro-preview` | `/chat/completions` | ❌ 400 unavailable, live-verified 2026-09-03 | exploratory | `shim_gemini31pro_messages` | Retained monotonic probe for the retired preview id. Copilot now rejects it as unavailable for the `vscode-chat` integrator; current resolvers fall through to Gemini 3.8 Flash. |
| `grok-4.6` | `/responses` | ✅ 200 live-verified 2026-08-27 | exploratory | `shim_grok46_messages` / `shim_grok46_messages_tool_use` | Shipped translated Grok lead/tool path. Routes through the SAME generic Responses shim as `gpt-5.5`/`gpt-5.6-sol` (`classifyMessagesRoute` keys off catalog `supported_endpoints`, never a hardcoded shim slug list). 500K total / 372K max-prompt / 128K max-output, `low..xhigh` effort (no `max`); kept bare (no `[1m]`) — see "Grok context accounting" in [`default-models.md`](default-models.md). |

**Field acceptances on the shim's target endpoints** (e2e probes verify HTTP 200 **acceptance** — the field does not `400`; **forwarding** is unit-tested — see the coverage-split note below):

> **Coverage split (read before trusting these rows).** The `shim_stop_*` / `shim_parallel_tool_calls_*` probes are end-to-end and assert **ACCEPTANCE only** — that the field does not cause a `400` end-to-end. A `200` does **not** prove the shim actually forwarded the field (a silent drop would still `200`), and it does **not** prove Copilot *honored* the field (e.g. truncated on `stop`). **Forwarding correctness** — that `payload.stop` / `payload.parallel_tool_calls` are actually set on the outbound Copilot body — is covered by the unit tests in `tests/anthropic-translate-request.test.ts` (gpt / Responses shim) and `tests/anthropic-translate-gemini-request.test.ts` (gemini / chat shim).

| Field (wire) | Endpoint | End-to-end status | Source | Probe id | Notes |
|---|---|---|---|---|---|
| `stop` (from Anthropic `stop_sequences`) | `/responses` | ✅ 200 (accepted; ignored on gpt) | exploratory | `shim_stop_responses` | Copilot's `/responses` **accepts** `stop` (no `400`) but does **not** honor it on gpt models (accepted-but-ignored, best-effort). The shim forwards it regardless (`anthropic-request.ts`). Probe asserts acceptance only; forwarding is unit-tested in `tests/anthropic-translate-request.test.ts`. |
| `stop` (from Anthropic `stop_sequences`) | `/chat/completions` | ✅ 200 (accepted; honoring best-effort, not asserted) | exploratory | `shim_stop_chat` | Copilot's `/chat/completions` **accepts** `stop` (HTTP 200, no `400`). Whether it **honors** the sequence (truncates output) was **not conclusively live-verified** — do not claim "honored". The probe asserts acceptance only; forwarding of `payload.stop` is unit-tested in `tests/anthropic-translate-gemini-request.test.ts`. |
| `parallel_tool_calls` | `/responses` | ✅ 200 (accepted) | exploratory | `shim_parallel_tool_calls_responses` | Accepted on `/responses` (no `400`). The shim only ever emits `parallel_tool_calls:false` (from Anthropic `tool_choice.disable_parallel_tool_use:true`), never `true`. Probe asserts acceptance only; forwarding is unit-tested in `tests/anthropic-translate-request.test.ts`. |

**Additional shim request shapes** (end-to-end probes assert the user-facing accept/degrade contract):

| Shape | Model / endpoint | Expected end-to-end status | Source | Probe id | Notes |
|---|---|---|---|---|---|
| Anthropic `document` block with base64 `application/pdf` source | `gpt-5.5` → `/responses` | ✅ 200 (accepted; model can read PDF text) | exploratory | `shim_document_pdf_gpt55` | Tiny embedded PDF contains sentinel `ShimPDFProbeZebra42`; probe asserts the Anthropic response references that sentinel, not just that the body validator accepts the file. |
| Anthropic `document` block with base64 `application/pdf` source | `gemini-3.5-flash` → `/chat/completions` | ✅ 200 (graceful degrade; no `400`) | exploratory | `shim_document_pdf_degrade_gemini35flash` | Chat shim cannot forward file parts to `/chat/completions`; it degrades the PDF to a text note and still returns a well-formed Anthropic message. PDF reading is **not** asserted on this path. |
| `max_tokens: 1` | `gpt-5.5` → `/responses` | ✅ 200 (accepted after shim clamp) | exploratory | `shim_max_tokens_clamp_gpt55` | Proves the Responses shim clamps below-minimum Anthropic `max_tokens` before forwarding instead of leaking a Copilot validator `400`. |
| Anthropic `image` block with base64 `image/png` source | `gpt-5.5` → `/responses` | ✅ 200 (accepted) | exploratory | `shim_image_gpt55` | Uses a known-valid tiny RGB PNG data payload (1×1 red pixel, color type 2), not an RGBA/malformed test string. |
| Anthropic `image` block with base64 `image/png` source | `gemini-3.5-flash` → `/chat/completions` | ✅ 200 (accepted) | exploratory | `shim_image_gemini35flash` | Same valid RGB PNG through the chat shim's `image_url` translation path. |
| Anthropic `image` block, **native passthrough**, `copilot-vision-request` header OMITTED | `claude-opus-5` → `/v1/messages` | ✅ 200 (accepted; model reads the image) | exploratory | `passthrough_image_claude` | Settles a long-standing unverified code comment in `create-messages.ts`. Verified live 2026-08-03 by sending the same image with the header omitted and with it set: both returned 200 **and the model named the image's colour in each case**, so the pixels genuinely reach it without the header. The proxy keeps omitting it (matching VS Code); this probe is what stops that silently becoming wrong. |
| Anthropic `image` nested inside a `tool_result` | `gpt-5.5` → `/responses` | ✅ 200 (accepted) | exploratory | `shim_image_tool_result_gpt55` | The shape a subagent reading a screenshot actually produces, and previously the one with **zero** live coverage — only top-level image blocks were probed. A `function_call_output` cannot carry an image, so the shim re-emits it as a follow-up user message in wire order. |
| Anthropic `image` nested inside a `tool_result` | `gemini-3.5-flash` → `/chat/completions` | ✅ 200 (accepted) | exploratory | `shim_image_tool_result_gemini35flash` | Same nested shape through the chat egress, where the follow-up rides as an `image_url` content part. |
| 2 image blocks to a `max_prompt_images: 1` model | `gpt-5.5` → `/responses` | ✅ 200 | exploratory | `vision_multi_image_gpt` | The proxy used to reject this **locally** at 2. Measured 2026-08-10 across all 23 vision models: `max_prompt_images` is accurate for gemini only (10, enforced) and understates everywhere else — `gpt-5.6-sol` advertises 1 and upstream enforces **50**, `gpt-5.5` advertises 1 and accepted **120**, `claude-opus-5` advertises 1 and accepted **200**. The ceiling is not uniform even within a family, so there is no single number to substitute. The local gate was refusing requests Copilot answers, and doing it fatally, because the count covered replayed history the caller cannot edit. A `400` here means a local count gate came back. |
| 12 image blocks to a model whose real ceiling is 10 | `gemini-3.8-flash` → `/chat/completions` | ✅ 200, live-verified 2026-09-03 | exploratory | `vision_ceiling_recovery_gemini` | Copilot names the real number when it refuses (`too many images: maximum allowed for model ... is 10`). The proxy parses it, prunes to it keeping the most recent images, retries **once**, and remembers it for the process lifetime; a second rejection or an unparseable one is forwarded untouched, so it cannot loop. **What this probe asserts is only the user-visible outcome**: a 200 and a well-formed message, which without the recovery would be a 400. The mechanism itself (exactly one upstream rejection, pruned to 10, exactly one retry, then proactive ceiling application) is pinned by `tests/vision-preflight.test.ts`. The carrier moved from the retired Pro preview to active Gemini 3.8 without removing the probe. It uses `max_tokens:512` because this high-effort model can exhaust a 128-token budget before producing the answer; the larger budget isolates image-ceiling recovery from output-budget exhaustion. |
| 1×1 PNG (below minimum dimensions) | `grok-4.5` → `/responses` | ❌ 400 `Image dimensions 1x1 are too small` | exploratory | (measured, not probed) | Measured 2026-08-10. A rule the proxy models nowhere, and part of why cardinality is left to upstream: local pre-validation cannot be complete. Not probed because a 1×1 is not a shape any client emits. |
| PNG image block | `gpt-4o` → `/chat/completions` | ❌ 400 `validating image item: image media type not supported` | exploratory | (measured, not probed) | Measured 2026-08-10. Note `gpt-4o-2024-05-13` accepted the same bytes at 32 images, so this is specific to the `gpt-4o` alias. Second instance of an upstream rule with no local model. |
| `anthropic-beta: advisor-tool-2026-03-01` plus advisor tool entries | `gpt-5.5` → `/responses` | ✅ 200 (graceful degrade; advisor unavailable, no `400`) | exploratory | `shim_advisor_degrade_gpt55` | Non-Claude shim path strips the proxy-internal `__anthropic_advisor` tool and native `advisor_*` typed tool, ignores the unsupported advisor beta, and proceeds without advisor. Authenticated fast Task-subagent traffic intentionally reuses this exact strip shape because fast Advisor is lead-only. |
| `anthropic-beta: advisor-tool-2026-03-01` plus advisor tool entries | `gemini-3.5-flash` → `/chat/completions` | ✅ 200 (graceful degrade; advisor unavailable, no `400`) | exploratory | `shim_advisor_degrade_gemini35flash` | Same graceful-degrade and fast-subagent strip contract on the chat shim path. |
| `POST /v1/messages/count_tokens` with a non-Claude GPT model id | `gpt-5.3-codex` → native count_tokens endpoint | ✅ 200 (accepted; returns `input_tokens`) | exploratory | `shim_count_tokens_gpt53codex` | Ensures Anthropic token-counting requests naming a GPT/Codex model return a token count rather than rejecting at the Anthropic boundary. |
| Anthropic `thinking:{type:"enabled", budget_tokens}` | `gpt-5.5` → `/responses` | ✅ 200 (accepted after effort mapping/clamp) | exploratory | `shim_thinking_effort_gpt55` | Shim maps Anthropic thinking budget to Responses `reasoning.effort`, clamped to the selected model's supported values. |
| Prompt/tool set that requests two independent tool calls | `gpt-5.5` → `/responses` | ✅ 200 (accepted; `tool_use` block emitted) | exploratory | `shim_parallel_tool_emit_gpt55` | Best-effort parallel-tool emission probe: asks for both `lookup_weather` and `lookup_time`, but model behavior can be nondeterministic, so the probe asserts `>=1` `tool_use` block and records multiple-tool emission intent rather than requiring exactly two. |

**Streaming usage**: Copilot emits usage on the stream unprompted (no `stream_options` needed); the shim maps it into the terminal `message_delta`.

## Web search — cross-endpoint native exposure (Task #2 empirical map)

Resolution of the long-standing `tooltype_web_search_20250305` "inconclusive" row, plus full coverage of how Copilot exposes web_search natively across all three Anthropic-shape entry points and what the proxy does on top.

| Endpoint | Tool shape sent | Direct upstream Copilot | End-to-end through proxy | Probe id |
|---|---|---|---|---|
| `/v1/messages` | `tools[].type=web_search_20250305` (Anthropic native) | ❌ 400 `unsupported_value: "The use of the web search tool is not supported."` | ✅ 200 (proxy intercepts in `processWebSearch`, fulfils via Copilot `/mcp` server-side, strips the tool, and appends an unmarked result block plus authoritative tail after the stable system prefix) | `web_search_anthropic_tool_messages` |
| `/v1/responses` | `tools[].type=web_search_preview` (OpenAI Responses native) | ✅ 200 — model invokes natively; output stream contains `web_search_call` block (action.queries[]) followed by `message` | ✅ 200 (proxy passes through; no MCP hop) | `web_search_responses_preview` |
| `/v1/responses` | `tools[].type=web_search_preview_2025_03_11` (versioned variant) | ✅ 200 — model invokes natively (same shape as bare preview) | (untested via proxy — covered by upstream confirmation) | (TODO) |
| `/v1/responses` | `tools[].type=web_search` (bare/legacy) | ✅ 200 — body validator accepts AND model invokes natively (proven with real query). Comment in `src/routes/responses/handler.ts:314-316` saying Copilot rejects this is now stale. | ✅ 200 — but proxy strips the `web_search` tool and inserts MCP results as a later system input item, preserving prior instructions/system prefix | (no probe — proxy strips so untestable end-to-end without bypass) |
| `/v1/chat/completions` | `tools[].type=web_search` | ❌ 400 `invalid_request_body: "Invalid 'tools[0].function.name': empty string."` (validator only accepts strict OpenAI function tools) | ✅ 200 (proxy intercepts in `injectWebSearchIfNeeded`, fulfils via MCP, strips the tool, and inserts results after leading stable system messages) | `web_search_chat_completions` |
| `/v1/chat/completions` | `tools[].type=web_search_preview` | ❌ 400 (same shape error) | ✅ 200 (same proxy strip+substitute path as above) | (TODO — same code path as above) |
| `/v1/chat/completions` | top-level `web_search_options: {}` (gpt-4o-search-preview style) | ✅ 200 (validator accepts) — but vanilla `gpt-4o` has no native search wiring; model returns "I cannot provide real-time data, knowledge ends Oct 2023". Field is silently ignored. | (proxy passthrough — no `web_search_options` strip) | (TODO) |

**Conclusion**: Copilot's only native web_search exposure is on `/v1/responses` for GPT-5.x via `web_search_preview` (and accidentally `web_search`, which the proxy strips). All other entry points require the proxy's MCP-fulfilment fallback.

**Native /mcp web_search tool** (used by the proxy under the hood — auth is the GitHub PAT, not the Copilot-exchanged token):
- Endpoint: `POST https://api.enterprise.githubcopilot.com/mcp`
- Wire: `initialize` → `notifications/initialized` → `tools/call`
- Required header: `X-MCP-Toolsets: web_search` (without it, `tools/list` returns the default toolset which omits web_search)
- Tool input schema (verbatim from `tools/list` 2026-05-14):
  ```json
  {"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}
  ```
- Response shape (stable across 3 distinct queries, 2026-05-14):
  ```json
  {
    "type": "...",
    "text": {"value": "<markdown body with citation refs>", "annotations": [...]},
    "annotations": [...],            // duplicate of text.annotations at top level
    "bing_searches": [{"text": "...", "url": "..."}]
  }
  ```
  Each `annotations[i]`: `{end_index, start_index, text, url_citation: {title, url}}`.
- The proxy's Zod schema (`src/services/copilot/web-search.ts:InnerSchema`) reads only `text.value` and `text.annotations[i].url_citation` — extra top-level `type`, top-level `annotations`, and the `bing_searches[i]` inner shape are silently stripped/ignored. **No drift observed since the May 8 fix** (when the inner shape changed and the schema was relaxed to make `annotations` `.nullable().optional()`).



The probe currently exercises `/v1/messages`. TODO:
- `/v1/messages/count_tokens` — same Copilot validator, same strip logic in `count-tokens-handler.ts`. Add probes mirroring the body-field strips above.
- `/v1/chat/completions` — Codex/raw-OpenAI clients
- `/v1/responses` — gpt-5.x / o-series models
- `/v1/embeddings` — passthrough

## Peer-MCP personas

The proxy's `/mcp` endpoint exposes four read-only adversarial-review personas (`codex_critic`, `codex_reviewer`, `gemini_critic`, `opus_critic`) plus an optional write-capable `codex_implementer` (only when `--codex-cli`). See [`docs/peer-mcp-design.md`](peer-mcp-design.md) for the full architecture.

Each persona declares an `allowedEfforts` allowlist that the `/mcp` `tools/call` handler enforces (Phase A1 of `cap-codex-effort-add-opus-critic`). Calls passing an effort outside the allowlist are rejected at the JSON-RPC layer with `-32602 RPC_INVALID_PARAMS` BEFORE any Copilot fetch, so a banned tier never burns an in-flight slot or hits the ~60s MCP per-tool-call ceiling. The allowlists are derived empirically from latency probes (see CLAUDE.md "Peer-model MCP integration" for the full table).

| Probe id | Persona | What's verified | End-to-end status | Source | Last verified |
|---|---|---|---|---|---|
| `opus_critic_low` | `opus_critic` | `/v1/messages` accepts `thinking.budget_tokens=1024 + max_tokens=2524` (the body shape the handler builds for `effort:"low"`) | ✅ 200 | anthropic-docs | 2026-05-14 |
| `opus_critic_medium` | `opus_critic` | `/v1/messages` accepts `thinking.budget_tokens=3000 + max_tokens=4500` (the body shape the handler builds for `effort:"medium"`) | ✅ 200 | anthropic-docs | 2026-05-14 |
| `opus_critic_high_allowed` | `opus_critic` | `peer-mcp-personas.ts` source: `opus-critic.allowedEfforts` INCLUDES `"high"`. Static-check probe — SSE-streamed /mcp responses (PR #28 commit 48f08be) bypass Claude Code's ~60s tools/call ceiling so the prior low/medium-only constraint was lifted. | ✅ included | proxy-internal | 2026-05-15 |
| `opus_critic_xhigh_allowed` | `opus_critic` | `peer-mcp-personas.ts` source: `opus-critic.allowedEfforts` INCLUDES `"xhigh"`. xhigh is now the persona's defaultEffort (commit 7734356) — SSE handles the wall-clock transparently. | ✅ included | proxy-internal | 2026-05-15 |
| `codex_critic_xhigh_allowed` | `codex_critic` | `peer-mcp-personas.ts` source: `codex-critic.allowedEfforts` INCLUDES `"xhigh"`. Empirical: gpt-5.5 at xhigh on a 600-byte prompt = 56s; SSE bypass + MCP_TOOL_TIMEOUT=600000 (commit 3a2c311) lifted the prior constraint. xhigh is now the default. | ✅ included | proxy-internal | 2026-05-15 |
| `codex_reviewer_xhigh_allowed` | `codex_reviewer` | `peer-mcp-personas.ts` source: `codex-reviewer.allowedEfforts` INCLUDES `"xhigh"`. Sibling model (gpt-5.3-codex) is faster than gpt-5.5; SSE handles long calls transparently. xhigh is now the default. | ✅ included | proxy-internal | 2026-05-15 |
| `gemini_critic_xhigh_rejected` | `gemini_critic` | `peer-mcp-personas.ts` source: `gemini-critic.allowedEfforts` EXCLUDES `"xhigh"`. **UPSTREAM constraint** (not a proxy choice): Copilot's gemini-3.x route strict-validates `reasoning_effort` and 400s on values outside `[low medium high]`. Empirically verified 2026-05-14 (error: `reasoning_effort "xhigh" is not supported by model gemini-3.1-pro-preview`). | ✅ excluded | proxy-internal | 2026-05-15 |

Static-check probes anchor the script to `PROJECT_ROOT` (computed from `BASH_SOURCE`) so they work regardless of CWD; the persona-block parser is a bounded `awk` window from the matched `agentName:` line and depends on the current TS source style (double-quoted string entries inside an array literal). If the persona spec ever switches to dynamic construction or single quotes, these probes will fail loudly — the failure mode is acceptable because the static check IS the source of truth the handler enforces, so any change to the spec needs the probe updated in lock-step.

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

## Transport (ALPN)

Not a request-shape row, but the same discipline applies: an upstream behaviour we
depend on, asserted by an executable check rather than assumed.

| Observable | Expectation | Verified by |
| --- | --- | --- |
| `api.githubcopilot.com` ALPN when the client offers `["h2","http/1.1"]` | ✅ selects `h2` | `bun run check:alpn` with `GH_ROUTER_UPSTREAM_ALLOW_H2=1` |
| `api.githubcopilot.com` ALPN when the client offers `["http/1.1"]` only | ✅ selects `http/1.1` | `bun run check:alpn` (default) |

Both measured 2026-08-07 on Node v26.7.0 (built-in undici 8.9.0, OpenSSL 3.5.7).

The check asserts the **negotiated** protocol, not the options an `Agent` was
constructed with. That distinction is load-bearing: while adding transport
diagnostics, supplying a custom `connect` connector silently defeated
`allowH2:false` on the Agent — ALPN is chosen by the connector
(`undici/lib/core/connect.js`), not the Agent — and every construction-level
assertion still passed while the live handshake negotiated `h2`.

Exposure is Node-version-gated: Node ≤24's built-in fetch reads
`Symbol.for("undici.globalDispatcher.1")`, whose wrapper hardcodes
`allowH2:false`; Node ≥26 reads `.2`. So a **runtime** bump can change this where
a dependency bump cannot — which is why the check records
`process.versions.undici` (the built-in, not the npm dependency).
