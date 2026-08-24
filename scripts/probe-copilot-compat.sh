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

  # ===== Prompt caching =====
  "cache_control_ephemeral_1h|claude-emits|Claude cache_control with ttl:1h returns 200"
  "cache_control_marker_limit_5|exploratory|Five Claude cache_control markers return 400 (upstream maximum is four)"
  "gpt56_explicit_cache_breakpoint|copilot-cli|GPT-5.6 Responses accepts prompt_cache_key + explicit prompt_cache_options + prompt_cache_breakpoint"
  "gpt55_cache_retention_24h|vscode-source|GPT-5.5 Responses accepts prompt_cache_retention:24h (acceptance only; long-idle effectiveness is not claimed)"

  # ===== Native Anthropic tool types =====
  "tooltype_memory_20250818|anthropic-docs|memory_20250818 returns 200; model emits tool_use{name:memory, command:view}"
  "tooltype_text_editor_20250728|anthropic-docs|text_editor_20250728 returns 200"
  "tooltype_bash_20250124|copilot-allowlist|bash_20250124 returns 200 (current bash version)"
  "tooltype_bash_20241022_legacy|copilot-allowlist|bash_20241022 (legacy version) returns 400"
  "tooltype_code_execution_20250825|copilot-allowlist|code_execution_20250825 returns 400 (not in Copilot allowlist)"
  "tooltype_web_search_20250305|anthropic-docs|web_search_20250305 returns 200 in body validator (model invocation inconclusive)"

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

  # ===== Signed thinking history integrity =====
  "signed_thinking_cache_scope_stripped|claude-emits|Real signed thinking+tool replay with cache_control.scope added to the thinking block returns 200 after the proxy strips only unsupported cache metadata"
  "thinking_history_invalid_signature_repaired|claude-emits|A persisted assistant turn rejected for an invalid thinking signature is repaired request-time and returns 200 without editing the transcript"

  # ===== Default tier models (emitted by every claude session) =====
  # claude-sonnet-5 is the ANTHROPIC_SMALL_FAST_MODEL default (and the
  # ANTHROPIC_DEFAULT_SONNET_MODEL + ANTHROPIC_DEFAULT_HAIKU_MODEL /model
  # picker tiers) — getClaudeCodeEnvVars in src/lib/server-setup.ts. Claude
  # Code emits it for status text, auto-compact summaries, session titles, and
  # other background ops on every session, so it must resolve+200 end-to-end.
  "smallfast_sonnet_baseline|claude-emits|claude-sonnet-5 (ANTHROPIC_SMALL_FAST_MODEL / DEFAULT_SONNET / DEFAULT_HAIKU default) resolves and returns 200 from /v1/messages"

  # ===== Advisor escalation to Opus (budget-lead path) =====
  # On a lighter Claude lead the advisor escalates to claude-opus-5 and dispatches
  # on /v1/messages instead of /responses (runAdvisor in src/services/advisor/advisor.ts).
  # That branch was unreachable while the advisor was always gpt-5.6-sol, so the
  # exact body it now emits — non-streaming + thinking:{type:"adaptive"} +
  # output_config.effort + the model's max_non_streaming_output_tokens — has no
  # prior production evidence behind it. These two probes are that evidence.
  "advisor_claude_adaptive_thinking|claude-emits|claude-opus-5 on /v1/messages accepts the escalated advisor body (stream:false + thinking:{type:'adaptive'} + output_config.effort) and returns 200"
  "advisor_claude_nonstreaming_cap|claude-emits|claude-opus-5 on /v1/messages accepts max_tokens at the advertised max_non_streaming_output_tokens (16000) when stream:false"
  "advisor_claude_streaming_cap_accepted|exploratory|claude-opus-5 on /v1/messages ACCEPTS max_tokens at the streaming ceiling (64000) even when stream:false — max_non_streaming_output_tokens is advertised but not enforced; the advisor stays inside it by choice, not necessity"

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
  "opus_critic_low|anthropic-docs|opus_critic at effort=low equivalent (claude-opus-4-6, thinking.budget=1024, max_tokens=2524) returns 200 from /v1/messages"
  "opus_critic_medium|anthropic-docs|opus_critic at effort=medium equivalent (claude-opus-4-6, thinking.budget=3000, max_tokens=4500) returns 200 from /v1/messages"
  "opus_critic_high_allowed|proxy-internal|peer-mcp-personas.ts: opus-critic.allowedEfforts INCLUDES 'high' (default+deepest tier on claude-opus-4-6) — static check"
  "opus_critic_xhigh_rejected|proxy-internal|peer-mcp-personas.ts: opus-critic.allowedEfforts EXCLUDES 'xhigh' (claude-opus-4-6 doesn't advertise xhigh) — static check"
  "codex_critic_xhigh_allowed|proxy-internal|peer-mcp-personas.ts: codex-critic.allowedEfforts INCLUDES 'xhigh' (post-SSE; xhigh is the default) — static check"
  "codex_reviewer_xhigh_allowed|proxy-internal|peer-mcp-personas.ts: codex-reviewer.allowedEfforts INCLUDES 'xhigh' (post-SSE; xhigh is the default) — static check"
  "gemini_critic_xhigh_rejected|proxy-internal|peer-mcp-personas.ts: gemini-critic.allowedEfforts EXCLUDES 'xhigh' (Copilot upstream-rejects) — static check"

  # ===== Worker tools (load-bearing model+shape contract) =====
  # The worker_explore / worker_review MCP tools default to gemini-3.5-flash
  # on /v1/chat/completions with stream:true + tools[] + reasoning_effort:"high";
  # worker_implement defaults to gpt-5.5 on /v1/responses with tools[] (function
  # shape) + reasoning:{effort:"xhigh"}. If Copilot ever tightens either
  # validator (rejects the field combination, or drops reasoning on the model),
  # the worker tools degrade — the dual gate's first arm catches catalog miss /
  # tool_calls=false on the gemini gate model, but only these probes catch the
  # case where the model IS present and tool-capable but the body shape is
  # rejected. See docs/peer-mcp-design.md "Worker tools".
  "worker_gemini_tools_reasoning|exploratory|gemini-3.5-flash on /v1/chat/completions accepts tools[] + reasoning_effort:'high' (load-bearing contract for worker_explore/worker_review MCP tools + the worker-tools dual gate)"
  "worker_gpt5_responses_tools_reasoning|exploratory|gpt-5.5 on /v1/responses accepts function tools[] + reasoning:{effort:'xhigh'} (retained fallback for the worker_implement MCP tool)"
  "worker_gpt56sol_responses_tools_reasoning|exploratory|gpt-5.6-sol on /v1/responses accepts function tools[] + reasoning:{effort:'xhigh'} (load-bearing contract for the worker_implement/implement DEFAULT model)"

  # ===== Non-Claude /v1/messages translation shim (src/lib/anthropic-translate/) =====
  # These probes exercise the shim END-TO-END through the proxy: an Anthropic
  # /v1/messages body NAMING a non-Claude model is diverted by catalog endpoint
  # (classifyMessagesRoute) to the Responses shim (gpt) or the chat shim (gemini),
  # translated to the matching Copilot request, and the reply is translated back
  # to the Anthropic wire shape. Each asserts a well-formed Anthropic 200. Claude
  # models are untouched (native passthrough). See docs/copilot-compat-matrix.md
  # "Anthropic-translation shim". These are the ONLY probes that catch a shim
  # regression: a body-shape or egress break here leaves the four models 400ing /
  # malformed on /v1/messages while the worker/persona paths (which hit /responses
  # or /chat/completions directly) keep working.
  "shim_gpt55_messages|exploratory|gpt-5.5 on /v1/messages (→ /responses shim): 200 + well-formed Anthropic message (content array)"
  "shim_gpt53codex_messages|exploratory|gpt-5.3-codex on /v1/messages (→ /responses shim): 200 + well-formed Anthropic message (400k context)"
  "shim_gemini35flash_messages|exploratory|gemini-3.5-flash on /v1/messages (→ /chat/completions shim): 200 + well-formed Anthropic message"
  "shim_gemini31pro_messages|exploratory|gemini-3.1-pro-preview on /v1/messages (→ /chat/completions shim): 200 + well-formed Anthropic message"
  "shim_gpt55_messages_streaming|exploratory|gpt-5.5 on /v1/messages with stream:true: 200 + synthesized Anthropic SSE (event: message_start … message_stop)"
  "shim_gpt55_messages_tool_use|exploratory|gpt-5.5 on /v1/messages with forced tool_choice: 200 + tool_use block with non-empty input"
  "shim_gemini35flash_messages_streaming|exploratory|gemini-3.5-flash on /v1/messages with stream:true (→ /chat/completions shim): 200 + synthesized Anthropic SSE (event: message_start … message_stop) — chat-shim symmetric to shim_gpt55_messages_streaming"
  "shim_gemini35flash_messages_tool_use|exploratory|gemini-3.5-flash on /v1/messages with a weather tool + triggering prompt (tool_choice:auto, → /chat/completions shim): 200 + tool_use block with non-empty input — chat-shim symmetric to shim_gpt55_messages_tool_use"
  # ACCEPTANCE probes: these assert only that the field does NOT cause a 400
  # end-to-end (Copilot accepts it). They do NOT prove the shim forwarded the
  # field — a silent drop would still 200. Forwarding correctness (payload.stop /
  # payload.parallel_tool_calls actually set on the outbound Copilot body) is
  # covered by the unit tests in tests/anthropic-translate-request.test.ts (gpt /
  # Responses shim) and tests/anthropic-translate-gemini-request.test.ts (gemini /
  # chat shim). The coverage split is intentional and documented in the matrix.
  "shim_stop_responses|exploratory|stop_sequences on /v1/messages → gpt-5.5 /responses shim: 200 ACCEPTANCE ('stop' does not 400 end-to-end; accepted-but-ignored on /responses/gpt). Forwarding of payload.stop is unit-tested in tests/anthropic-translate-request.test.ts"
  "shim_stop_chat|exploratory|stop_sequences on /v1/messages → gemini-3.5-flash /chat/completions shim: 200 ACCEPTANCE ('stop' does not 400 end-to-end; honoring is best-effort and NOT asserted by this probe). Forwarding of payload.stop is unit-tested in tests/anthropic-translate-gemini-request.test.ts"
  "shim_parallel_tool_calls_responses|exploratory|tool_choice.disable_parallel_tool_use:true on /v1/messages → gpt-5.5 /responses shim: 200 ACCEPTANCE (parallel_tool_calls:false does not 400 end-to-end). Forwarding is unit-tested in tests/anthropic-translate-request.test.ts"
  "shim_document_pdf_gpt55|exploratory|base64 PDF document block on /v1/messages → gpt-5.5 /responses shim: 200 + well-formed Anthropic message that references PDF sentinel text"
  "shim_document_pdf_degrade_gemini35flash|exploratory|base64 PDF document block on /v1/messages → gemini-3.5-flash /chat shim: 200 graceful text-note degrade (no 400) + well-formed Anthropic message"
  "shim_max_tokens_clamp_gpt55|exploratory|max_tokens:1 on /v1/messages → gpt-5.5 /responses shim: 200 + well-formed Anthropic message (proves min-output clamp)"
  "shim_image_gpt55|exploratory|base64 RGB PNG image block on /v1/messages → gpt-5.5 /responses shim: 200 + well-formed Anthropic message"
  "shim_image_gemini35flash|exploratory|base64 RGB PNG image block on /v1/messages → gemini-3.5-flash /chat shim: 200 + well-formed Anthropic message"
  "passthrough_image_claude|exploratory|base64 RGB PNG image block on /v1/messages → claude-opus-5 NATIVE passthrough (no copilot-vision-request header): 200 + well-formed Anthropic message"
  "shim_image_tool_result_gpt55|exploratory|image inside a tool_result on /v1/messages → gpt-5.5 /responses shim: 200 (the shape a subagent reading a screenshot actually produces)"
  "shim_image_tool_result_gemini35flash|exploratory|image inside a tool_result on /v1/messages → gemini-3.5-flash /chat shim: 200 (same shape, chat egress)"
  "vision_multi_image_gpt|exploratory|2 images to a max_prompt_images:1 gpt model → 200; the catalog field understates the real ceiling (gpt-5.5 accepted 120) and must not gate locally"
  "vision_ceiling_recovery_gemini|exploratory|12 images to gemini (real upstream ceiling 10) → 200; the proxy prunes to the number upstream names and retries once"
  "shim_advisor_degrade_gpt55|exploratory|advisor beta header + advisor tool on /v1/messages → gpt-5.5 /responses shim: 200 graceful degrade (advisor tool stripped, no 400)"
  "shim_advisor_degrade_gemini35flash|exploratory|advisor beta header + advisor tool on /v1/messages → gemini-3.5-flash /chat shim: 200 graceful degrade (advisor tool stripped, no 400)"
  "shim_count_tokens_gpt53codex|exploratory|/v1/messages/count_tokens with gpt-5.3-codex model id: 200 + input_tokens count"
  "shim_thinking_effort_gpt55|exploratory|thinking.budget_tokens on /v1/messages → gpt-5.5 /responses shim: 200 + well-formed Anthropic message"
  "shim_parallel_tool_emit_gpt55|exploratory|prompt asks gpt-5.5 /responses shim for two tool calls: 200 + tool_use block(s); asserts >=1 because parallel emission is model-nondeterministic"
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

probe_cache_control_ephemeral_1h() {
  local stable body
  stable="$(printf 'stable %.0s' {1..800})"
  body="$(jq -nc --arg stable "$stable" '{
    model:"claude-sonnet-5",
    max_tokens:16,
    system:[{
      type:"text",
      text:$stable,
      cache_control:{type:"ephemeral",ttl:"1h"}
    }],
    tools:[{
      name:"echo",
      description:"Echo a value.",
      input_schema:{type:"object",properties:{value:{type:"string"}}},
      cache_control:{type:"ephemeral",ttl:"1h"}
    }],
    messages:[{role:"user",content:"Reply OK without calling a tool."}]
  }')"
  do_request POST /v1/messages "$body"
  assert_status 200
}

probe_cache_control_marker_limit_5() {
  local body
  body="$(jq -nc '{
    model:"claude-sonnet-5",
    max_tokens:16,
    system:[
      range(0;5) as $i
      | {type:"text",text:("marker-\($i) " + ("stable " * 300)),cache_control:{type:"ephemeral"}}
    ],
    messages:[{role:"user",content:"Reply OK."}]
  }')"
  do_request POST /v1/messages "$body"
  assert_status 400 \
    && assert_body_contains "maximum of 4"
}

probe_gpt56_explicit_cache_breakpoint() {
  local stable body
  stable="$(printf 'stable %.0s' {1..800})"
  body="$(jq -nc --arg stable "$stable" '{
    model:"gpt-5.6-sol",
    stream:false,
    max_output_tokens:16,
    prompt_cache_key:"github-router-probe-explicit-v1",
    prompt_cache_options:{mode:"explicit",ttl:"30m"},
    input:[
      {role:"system",content:[{
        type:"input_text",
        text:$stable,
        prompt_cache_breakpoint:{mode:"explicit"}
      }]},
      {role:"user",content:"Reply OK."}
    ]
  }')"
  do_request POST /v1/responses "$body"
  assert_status 200
}

probe_gpt55_cache_retention_24h() {
  do_request POST /v1/responses '{
    "model":"gpt-5.5",
    "stream":false,
    "max_output_tokens":16,
    "prompt_cache_retention":"24h",
    "input":[{"role":"user","content":"Reply OK."}]
  }'
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
  # UPSTREAM DRIFT, 2026-08-03: this asserted 400 (not in Copilot's tool-type
  # allowlist) since the matrix was written. Copilot now ACCEPTS the type —
  # verified with three consecutive runs returning 200 and a normal assistant
  # message. Flipping the expectation is the point of a symmetric probe suite:
  # a quietly-added upstream capability is exactly as interesting as a quietly
  # removed one, and this is how we learn about it rather than guessing.
  #
  # NOTE: acceptance is not execution. The 200 proves the request validator no
  # longer rejects the tool type; whether Copilot actually runs code for it is
  # unverified and deliberately not asserted here.
  do_request POST /v1/messages '{
    "model": "claude-opus-4-7",
    "max_tokens": 50,
    "tools": [{"type":"code_execution_20250825","name":"code_execution"}],
    "messages": [{"role":"user","content":"hi"}]
  }'
  assert_status 200 \
    && assert_anthropic_message
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
  # budget_tokens=1024 → max_tokens=budget+1500=2524. opus_critic now
  # runs on claude-opus-4-6 (resolves to claude-opus-4.6-1m when present).
  do_request POST /v1/messages '{
    "model": "claude-opus-4-6",
    "max_tokens": 2524,
    "system": "You are opus-critic.",
    "thinking": {"type": "enabled", "budget_tokens": 1024},
    "messages": [{"role": "user", "content": "Reply with the literal string \"no material objection\" if you have none."}]
  }'
  assert_status 200
}

probe_opus_critic_medium() {
  # End-to-end live probe. effort=medium → budget_tokens=3000,
  # max_tokens=4500. Same shape as opus_critic_low (claude-opus-4-6).
  do_request POST /v1/messages '{
    "model": "claude-opus-4-6",
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
  # lifted in PR #28 (handler.ts:handleToolsCallSSE). "high" is now the
  # persona's DEFAULT effort (claude-opus-4-6 doesn't advertise xhigh, so
  # high is the deepest tier it offers). Validates the SOURCE OF TRUTH
  # (peer-mcp-personas.ts).
  assert_persona_includes_tier \
    "opus-critic" '"high"' \
    "high is opus-critic's default+deepest tier on claude-opus-4-6 (no xhigh advertised)"
}

probe_opus_critic_xhigh_rejected() {
  # Static check: opus-critic moved to claude-opus-4-6, whose catalog entry
  # advertises reasoning_effort ["low","medium","high","max"] — NO xhigh.
  # The persona spec MUST exclude "xhigh" from allowedEfforts so a
  # caller-supplied xhigh rejects with -32602 at the /mcp boundary rather
  # than bouncing off Copilot at request time. Validates the SOURCE OF
  # TRUTH (peer-mcp-personas.ts). Mirrors gemini_critic_xhigh_rejected.
  assert_persona_excludes_tier \
    "opus-critic" '"xhigh"' \
    "claude-opus-4-6 does not advertise xhigh; the persona must not offer it"
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

probe_smallfast_sonnet_baseline() {
  # End-to-end live probe. claude-sonnet-5 is the ANTHROPIC_SMALL_FAST_MODEL
  # (and ANTHROPIC_DEFAULT_SONNET_MODEL / ANTHROPIC_DEFAULT_HAIKU_MODEL) default
  # injected by getClaudeCodeEnvVars — emitted on every claude session for
  # background ops + the /model picker cheap/sonnet tiers. resolveModel
  # exact-matches it to Copilot's claude-sonnet-5 (no dotted variant); Copilot
  # must 200.
  do_request POST /v1/messages '{
    "model": "claude-sonnet-5",
    "max_tokens": 16,
    "messages": [{"role": "user", "content": "Reply with the single word: ok"}]
  }'
  assert_status 200
}

# ===========================================================================
# Advisor escalation probes (budget-lead path)
# ===========================================================================

# End-to-end live probes for the body `runAdvisor` emits on its Anthropic
# branch. Referenced from the code comment in src/services/advisor/advisor.ts so
# a contributor following the breadcrumb lands on the empirical evidence.
#
# Why these exist: the /v1/messages advisor branch was dead code for as long as
# ADVISOR_DEFAULT_MODEL was gpt-5.6-sol (which always matches the /responses
# regex). A budget lead makes it live, so every field in that body is newly
# exercised against Copilot and none of it had prior production evidence.

probe_advisor_claude_adaptive_thinking() {
  # The escalated advisor body: non-streaming, with the adaptive-thinking shape
  # translateThinking produces for any model advertising adaptive_thinking.
  # If Copilot ever rejects this combination the advisor silently loses its
  # reasoning effort on exactly the path the escalation exists to serve.
  do_request POST /v1/messages '{
    "model": "claude-opus-5",
    "max_tokens": 1024,
    "stream": false,
    "system": "You are an expert advisor.",
    "messages": [{"role": "user", "content": "Reply with the single word: ok"}],
    "thinking": {"type": "adaptive"},
    "output_config": {"effort": "high"}
  }'
  assert_status 200
}

probe_advisor_claude_nonstreaming_cap() {
  # claude-opus-5 advertises max_output_tokens 64000 but
  # max_non_streaming_output_tokens 16000. The advisor sets stream:false, so it
  # sizes max_tokens from the NON-streaming limit. Asserts that limit is really
  # accepted.
  do_request POST /v1/messages '{
    "model": "claude-opus-5",
    "max_tokens": 16000,
    "stream": false,
    "messages": [{"role": "user", "content": "Reply with the single word: ok"}]
  }'
  assert_status 200
}

probe_advisor_claude_streaming_cap_accepted() {
  # MEASURED, not assumed: Copilot does NOT enforce
  # max_non_streaming_output_tokens. It returns 200 for max_tokens at the
  # streaming ceiling (64000) even with stream:false.
  #
  # The advisor still sizes its cap from the non-streaming limit. That is a
  # deliberate choice to stay inside the advertised contract rather than to rely
  # on upstream leniency, NOT a workaround for a rejection — an earlier version
  # of this probe asserted a 400 here and was wrong. If this row ever flips to
  # 400, Copilot started enforcing the advertised limit and the advisor's
  # conservative sizing is what will have kept it working.
  do_request POST /v1/messages '{
    "model": "claude-opus-5",
    "max_tokens": 64000,
    "stream": false,
    "messages": [{"role": "user", "content": "Reply with the single word: ok"}]
  }'
  assert_status 200
}

# ===========================================================================
# Worker-tools probes
# ===========================================================================

# End-to-end live probe: assert Copilot's /v1/chat/completions accepts the
# exact body shape the worker-agent stream-fn emits for explore/review —
# gemini-3.5-flash with a tools[] array + reasoning_effort:"high". This is the
# load-bearing contract for the worker_explore / worker_review MCP tools AND
# the worker-tools dual gate (gemini-3.5-flash is the gate model — see
# docs/peer-mcp-design.md "Worker tools" and docs/pi-vendor-sync.md).
#
# Failure mode this catches: Copilot tightens the gemini-3.5-flash validator in
# a way that the dual gate cannot detect. The dual gate's catalog arm only
# checks "model present + tool_calls advertised"; it does NOT exercise the
# actual request shape. If the validator starts rejecting the combination (or
# drops reasoning_effort on this model), the gate would leave the tools
# advertised but every explore/review call would 400 — this probe surfaces
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

# End-to-end live probe: assert Copilot's /v1/responses accepts the exact body
# shape the worker-agent stream-fn emits for implement — gpt-5.5 with a
# function-shaped tools[] array (flat {type:"function",name,description,
# parameters}, NOT chat's nested {function:{...}}) + reasoning:{effort:"xhigh"}.
# gpt-5.5 is now the RETAINED FALLBACK for the worker_implement MCP tool (the
# default moved to gpt-5.6-sol — see probe_worker_gpt56sol_responses_tools_reasoning).
# gpt-5.5 is NOT a dual-gate input (only the gemini gate model is), so if this
# shape regresses, implement's fallback breaks while explore/review keep working
# — only this probe surfaces it.
probe_worker_gpt5_responses_tools_reasoning() {
  do_request POST /v1/responses '{
    "model": "gpt-5.5",
    "input": "reply with the literal string ok",
    "tools": [{"type":"function","name":"echo","description":"echo the input","parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}],
    "tool_choice": "auto",
    "reasoning": {"effort":"xhigh"},
    "max_output_tokens": 50
  }'
  assert_status 200
}

# End-to-end live probe: the SAME load-bearing worker-implement contract shape,
# but against gpt-5.6-sol — the CURRENT default model for the implement/test
# worker tools + the native implementer subagent + advisor + codex_critic. Same
# flat function tools[] + reasoning:{effort:"xhigh"} on /v1/responses. If this
# regresses, the default implement path breaks (the gpt-5.5 fallback still
# works). gpt-5.6-sol is 1050k context, /responses-only, same restriction tier.
probe_worker_gpt56sol_responses_tools_reasoning() {
  do_request POST /v1/responses '{
    "model": "gpt-5.6-sol",
    "input": "reply with the literal string ok",
    "tools": [{"type":"function","name":"echo","description":"echo the input","parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}],
    "tool_choice": "auto",
    "reasoning": {"effort":"xhigh"},
    "max_output_tokens": 50
  }'
  assert_status 200
}

# ===========================================================================
# Non-Claude /v1/messages translation-shim probes
# ===========================================================================

# Assert the response body is a well-formed non-streaming Anthropic Messages
# object: type:"message", role:"assistant", and a content array. The shim's
# egress (responses-egress.ts / chat-egress.ts) builds exactly this shape from
# the Copilot /responses or /chat/completions reply. Uses grep -F so the '['
# in the "content":[ needle is matched literally (plain grep would treat it as
# a BRE bracket expression).
assert_anthropic_message() {
  local needle
  for needle in '"type":"message"' '"role":"assistant"' '"content":['; do
    if ! grep -qF -- "$needle" "$LAST_BODY_FILE"; then
      echo "  ${C_RED}FAIL${C_RESET}: response is not a well-formed Anthropic message (missing ${needle})"
      echo "  ${C_DIM}body: $(head -c 300 "$LAST_BODY_FILE")${C_RESET}"
      return 1
    fi
  done
  return 0
}

body_occurrence_count() {
  local needle="$1"
  awk -v needle="$needle" '
    {
      line = $0
      while ((pos = index(line, needle)) > 0) {
        count++
        line = substr(line, pos + length(needle))
      }
    }
    END { print count + 0 }
  ' "$LAST_BODY_FILE"
}

assert_tool_use_count_at_least() {
  local minimum="$1"
  local count
  count="$(body_occurrence_count '"type":"tool_use"')"
  if [ "$count" -lt "$minimum" ]; then
    echo "  ${C_RED}FAIL${C_RESET}: expected at least ${minimum} tool_use block(s), got ${count}"
    echo "  ${C_DIM}body: $(head -c 300 "$LAST_BODY_FILE")${C_RESET}"
    return 1
  fi
  return 0
}

probe_shim_gpt55_messages() {
  # gpt-5.5 is a /responses-only model; naming it on /v1/messages diverts to the
  # Responses shim (handleNonClaudeResponses), which translates to a /responses
  # request and the reply back to an Anthropic Messages object.
  do_request POST /v1/messages '{
    "model": "gpt-5.5",
    "max_tokens": 128,
    "messages": [{"role":"user","content":"Reply with the single word: ok"}]
  }'
  assert_status 200 \
    && assert_anthropic_message
}

probe_shim_gpt53codex_messages() {
  # gpt-5.3-codex: same /responses shim path as gpt-5.5 (400k context, not 1M).
  do_request POST /v1/messages '{
    "model": "gpt-5.3-codex",
    "max_tokens": 128,
    "messages": [{"role":"user","content":"Reply with the single word: ok"}]
  }'
  assert_status 200 \
    && assert_anthropic_message
}

probe_shim_gemini35flash_messages() {
  # gemini-3.5-flash is a /chat/completions model; naming it on /v1/messages
  # diverts to the chat shim (handleNonClaudeChat).
  do_request POST /v1/messages '{
    "model": "gemini-3.5-flash",
    "max_tokens": 128,
    "messages": [{"role":"user","content":"Reply with the single word: ok"}]
  }'
  assert_status 200 \
    && assert_anthropic_message
}

probe_shim_gemini31pro_messages() {
  # gemini-3.1-pro-preview: same /chat/completions shim path as gemini-3.5-flash.
  do_request POST /v1/messages '{
    "model": "gemini-3.1-pro-preview",
    "max_tokens": 128,
    "messages": [{"role":"user","content":"Reply with the single word: ok"}]
  }'
  assert_status 200 \
    && assert_anthropic_message
}

probe_shim_gpt55_messages_streaming() {
  # Streaming through the Responses shim: the shim synthesizes an Anthropic SSE
  # sequence (anthropic-sse.ts serializeAnthropicEvent → `event: <type>`), so the
  # wire must open with message_start and terminate with message_stop.
  do_stream_request POST /v1/messages '{
    "model": "gpt-5.5",
    "max_tokens": 128,
    "stream": true,
    "messages": [{"role":"user","content":"Reply with the single word: ok"}]
  }'
  assert_status 200 \
    && assert_body_contains "event: message_start" \
    && assert_body_contains "event: message_stop"
}

probe_shim_gpt55_messages_tool_use() {
  # Forced tool call through the Responses shim. Anthropic tool_choice
  # {type:"tool",name} is translated to Responses tool_choice
  # {type:"function",name} (anthropic-request.ts parseToolChoice), so the model
  # MUST emit the tool. The egress renders it as an Anthropic tool_use block; the
  # required schema field ("city") appearing in the input proves the args are
  # non-empty. Larger max_tokens gives headroom for any hidden reasoning before
  # the function call.
  do_request POST /v1/messages '{
    "model": "gpt-5.5",
    "max_tokens": 512,
    "tools": [{"name":"get_weather","description":"Get the current weather for a city","input_schema":{"type":"object","properties":{"city":{"type":"string","description":"City name"}},"required":["city"]}}],
    "tool_choice": {"type":"tool","name":"get_weather"},
    "messages": [{"role":"user","content":"What is the weather in Paris?"}]
  }'
  assert_status 200 \
    && assert_body_contains '"type":"tool_use"' \
    && assert_body_contains '"name":"get_weather"' \
    && assert_body_contains '"city"'
}

probe_shim_gemini35flash_messages_streaming() {
  # Chat-shim symmetric to shim_gpt55_messages_streaming. gemini-3.5-flash is a
  # /chat/completions model, so stream:true on /v1/messages drives the chat shim
  # (handleNonClaudeChat), which synthesizes the same Anthropic SSE sequence
  # (anthropic-sse.ts serializeAnthropicEvent → `event: <type>`) as the Responses
  # shim — so the wire must open with message_start and terminate with
  # message_stop. Generous max_tokens (512): gemini-3.5-flash can spend a tiny
  # budget entirely on internal reasoning and emit no content, but the SSE frame
  # envelope (start/stop) is emitted regardless; 512 keeps the run realistic.
  do_stream_request POST /v1/messages '{
    "model": "gemini-3.5-flash",
    "max_tokens": 512,
    "stream": true,
    "messages": [{"role":"user","content":"Reply with the single word: ok"}]
  }'
  assert_status 200 \
    && assert_body_contains "event: message_start" \
    && assert_body_contains "event: message_stop"
}

probe_shim_gemini35flash_messages_tool_use() {
  # Chat-shim symmetric to shim_gpt55_messages_tool_use. A weather tool + a prompt
  # that can only be answered by calling it triggers the tool via tool_choice:auto
  # (NOT forced — gemini-3.5-flash early-stops on forced tool-calls; autonomous
  # auto-mode is the pattern the workers use and that the matrix documents as
  # working). The chat egress (chat-egress.ts) renders the model's tool call as an
  # Anthropic tool_use block; the required schema field ("city") appearing in the
  # input AND its value ("Paris") prove the args are non-empty. Generous max_tokens
  # (512) gives headroom for hidden reasoning before the call so the model actually
  # produces the toolcall.
  do_request POST /v1/messages '{
    "model": "gemini-3.5-flash",
    "max_tokens": 512,
    "tools": [{"name":"get_weather","description":"Get the current weather for a city","input_schema":{"type":"object","properties":{"city":{"type":"string","description":"City name"}},"required":["city"]}}],
    "tool_choice": {"type":"auto"},
    "messages": [{"role":"user","content":"What is the weather in Paris? Use the get_weather tool."}]
  }'
  assert_status 200 \
    && assert_body_contains '"type":"tool_use"' \
    && assert_body_contains '"name":"get_weather"' \
    && assert_body_contains '"city"' \
    && assert_body_contains "Paris"
}

probe_shim_stop_responses() {
  # Anthropic stop_sequences → the Responses shim forwards them as `stop`
  # (anthropic-request.ts). Copilot's /responses ACCEPTS `stop` (HTTP 200) but
  # ignores it on gpt models (best-effort, accepted-but-ignored).
  #
  # SCOPE: this e2e probe asserts ACCEPTANCE only — that `stop` does not cause a
  # 400 end-to-end. It does NOT prove the shim actually forwarded the field (a
  # silent drop would still 200). Forwarding correctness (payload.stop set on the
  # outbound /responses body) is covered by tests/anthropic-translate-request.test.ts.
  do_request POST /v1/messages '{
    "model": "gpt-5.5",
    "max_tokens": 64,
    "stop_sequences": ["\n\nHuman:"],
    "messages": [{"role":"user","content":"Reply with the single word: ok"}]
  }'
  assert_status 200 \
    && assert_anthropic_message
}

probe_shim_stop_chat() {
  # Anthropic stop_sequences → the chat shim forwards `stop` to /chat/completions
  # (anthropic-translate-gemini-request). Copilot's /chat/completions ACCEPTS
  # `stop` (HTTP 200, no 400).
  #
  # SCOPE: this e2e probe asserts ACCEPTANCE only — that `stop` does not cause a
  # 400 end-to-end. Whether Copilot HONORS the stop sequence (truncates output)
  # is NOT asserted here (honoring is best-effort and was not conclusively
  # live-verified on /chat). And, like shim_stop_responses, the 200 does not by
  # itself prove the shim forwarded the field — forwarding correctness
  # (payload.stop set on the outbound /chat/completions body) is covered by
  # tests/anthropic-translate-gemini-request.test.ts.
  do_request POST /v1/messages '{
    "model": "gemini-3.5-flash",
    "max_tokens": 64,
    "stop_sequences": ["\n\nHuman:"],
    "messages": [{"role":"user","content":"Reply with the single word: ok"}]
  }'
  assert_status 200 \
    && assert_anthropic_message
}

probe_shim_parallel_tool_calls_responses() {
  # Anthropic tool_choice.disable_parallel_tool_use:true → the Responses shim
  # emits parallel_tool_calls:false (anthropic-request.ts
  # parseDisableParallelToolUse; it only ever emits false, never true). Copilot's
  # /responses ACCEPTS the field (HTTP 200).
  #
  # SCOPE: this e2e probe asserts ACCEPTANCE only — that parallel_tool_calls:false
  # does not cause a 400 end-to-end. It does NOT prove the shim forwarded the field
  # (a silent drop would still 200). Forwarding correctness (parallel_tool_calls
  # set on the outbound /responses body) is covered by
  # tests/anthropic-translate-request.test.ts.
  do_request POST /v1/messages '{
    "model": "gpt-5.5",
    "max_tokens": 128,
    "tools": [{"name":"get_weather","description":"Get the current weather for a city","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}],
    "tool_choice": {"type":"auto","disable_parallel_tool_use":true},
    "messages": [{"role":"user","content":"Reply with the single word: ok"}]
  }'
  assert_status 200 \
    && assert_anthropic_message
}

probe_shim_document_pdf_gpt55() {
  # Responses shim document path: Anthropic base64 PDF → neutral document →
  # Responses input_file.file_data. The tiny PDF contains selectable text
  # "ShimPDFProbeZebra42"; the response must reference it, proving the model
  # can read the document rather than merely accepting the body shape.
  do_request POST /v1/messages '{
    "model": "gpt-5.5",
    "max_tokens": 128,
    "messages": [{"role":"user","content":[
      {"type":"document","title":"shim-probe.pdf","source":{"type":"base64","media_type":"application/pdf","data":"JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMTQ0XSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNTAgPj4Kc3RyZWFtCkJUIC9GMSAxOCBUZiAzNiA5NiBUZCAoU2hpbVBERlByb2JlWmVicmE0MikgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA2NCAwMDAwMCBuIAowMDAwMDAwMTIxIDAwMDAwIG4gCjAwMDAwMDAyNDcgMDAwMDAgbiAKMDAwMDAwMDMxNyAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxNgolJUVPRgo="}},
      {"type":"text","text":"Read the attached PDF and reply with exactly the sentinel text it contains."}
    ]}]
  }'
  assert_status 200 \
    && assert_anthropic_message \
    && assert_body_contains "ShimPDFProbeZebra42"
}

probe_shim_document_pdf_degrade_gemini35flash() {
  # Chat shim document path: Anthropic base64 PDF cannot be forwarded to
  # /chat/completions, so the shim degrades it to an inline text note. User-facing
  # expectation is graceful 200 + Anthropic response, not actual PDF reading.
  do_request POST /v1/messages '{
    "model": "gemini-3.5-flash",
    "max_tokens": 128,
    "messages": [{"role":"user","content":[
      {"type":"document","title":"shim-probe.pdf","source":{"type":"base64","media_type":"application/pdf","data":"JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMTQ0XSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNTAgPj4Kc3RyZWFtCkJUIC9GMSAxOCBUZiAzNiA5NiBUZCAoU2hpbVBERlByb2JlWmVicmE0MikgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA2NCAwMDAwMCBuIAowMDAwMDAwMTIxIDAwMDAwIG4gCjAwMDAwMDAyNDcgMDAwMDAgbiAKMDAwMDAwMDMxNyAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxNgolJUVPRgo="}},
      {"type":"text","text":"A PDF is attached. If the model cannot read it, reply with a brief acknowledgement instead of an error."}
    ]}]
  }'
  assert_status 200 \
    && assert_anthropic_message
}

probe_shim_max_tokens_clamp_gpt55() {
  # max_tokens below Copilot's minimum is clamped by the Responses shim rather
  # than forwarded raw (which would 400). User-facing expectation: 200.
  do_request POST /v1/messages '{
    "model": "gpt-5.5",
    "max_tokens": 1,
    "messages": [{"role":"user","content":"Reply with the single word: ok"}]
  }'
  assert_status 200 \
    && assert_anthropic_message
}

probe_shim_image_gpt55() {
  # Valid tiny RGB PNG (1x1 red pixel; color type 2), not a malformed/RGBA test
  # string. The shim turns this Anthropic base64 source into a PNG data URI for
  # the Responses input_image part.
  do_request POST /v1/messages '{
    "model": "gpt-5.5",
    "max_tokens": 128,
    "messages": [{"role":"user","content":[
      {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}},
      {"type":"text","text":"Describe this image in one short sentence."}
    ]}]
  }'
  assert_status 200 \
    && assert_anthropic_message
}

probe_shim_image_gemini35flash() {
  # Same valid RGB PNG as shim_image_gpt55, through the chat shim's image_url
  # translation path.
  do_request POST /v1/messages '{
    "model": "gemini-3.5-flash",
    "max_tokens": 128,
    "messages": [{"role":"user","content":[
      {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}},
      {"type":"text","text":"Describe this image in one short sentence."}
    ]}]
  }'
  assert_status 200 \
    && assert_anthropic_message
}

probe_passthrough_image_claude() {
  # G9: the Claude passthrough deliberately omits `copilot-vision-request`.
  # That was an unverified code comment for a long time; this probe is what
  # keeps it true. A 200 here plus a well-formed message means the native
  # endpoint accepted an image without the header.
  do_request POST /v1/messages '{
    "model": "claude-opus-5",
    "max_tokens": 128,
    "messages": [{"role":"user","content":[
      {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}},
      {"type":"text","text":"Describe this image in one short sentence."}
    ]}]
  }'
  assert_status 200     && assert_anthropic_message
}

probe_shim_image_tool_result_gpt55() {
  # The shape every "subagent reads a screenshot" session produces, and the one
  # with no live coverage before now: the image is nested inside a tool_result,
  # not at the top level. A function_call_output cannot carry an image, so the
  # shim re-emits it as a follow-up user message.
  do_request POST /v1/messages '{
    "model": "gpt-5.5",
    "max_tokens": 128,
    "messages": [
      {"role":"user","content":[{"type":"text","text":"Take a screenshot."}]},
      {"role":"assistant","content":[{"type":"tool_use","id":"toolu_probe1","name":"screenshot","input":{}}]},
      {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_probe1","content":[
        {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}}
      ]}]}
    ],
    "tools":[{"name":"screenshot","description":"Capture the screen.","input_schema":{"type":"object","properties":{}}}]
  }'
  assert_status 200     && assert_anthropic_message
}

probe_shim_image_tool_result_gemini35flash() {
  # Same nested shape through the chat egress, where the follow-up rides as an
  # image_url content part.
  do_request POST /v1/messages '{
    "model": "gemini-3.5-flash",
    "max_tokens": 128,
    "messages": [
      {"role":"user","content":[{"type":"text","text":"Take a screenshot."}]},
      {"role":"assistant","content":[{"type":"tool_use","id":"toolu_probe2","name":"screenshot","input":{}}]},
      {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_probe2","content":[
        {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}}
      ]}]}
    ],
    "tools":[{"name":"screenshot","description":"Capture the screen.","input_schema":{"type":"object","properties":{}}}]
  }'
  assert_status 200     && assert_anthropic_message
}

probe_vision_multi_image_gpt() {
  # The regression this replaces: the proxy used to reject this LOCALLY at 2
  # images because gpt-5.5 publishes max_prompt_images: 1. Measured 2026-08-10,
  # gpt-5.5 itself accepted 120 in one request, so the local gate was rejecting
  # requests Copilot would have answered — and doing it fatally, because the
  # count covered replayed history the caller could not edit. (The real ceiling
  # is per-model and not uniform within a family: gpt-5.6-sol stops at 50 while
  # gpt-5.5 took 120, which is why nothing here hardcodes a number.) A 400 here
  # means a local count gate came back.
  do_request POST /v1/messages '{
    "model": "gpt-5.5",
    "max_tokens": 128,
    "messages": [{"role":"user","content":[
      {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}},
      {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}},
      {"type":"text","text":"Compare these."}
    ]}]
  }'
  assert_status 200
}

probe_vision_ceiling_recovery_gemini() {
  # gemini is the one family whose catalog value is real: upstream enforces 10
  # exactly and says so ("maximum allowed for model ... is 10, got 12"). This
  # asserts the recovery end to end — the proxy reads that number, prunes to it,
  # retries once, and the caller sees a normal 200 instead of a dead session.
  local img='{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}}'
  local images="$img"
  local i
  for i in $(seq 2 12); do images="${images},${img}"; done
  do_request POST /v1/messages "{
    \"model\": \"gemini-3.1-pro-preview\",
    \"max_tokens\": 128,
    \"messages\": [{\"role\":\"user\",\"content\":[${images},{\"type\":\"text\",\"text\":\"How many images?\"}]}]
  }"
  # This asserts the user-visible OUTCOME only: without the recovery this is a
  # 400, so a well-formed 200 means the request was rescued. It cannot see the
  # mechanism (one rejection, prune to 10, one retry, ceiling then learned) —
  # that is pinned by tests/vision-preflight.test.ts.
  assert_status 200     && assert_anthropic_message
}

probe_shim_advisor_degrade_gpt55() {
  # ADVISOR is Claude-only. On the non-Claude Responses shim path, the proxy
  # strips the advisor beta/header effect plus both the proxy-internal and native
  # advisor tools, then proceeds without advisor rather than returning 400.
  do_request POST /v1/messages '{
    "model": "gpt-5.5",
    "max_tokens": 128,
    "tools": [
      {"name":"__anthropic_advisor","description":"advisor","input_schema":{"type":"object","properties":{},"required":[]}},
      {"type":"advisor_20260301","name":"advisor"}
    ],
    "tool_choice": {"type":"tool","name":"__anthropic_advisor"},
    "messages": [{"role":"user","content":"Reply with the single word: ok"}]
  }' "anthropic-beta: advisor-tool-2026-03-01"
  assert_status 200 \
    && assert_anthropic_message
}

probe_shim_advisor_degrade_gemini35flash() {
  # Same advisor graceful-degrade expectation on the chat shim path.
  do_request POST /v1/messages '{
    "model": "gemini-3.5-flash",
    "max_tokens": 128,
    "tools": [
      {"name":"__anthropic_advisor","description":"advisor","input_schema":{"type":"object","properties":{},"required":[]}},
      {"type":"advisor_20260301","name":"advisor"}
    ],
    "tool_choice": {"type":"tool","name":"__anthropic_advisor"},
    "messages": [{"role":"user","content":"Reply with the single word: ok"}]
  }' "anthropic-beta: advisor-tool-2026-03-01"
  assert_status 200 \
    && assert_anthropic_message
}

probe_shim_count_tokens_gpt53codex() {
  # Non-Claude model id on Anthropic count_tokens must still return a token
  # accounting object instead of rejecting the model at the Anthropic boundary.
  do_request POST /v1/messages/count_tokens '{
    "model": "gpt-5.3-codex",
    "max_tokens": 16,
    "messages": [{"role":"user","content":"Count this short prompt."}]
  }'
  assert_status 200 \
    && assert_body_contains '"input_tokens":'
}

probe_shim_thinking_effort_gpt55() {
  # Anthropic thinking.budget_tokens maps to the Responses reasoning effort and
  # is clamped to the selected model's supported effort values.
  do_request POST /v1/messages '{
    "model": "gpt-5.5",
    "max_tokens": 128,
    "thinking": {"type":"enabled","budget_tokens":1024},
    "messages": [{"role":"user","content":"Reply with the single word: ok"}]
  }'
  assert_status 200 \
    && assert_anthropic_message
}

probe_shim_parallel_tool_emit_gpt55() {
  # Ask for two independent tool calls. Live model behavior can be
  # nondeterministic, so this probe asserts a well-formed 200 plus >=1 tool_use;
  # the registry/matrix note records the best-effort multiple-tool intent.
  do_request POST /v1/messages '{
    "model": "gpt-5.5",
    "max_tokens": 1024,
    "tools": [
      {"name":"lookup_weather","description":"Look up weather for a city","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}},
      {"name":"lookup_time","description":"Look up local time for a city","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}
    ],
    "tool_choice": {"type":"auto"},
    "messages": [{"role":"user","content":"Use both lookup_weather and lookup_time for Paris. The calls are independent; issue both tool calls before answering."}]
  }'
  assert_status 200 \
    && assert_anthropic_message \
    && assert_tool_use_count_at_least 1
}

probe_signed_thinking_cache_scope_stripped() {
  local prompt first_body tool_id continuation
  prompt="Carefully derive the 20th Fibonacci number, verify it independently, then call record_result with the integer result. You must use the tool."
  do_request POST /v1/messages "{
    \"model\":\"claude-opus-5\",
    \"max_tokens\":4096,
    \"thinking\":{\"type\":\"adaptive\",\"display\":\"summarized\"},
    \"output_config\":{\"effort\":\"xhigh\"},
    \"messages\":[{\"role\":\"user\",\"content\":$(jq -Rn --arg value "$prompt" '$value')}],
    \"tools\":[{\"name\":\"record_result\",\"description\":\"Record the verified integer result\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"value\":{\"type\":\"integer\"}},\"required\":[\"value\"]}}]
  }"
  assert_status 200 || return 1
  if ! jq -e '.content | any(.type=="thinking") and any(.type=="tool_use")' "$LAST_BODY_FILE" >/dev/null; then
    echo "  ${C_RED}FAIL${C_RESET} setup response did not contain thinking + tool_use"
    return 1
  fi

  first_body="$(mktemp -t probe-thinking.XXXXXX)"
  cp "$LAST_BODY_FILE" "$first_body"
  tool_id="$(jq -r '.content[] | select(.type=="tool_use") | .id' "$first_body" | head -1)"
  continuation="$(
    jq -c --arg prompt "$prompt" --arg tool_id "$tool_id" '{
      model:"claude-opus-5",
      max_tokens:512,
      thinking:{type:"adaptive",display:"summarized"},
      output_config:{effort:"xhigh"},
      messages:[
        {role:"user",content:$prompt},
        {role:"assistant",content:(.content | map(
          if .type=="thinking"
          then . + {cache_control:{type:"ephemeral",scope:"global"}}
          else .
          end
        ))},
        {role:"user",content:[
          {type:"tool_result",tool_use_id:$tool_id,content:"recorded"}
        ]}
      ],
      tools:[{
        name:"record_result",
        description:"Record the verified integer result",
        input_schema:{
          type:"object",
          properties:{value:{type:"integer"}},
          required:["value"]
        }
      }]
    }' "$first_body"
  )"
  rm -f "$first_body"

  do_request POST /v1/messages "$continuation"
  assert_status 200 && assert_anthropic_message
}

probe_thinking_history_invalid_signature_repaired() {
  do_request POST /v1/messages '{
    "model":"claude-opus-5",
    "max_tokens":128,
    "thinking":{"type":"adaptive"},
    "messages":[
      {"role":"user","content":"Reply with one word after reading the tool result."},
      {"role":"assistant","content":[
        {"type":"thinking","thinking":"","signature":"probe-invalid-signature"},
        {"type":"tool_use","id":"toolu_probe_repair_1","name":"lookup","input":{}}
      ]},
      {"role":"user","content":[
        {"type":"tool_result","tool_use_id":"toolu_probe_repair_1","content":"ok"}
      ]}
    ],
    "tools":[
      {"name":"lookup","description":"Return ok","input_schema":{"type":"object","properties":{},"required":[]}}
    ]
  }'
  assert_status 200 && assert_anthropic_message
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
