#!/usr/bin/env bash
# probe-copilot-compat.sh — symmetric Copilot compatibility probe suite for github-router
#
# Why this exists:
#   The proxy strips, translates, and forwards Anthropic-shaped requests to GitHub
#   Copilot's API. Copilot's validator accepts a subset of Anthropic's surface and
#   rejects the rest, with the boundary shifting over time. Without empirical probes
#   the proxy accumulates dead strip rules (Copilot quietly fixed support for a field)
#   and misses newly-rejected fields (Copilot tightened a validator and users hit 400s
#   in production).
#
# How it works:
#   Each probe is a function `probe_<id>` returning 0 (pass) / 1 (fail). Probe metadata
#   is registered in PROBE_REGISTRY (see registration block below) with name, source,
#   and expected status. Probes use `assert_status` and (optionally) `assert_body_contains`
#   to express expected outcomes. SYMMETRIC: both accept (200) and reject (4xx) outcomes
#   are asserted — drift in either direction is a failure.
#
# Discovery rule (enforced via CLAUDE.md):
#   Every field, header, body shape, or tool type that any client (Claude Code, Codex,
#   raw API users) emits MUST have a probe row, irrespective of accept/reject. The probe
#   set grows monotonically. Removing a probe requires written justification in
#   docs/copilot-compat-matrix.md.
#
# Usage:
#   bash scripts/probe-copilot-compat.sh                     # run all (--report mode default)
#   bash scripts/probe-copilot-compat.sh --strict            # exit non-zero on any deviation
#   bash scripts/probe-copilot-compat.sh --list              # enumerate probes
#   bash scripts/probe-copilot-compat.sh --probe <id>        # run one
#   bash scripts/probe-copilot-compat.sh --source <category> # filter by source column
#
# Environment:
#   PROXY_URL — base URL of the running proxy (default http://127.0.0.1:54668)
#   AUTH_TOKEN — Bearer token (default "dummy"; the proxy doesn't enforce auth)
#   ANTHROPIC_VERSION — anthropic-version header (default "2023-06-01")

set -euo pipefail

PROXY_URL="${PROXY_URL:-http://127.0.0.1:54668}"
AUTH_TOKEN="${AUTH_TOKEN:-dummy}"
ANTHROPIC_VERSION="${ANTHROPIC_VERSION:-2023-06-01}"

# Repo root — used by static-check probes (peer-MCP gate validation) that
# read source files directly rather than going through the proxy. Anchored
# to this script's location so probes work regardless of CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Output ANSI color when stdout is a TTY.
if [ -t 1 ]; then
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_DIM=$'\033[2m'
  C_RESET=$'\033[0m'
else
  C_RED=""
  C_GREEN=""
  C_YELLOW=""
  C_DIM=""
  C_RESET=""
fi

# Probe registry: each row is "id|source|description"
# Sources:
#   claude-emits      — observed in Claude Code traffic
#   codex-emits       — observed in Codex traffic
#   anthropic-docs    — published in Anthropic API docs
#   copilot-allowlist — extracted from a Copilot 400 error message
#   exploratory       — speculative "let me see what Copilot does"
declare -a PROBE_REGISTRY=(
  # ===== Tool baseline =====
  "tool_baseline_custom|anthropic-docs|Custom tool with no special fields returns 200"
  "tool_baseline_custom_with_type|anthropic-docs|Custom tool with explicit type:custom returns 200"

  # ===== FGTS strip (Phase 0 of plan) =====
  # IMPORTANT: probes go through the proxy, so they test end-to-end behavior.
  # Once the Phase 0 strip ships, the proxy removes eager_input_streaming
  # before forwarding, so Copilot returns 200 (not 400). If a future Copilot
  # update accepts the field natively, these probes still pass — and we'd
  # know to consider lifting the strip (the matrix doc tracks the upstream
  # truth separately from the proxy's user-facing behavior).
  "eager_input_streaming_stripped|claude-emits|tools[i].eager_input_streaming sent through proxy returns 200 (proxy strips before forwarding; Copilot would 400 on the raw field)"
  "eager_input_streaming_with_type_custom_stripped|claude-emits|Same field with explicit type:custom returns 200 (same strip path)"

  # ===== fast-mode `speed` body-field strip =====
  # The `fast-mode-2026-02-01` beta HEADER is forwarded (extended/leverage mode),
  # but the top-level `speed:"fast"` BODY field is unknown to Copilot's validator.
  # The proxy strips the body field before forwarding so the request 200s; Copilot
  # would 400 ("Extra inputs are not permitted") on the raw top-level field.
  # count-tokens needs its own probe — the harness runs end-to-end through the
  # proxy only, and a /v1/messages probe cannot honestly cover the separate
  # count-tokens code path.
  "speed_fast_stripped|claude-emits|top-level speed:\"fast\" (with fast-mode beta header) sent through proxy returns 200 (proxy strips body field before forwarding; Copilot would 400 on the raw top-level field)"
  "speed_fast_count_tokens_stripped|claude-emits|top-level speed:\"fast\" on /v1/messages/count_tokens returns 200 (proxy strips before forwarding; Copilot would 400 on the raw field)"
  "output_config_format_ga_stripped|anthropic-docs|output_config:{format:{type,schema}} (Structured Outputs GA 2026-02-17 nested shape) returns 200 (proxy strips output_config.format + injects schema as system instruction; Copilot would 400 on output_config.* other than effort)"

  # ===== Native Anthropic tool types =====
  "tooltype_memory_20250818|anthropic-docs|memory_20250818 returns 200; model emits tool_use{name:memory, command:view}"
  "tooltype_text_editor_20250728|anthropic-docs|text_editor_20250728 returns 200"
  "tooltype_bash_20250124|copilot-allowlist|bash_20250124 returns 200 (current bash version)"
  "tooltype_bash_20241022_legacy|copilot-allowlist|bash_20241022 (legacy version) returns 400"
  "tooltype_code_execution_20250825|copilot-allowlist|code_execution_20250825 returns 400 (not in Copilot allowlist)"
  "tooltype_web_search_20250305|anthropic-docs|web_search_20250305 returns 200 in body validator (model invocation inconclusive)"
  "tooltype_web_fetch_hosted_rejected|anthropic-docs|hosted web_fetch_20260209 returns 400 (proxy fail-fast: no Copilot backend, URL is model-chosen mid-generation so cannot be pre-fulfilled)"
  "tooltype_web_fetch_custom_name_allowed|exploratory|custom tool merely NAMED web_fetch (type:custom) returns 200 — detection matches the hosted type slug, not the name (regression guard against over-matching)"

  # ===== Web search across endpoints (Task #2 — empirical native exposure map) =====
  # End-to-end through proxy: the Anthropic-shape web_search tool is rejected by
  # Copilot's upstream /v1/messages with 400 'use of the web search tool is not
  # supported'. The proxy intercepts in handler.ts (processWebSearch), runs the
  # MCP path server-side (web-search.ts), and substitutes results into the system
  # prompt before forwarding the (web_search-stripped) body. End-user sees 200.
  "web_search_anthropic_tool_messages|anthropic-docs|tools[].type=web_search_20250305 on /v1/messages: end-to-end 200 (proxy fulfils via MCP and strips before forwarding); upstream Copilot 400s on raw"
  # Native: Copilot's /v1/responses fulfils web_search_preview natively for
  # GPT-5.x — no proxy intervention needed; output stream contains a
  # web_search_call block followed by the model's final message.
  "web_search_responses_preview|copilot-allowlist|tools[].type=web_search_preview on /v1/responses (gpt-5.5): 200; model invokes (output[].type=web_search_call present)"
  # Negative-upstream / positive-proxy: Copilot's /chat/completions has no
  # native hosted web_search. Direct upstream returns 400 with
  # 'tools[0].function.name' empty-string error. The proxy intercepts via
  # injectWebSearchIfNeeded (chat-completions/handler.ts), fulfils via MCP
  # server-side, and strips the web_search tool before forwarding — so the
  # end-user sees 200. Same pattern as web_search_anthropic_tool_messages.
  "web_search_chat_completions|exploratory|tools[].type=web_search on /chat/completions (gpt-4.1): end-to-end 200 (proxy fulfils via MCP and strips before forwarding); upstream Copilot 400s on raw shape (only OpenAI function tools accepted there)"

  # ===== Context management =====
  "compact_20260112|anthropic-docs|context_management.edits[].type=compact_20260112 with anthropic-beta:compact-2026-01-12 returns 200"
  "clear_tool_uses_20250919|anthropic-docs|context_management.edits[].type=clear_tool_uses_20250919 returns 200"

  # ===== Streaming =====
  "stream_with_tools|claude-emits|Streaming response with tools (no FGTS) returns 200 with valid SSE event sequence"

  # ===== Peer-MCP personas (Phase B6 of cap-codex-effort-add-opus-critic) =====
  # Two probe shapes:
  #   - opus_critic_low / opus_critic_medium are END-TO-END LIVE PROBES against the
  #     proxy's /v1/messages endpoint, using the same Anthropic-shape thinking block
  #     that the /mcp /v1/messages branch builds for the opus-critic persona. They
  #     verify Copilot still 200s on those budget_tokens/max_tokens combos.
  #   - opus_critic_high_rejected / codex_critic_xhigh_rejected /
  #     codex_reviewer_xhigh_rejected are STATIC-CHECK PROBES that read
  #     src/lib/peer-mcp-personas.ts directly and assert the per-persona
  #     allowedEfforts gate (Phase A1 of the same plan) excludes the
  #     ceiling-busting tier. The static check is the single source of truth
  #     the handler then enforces at the /mcp boundary; running the live MCP
  #     call would require fishing the per-launch nonce out of
  #     ~/.local/share/github-router/.../peer-mcp-<pid>-<rand>.json — much
  #     more brittle than parsing one TS source line.
  "opus_critic_low|anthropic-docs|opus_critic at effort=low equivalent (thinking.budget=1024, max_tokens=2524) returns 200 from /v1/messages"
  "opus_critic_medium|anthropic-docs|opus_critic at effort=medium equivalent (thinking.budget=3000, max_tokens=4500) returns 200 from /v1/messages"
  "opus_critic_high_allowed|proxy-internal|peer-mcp-personas.ts: opus-critic.allowedEfforts INCLUDES 'high' (post-SSE) — static check"
  "opus_critic_xhigh_allowed|proxy-internal|peer-mcp-personas.ts: opus-critic.allowedEfforts INCLUDES 'xhigh' (post-SSE; xhigh is the default) — static check"
  "codex_critic_xhigh_allowed|proxy-internal|peer-mcp-personas.ts: codex-critic.allowedEfforts INCLUDES 'xhigh' (post-SSE; xhigh is the default) — static check"
  "codex_reviewer_xhigh_allowed|proxy-internal|peer-mcp-personas.ts: codex-reviewer.allowedEfforts INCLUDES 'xhigh' (post-SSE; xhigh is the default) — static check"
  "gemini_critic_xhigh_rejected|proxy-internal|peer-mcp-personas.ts: gemini-critic.allowedEfforts EXCLUDES 'xhigh' (Copilot upstream-rejects) — static check"

  # ===== Worker tools (load-bearing model+shape contract) =====
  # The worker_explore / worker_implement MCP tools default to gemini-3.5-flash
  # on /v1/chat/completions with stream:true + tools[] + reasoning_effort:"high".
  # If Copilot ever tightens the validator (rejects the field combination, or
  # drops reasoning_effort on this model), the worker tools degrade silently —
  # the dual gate's first arm catches catalog miss / tool_calls=false, but only
  # this probe catches the case where the model IS present and tool-capable but
  # the body shape is rejected. See docs/peer-mcp-design.md "Worker tools".
  "worker_gemini_tools_reasoning|exploratory|gemini-3.5-flash on /v1/chat/completions accepts tools[] + reasoning_effort:'high' (load-bearing contract for worker_explore/worker_implement MCP tools)"
)

# ===========================================================================
# Helpers
# ===========================================================================

# Last response captured by `do_request`.
LAST_STATUS=""
LAST_BODY_FILE=""

cleanup() {
  if [ -n "${LAST_BODY_FILE:-}" ] && [ -f "$LAST_BODY_FILE" ]; then
    rm -f "$LAST_BODY_FILE"
  fi
}
trap cleanup EXIT

# do_request <method> <path> <body>
# Captures status code in $LAST_STATUS, body in $LAST_BODY_FILE.
do_request() {
  local method="$1" path="$2" body="$3"
  shift 3
  local extra_headers=("$@")
  LAST_BODY_FILE="$(mktemp -t probe-body.XXXXXX)"
  local hdr_args=(
    -H "Content-Type: application/json"
    -H "Authorization: Bearer ${AUTH_TOKEN}"
    -H "anthropic-version: ${ANTHROPIC_VERSION}"
  )
  local h
  for h in "${extra_headers[@]:-}"; do
    [ -n "$h" ] && hdr_args+=(-H "$h")
  done
  LAST_STATUS=$(
    curl -s -o "$LAST_BODY_FILE" -w "%{http_code}" \
      -X "$method" "${PROXY_URL}${path}" \
      "${hdr_args[@]}" \
      -d "$body"
  )
}

# do_stream_request — like do_request but with -N for streaming.
do_stream_request() {
  local method="$1" path="$2" body="$3"
  shift 3
  local extra_headers=("$@")
  LAST_BODY_FILE="$(mktemp -t probe-body.XXXXXX)"
  local hdr_args=(
    -H "Content-Type: application/json"
    -H "Authorization: Bearer ${AUTH_TOKEN}"
    -H "anthropic-version: ${ANTHROPIC_VERSION}"
  )
  local h
  for h in "${extra_headers[@]:-}"; do
    [ -n "$h" ] && hdr_args+=(-H "$h")
  done
  LAST_STATUS=$(
    curl -s -N -o "$LAST_BODY_FILE" -w "%{http_code}" \
      -X "$method" "${PROXY_URL}${path}" \
      "${hdr_args[@]}" \
      -d "$body"
  )
}

assert_status() {
  local expected="$1"
  if [ "$LAST_STATUS" != "$expected" ]; then
    echo "  ${C_RED}FAIL${C_RESET}: expected HTTP $expected, got $LAST_STATUS"
    echo "  ${C_DIM}body: $(head -c 300 "$LAST_BODY_FILE")${C_RESET}"
    return 1
  fi
  return 0
}

assert_body_contains() {
  local needle="$1"
  if ! grep -q -- "$needle" "$LAST_BODY_FILE"; then
    echo "  ${C_RED}FAIL${C_RESET}: response body did not contain '$needle'"
    echo "  ${C_DIM}body: $(head -c 300 "$LAST_BODY_FILE")${C_RESET}"
    return 1
  fi
  return 0
}

# ===========================================================================
# Probes
# ===========================================================================

probe_tool_baseline_custom() {
  do_request POST /v1/messages '{
    "model": "claude-haiku-4-5",
    "max_tokens": 50,
    "tools": [{"name":"echo","description":"t","input_schema":{"type":"object"}}],
    "messages": [{"role":"user","content":"call echo"}]
  }'
  assert_status 200
}

probe_tool_baseline_custom_with_type() {
  do_request POST /v1/messages '{
    "model": "claude-haiku-4-5",
    "max_tokens": 50,
    "tools": [{"type":"custom","name":"echo","description":"t","input_schema":{"type":"object"}}],
    "messages": [{"role":"user","content":"call echo"}]
  }'
  assert_status 200
}

probe_eager_input_streaming_stripped() {
  # End-to-end: proxy must strip the field, Copilot must then 200.
  # Pre-Phase-0 (no strip): this fails because Copilot 400s on the field.
  # Post-Phase-0 (strip in place): this passes because the proxy removes the
  # field before forwarding. If Copilot ever broadens to accept the field
  # natively, this probe still passes — visit the matrix to consider whether
  # the strip is still needed.
  do_request POST /v1/messages '{
    "model": "claude-haiku-4-5",
    "max_tokens": 50,
    "tools": [{"name":"echo","description":"t","input_schema":{"type":"object"},"eager_input_streaming":true}],
    "messages": [{"role":"user","content":"hi"}]
  }'
  assert_status 200
}

probe_eager_input_streaming_with_type_custom_stripped() {
  do_request POST /v1/messages '{
    "model": "claude-haiku-4-5",
    "max_tokens": 50,
    "tools": [{"type":"custom","name":"echo","description":"t","input_schema":{"type":"object"},"eager_input_streaming":true}],
    "messages": [{"role":"user","content":"hi"}]
  }'
  assert_status 200
}

probe_speed_fast_stripped() {
  # Send the REAL fast-mode shape: the `fast-mode-2026-02-01` beta header is
  # forwarded (extended/leverage mode) while the top-level `speed:"fast"` body
  # field is stripped by the proxy before forwarding. End-user sees 200; Copilot
  # would 400 on the raw top-level field.
  do_request POST /v1/messages '{"model":"claude-haiku-4-5","max_tokens":50,"speed":"fast","messages":[{"role":"user","content":"hi"}]}' "anthropic-beta: fast-mode-2026-02-01"
  assert_status 200
}

probe_speed_fast_count_tokens_stripped() {
  # Same strip exercised through the independent count_tokens code path.
  do_request POST /v1/messages/count_tokens '{"model":"claude-haiku-4-5","speed":"fast","messages":[{"role":"user","content":"hi"}]}' "anthropic-beta: fast-mode-2026-02-01"
  assert_status 200
}

probe_output_config_format_ga_stripped() {
  # Structured Outputs GA (2026-02-17) nests schema/type under
  # output_config.format. The proxy strips output_config.* (Copilot 400s on
  # everything but effort) and injects the schema as a system-prompt
  # instruction so the structured-output intent survives. End-user sees 200.
  do_request POST /v1/messages '{"model":"claude-haiku-4-5","max_tokens":50,"output_config":{"format":{"type":"json_schema","schema":{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}}},"messages":[{"role":"user","content":"hi"}]}'
  assert_status 200
}

probe_tooltype_memory_20250818() {
  do_request POST /v1/messages '{
    "model": "claude-opus-4-7",
    "max_tokens": 100,
    "tools": [{"type":"memory_20250818","name":"memory"}],
    "messages": [{"role":"user","content":"Check your memory then say hi"}]
  }' "anthropic-beta: memory-2025-08-18"
  assert_status 200
}

probe_tooltype_text_editor_20250728() {
  do_request POST /v1/messages '{
    "model": "claude-opus-4-7",
    "max_tokens": 50,
    "tools": [{"type":"text_editor_20250728","name":"str_replace_based_edit_tool"}],
    "messages": [{"role":"user","content":"view /tmp/foo"}]
  }'
  assert_status 200
}

probe_tooltype_bash_20250124() {
  do_request POST /v1/messages '{
    "model": "claude-opus-4-7",
    "max_tokens": 50,
    "tools": [{"type":"bash_20250124","name":"bash"}],
    "messages": [{"role":"user","content":"hi"}]
  }'
  assert_status 200
}

probe_tooltype_bash_20241022_legacy() {
  do_request POST /v1/messages '{
    "model": "claude-opus-4-7",
    "max_tokens": 50,
    "tools": [{"type":"bash_20241022","name":"bash"}],
    "messages": [{"role":"user","content":"hi"}]
  }'
  assert_status 400 \
    && assert_body_contains "bash_20241022"
}

probe_tooltype_code_execution_20250825() {
  do_request POST /v1/messages '{
    "model": "claude-opus-4-7",
    "max_tokens": 50,
    "tools": [{"type":"code_execution_20250825","name":"code_execution"}],
    "messages": [{"role":"user","content":"hi"}]
  }'
  assert_status 400 \
    && assert_body_contains "code_execution_20250825"
}

probe_tooltype_web_search_20250305() {
  do_request POST /v1/messages '{
    "model": "claude-opus-4-7",
    "max_tokens": 50,
    "tools": [{"type":"web_search_20250305","name":"web_search"}],
    "messages": [{"role":"user","content":"hi"}]
  }'
  assert_status 200
}

probe_tooltype_web_fetch_hosted_rejected() {
  # Proxy fail-fast 400 (generated proxy-side, independent of Copilot). The
  # hosted web_fetch tool is matched on its `type` slug.
  do_request POST /v1/messages '{
    "model": "claude-opus-4-7",
    "max_tokens": 50,
    "tools": [{"type":"web_fetch_20260209"}],
    "messages": [{"role":"user","content":"fetch https://example.com"}]
  }'
  assert_status 400
}

probe_tooltype_web_fetch_custom_name_allowed() {
  # Regression guard: a CLIENT-SIDE custom tool that merely shares the name
  # "web_fetch" (type:custom) must NOT be caught by the hosted-tool gate —
  # Copilot's allowlist accepts `custom`, so the end user sees 200.
  do_request POST /v1/messages '{
    "model": "claude-opus-4-7",
    "max_tokens": 50,
    "tools": [{"type":"custom","name":"web_fetch","input_schema":{"type":"object"}}],
    "messages": [{"role":"user","content":"hi"}]
  }'
  assert_status 200
}

# End-to-end via proxy: Anthropic-shape web_search tool on /v1/messages.
# Asserts the user-facing 200 the proxy delivers (it intercepts in
# processWebSearch, fulfils via Copilot's /mcp web_search server-side, and
# strips the tool before forwarding the body to upstream Copilot — which
# would 400 'use of the web search tool is not supported' without the strip).
# A real-world trigger query ('current price of bitcoin') is used so the proxy
# actually exercises the MCP fulfilment path.
probe_web_search_anthropic_tool_messages() {
  do_request POST /v1/messages '{
    "model": "claude-opus-4-7",
    "max_tokens": 256,
    "tools": [{"type":"web_search_20250305","name":"web_search"}],
    "messages": [{"role":"user","content":"What is the current price of Bitcoin?"}]
  }'
  assert_status 200
}

# Native Copilot path: /v1/responses fulfils web_search_preview natively for
# GPT-5.x. Output stream contains a web_search_call block (action.queries[])
# followed by the model's message. No proxy intervention needed.
probe_web_search_responses_preview() {
  do_request POST /v1/responses '{
    "model": "gpt-5.5",
    "input": "What is the current price of Bitcoin?",
    "tools": [{"type":"web_search_preview"}],
    "max_output_tokens": 256
  }'
  assert_status 200 \
    && assert_body_contains "web_search_call"
}

# End-to-end via proxy: OpenAI-shape web_search tool on /chat/completions.
# Asserts the 200 the proxy delivers. The proxy's injectWebSearchIfNeeded
# (chat-completions/handler.ts) intercepts {type:"web_search"} OR
# function-shaped tools named "web_search", fulfils via Copilot's /mcp
# server-side, and strips before forwarding to upstream — which would 400
# with 'tools[0].function.name' empty-string error on the raw shape.
# Uses gpt-4.1 (chat/completions-capable). gpt-5.5 is /responses-only.
probe_web_search_chat_completions() {
  do_request POST /v1/chat/completions '{
    "model": "gpt-4.1",
    "messages": [{"role":"user","content":"What is the current price of Bitcoin?"}],
    "tools": [{"type":"web_search"}],
    "max_tokens": 256
  }'
  assert_status 200
}

probe_compact_20260112() {
  # `compact_20260112` is gated upstream by the `anthropic-beta:
  # compact-2026-01-12` header. The probe sends the header, but the
  # default `bun run start` proxy runs in **stealth** mode (only 3
  # VSCode beta prefixes forwarded; `compact-*` is stripped) — so by
  # the time the request reaches Copilot the beta is gone and the
  # upstream allowlist falls back to `{clear_thinking_20251015,
  # clear_tool_uses_20250919}`, rejecting `compact_20260112` with 400.
  #
  # Asserting 400 captures the stealth-default user-facing reality.
  # The leverage-mode (extended-betas, `github-router claude`'s
  # default) path that DOES return 200 is intentionally not asserted
  # here — that'd need a separate proxy launch flag. See
  # docs/copilot-compat-matrix.md "Anthropic-beta header prefixes" +
  # the `compact-` row for the leverage-mode expectation.
  do_request POST /v1/messages '{
    "model": "claude-opus-4-7",
    "max_tokens": 50,
    "context_management": {"edits": [{"type":"compact_20260112"}]},
    "messages": [{"role":"user","content":"hi"}]
  }' "anthropic-beta: compact-2026-01-12"
  assert_status 400 \
    && assert_body_contains "compact_20260112"
}

probe_clear_tool_uses_20250919() {
  do_request POST /v1/messages '{
    "model": "claude-opus-4-7",
    "max_tokens": 50,
    "context_management": {"edits": [{"type":"clear_tool_uses_20250919"}]},
    "messages": [{"role":"user","content":"hi"}]
  }' "anthropic-beta: context-management-2025-06-27"
  assert_status 200
}

probe_stream_with_tools() {
  do_stream_request POST /v1/messages '{
    "model": "claude-haiku-4-5",
    "max_tokens": 50,
    "stream": true,
    "tools": [{"name":"echo","description":"t","input_schema":{"type":"object"}}],
    "messages": [{"role":"user","content":"call echo"}]
  }'
  assert_status 200 \
    && assert_body_contains "event: message_start" \
    && assert_body_contains "event: content_block_start"
}

# ===========================================================================
# Peer-MCP persona probes (Phase B6)
# ===========================================================================

# Helper: extract a persona's allowedEfforts line from peer-mcp-personas.ts.
# Args:
#   $1 = persona agentName (e.g. "opus-critic")
# Stdout: the matching `allowedEfforts: [...]` line, or empty on miss.
extract_persona_allowed_efforts() {
  local persona_name="$1"
  local file="${PROJECT_ROOT}/src/lib/peer-mcp-personas.ts"
  if [ ! -f "$file" ]; then
    echo ""
    return
  fi
  # awk: from the agentName line, scan up to 30 lines forward for the
  # allowedEfforts line. Bounded window keeps the match local to the
  # persona's own block (each persona block is < 20 lines in practice).
  awk -v target="agentName: \"${persona_name}\"" '
    $0 ~ target { found=NR }
    found && NR > found && NR <= found + 30 && /allowedEfforts:/ { print; exit }
  ' "$file"
}

# Helper: assert a static-check result with a clear failure message.
# Args:
#   $1 = persona agentName
#   $2 = forbidden tier (e.g. '"high"' or '"xhigh"')
#   $3 = brief reason (shown in failure output)
assert_persona_excludes_tier() {
  local persona="$1" forbidden="$2" reason="$3"
  local line
  line="$(extract_persona_allowed_efforts "$persona")"
  if [ -z "$line" ]; then
    echo "  ${C_RED}FAIL${C_RESET}: persona '${persona}' allowedEfforts not found in src/lib/peer-mcp-personas.ts"
    return 1
  fi
  # Match the forbidden tier as a quoted JSON-like array entry. The
  # surrounding quotes ensure '"high"' does NOT match the substring of
  # '"xhigh"' (and vice versa).
  if echo "$line" | grep -q -- "${forbidden}"; then
    echo "  ${C_RED}FAIL${C_RESET}: persona '${persona}' allowedEfforts unexpectedly includes ${forbidden} (${reason})"
    echo "  ${C_DIM}line: ${line}${C_RESET}"
    return 1
  fi
  return 0
}

# Sibling of assert_persona_excludes_tier — asserts a persona's
# allowedEfforts spec INCLUDES a given tier.
#   $1 = persona agent name
#   $2 = required tier (e.g. '"high"' or '"xhigh"')
#   $3 = brief reason (shown in failure output)
assert_persona_includes_tier() {
  local persona="$1" required="$2" reason="$3"
  local line
  line="$(extract_persona_allowed_efforts "$persona")"
  if [ -z "$line" ]; then
    echo "  ${C_RED}FAIL${C_RESET}: persona '${persona}' allowedEfforts not found in src/lib/peer-mcp-personas.ts"
    return 1
  fi
  if ! echo "$line" | grep -q -- "${required}"; then
    echo "  ${C_RED}FAIL${C_RESET}: persona '${persona}' allowedEfforts missing ${required} (${reason})"
    echo "  ${C_DIM}line: ${line}${C_RESET}"
    return 1
  fi
  return 0
}

probe_opus_critic_low() {
  # End-to-end live probe. Mirrors the Anthropic body shape that the
  # /mcp /v1/messages branch builds for opus_critic at effort=low:
  # budget_tokens=1024 → max_tokens=budget+1500=2524.
  do_request POST /v1/messages '{
    "model": "claude-opus-4-7",
    "max_tokens": 2524,
    "system": "You are opus-critic.",
    "thinking": {"type": "enabled", "budget_tokens": 1024},
    "messages": [{"role": "user", "content": "Reply with the literal string \"no material objection\" if you have none."}]
  }'
  assert_status 200
}

probe_opus_critic_medium() {
  # End-to-end live probe. effort=medium → budget_tokens=3000,
  # max_tokens=4500. Same shape as opus_critic_low.
  do_request POST /v1/messages '{
    "model": "claude-opus-4-7",
    "max_tokens": 4500,
    "system": "You are opus-critic.",
    "thinking": {"type": "enabled", "budget_tokens": 3000},
    "messages": [{"role": "user", "content": "Reply with the literal string \"no material objection\" if you have none."}]
  }'
  assert_status 200
}

probe_opus_critic_high_allowed() {
  # Static check: the opus-critic persona spec MUST include "high" in
  # allowedEfforts. SSE-streamed /mcp tools/call responses bypass Claude
  # Code's ~60s ceiling, so the prior low|medium-only constraint was
  # lifted in PR #28 (handler.ts:handleToolsCallSSE). Validates the
  # SOURCE OF TRUTH (peer-mcp-personas.ts).
  assert_persona_includes_tier \
    "opus-critic" '"high"' \
    "SSE bypasses the 60s ceiling so high-tier thinking budgets now fit transparently"
}

probe_opus_critic_xhigh_allowed() {
  # Same as above for xhigh — opus_critic now exposes the deepest tier
  # (default since the recent commit raising defaults).
  assert_persona_includes_tier \
    "opus-critic" '"xhigh"' \
    "SSE bypasses the 60s ceiling; xhigh is the persona's default since the defaults-to-xhigh change"
}

probe_codex_critic_xhigh_allowed() {
  # Static check: codex-critic (gpt-5.5) now allows xhigh. Empirical:
  # 56s baseline at xhigh on a tiny prompt previously busted the 60s
  # MCP ceiling — SSE-streamed responses make this irrelevant. Default
  # is now xhigh.
  assert_persona_includes_tier \
    "codex-critic" '"xhigh"' \
    "SSE bypass + MCP_TOOL_TIMEOUT=600000 lifted the prior xhigh constraint; xhigh is now the default"
}

probe_codex_reviewer_xhigh_allowed() {
  # Static check: codex-reviewer (gpt-5.3-codex) now allows xhigh. Sibling
  # model is faster but xhigh still pushes the ceiling on realistic diffs;
  # SSE handles the wall-clock transparently.
  assert_persona_includes_tier \
    "codex-reviewer" '"xhigh"' \
    "SSE bypass lifted the prior xhigh constraint; xhigh is now the default"
}

probe_gemini_critic_xhigh_rejected() {
  # Static check: gemini_critic MUST exclude "xhigh" — Copilot's gemini-3.x
  # route strict-validates `reasoning_effort` and 400s on values outside
  # `[low medium high]` (empirically verified 2026-05-14 — error message:
  # `reasoning_effort "xhigh" is not supported by model gemini-3.1-pro-preview`).
  # This is an UPSTREAM constraint (Copilot 400s), not a proxy choice.
  assert_persona_excludes_tier \
    "gemini-critic" '"xhigh"' \
    "Copilot's gemini-3.x route 400s on xhigh; persona allowlist must reflect that"
}

# ===========================================================================
# Worker-tools probes
# ===========================================================================

# End-to-end live probe: assert Copilot's /v1/chat/completions accepts the
# exact body shape the worker-agent stream-fn emits — gemini-3.5-flash with
# a tools[] array + reasoning_effort:"high". This is the load-bearing
# contract for the worker_explore / worker_implement MCP tools (see
# docs/peer-mcp-design.md "Worker tools" and docs/pi-vendor-sync.md).
#
# Failure mode this catches: Copilot tightens the gemini-3.5-flash validator
# in a way that the dual gate cannot detect. The dual gate's catalog arm
# only checks "model present + tool_calls advertised"; it does NOT exercise
# the actual request shape. If the validator starts rejecting the
# combination (or drops reasoning_effort on this model), the gate would
# leave the tools advertised but every call would 400 — this probe surfaces
# that regression upstream.
probe_worker_gemini_tools_reasoning() {
  do_request POST /v1/chat/completions '{
    "model": "gemini-3.5-flash",
    "messages": [{"role":"user","content":"reply with the literal string ok"}],
    "tools": [{"type":"function","function":{"name":"echo","description":"echo the input","parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}}],
    "tool_choice": "auto",
    "reasoning_effort": "high",
    "max_tokens": 50
  }'
  assert_status 200
}

# ===========================================================================
# Driver
# ===========================================================================

usage() {
  cat <<USAGE
Usage: $0 [options]

Options:
  --strict             Exit non-zero on any probe failure (default for CI)
  --report             Run all probes, print summary, exit 0 (default for dev)
  --list               List all registered probes (id | source | description)
  --probe <id>         Run a single probe by id
  --source <category>  Run only probes whose source matches (e.g. claude-emits)
  --help               This help

Environment:
  PROXY_URL=<url>      Default: http://127.0.0.1:54668
  AUTH_TOKEN=<token>   Default: dummy (proxy doesn't enforce auth)

Examples:
  bash $0
  bash $0 --strict
  bash $0 --probe tooltype_memory_20250818
  bash $0 --source claude-emits --strict
USAGE
}

list_probes() {
  printf "%-50s %-22s %s\n" "ID" "SOURCE" "DESCRIPTION"
  printf "%-50s %-22s %s\n" "$(printf '%.0s-' {1..50})" "$(printf '%.0s-' {1..22})" "$(printf '%.0s-' {1..40})"
  local row id src desc
  for row in "${PROBE_REGISTRY[@]}"; do
    IFS='|' read -r id src desc <<<"$row"
    printf "%-50s %-22s %s\n" "$id" "$src" "$desc"
  done
}

run_one() {
  local row id src desc
  local target_id="$1"
  for row in "${PROBE_REGISTRY[@]}"; do
    IFS='|' read -r id src desc <<<"$row"
    if [ "$id" = "$target_id" ]; then
      echo "${C_DIM}[$src]${C_RESET} $id"
      if probe_"$id"; then
        echo "  ${C_GREEN}PASS${C_RESET}"
        return 0
      else
        return 1
      fi
    fi
  done
  echo "${C_RED}probe not found:${C_RESET} $target_id" >&2
  return 1
}

run_all() {
  local source_filter="${1:-}"
  local row id src desc
  local n_pass=0 n_fail=0 n_skip=0
  local fail_ids=()
  for row in "${PROBE_REGISTRY[@]}"; do
    IFS='|' read -r id src desc <<<"$row"
    if [ -n "$source_filter" ] && [ "$src" != "$source_filter" ]; then
      n_skip=$((n_skip + 1))
      continue
    fi
    echo "${C_DIM}[$src]${C_RESET} $id"
    if probe_"$id"; then
      echo "  ${C_GREEN}PASS${C_RESET}"
      n_pass=$((n_pass + 1))
    else
      n_fail=$((n_fail + 1))
      fail_ids+=("$id")
    fi
  done
  echo
  echo "Summary: ${C_GREEN}${n_pass} passed${C_RESET} / ${C_RED}${n_fail} failed${C_RESET} / ${C_YELLOW}${n_skip} skipped${C_RESET}"
  if [ "$n_fail" -gt 0 ]; then
    echo "Failed: ${fail_ids[*]}"
    return 1
  fi
  return 0
}

# ===========================================================================
# CLI
# ===========================================================================

MODE="report"
SOURCE_FILTER=""
SINGLE_PROBE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --strict) MODE="strict" ;;
    --report) MODE="report" ;;
    --list) MODE="list" ;;
    --probe) SINGLE_PROBE="$2"; shift ;;
    --source) SOURCE_FILTER="$2"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

case "$MODE" in
  list) list_probes; exit 0 ;;
esac

if [ -n "$SINGLE_PROBE" ]; then
  if run_one "$SINGLE_PROBE"; then exit 0; else exit 1; fi
fi

if run_all "$SOURCE_FILTER"; then
  exit 0
else
  case "$MODE" in
    strict) exit 1 ;;
    *) exit 0 ;;
  esac
fi
