import consola from "consola"

import { state } from "./state"

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
 * Cap-aware default picker for `ANTHROPIC_MODEL` on the implicit-default
 * path. Returns `claude-opus-${family}[1m]` when the live Copilot catalog
 * contains an `opus-${family}-1m*` variant (enterprise tier), else the
 * bare `claude-opus-${family}` slug. `family` defaults to `"4.7"` so the
 * no-arg call preserves the original behavior; explicit values like
 * `"4.6"` or `"4.8"` are used to honor the `github-router claude
 * -m <version>` family shorthand.
 *
 * The `[1m]` literal-bracket suffix is Claude Code's local 1M-context
 * unlock — cc-backup `src/utils/context.ts:35-40` matches `/\[1m\]/i`
 * to flip the context window from 200K to 1M, which drives compaction
 * triggers, the status-line context %, and token budgets. Without the
 * bracket Claude Code accounts against 200K regardless of how the
 * proxy routes the underlying request.
 *
 * Cap-awareness matters because on non-enterprise Copilot tiers there
 * is no `-1m` opus backend; sending `[1m]` there would either 400 at
 * Copilot or (with `resolveModel`'s graceful-degrade) silently
 * downgrade upstream while Claude Code still over-accounts context.
 * This helper detects the catalog state at launch and only opts in
 * when the backend can actually serve 1M.
 *
 * Sonnet/Haiku families are intentionally NOT given `[1m]` defaults
 * because Copilot has no `-1m` backend for them (and Anthropic-side
 * `modelSupports1M` doesn't list haiku at all). See
 * `src/lib/server-setup.ts:getClaudeCodeEnvVars` for the
 * `ANTHROPIC_DEFAULT_{SONNET,HAIKU,OPUS}_MODEL` tier defaults.
 *
 * Must be called AFTER `cacheModels()` has populated `state.models`.
 * Returns the bare slug if the catalog isn't populated (resolveModel
 * can't tell the difference between "no catalog yet" and "no 1M
 * variant" — defaulting safe-side preserves the pre-change behavior).
 */
const DEFAULT_OPUS_FAMILY = "4.7"

export function pickClaudeDefault(opusFamily: string = DEFAULT_OPUS_FAMILY): string {
  // Canonicalize the family to dotted form so both "4.7" and "4-7" work
  // as input, then derive the dashed Anthropic slug and a regex that
  // tolerates either separator in catalog ids (Copilot uses dotted,
  // some test fixtures use dashed).
  const dotted = opusFamily.replace(/-/g, ".")
  const dashed = dotted.replace(/\./g, "-")
  const bareSlug = `claude-opus-${dashed}`
  const versionPattern = dotted.replace(/\./g, "[.-]")
  const oneMRegex = new RegExp(`opus-${versionPattern}-1m(?:$|-)`, "i")
  const familyRegex = new RegExp(`opus-${versionPattern}(?:$|[-.])`, "i")

  const models = state.models?.data ?? []
  const has1m = models.some((m) => oneMRegex.test(m.id))

  // Warn when the user explicitly requested a family that's completely
  // absent from the catalog — `resolveModel`'s downstream cache-walk
  // will surface the "model not found" error, but a heads-up at this
  // layer makes it obvious why a typo'd `-m 4.0` falls through.
  if (
    opusFamily !== DEFAULT_OPUS_FAMILY
    && state.models
    && models.length > 0
    && !models.some((m) => familyRegex.test(m.id))
  ) {
    consola.warn(
      `Requested Opus family "${dotted}" not found in Copilot catalog; using "${bareSlug}" anyway (resolveModel may not find a backend for it).`,
    )
  }

  if (has1m) {
    consola.info(
      `Catalog contains opus-${dotted}-1m variant; defaulting ANTHROPIC_MODEL to "${bareSlug}[1m]" so Claude Code accounts for 1M context locally. Set CLAUDE_CODE_DISABLE_1M_CONTEXT=1 to opt out (HIPAA), or pass --model ${bareSlug} to pin 200K.`,
    )
    return `${bareSlug}[1m]`
  }
  return bareSlug
}

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
  // Strict integer format only: parseInt is too permissive — it would
  // silently turn `"5e3"` into 5, `"300_000"` into 300, `"60000ms"` into
  // 60000. For timeout knobs we'd rather fall back than silently
  // misconfigure (e.g. set a 5-min inactivity timer to 5 ms).
  if (!/^[0-9]+$/.test(raw.trim())) {
    consola.warn(
      `${key}=${JSON.stringify(raw)} is not a non-negative integer; using fallback ${fallback}`,
    )
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
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
