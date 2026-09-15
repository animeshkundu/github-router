/**
 * Approximate discounted USD for a session, from static per-model discount
 * factors applied to the AIC ledger's billed nano-AIU.
 *
 * Background: GitHub's portal lists per-token rates, but the spend dashboard
 * bills several models well below portal (gpt-5.6-sol ≈ 0.28x, the Opus /
 * Sonnet / Codex cluster ≈ 0.6x, gemini-3.7-flash ≈ 0.29x since Sep 2026),
 * while Luna bills long-context portal tiers and Grok / 3.8-flash bill
 * portal-default exactly. No uniform per-lab factor exists (verified across
 * 28d / MTD / 7d / daily windows), so each model carries its own factor.
 *
 * The factors scale NANO-AIU, not tokens × portal rates: nano is already
 * tier-correct upstream (long-context tiers, cache writes), so no tier
 * engine or portal-rate table is needed here. Displayed total is capped:
 * `min(factored, totalCredits × $0.01)` — the cap can only ever lower the
 * number (all factors ≤ 1), so a typo like 2.8-instead-of-0.28 degrades to
 * the unfactored total rather than overstating spend.
 *
 * Staleness: rates move (3.7-flash flipped 1.00x → 0.29x overnight once
 * already). Re-derive monthly from the portal + spend dashboard; drift
 * degrades to cap-bound display, never to overstatement.
 */

import type { AicSnapshot } from "./aic-ledger"
import { aicTotalCredits } from "./aic-ledger"

/** USD value of one AI credit (GitHub's published conversion). */
export const USD_PER_AIC_CREDIT = 0.01

export interface DiscountFactorRow {
  /** Multiply nano-implied USD by this. */
  factor: number
  /** Why this value: which snapshot window(s) it was derived from. */
  source: string
}

function row(factor: number, source: string): DiscountFactorRow {
  return { factor, source }
}

/**
 * Static per-model discount factors, keyed by resolved (Copilot-side) model
 * id — the same key the ledger's `perModel` uses. Derived Sep 2026 from the
 * 28d / MTD / 7d / daily spend-dashboard windows vs portal rates.
 */
export const DISCOUNT_FACTORS: Readonly<Record<string, DiscountFactorRow>> =
  Object.freeze({
    "gpt-5.6-sol": row(0.28, "0.27-0.29 across 28d/MTD/7d/pre/9-9; write-mix refuted"),
    "claude-opus-5": row(0.62, "0.61-0.64 across windows; 9/7 1.02 excluded as single-day artifact"),
    "claude-sonnet-5": row(0.66, "0.62-0.71 across windows"),
    "gpt-5.3-codex": row(0.60, "0.59-0.62 across windows"),
    "gpt-5.4": row(0.60, "single snapshot 0.598"),
    // Regime break: billed 1.00x pre-Sep, 0.29x since. Recheck FIRST at
    // every refresh — likeliest row to have moved again.
    "gemini-3.7-flash": row(0.29, "September regime; pre-Sep 1.00x — volatile"),
    // No discount: Luna's heat is long-context tiers + ~2% cache writes
    // (both already in nano); Grok / 3.8-flash bill portal-default exactly.
    "gpt-5.6-luna": row(1.0, "long-tier portal + writes, no discount"),
    "grok-4.6": row(1.0, "portal default, six windows"),
    "gemini-3.8-flash": row(1.0, "portal exact, six windows to the dollar"),
  })

/** Discount factor for a model id; 1.0 (no discount) when unlisted. */
export function discountFactorFor(modelId: string): number {
  return sanitizeFactor(DISCOUNT_FACTORS[modelId]?.factor)
}

/**
 * Clamp a factor to usable range. Non-finite or negative factors (corrupt
 * table edit, bad injection) degrade to 1.0 — unfactored but never NaN,
 * never negative on screen.
 */
function sanitizeFactor(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 1.0
}

export interface DiscountedUsd {
  /** Capped total actually displayed (`~$`). */
  total: number
  /** Per-model factored USD, scaled to the capped total when the cap binds. */
  byModel: Record<string, number>
  /** True when the cap (not the factors) decided the total. */
  capped: boolean
}

/**
 * Session discounted USD from a ledger snapshot. Total function: never
 * throws (guards non-finite/negative ledger values defensively — a corrupt
 * snapshot must degrade the status line, not crash the hook).
 */
export function discountedUsdForSnapshot(snapshot: AicSnapshot): DiscountedUsd {
  return discountedUsdWithFactors(snapshot, DISCOUNT_FACTORS)
}

/**
 * Factor-injectable core (exported for unit tests — e.g. proving a
 * fat-finger factor can never overstate spend). `factors` falls back to
 * 1.0 per model exactly like the table lookup.
 */
export function discountedUsdWithFactors(
  snapshot: AicSnapshot,
  factors: Readonly<Record<string, DiscountFactorRow>>,
): DiscountedUsd {
  const byModel: Record<string, number> = {}
  let sum = 0
  for (const [model, entry] of Object.entries(snapshot.perModel)) {
    const nano =
      typeof entry.nanoAiu === "number" && Number.isFinite(entry.nanoAiu)
        ? Math.max(0, entry.nanoAiu)
        : 0
    const factor = sanitizeFactor(factors[model]?.factor)
    const usd = (nano / 1_000_000_000) * USD_PER_AIC_CREDIT * factor
    byModel[model] = usd
    sum += usd
  }
  const cap = aicTotalCredits(snapshot) * USD_PER_AIC_CREDIT
  // Relative epsilon: per-model float summation can exceed the cap by a
  // final-ulp hair without any factor being wrong — only bind on a real gap.
  if (!(sum > cap * (1 + 1e-9)) || sum <= 0) {
    return { total: sum, byModel, capped: false }
  }
  // Cap binds (fat-finger factor, volatile row, unknown-model overstatement):
  // scale rows down proportionally so the table still sums to its Total.
  const scale = cap / sum
  const scaled: Record<string, number> = {}
  for (const [model, usd] of Object.entries(byModel)) {
    scaled[model] = usd * scale
  }
  return { total: cap, byModel: scaled, capped: true }
}

/** Format table dollars: always cents (`~$` added by callers that want it). */
export function formatTableUsd(usd: number): string {
  return usd.toFixed(2)
}

interface CostTableRow {
  model: string
  uncached: number
  cached: number
  writes: number
  output: number
  usd: number
}

/**
 * Beautiful per-model session cost table (plain text, no ANSI — it lands on
 * stderr / logs). Columns mirror the spend dashboard: Uncached / Cached /
 * [Write] / Cache% / Output / $. The Write column appears only when the
 * session actually wrote cache. `Cache% = cache_read / (cache_read + input)`;
 * writes are excluded (they are new tokens, not hits).
 */
export function formatDiscountedCostTable(
  snapshot: AicSnapshot,
  discounted: DiscountedUsd,
): string {
  const tokens = snapshot.tokensByModel ?? {}
  const models = new Set([...Object.keys(snapshot.perModel), ...Object.keys(tokens)])
  const rows: Array<CostTableRow> = []
  for (const model of models) {
    const t = tokens[model]
    rows.push({
      model,
      uncached: t?.input ?? 0,
      cached: t?.cache_read ?? 0,
      writes: t?.cache_write ?? 0,
      output: t?.output ?? 0,
      usd: discounted.byModel[model] ?? 0,
    })
  }
  if (rows.length === 0) return ""
  rows.sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model))

  const showWrites = rows.some((r) => r.writes > 0)
  const cachePct = (cached: number, uncached: number): string => {
    const denom = cached + uncached
    if (denom <= 0) return "—"
    return `${((cached / denom) * 100).toFixed(1)}%`
  }

  type Cell = { text: string; align: "left" | "right" }
  const header: Array<Cell> = [
    { text: "Model", align: "left" },
    { text: "Uncached", align: "right" },
    { text: "Cached", align: "right" },
  ]
  if (showWrites) header.push({ text: "Write", align: "right" })
  header.push(
    { text: "Cache%", align: "right" },
    { text: "Output", align: "right" },
    { text: "$", align: "right" },
  )

  const body: Array<Array<Cell>> = rows.map((r) => {
    const cells: Array<Cell> = [
      { text: r.model, align: "left" },
      { text: formatCount(r.uncached), align: "right" },
      { text: formatCount(r.cached), align: "right" },
    ]
    if (showWrites) cells.push({ text: formatCount(r.writes), align: "right" })
    cells.push(
      { text: cachePct(r.cached, r.uncached), align: "right" },
      { text: formatCount(r.output), align: "right" },
      { text: `~$${formatTableUsd(r.usd)}`, align: "right" },
    )
    return cells
  })

  const totalUncached = rows.reduce((n, r) => n + r.uncached, 0)
  const totalCached = rows.reduce((n, r) => n + r.cached, 0)
  const totalWrites = rows.reduce((n, r) => n + r.writes, 0)
  const totalOutput = rows.reduce((n, r) => n + r.output, 0)
  const totalCells: Array<Cell> = [
    { text: "Total", align: "left" },
    { text: formatCount(totalUncached), align: "right" },
    { text: formatCount(totalCached), align: "right" },
  ]
  if (showWrites) {
    totalCells.push({ text: formatCount(totalWrites), align: "right" })
  }
  totalCells.push(
    { text: cachePct(totalCached, totalUncached), align: "right" },
    { text: formatCount(totalOutput), align: "right" },
    { text: `~$${formatTableUsd(discounted.total)}`, align: "right" },
  )

  const widths = header.map((h, i) => {
    let w = h.text.length
    for (const row of [...body, totalCells]) {
      w = Math.max(w, row[i].text.length)
    }
    return w
  })
  const render = (cells: Array<Cell>): string =>
    cells
      .map((c, i) =>
        c.align === "left" ? c.text.padEnd(widths[i]) : c.text.padStart(widths[i]),
      )
      .join("  ")
  const lines = [
    "Session cost (discounted actuals, ~$):",
    render(header),
    ...body.map(render),
    render(totalCells),
  ]
  return lines.join("\n")
}

/** Compact count for table cells: `999` → `999`, `15234` → `15.2k`. */
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}
