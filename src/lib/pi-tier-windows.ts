import consola from "consola"

import type { Model } from "~/services/copilot/get-models"

/**
 * Copilot Default-tier (cheap) input-token thresholds per model.
 *
 * Sourced from https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 * (per 1M tokens; tiers key on per-request INPUT tokens):
 *   - gpt-6-luna: Default ≤ 272K ($0.10 in) vs Long > 272K ($0.20 in)
 *   - gpt-6-sol:  Default ≤ 272K ($2.00 in) vs Long > 272K ($4.00 in)
 *   - grok-4.6:   Default ≤ 200K ($2.00 in) vs Long > 200K ($4.00 in)
 *
 * The live catalog carries no tier data (flat `billing.token_prices` +
 * single `limits.*` only), so this table is hardcoded by exact model id —
 * same precedent as `FALLBACK_TOKEN_PRICES`. Anything not listed here
 * runs at the 200K default window. LAST_VERIFIED 2026-09-24: refresh the
 * values (and the drift expectations below) when the billing doc changes.
 */
export const PI_TIER_THRESHOLDS: Readonly<Record<string, number>> = Object.freeze({
  "gpt-6-luna": 272_000,
  "gpt-6-sol": 272_000,
  "grok-4.6": 200_000,
})

/** Window for models with no pinned tier threshold. */
export const PI_TIER_FALLBACK_TOKENS = 200_000 as const

/** Pinned Default-tier threshold for a model id, or the 200K fallback. */
export function piTierThresholdFor(modelId: string): number {
  return PI_TIER_THRESHOLDS[modelId] ?? PI_TIER_FALLBACK_TOKENS
}

/**
 * Effective Pi `contextWindow` for a model: its cheap-tier threshold,
 * defensively capped at the catalog-advertised total window so a stale
 * table can never budget above what Copilot serves.
 */
export function piContextWindowFor(
  modelId: string,
  advertisedMaxContextTokens?: number,
): number {
  const threshold = piTierThresholdFor(modelId)
  if (
    typeof advertisedMaxContextTokens === "number"
    && Number.isFinite(advertisedMaxContextTokens)
    && advertisedMaxContextTokens > 0
  ) {
    return Math.min(threshold, Math.floor(advertisedMaxContextTokens))
  }
  return threshold
}

const EXPECTED_DEFAULT_INPUT_PER_1M: Readonly<Record<string, number>> =
  Object.freeze({
    "gpt-6-luna": 0.1,
    "gpt-6-sol": 2.0,
    "grok-4.6": 2.0,
  })

/**
 * Warn loudly when live catalog input prices disagree with the pinned
 * tier table's implied Default rates — the table (or the billing doc)
 * drifted and needs a refresh. Warn-only; never blocks a launch.
 * Pure over caller-supplied rows so it is unit-testable.
 */
export function tierPriceDriftWarnings(
  rows: ReadonlyArray<{ id: string; inputPer1M: number | undefined }>,
): Array<string> {
  const warnings: Array<string> = []
  for (const row of rows) {
    const expected = EXPECTED_DEFAULT_INPUT_PER_1M[row.id]
    if (expected === undefined) continue
    if (row.inputPer1M === undefined) continue
    if (Math.abs(row.inputPer1M - expected) > 1e-9) {
      warnings.push(
        `Copilot catalog prices for "${row.id}" ($${row.inputPer1M}/1M input) disagree with the pinned Pi tier table ($${expected}/1M Default). Refresh PI_TIER_THRESHOLDS in src/lib/pi-tier-windows.ts.`,
      )
    }
  }
  return warnings
}

/** Emit drift warnings to stderr (launch-time seam). */
export function warnOnTierPriceDrift(
  rows: ReadonlyArray<{ id: string; inputPer1M: number | undefined }>,
): void {
  for (const warning of tierPriceDriftWarnings(rows)) {
    consola.warn(warning)
  }
}

/**
 * Normalize live catalog input prices to per-1M rows for the drift guard.
 * Same validation as `livePricesFor` (batch must be a positive safe
 * integer, prices finite and non-negative); anything else yields
 * `undefined` (unknown — skipped, never treated as drift).
 */
export function liveInputPer1M(
  models: ReadonlyArray<Model> | undefined,
): Array<{ id: string; inputPer1M: number | undefined }> {
  return (models ?? []).map((m) => {
    const prices = m.billing?.token_prices
    const batch = prices?.batch_size
    const input = prices?.input_price
    const valid =
      typeof batch === "number" && Number.isSafeInteger(batch) && batch > 0
      && typeof input === "number" && Number.isFinite(input) && input >= 0
    return {
      id: m.id,
      inputPer1M: valid ? input / 1e9 * 1e6 / (batch as number) : undefined,
    }
  })
}

/** One-call launch seam: normalize the live catalog and warn on drift. */
export function warnOnTierPriceDriftForModels(
  models: ReadonlyArray<Model> | undefined,
): void {
  warnOnTierPriceDrift(liveInputPer1M(models))
}
