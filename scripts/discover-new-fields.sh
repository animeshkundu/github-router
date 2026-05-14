#!/usr/bin/env bash
# discover-new-fields.sh — diff Claude Code / Codex traffic against the
# Copilot compatibility matrix to surface fields that need probe rows.
#
# Phase 0.5 of the long-horizon plan. Closes the discovery loop:
#
#   1. Launch the proxy with GH_ROUTER_LOG_FIELDS=1 set in its environment.
#   2. Run a representative session (e.g. github-router claude with normal usage).
#   3. Run this script — it reads the proxy's stdout/stderr log (passed via
#      stdin or LOG_FILE), aggregates unique field names per request shape,
#      and diffs against the known-fields lists embedded in
#      docs/copilot-compat-matrix.md (and the probe registry in
#      probe-copilot-compat.sh).
#   4. Output is a checklist of "NEW: <field>" entries. Each must be added
#      to the probe before the next merge — that's the discovery rule.
#
# Usage:
#   # Pipe live proxy logs through (most useful during development):
#   tail -f /path/to/proxy.log | bash scripts/discover-new-fields.sh
#
#   # Or analyze a captured log file:
#   bash scripts/discover-new-fields.sh --log /path/to/proxy.log
#
#   # Or read from stdin (CI mode):
#   cat proxy.log | bash scripts/discover-new-fields.sh
#
# The proxy must have been launched with GH_ROUTER_LOG_FIELDS=1 in its
# environment so it emits the `[fields]` instrumentation lines.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MATRIX_DOC="${REPO_ROOT}/docs/copilot-compat-matrix.md"
PROBE_SCRIPT="${REPO_ROOT}/scripts/probe-copilot-compat.sh"

LOG_FILE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --log) LOG_FILE="$2"; shift ;;
    --help|-h)
      cat <<USAGE
Usage: $0 [--log <file>]

Reads proxy logs from --log <file> or stdin (when --log not given).
Greps for [fields] lines emitted by GH_ROUTER_LOG_FIELDS=1 instrumentation,
extracts unique field/header/tool-field names per path, and reports any
not yet documented in docs/copilot-compat-matrix.md or registered in
scripts/probe-copilot-compat.sh.

Output: per-path "NEW: <field>" lines plus a summary count.
Exit 0 when nothing new is found; exit 1 when there's anything to add.
USAGE
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# Color when stdout is a TTY.
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

# Build the "known fields" set from the matrix doc and probe script.
# We grep liberally — the matrix is plain markdown and the probe script is
# bash; both contain the field names verbatim. False positives (a known
# field treated as known when it's actually new) are acceptable; false
# negatives (a known field treated as unknown) generate noise but no
# silent loss.
KNOWN="$(mktemp -t known-fields.XXXXXX)"
trap 'rm -f "$KNOWN" "${SEEN:-}"' EXIT
{
  if [ -f "$MATRIX_DOC" ]; then cat "$MATRIX_DOC"; fi
  if [ -f "$PROBE_SCRIPT" ]; then cat "$PROBE_SCRIPT"; fi
} > "$KNOWN"

# is_known <token>: returns 0 if the token appears in the matrix or probe,
# either verbatim OR as a prefix-with-dash (so `foo-bar-2026-01-01` matches
# matrix entries listing `foo-bar-` — common pattern for anthropic-beta
# headers where the matrix indexes by prefix and traffic carries the
# dated full form).
is_known() {
  local token="$1"
  if grep -qF -- "$token" "$KNOWN"; then return 0; fi
  # Try collapsing trailing -<digits/date> segments to the prefix form
  # `foo-bar-2026-01-01` → `foo-bar-`
  # `foo-bar-2026-01` → `foo-bar-`
  # `foo_20250818` → `foo_` (no — date_str sniff is dash-only)
  local prefix="$token"
  while [[ "$prefix" =~ -[0-9]+$ ]]; do
    prefix="${prefix%-*}"
  done
  if [ "$prefix" != "$token" ]; then
    if grep -qF -- "${prefix}-" "$KNOWN"; then return 0; fi
  fi
  return 1
}

# Read source: --log file, or stdin
SEEN="$(mktemp -t seen-fields.XXXXXX)"
if [ -n "$LOG_FILE" ]; then
  grep -F "[fields]" "$LOG_FILE" > "$SEEN" || true
else
  grep -F "[fields]" > "$SEEN" || true
fi

if [ ! -s "$SEEN" ]; then
  echo "${C_YELLOW}No [fields] log lines found.${C_RESET}" >&2
  echo "Make sure the proxy was launched with GH_ROUTER_LOG_FIELDS=1 set." >&2
  echo "Example: GH_ROUTER_LOG_FIELDS=1 bun run dev" >&2
  exit 0
fi

# Extract unique values per category, per path
extract_csv() {
  # extract_csv <key>  — pulls the value of `<key>=<csv>` from each line,
  # splits by comma, dedupes globally
  local key="$1"
  awk -v key="$key" '
    {
      # Find " key=" then read until next space-separated token
      n = index($0, " " key "=")
      if (n > 0) {
        rest = substr($0, n + length(key) + 2)
        # Read until next space
        space = index(rest, " ")
        if (space > 0) {
          val = substr(rest, 1, space - 1)
        } else {
          val = rest
        }
        # Split val by comma
        nf = split(val, parts, ",")
        for (i = 1; i <= nf; i++) {
          if (parts[i] != "") seen[parts[i]] = 1
        }
      }
    }
    END {
      for (k in seen) print k
    }
  ' "$SEEN" | sort
}

# Pull paths so we can group output
PATHS_SEEN="$(awk '{
  n = index($0, " path=")
  if (n > 0) {
    rest = substr($0, n + 6)
    space = index(rest, " ")
    print (space > 0 ? substr(rest, 1, space - 1) : rest)
  }
}' "$SEEN" | sort -u)"

NEW_COUNT=0

echo "${C_DIM}=== Discovery report (against ${MATRIX_DOC#$REPO_ROOT/} and ${PROBE_SCRIPT#$REPO_ROOT/}) ===${C_RESET}"
for category in body_keys tool_field_keys beta_values; do
  echo
  echo "${C_DIM}-- ${category} --${C_RESET}"
  values="$(extract_csv "$category")"
  if [ -z "$values" ]; then
    echo "  ${C_DIM}(none seen)${C_RESET}"
    continue
  fi
  while IFS= read -r v; do
    [ -z "$v" ] && continue
    if is_known "$v"; then
      echo "  ${C_GREEN}known${C_RESET}    $v"
    else
      echo "  ${C_RED}NEW${C_RESET}      $v"
      NEW_COUNT=$((NEW_COUNT + 1))
    fi
  done <<<"$values"
done

echo
echo "${C_DIM}-- paths seen --${C_RESET}"
echo "$PATHS_SEEN" | sed 's/^/  /'
echo

if [ "$NEW_COUNT" -gt 0 ]; then
  echo "${C_RED}${NEW_COUNT} new field(s) discovered.${C_RESET}"
  echo "Per the discovery rule (CLAUDE.md): add a probe row in scripts/probe-copilot-compat.sh AND a row in docs/copilot-compat-matrix.md before merging."
  exit 1
else
  echo "${C_GREEN}No new fields. Matrix is in sync with observed traffic.${C_RESET}"
  exit 0
fi
