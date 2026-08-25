/**
 * Pure derivation helper for a future per-model conservative compaction
 * trigger for Grok-family models served through the fast launch profile's
 * `reviewer-fast` agent (grok-4.6).
 *
 * Grok 4.6 advertises 500K total context, 372K max prompt tokens, and 128K
 * max output tokens in the live Copilot catalog. Claude Code has no
 * supported way to declare a per-model prompt/output split today, so this
 * repo does NOT inject a global `CLAUDE_CODE_MAX_CONTEXT_TOKENS` override or
 * pass `--autocompact` (both are launch-global and would incorrectly cap
 * every other 1M model too — see docs/default-models.md and the plan doc
 * "the-default-models-concurrent-pumpkin.md" section 4). Grok stays bare
 * and Claude Code assumes its own conservative ~200K default window.
 *
 * This module exists so the derivation is committed, testable, and ready to
 * wire up the moment a supported per-model client declaration exists — NOT
 * to be called from any live request path yet. Values are DERIVED, never
 * hardcoded, so a future catalog change (e.g. a wider or narrower Grok
 * prompt/output window) recomputes correctly rather than silently going
 * stale.
 */

export interface ConservativeCompactionTrigger {
  /** floor(maxPromptTokens * 0.85) — the point at which a conservative
   *  client-side compactor should trigger, leaving 15% headroom below the
   *  model's actual advertised prompt ceiling. */
  triggerTokens: number
  /** The client-side window a caller would need to ASSUME to make
   *  `triggerTokens` the natural compaction point, given the client also
   *  reserves `min(maxOutputTokens, 20_000)` for its own output budget
   *  (mirrors Claude Code's fixed 20K output reserve). */
  assumedClientWindowTokens: number
}

/** Claude Code's fixed output-token reserve when computing its own
 *  compaction-window assumption. Grok 4.6's 128K max output stays well
 *  above this, so the reserve — not the model's real output ceiling — is
 *  what caps the second term. */
const CLIENT_OUTPUT_RESERVE_TOKENS = 20_000

/**
 * Derive the conservative 85%-of-prompt compaction trigger and the client
 * window that would need to be assumed to make that trigger point natural.
 *
 * `target trigger = floor(max_prompt_tokens * 0.85)`
 * `assumed client window = target trigger + min(max_output_tokens, 20_000)`
 *
 * For Grok 4.6's current catalog entry (max_prompt_tokens=372_000,
 * max_output_tokens=128_000) this yields `{ triggerTokens: 316_200,
 * assumedClientWindowTokens: 336_200 }` — the exact figures the plan
 * document records. Pure and side-effect-free; callers are responsible for
 * sourcing `maxPromptTokens`/`maxOutputTokens` from the live catalog.
 */
export function computeConservativeCompactionTrigger(
  maxPromptTokens: number,
  maxOutputTokens: number,
): ConservativeCompactionTrigger {
  const triggerTokens = Math.floor(maxPromptTokens * 0.85)
  const assumedClientWindowTokens =
    triggerTokens + Math.min(maxOutputTokens, CLIENT_OUTPUT_RESERVE_TOKENS)
  return { triggerTokens, assumedClientWindowTokens }
}
