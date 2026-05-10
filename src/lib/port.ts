export const DEFAULT_PORT = 8787

/**
 * Default model for `github-router claude`. The Anthropic-published dashed
 * slug (`claude-opus-4-7`) — NOT the Copilot-internal slug
 * (`claude-opus-4.7-1m-internal`) — because Claude Code 2.1.126's `/model`
 * UI is backed by a hardcoded registry of Anthropic slugs, and an
 * unrecognized slug causes the menu to highlight "Opus 4" with a
 * "Newer version available" hint instead of "Opus 4.7 (1M context)".
 *
 * The proxy's `resolveModel` (`src/lib/utils.ts`) translates this to
 * Copilot's `claude-opus-4.7-1m-internal` (enterprise) or
 * `claude-opus-4.7` (Pro+/Business/Max) at request time via the
 * family-preference + version-match branch — round-trip covered by
 * `tests/lib-utils.test.ts:154`.
 *
 * `DEFAULT_CLAUDE_MODEL_FALLBACKS` covers major.minor regressions only;
 * 1M↔200K downgrade is handled inside the resolver, so we don't need
 * separate `-1m` entries here.
 */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-7"
export const DEFAULT_CLAUDE_MODEL_FALLBACKS = [
  "claude-opus-4-6",
  "claude-opus-4-5",
] as const

/**
 * Default model for `github-router codex`. `gpt-5.5` is the new flagship
 * `/responses` model; the fallback chain handles older Copilot tiers where
 * 5.5 hasn't rolled out yet. `resolveCodexModel` provides a final
 * "best available `/responses` model" safety net beyond this list.
 */
export const DEFAULT_CODEX_MODEL = "gpt-5.5"
export const DEFAULT_CODEX_MODEL_FALLBACKS = [
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
] as const

const PORT_RANGE_MIN = 11000
const PORT_RANGE_MAX = 65535

/** Generate a random port number in the range [11000, 65535]. */
export function generateRandomPort(): number {
  return (
    Math.floor(Math.random() * (PORT_RANGE_MAX - PORT_RANGE_MIN + 1))
    + PORT_RANGE_MIN
  )
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// Total fetch-phase timeout (until Response object resolves) for upstream
// streaming endpoints. Default 0 = no fetch-phase timeout — body-phase
// failures are covered by UPSTREAM_INACTIVITY_TIMEOUT_MS below, and a
// fetch-lifecycle timeout would silently truncate legitimate long
// completions (e.g. xhigh-thinking responses that legitimately stream
// for 30+ minutes). Set the env var to a positive integer if you need
// a hard cap.
export const UPSTREAM_FETCH_TIMEOUT_MS = envInt(
  "UPSTREAM_FETCH_TIMEOUT_MS",
  0,
)

// Inactivity bound on body reads — if no chunk arrives within this window,
// abort the stream and emit a structured error event. 300s (5 min) sits
// well above Copilot's ~60s idle cut so the proxy still reaps stalled
// connections before the upstream RST hits us as an unhandled rejection,
// but does NOT prematurely abort reasoning-capable models (gpt-5.5,
// gpt-5.3-codex, gemini-3.1-pro-preview, claude-opus-4.7-xhigh) which
// routinely produce >75s silences between visible token bursts while
// thinking. The earlier 75s default produced live aborts at /v1/messages
// with bytes=134k–163k already streamed — proof the upstream was healthy
// and just thinking. Lower this only if you specifically want to reap
// stalled connections faster than 5 minutes.
export const UPSTREAM_INACTIVITY_TIMEOUT_MS = envInt(
  "UPSTREAM_INACTIVITY_TIMEOUT_MS",
  300_000,
)

// TODO: extend timeout coverage to non-streaming paths (web-search MCP in
// src/services/copilot/web-search.ts, embeddings, models) when those
// endpoints become hot or start hanging in practice.
