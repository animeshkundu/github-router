export const DEFAULT_PORT = 8787

/**
 * Default model for `github-router claude`. The 1M-context variant is
 * enterprise-only (`billing.restricted_to: ["enterprise"]`); when it isn't
 * in the resolved Copilot model list, the launcher walks
 * `DEFAULT_CLAUDE_MODEL_FALLBACKS` in order and picks the first available.
 */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-4.7-1m-internal"
export const DEFAULT_CLAUDE_MODEL_FALLBACKS = [
  "claude-opus-4.7",
  "claude-opus-4.6-1m",
  "claude-opus-4.6",
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
