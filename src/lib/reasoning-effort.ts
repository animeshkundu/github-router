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

export const EFFORT_ORDER = ["low", "medium", "high", "xhigh"] as const

export type Effort = (typeof EFFORT_ORDER)[number]

/**
 * Bucket a thinking budget into a Copilot reasoning-effort string.
 * `<2000`→low, `<8000`→medium, `<24000`→high, else→xhigh.
 * Defaults missing/non-numeric budgets to 8000 ("high").
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
