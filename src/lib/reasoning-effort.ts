/**
 * Reasoning-effort bucketing + clamping shared by the `/v1/messages` handler
 * (adaptive-thinking translation) and the Anthropic-translation shim
 * (thinking-budget → Responses `reasoning.effort`).
 *
 * Extracted from `src/routes/messages/handler.ts` so a `~/lib/*` module can
 * depend on it without importing route code (and without forming a
 * handler → shim → handler import cycle). `handler.ts` re-exports these for
 * backward compatibility with existing imports/tests.
 */

/**
 * Copilot's reasoning-effort tiers, lowest to highest.
 *
 * Both ends were added after the fact and both are load-bearing:
 *
 * `none` is advertised by every gpt-5.x entry in the live catalog. While it was
 * missing here it was treated as an UNRECOGNIZED value, so a client asking for
 * the MINIMUM on a model that does not offer it (gemini advertises only
 * low/medium/high) was anchored at the unknown-value tier and clamped to
 * `high` — the maximum. Listing it makes the clamp resolve to `low` instead,
 * which is what "nearest supported tier" should always have meant.
 *
 * `max` is advertised by `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`,
 * `claude-opus-5` and the 4.7/4.8 Opus lines, and Claude Code's effort picker
 * offers it for any model whose entry allows it. Listing it lets an explicit
 * selection pass through, and lets `clampEffort` land on it for a model that
 * advertises nothing lower.
 *
 * `bucketEffort` deliberately reaches neither end — see below.
 */
export const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"] as const

export type Effort = (typeof EFFORT_ORDER)[number]

/** Anchor for an effort value that is not a recognized tier at all.
 *
 *  Deliberately NOT the top of `EFFORT_ORDER`. Callers reach this only when the
 *  incoming value is unrecognized, which is a guess — and resolving a guess to
 *  the most expensive tier a model advertises would silently spend more than the
 *  caller could have meant. Anchoring here and clamping DOWN keeps the behavior
 *  identical to before `max` joined the ladder, while `max` stays reachable by
 *  explicit, valid selection. */
export const UNKNOWN_EFFORT_ANCHOR: Effort = "xhigh"

/**
 * Bucket a thinking budget into a Copilot reasoning-effort string.
 * `<2000`→low, `<8000`→medium, `<24000`→high, else→xhigh.
 * Defaults missing/non-numeric budgets to 8000 ("high").
 *
 * The ceiling stays at `xhigh` even though `max` exists: Anthropic's
 * `budget_tokens` is unbounded above, so any threshold chosen for a `max`
 * bucket would silently re-tier existing callers whose budgets already map to
 * `xhigh`. `max` is reachable only by explicit selection
 * (`output_config.effort`), which is an unambiguous request rather than an
 * inference from a token count.
 */
export function bucketEffort(budget: unknown): Effort {
  const n =
    typeof budget === "number" && Number.isFinite(budget) ? budget : 8000
  if (n < 2000) return "low"
  if (n < 8000) return "medium"
  if (n < 24000) return "high"
  return "xhigh"
}

/**
 * Clamp a bucketed effort to the closest value in `supported`. Ties resolve to
 * the lower-tier option (per EFFORT_ORDER).
 *
 * Iterates EFFORT_ORDER (canonical low→xhigh) so the first match on a given
 * distance is always the lower-tier value, regardless of input order in
 * `supported`.
 */
export function clampEffort(
  bucketed: Effort,
  supported: Array<string>,
): string {
  if (supported.includes(bucketed)) return bucketed
  const targetIdx = EFFORT_ORDER.indexOf(bucketed)
  let best: Effort | undefined
  let bestDist = Infinity
  for (let i = 0; i < EFFORT_ORDER.length; i++) {
    const value = EFFORT_ORDER[i]
    if (!supported.includes(value)) continue
    const dist = Math.abs(i - targetIdx)
    // strict `<` keeps the first (lower-tier) on ties
    if (dist < bestDist) {
      bestDist = dist
      best = value
    }
  }
  return best ?? bucketed
}
