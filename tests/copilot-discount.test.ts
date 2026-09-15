import { describe, expect, test } from "bun:test"

import type { AicSnapshot } from "~/lib/aic-ledger"
import {
  DISCOUNT_FACTORS,
  discountedUsdForSnapshot,
  discountedUsdWithFactors,
  discountFactorFor,
  formatDiscountedCostTable,
} from "~/lib/copilot-discount"

function snapshot(
  perModel: Record<string, number>,
  tokensByModel: AicSnapshot["tokensByModel"] = {},
): AicSnapshot {
  const entries = Object.entries(perModel)
  return {
    totalNanoAiu: entries.reduce((n, [, v]) => n + v, 0),
    requests: entries.length,
    perModel: Object.fromEntries(
      entries.map(([k, v]) => [k, { nanoAiu: v, requests: 1 }]),
    ),
    perTokenType: {},
    tokensByModel,
  }
}

describe("discount factors", () => {
  test("locked rows match the snapshot analysis", () => {
    expect(discountFactorFor("gpt-5.6-sol")).toBe(0.28)
    expect(discountFactorFor("claude-opus-5")).toBe(0.62)
    expect(discountFactorFor("claude-sonnet-5")).toBe(0.66)
    expect(discountFactorFor("gpt-5.3-codex")).toBe(0.60)
    expect(discountFactorFor("gpt-5.4")).toBe(0.60)
    expect(discountFactorFor("gemini-3.7-flash")).toBe(0.29)
    expect(discountFactorFor("gpt-5.6-luna")).toBe(1.0)
    expect(discountFactorFor("grok-4.6")).toBe(1.0)
    expect(discountFactorFor("gemini-3.8-flash")).toBe(1.0)
  })

  test("unknown models default to 1.0 and every factor is a sane fraction", () => {
    expect(discountFactorFor("gpt-9-future")).toBe(1.0)
    expect(discountFactorFor("")).toBe(1.0)
    for (const row of Object.values(DISCOUNT_FACTORS)) {
      expect(row.factor).toBeGreaterThan(0)
      expect(row.factor).toBeLessThanOrEqual(1.0)
      expect(row.source.length).toBeGreaterThan(0)
    }
  })
})

describe("discountedUsdForSnapshot", () => {
  test("sol session: 12.42 credits × 0.28", () => {
    const r = discountedUsdForSnapshot(snapshot({ "gpt-5.6-sol": 12_420_000_000 }))
    expect(r.total).toBeCloseTo(0.034776, 12)
    expect(r.byModel["gpt-5.6-sol"]).toBeCloseTo(0.034776, 12)
    expect(r.capped).toBe(false)
  })

  test("luna long-context nano passes through at 1.0", () => {
    const r = discountedUsdForSnapshot(snapshot({ "gpt-5.6-luna": 5_000_000_000 }))
    expect(r.total).toBeCloseTo(0.05, 12)
    expect(r.capped).toBe(false)
  })

  test("multi-model sums per-model contributions", () => {
    const r = discountedUsdForSnapshot(
      snapshot({ "gpt-5.6-sol": 10_000_000_000, "grok-4.6": 10_000_000_000 }),
    )
    // 10cr × 0.28 + 10cr × 1.0 = 12.8cr → $0.128; cap is $0.20.
    expect(r.total).toBeCloseTo(0.128, 12)
    expect(r.capped).toBe(false)
  })

  test("corrupt factors degrade to 1.0, never NaN or negative", () => {
    const snap = snapshot({ m: 10_000_000_000 })
    for (const bad of [Number.NaN, -0.5, Number.POSITIVE_INFINITY]) {
      const r = discountedUsdWithFactors(snap, { m: { factor: bad, source: "test" } })
      expect(r.total).toBeCloseTo(0.1, 12)
      expect(r.capped).toBe(false)
    }
  })

  test("fat-finger factor can never overstate: cap binds, rows rescale", () => {
    const snap = snapshot({ "gpt-5.6-sol": 10_000_000_000 })
    const r = discountedUsdWithFactors(snap, {
      "gpt-5.6-sol": { factor: 2.8, source: "test" },
    })
    // Cap is 10cr × $0.01 = $0.10; raw would be $0.28.
    expect(r.capped).toBe(true)
    expect(r.total).toBeCloseTo(0.1, 12)
    expect(r.byModel["gpt-5.6-sol"]).toBeCloseTo(0.1, 12)
  })

  test("zero-nano session yields zero, never NaN", () => {
    const r = discountedUsdForSnapshot(
      snapshot({ "gpt-4.1": 0 }, { "gpt-4.1": { input: 146091, cache_read: 0, cache_write: 0, output: 0, other: 0 } }),
    )
    expect(r.total).toBe(0)
    expect(r.capped).toBe(false)
  })

  test("empty snapshot yields zero", () => {
    const r = discountedUsdForSnapshot(snapshot({}))
    expect(r).toEqual({ total: 0, byModel: {}, capped: false })
  })
})

describe("formatDiscountedCostTable", () => {
  const snap = snapshot(
    { "gpt-5.6-sol": 12_420_000_000, "grok-4.6": 6_670_000_000 },
    {
      "gpt-5.6-sol": { input: 178066254, cache_read: 8549020308, cache_write: 0, output: 18710695, other: 0 },
      "grok-4.6": { input: 163525363, cache_read: 512168992, cache_write: 0, output: 12700063, other: 0 },
    },
  )
  const table = formatDiscountedCostTable(snap, discountedUsdForSnapshot(snap))

  test("header, rows sorted by spend desc, total sums", () => {
    const lines = table.split("\n")
    expect(lines[0]).toContain("Session cost")
    expect(lines[1]).toMatch(/Model.*Uncached.*Cached.*Cache%.*Output.*\$/)
    // Sorted by spend desc: grok 6.67cr×1.0=$0.0667 above sol 12.42cr×0.28=$0.0348.
    expect(lines[2]).toContain("grok-4.6")
    expect(lines[3]).toContain("gpt-5.6-sol")
    expect(lines[4]).toContain("Total")
    expect(lines[4]).toContain("~$0.10")
  })

  test("cache% math + compact counts", () => {
    expect(table).toContain("98.0%")
    expect(table).toContain("8549.0M")
    expect(table).toContain("178.1M")
  })

  test("write column appears only with writes", () => {
    expect(table).not.toContain("Write")
    const withWrites = snapshot(
      { "gpt-5.6-luna": 1_000_000_000 },
      { "gpt-5.6-luna": { input: 1, cache_read: 10, cache_write: 2, output: 1, other: 0 } },
    )
    const t2 = formatDiscountedCostTable(withWrites, discountedUsdForSnapshot(withWrites))
    expect(t2).toContain("Write")
  })

  test("empty snapshot yields empty string", () => {
    expect(formatDiscountedCostTable(snapshot({}), discountedUsdForSnapshot(snapshot({})))).toBe("")
  })

  test("all lines align to the same width", () => {
    const lines = table.split("\n").slice(1)
    const widths = new Set(lines.map((l) => l.length))
    expect(widths.size).toBe(1)
  })
})
