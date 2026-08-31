/**
 * Conservative per-model compaction accounting for models whose ADVERTISED
 * TOTAL context window is larger than the prompt ceiling the provider actually
 * enforces.
 *
 * The defect class this exists to close: Claude Code budgets against a total
 * window (1,000,000 via the `[1m]` bracket) while Copilot enforces
 * `max_prompt_tokens` (Luna 922K, Opus 5 936K, Grok 372K). Its own compaction
 * threshold therefore lands ABOVE the ceiling, so a long session sends a
 * request the provider rejects before the client ever decides to compact.
 *
 * Grok 4.6 was the first model where this was noticed (500K total / 372K
 * prompt / 128K output), and at the time there was no supported way for a
 * client to declare the split, so the derivation was committed unused. It is
 * now wired up: `deriveAutoCompactWindowTokens` turns it into the integer
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` value the launcher exports. Values are
 * DERIVED from the live catalog, never hardcoded, so a catalog change
 * recomputes rather than silently going stale.
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
 * The client's additional flat reserve between the output-reduced window and
 * its reactive compaction threshold. Read from the installed Claude Code
 * 2.1.251 bundle: `E9(e,t)` computes `r = e - 13000` and returns it when no
 * percentage override is set, where `e` is already
 * `window - min(maxOutput, 20_000)`.
 */
const CLIENT_THRESHOLD_RESERVE_TOKENS = 13_000

/**
 * Bounds the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env path applies to whatever it
 * parses: `IWe = 1e5` floor, `ZRt = 1e6` cap. A value below the floor is
 * silently RAISED to it, so deriving something smaller would be a lie; a value
 * above the cap is clamped. In the 2.1.251 bundle, `ike = 1e5` and
 * `JNe = 1e6` are passed to the shared env parser and the result is floored
 * again with `Math.max(ike, ...)` before use.
 */
const ENV_WINDOW_MIN_TOKENS = 100_000
const ENV_WINDOW_MAX_TOKENS = 1_000_000

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

/**
 * The integer `CLAUDE_CODE_AUTO_COMPACT_WINDOW` value that puts the client's
 * REACTIVE compaction trigger at 85% of the provider's real prompt ceiling.
 *
 * The client computes its trigger as
 * `window - min(maxOutput, 20_000) - 13_000`, so we invert that:
 * `window = assumedClientWindowTokens + 13_000`.
 *
 * Worked, against the live catalog at time of writing:
 *   Luna    922_000 prompt / 128_000 out -> trigger 783_700, window 816_700
 *   Opus 5  936_000 prompt /  64_000 out -> trigger 795_600, window 828_600
 *
 * Returns undefined when the catalog metadata is missing or nonsensical, so
 * the caller omits the variable entirely rather than exporting a guess. That
 * degrades to today's behaviour (client budgets against the total window)
 * instead of to a wrong number, which is the safer direction for a value the
 * client silently floors.
 */
export function deriveAutoCompactWindowTokens(
  maxPromptTokens: number | undefined,
  maxOutputTokens: number | undefined,
): number | undefined {
  if (
    typeof maxPromptTokens !== "number"
    || !Number.isFinite(maxPromptTokens)
    || maxPromptTokens <= 0
  ) {
    return undefined
  }
  // An absent output limit must not silently become a 0 reserve: fall back to
  // the client's own 20K reserve, which is what `Math.min` would pick for any
  // real model in this lineup anyway.
  const outputTokens =
    typeof maxOutputTokens === "number"
      && Number.isFinite(maxOutputTokens)
      && maxOutputTokens > 0
      ? maxOutputTokens
      : CLIENT_OUTPUT_RESERVE_TOKENS

  const { assumedClientWindowTokens } = computeConservativeCompactionTrigger(
    maxPromptTokens,
    outputTokens,
  )
  const window = assumedClientWindowTokens + CLIENT_THRESHOLD_RESERVE_TOKENS
  return Math.min(
    ENV_WINDOW_MAX_TOKENS,
    Math.max(ENV_WINDOW_MIN_TOKENS, window),
  )
}
