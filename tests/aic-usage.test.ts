import { describe, expect, test } from "bun:test"

import {
  creditsForDetail,
  extractCopilotUsage,
  formatAic,
  nanoAiuToCredits,
  NANO_AIU_PER_CREDIT,
} from "~/lib/aic-usage"

// Verified live 2026-09-14: gpt-6-luna /responses non-streaming.
const LUNA_RESPONSE = {
  copilot_usage: {
    token_details: [
      { batch_size: 1000000, cost_per_batch: 20000000000, model: "gpt-6-luna", token_count: 11, token_type: "input" },
      { batch_size: 1000000, cost_per_batch: 2000000000, model: "gpt-6-luna", token_count: 0, token_type: "cache_read" },
      { batch_size: 1000000, cost_per_batch: 25000000000, model: "gpt-6-luna", token_count: 0, token_type: "cache_write" },
      { batch_size: 1000000, cost_per_batch: 120000000000, model: "gpt-6-luna", token_count: 5, token_type: "output" },
    ],
    total_nano_aiu: 820000,
  },
  usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
}

describe("extractCopilotUsage", () => {
  test("parses the verified live shape", () => {
    const usage = extractCopilotUsage(LUNA_RESPONSE.copilot_usage)
    expect(usage).toBeDefined()
    expect(usage!.totalNanoAiu).toBe(820000)
    expect(usage!.tokenDetails).toHaveLength(4)
    expect(usage!.tokenDetails[0]).toEqual({
      model: "gpt-6-luna",
      tokenType: "input",
      tokenCount: 11,
      batchSize: 1000000,
      costPerBatch: 20000000000,
    })
  })

  test("per-detail costs reconstruct the reported total", () => {
    const usage = extractCopilotUsage(LUNA_RESPONSE.copilot_usage)!
    const sum = usage.tokenDetails.reduce((acc, d) => acc + creditsForDetail(d), 0)
    // 11×20e9/1e6 + 5×120e9/1e6 nano = 820000 nano — the reconstruction holds.
    expect(sum).toBeCloseTo(nanoAiuToCredits(820000), 12)
  })

  test("returns undefined for missing/invalid input and never throws", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "copilot_usage",
      [],
      {},
      { total_nano_aiu: "820000" },
      { total_nano_aiu: -1 },
      { total_nano_aiu: Number.NaN },
    ]) {
      expect(extractCopilotUsage(bad)).toBeUndefined()
    }
    // token_details is optional — a non-array is ignored, not fatal.
    expect(
      extractCopilotUsage({ total_nano_aiu: 100, token_details: "not-an-array" }),
    ).toEqual({ totalNanoAiu: 100, tokenDetails: [] })
    // Invalid details are skipped, valid ones kept.
    const mixed = extractCopilotUsage({
      total_nano_aiu: 100,
      token_details: [{ batch_size: 0, token_count: 5 }, null, "x"],
    })
    expect(mixed?.tokenDetails).toEqual([])
  })

  test("floors fractional nano values", () => {
    expect(extractCopilotUsage({ total_nano_aiu: 99.9 })?.totalNanoAiu).toBe(99)
  })
})

describe("nanoAiuToCredits", () => {
  test("divides by 1e9", () => {
    expect(nanoAiuToCredits(NANO_AIU_PER_CREDIT)).toBe(1)
    expect(nanoAiuToCredits(820000)).toBeCloseTo(0.00082, 12)
  })

  test("non-positive/non-finite yields 0", () => {
    expect(nanoAiuToCredits(0)).toBe(0)
    expect(nanoAiuToCredits(-5)).toBe(0)
    expect(nanoAiuToCredits(Number.NaN)).toBe(0)
    expect(nanoAiuToCredits(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe("formatAic", () => {
  test("adapts precision to magnitude", () => {
    expect(formatAic(0)).toBe("0")
    expect(formatAic(-1)).toBe("0")
    expect(formatAic(12.424)).toBe("12.42")
    expect(formatAic(150.55)).toBe("150.6")
    expect(formatAic(0.5)).toBe("0.500")
    expect(formatAic(0.00082)).toBe("0.00082")
  })
})
