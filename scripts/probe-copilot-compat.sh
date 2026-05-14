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

  # ===== Native Anthropic tool types =====
  "tooltype_memory_20250818|anthropic-docs|memory_20250818 returns 200; model emits tool_use{name:memory, command:view}"
  "tooltype_text_editor_20250728|anthropic-docs|text_editor_20250728 returns 200"
  "tooltype_bash_20250124|copilot-allowlist|bash_20250124 returns 200 (current bash version)"
  "tooltype_bash_20241022_legacy|copilot-allowlist|bash_20241022 (legacy version) returns 400"
  "tooltype_code_execution_20250825|copilot-allowlist|code_execution_20250825 returns 400 (not in Copilot allowlist)"
  "tooltype_web_search_20250305|anthropic-docs|web_search_20250305 returns 200 in body validator (model invocation inconclusive)"

  # ===== Context management =====
  "compact_20260112|anthropic-docs|context_management.edits[].type=compact_20260112 with anthropic-beta:compact-2026-01-12 returns 200"
  "clear_tool_uses_20250919|anthropic-docs|context_management.edits[].type=clear_tool_uses_20250919 returns 200"

  # ===== Streaming =====
  "stream_with_tools|claude-emits|Streaming response with tools (no FGTS) returns 200 with valid SSE event sequence"
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

probe_compact_20260112() {
  do_request POST /v1/messages '{
    "model": "claude-opus-4-7",
    "max_tokens": 50,
    "context_management": {"edits": [{"type":"compact_20260112"}]},
    "messages": [{"role":"user","content":"hi"}]
  }' "anthropic-beta: compact-2026-01-12"
  assert_status 200 \
    && assert_body_contains "applied_edits"
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
