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
