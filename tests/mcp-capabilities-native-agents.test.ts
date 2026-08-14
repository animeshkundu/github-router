// Unit tests for the conditional cheaper-tier native resolvers and the 1M
// context floor they rely on.
//
// Two properties are load-bearing and neither was previously covered:
//
//   1. Each resolver returns undefined rather than a substitute when nothing in
//      its chain resolves. The caller then DROPS the agent. Costing less than
//      the lead is the whole point of these agents, so inheriting the lead's
//      model would be worse than not existing.
//   2. `minContextTokens` actually skips a sub-1M entry. Their descriptions
//      promise a 1M window, and `withOneMSuffix` would silently omit the `[1m]`
//      bracket for a shrunken model — leaving the agent budgeted at Claude
//      Code's 200K default with no signal. The floor is what keeps the promise
//      true against an upstream catalog change rather than merely asserted.
//
// `scoutModel` is covered here too because its luna -> Gemini chain carries the
// same 1M floor and drop-not-downgrade contract.

import { afterEach, expect, test } from "bun:test"

import {
  brainstormModel,
  generalPurposeFastModel,
  geminiAvailable,
  implementerFastModel,
  resolveGeminiReviewModel,
  reviewerFastModel,
  reviewerModel,
  SCOUT_MODEL_CHAIN,
  scoutModel,
} from "~/lib/mcp-capabilities"
import { state } from "~/lib/state"

const savedModels = state.models

const ONE_M = 1_000_000

function entry(
  id: string,
  opts?: { ctx?: number, toolCalls?: boolean },
) {
  return {
    id,
    name: id,
    object: "model",
    vendor: id.startsWith("gemini") ? "google" : "openai",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: id,
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      limits:
        opts?.ctx === undefined ? {} : { max_context_window_tokens: opts.ctx },
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

test("reviewer and brainstorm prefer Pro, then Flash, then OpenAI frontier", () => {
  setCatalog(
    entry("gemini-3.1-pro-preview", { ctx: ONE_M }),
    entry("gemini-3.7-flash", { ctx: ONE_M }),
    entry("gpt-5.6-sol", { ctx: 1_050_000 }),
  )
  expect(reviewerModel()).toBe("gemini-3.1-pro-preview")
  expect(brainstormModel()).toBe("gemini-3.1-pro-preview")

  setCatalog(
    entry("gemini-3.7-flash", { ctx: ONE_M }),
    entry("gpt-5.6-sol", { ctx: 1_050_000 }),
  )
  expect(reviewerModel()).toBe("gemini-3.7-flash")
  expect(brainstormModel()).toBe("gemini-3.7-flash")

  setCatalog(entry("gpt-5.6-sol", { ctx: 1_050_000 }))
  expect(reviewerModel()).toBe("gpt-5.6-sol")
  expect(brainstormModel()).toBe("gpt-5.6-sol")
})

// Regression: an earlier draft of the deprecation fix replaced the
// gemini-3.x-pro FAMILY regex `geminiAvailable()` used to use with exact
// string matches only, silently losing resilience to a GA rename. If Google
// ships `gemini-3.1-pro-preview` -> `gemini-3.1-pro` (drops "-preview") as the
// deprecation successor, that new id must still outrank Flash and OpenAI
// rather than being treated as an unrecognized model.
test("reviewer and brainstorm recognize a GA rename of the preview slug ahead of Flash", () => {
  setCatalog(
    entry("gemini-3.1-pro", { ctx: ONE_M }),
    entry("gemini-3.7-flash", { ctx: ONE_M }),
    entry("gpt-5.6-sol", { ctx: 1_050_000 }),
  )
  expect(reviewerModel()).toBe("gemini-3.1-pro")
  expect(brainstormModel()).toBe("gemini-3.1-pro")
  expect(resolveGeminiReviewModel()).toBe("gemini-3.1-pro")
  expect(geminiAvailable()).toBe(true)

  // Without a GA rename present, Flash still wins over OpenAI as before.
  setCatalog(
    entry("gemini-3.7-flash", { ctx: ONE_M }),
    entry("gpt-5.6-sol", { ctx: 1_050_000 }),
  )
  expect(resolveGeminiReviewModel()).toBe("gemini-3.7-flash")
})

test("reviewerFastModel is single-entry and enforces tool calls plus 1M", () => {
  setCatalog(entry("gemini-3.7-flash", { ctx: ONE_M }))
  expect(reviewerFastModel()).toBe("gemini-3.7-flash")

  setCatalog(entry("gemini-3.7-flash", { ctx: ONE_M, toolCalls: false }))
  expect(reviewerFastModel()).toBeUndefined()

  setCatalog(entry("gemini-3.7-flash", { ctx: 999_999 }))
  expect(reviewerFastModel()).toBeUndefined()

  setCatalog(entry("gemini-3.1-pro-preview", { ctx: ONE_M }))
  expect(reviewerFastModel()).toBeUndefined()
})

test("implementerFastModel prefers gpt-5.6-terra, falls back to gemini-3.1-pro-preview", () => {
  setCatalog(
    entry("gpt-5.6-terra", { ctx: 1_050_000 }),
    entry("gemini-3.1-pro-preview", { ctx: ONE_M }),
  )
  expect(implementerFastModel()).toBe("gpt-5.6-terra")

  setCatalog(entry("gemini-3.1-pro-preview", { ctx: ONE_M }))
  expect(implementerFastModel()).toBe("gemini-3.1-pro-preview")
})

// gpt-5.6-sol is deliberately absent from this chain: the OpenAI frontier coder
// is already `implementer`'s job, and a catch-all that quietly bills at frontier
// rates is the opposite of what the agent is for.
test("implementerFastModel does NOT fall through to the OpenAI frontier", () => {
  setCatalog(
    entry("gpt-5.6-sol", { ctx: 1_050_000 }),
    entry("gpt-5.5", { ctx: 1_050_000 }),
  )
  expect(implementerFastModel()).toBeUndefined()
})

test("generalPurposeFastModel is single-entry: gpt-5.6-luna or nothing", () => {
  setCatalog(entry("gpt-5.6-luna", { ctx: 1_050_000 }))
  expect(generalPurposeFastModel()).toBe("gpt-5.6-luna")

  setCatalog(
    entry("gpt-5.6-terra", { ctx: 1_050_000 }),
    entry("gemini-3.6-flash", { ctx: ONE_M }),
    entry("gemini-3.5-flash", { ctx: ONE_M }),
    entry("gpt-5.4-mini", { ctx: 400_000 }),
  )
  expect(generalPurposeFastModel()).toBeUndefined()
})

// The drop-not-downgrade rule. A thin catalog must not silently promote these
// agents onto the lead's model.
test("every conditional resolver returns undefined on an empty or absent catalog", () => {
  setCatalog()
  expect(implementerFastModel()).toBeUndefined()
  expect(reviewerFastModel()).toBeUndefined()
  expect(generalPurposeFastModel()).toBeUndefined()

  state.models = undefined
  expect(implementerFastModel()).toBeUndefined()
  expect(reviewerFastModel()).toBeUndefined()
  expect(generalPurposeFastModel()).toBeUndefined()
})

test("a chain entry without tool_calls is skipped, and absent metadata fails closed", () => {
  setCatalog(
    entry("gpt-5.6-terra", { ctx: 1_050_000, toolCalls: false }),
    entry("gemini-3.1-pro-preview", { ctx: ONE_M }),
  )
  expect(implementerFastModel()).toBe("gemini-3.1-pro-preview")

  // No `supports` metadata at all -> not selected.
  state.models = {
    object: "list",
    data: [
      {
        ...entry("gpt-5.6-luna", { ctx: 1_050_000 }),
        capabilities: {
          family: "gpt-5.6-luna",
          object: "model_capabilities",
          tokenizer: "o200k_base",
          type: "chat",
          limits: { max_context_window_tokens: 1_050_000 },
          supports: {},
        },
      },
    ] as never,
  }
  expect(generalPurposeFastModel()).toBeUndefined()
})

// The mutation this floor exists to catch: an id stays in the catalog with
// tool_calls intact, but its advertised window shrinks below 1M. Without the
// floor the chain still selects it, `withOneMSuffix` omits the bracket, and the
// agent is quietly budgeted at 200K while its description still promises 1M.
test("minContextTokens skips a chain entry whose window has dropped below 1M", () => {
  setCatalog(
    entry("gpt-5.6-terra", { ctx: 400_000 }),
    entry("gemini-3.1-pro-preview", { ctx: ONE_M }),
  )
  expect(implementerFastModel()).toBe("gemini-3.1-pro-preview")

  setCatalog(entry("gpt-5.6-luna", { ctx: 400_000 }))
  expect(generalPurposeFastModel()).toBeUndefined()
})

test("absent context metadata fails closed under the 1M floor", () => {
  setCatalog(entry("gpt-5.6-luna"))
  expect(generalPurposeFastModel()).toBeUndefined()
})

// Scout keeps a distinct cross-vendor 1M fallback. Pin the chain shape itself:
// referencing EXPLORE_DEFAULT_MODEL here previously let an explore retune collapse
// both entries to Luna without a type error or failed behavior test.
test("scout chain has two distinct literal entries", () => {
  expect(SCOUT_MODEL_CHAIN).toEqual(["gpt-5.6-luna", "gemini-3.6-flash"])
  expect(new Set(SCOUT_MODEL_CHAIN).size).toBe(2)
})

// The accepted consequence is that a catalog carrying neither Luna nor the
// 1M Gemini fallback gets no scout rather than a 400K last resort.
test("scoutModel walks luna -> flash, enforces 1M, and otherwise drops", () => {
  setCatalog(
    entry("gemini-3.6-flash", { ctx: ONE_M }),
    entry("gpt-5.6-luna", { ctx: 1_050_000 }),
  )
  expect(scoutModel()).toBe("gpt-5.6-luna")

  // Exactly 1M must remain eligible. If this floor comparison ever becomes
  // exclusive, scout silently loses its cross-vendor fallback.
  setCatalog(entry("gemini-3.6-flash", { ctx: ONE_M }))
  expect(scoutModel()).toBe("gemini-3.6-flash")

  setCatalog(
    entry("gpt-5.6-luna", { ctx: 400_000 }),
    entry("gemini-3.6-flash", { ctx: 200_000 }),
    entry("gpt-5.4-mini", { ctx: 400_000 }),
  )
  expect(scoutModel()).toBeUndefined()
})
