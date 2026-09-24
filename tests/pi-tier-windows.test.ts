import { describe, expect, test } from "bun:test"

import {
  liveInputPer1M,
  PI_TIER_FALLBACK_TOKENS,
  piContextWindowFor,
  piTierThresholdFor,
  tierPriceDriftWarnings,
} from "~/lib/pi-tier-windows"

describe("pi tier thresholds", () => {
  test("pinned cheap-tier thresholds", () => {
    expect(piTierThresholdFor("gpt-6-luna")).toBe(272_000)
    expect(piTierThresholdFor("gpt-6-sol")).toBe(272_000)
    expect(piTierThresholdFor("grok-4.6")).toBe(200_000)
  })

  test("unknown model falls back to 200K", () => {
    expect(piTierThresholdFor("gpt-9-unknown")).toBe(200_000)
    expect(piTierThresholdFor("")).toBe(200_000)
    expect(PI_TIER_FALLBACK_TOKENS).toBe(200_000)
  })

  test("window is capped at the advertised catalog total", () => {
    expect(piContextWindowFor("gpt-6-luna", 1_050_000)).toBe(272_000)
    expect(piContextWindowFor("gpt-6-sol", 200_000)).toBe(200_000)
    expect(piContextWindowFor("grok-4.6", 0)).toBe(200_000)
    expect(piContextWindowFor("gpt-9-unknown", undefined)).toBe(200_000)
    expect(piContextWindowFor("gpt-9-unknown", 1_000_000)).toBe(200_000)
  })
})

describe("live catalog price normalization", () => {
  test("per-1M math with validation", () => {
    const rows = liveInputPer1M([
      { id: "gpt-6-luna", billing: { is_premium: false, multiplier: 1, token_prices: { input_price: 1e9 * 0.1, batch_size: 1_000_000 } } } as never,
      { id: "bad-batch", billing: { is_premium: false, multiplier: 1, token_prices: { input_price: 5, batch_size: 0 } } } as never,
      { id: "no-billing" } as never,
    ])
    expect(rows).toEqual([
      { id: "gpt-6-luna", inputPer1M: 0.1 },
      { id: "bad-batch", inputPer1M: undefined },
      { id: "no-billing", inputPer1M: undefined },
    ])
  })
})

describe("tier price drift guard", () => {
  test("matching Default rates stay silent", () => {
    expect(
      tierPriceDriftWarnings([
        { id: "gpt-6-luna", inputPer1M: 0.1 },
        { id: "gpt-6-sol", inputPer1M: 2.0 },
        { id: "grok-4.6", inputPer1M: 2.0 },
      ]),
    ).toEqual([])
  })

  test("drifted or Long-tier pricing warns per model", () => {
    const warnings = tierPriceDriftWarnings([
      { id: "gpt-6-luna", inputPer1M: 0.2 },
      { id: "gpt-6-sol", inputPer1M: 2.0 },
      { id: "gpt-9-unknown", inputPer1M: 99 },
      { id: "grok-4.6", inputPer1M: undefined },
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("gpt-6-luna")
    expect(warnings[0]).toContain("pi-tier-windows.ts")
  })
})
