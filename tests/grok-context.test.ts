// Pure-function tests for the Grok conservative-compaction-trigger
// derivation. This helper is SCAFFOLDING ONLY — it is not wired into any
// live request path yet (see the module doc comment); these tests pin the
// arithmetic so a future per-model client declaration can be activated
// against a known-correct derivation rather than a hand-recomputed one.

import { describe, expect, test } from "bun:test"

import { computeConservativeCompactionTrigger } from "~/lib/grok-context"

describe("computeConservativeCompactionTrigger", () => {
  test("Grok 4.6's live catalog shape yields the plan's recorded figures", () => {
    // max_prompt_tokens=372_000, max_output_tokens=128_000 (Grok 4.6).
    const result = computeConservativeCompactionTrigger(372_000, 128_000)
    expect(result.triggerTokens).toBe(316_200)
    // Output reserve clamps to 20_000 (Grok's 128K max output exceeds it).
    expect(result.assumedClientWindowTokens).toBe(336_200)
  })

  test("floors a non-integer 85% product", () => {
    const result = computeConservativeCompactionTrigger(100_001, 0)
    // 100_001 * 0.85 = 85000.85 -> floor to 85000.
    expect(result.triggerTokens).toBe(85_000)
    expect(result.assumedClientWindowTokens).toBe(85_000)
  })

  test("output reserve clamps to min(maxOutputTokens, 20_000)", () => {
    const smallOutput = computeConservativeCompactionTrigger(200_000, 5_000)
    expect(smallOutput.triggerTokens).toBe(170_000)
    expect(smallOutput.assumedClientWindowTokens).toBe(175_000)

    const largeOutput = computeConservativeCompactionTrigger(200_000, 999_000)
    expect(largeOutput.triggerTokens).toBe(170_000)
    // Reserve caps at 20_000 regardless of how large maxOutputTokens is.
    expect(largeOutput.assumedClientWindowTokens).toBe(190_000)
  })

  test("zero inputs derive zero, not a crash", () => {
    const result = computeConservativeCompactionTrigger(0, 0)
    expect(result.triggerTokens).toBe(0)
    expect(result.assumedClientWindowTokens).toBe(0)
  })
})
