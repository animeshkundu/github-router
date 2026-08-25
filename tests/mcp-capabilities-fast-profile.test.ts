// Unit tests for the fast-launch-profile native model resolvers
// (`fastScoutModel`/`fastImplementerFastModel`/`fastReviewerFastModel`).
//
// These are DELIBERATELY separate resolvers from the standard-profile ones
// covered in `mcp-capabilities-native-agents.test.ts`: single-entry,
// no-fallback, pinned to the fast profile's exact roster (scout/
// implementer-fast -> Luna, reviewer-fast -> Grok). Load-bearing properties
// pinned here:
//
//   1. Each resolver requires `tool_calls` and returns undefined (never a
//      substitute) when its one entry is absent or lacks it.
//   2. The Luna-backed resolvers additionally require >=1M advertised
//      context (matching the standard `scoutModel`/`implementerFastModel`
//      1M-floor contract).
//   3. `fastReviewerFastModel` checks `max_prompt_tokens` against a
//      conservative floor rather than `max_context_window_tokens` — Grok
//      4.6's total context (500K) is below the 1M floor the other two fast
//      natives require, so gating on total context would always fail and
//      silently drop the agent.

import { afterEach, expect, test } from "bun:test"

import {
  FAST_IMPLEMENTER_FAST_MODEL,
  FAST_REVIEWER_FAST_MODEL,
  FAST_REVIEWER_MIN_PROMPT_TOKENS,
  FAST_SCOUT_MODEL,
  fastImplementerFastModel,
  fastReviewerFastModel,
  fastScoutModel,
} from "~/lib/mcp-capabilities"
import { state } from "~/lib/state"

const savedModels = state.models
const ONE_M = 1_000_000

function entry(
  id: string,
  opts?: { ctx?: number, maxPrompt?: number, toolCalls?: boolean },
) {
  return {
    id,
    name: id,
    object: "model",
    vendor: id.startsWith("grok") ? "xai" : "openai",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: id,
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      limits: {
        ...(opts?.ctx === undefined ? {} : { max_context_window_tokens: opts.ctx }),
        ...(opts?.maxPrompt === undefined ? {} : { max_prompt_tokens: opts.maxPrompt }),
      },
      supports:
        opts?.toolCalls === false ? { tool_calls: false } : { tool_calls: true },
    },
  }
}

function setCatalog(...entries: Array<ReturnType<typeof entry>>) {
  state.models = { object: "list", data: entries as never }
}

afterEach(() => {
  state.models = savedModels
})

test("fastScoutModel and fastImplementerFastModel pin to Luna, requiring tool_calls + 1M", () => {
  expect(FAST_SCOUT_MODEL).toBe("gpt-5.6-luna")
  expect(FAST_IMPLEMENTER_FAST_MODEL).toBe("gpt-5.6-luna")

  setCatalog(entry("gpt-5.6-luna", { ctx: 1_050_000 }))
  expect(fastScoutModel()).toBe("gpt-5.6-luna")
  expect(fastImplementerFastModel()).toBe("gpt-5.6-luna")

  // Below the 1M floor -> dropped, not downgraded.
  setCatalog(entry("gpt-5.6-luna", { ctx: 400_000 }))
  expect(fastScoutModel()).toBeUndefined()
  expect(fastImplementerFastModel()).toBeUndefined()

  // No tool_calls -> dropped.
  setCatalog(entry("gpt-5.6-luna", { ctx: 1_050_000, toolCalls: false }))
  expect(fastScoutModel()).toBeUndefined()
  expect(fastImplementerFastModel()).toBeUndefined()

  // Absent entirely -> dropped.
  setCatalog(entry("gpt-5.6-sol", { ctx: 1_050_000 }))
  expect(fastScoutModel()).toBeUndefined()
  expect(fastImplementerFastModel()).toBeUndefined()

  // No fallback: another 1M-context Luna-adjacent model must NOT substitute.
  setCatalog(entry("gpt-5.6-terra", { ctx: 1_050_000 }))
  expect(fastScoutModel()).toBeUndefined()
})

test("fastReviewerFastModel pins to Grok 4.6 via max_prompt_tokens, not total context", () => {
  expect(FAST_REVIEWER_FAST_MODEL).toBe("grok-4.6")

  // Grok's real advertised shape: 500K total / 372K max prompt. Total context
  // is BELOW the 1M floor the other two fast natives require, so this
  // resolver must not gate on it.
  setCatalog(entry("grok-4.6", { ctx: 500_000, maxPrompt: 372_000 }))
  expect(fastReviewerFastModel()).toBe("grok-4.6")

  // Below the conservative max_prompt_tokens floor -> dropped.
  setCatalog(entry("grok-4.6", { ctx: 500_000, maxPrompt: FAST_REVIEWER_MIN_PROMPT_TOKENS - 1 }))
  expect(fastReviewerFastModel()).toBeUndefined()

  // Missing max_prompt_tokens entirely -> fails closed (treated as 0).
  setCatalog(entry("grok-4.6", { ctx: 500_000 }))
  expect(fastReviewerFastModel()).toBeUndefined()

  // No tool_calls -> dropped.
  setCatalog(entry("grok-4.6", { ctx: 500_000, maxPrompt: 372_000, toolCalls: false }))
  expect(fastReviewerFastModel()).toBeUndefined()

  // Absent entirely -> dropped, no fallback to any other model.
  setCatalog(entry("gemini-3.7-flash", { ctx: ONE_M, maxPrompt: ONE_M }))
  expect(fastReviewerFastModel()).toBeUndefined()
})
