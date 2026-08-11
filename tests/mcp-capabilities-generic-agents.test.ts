// Unit tests for the three `generic*` catch-all resolvers and the 1M context
// floor they rely on.
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
// `scoutModel` is covered here too because it shares the chain walk but
// deliberately does NOT take the floor: its `gpt-5.4-mini` last resort is 400K
// and is retained precisely for its wider availability.

import { afterEach, expect, test } from "bun:test"

import {
  genericCheapModel,
  genericFastModel,
  genericModel,
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

test("genericModel prefers gpt-5.6-terra, falls back to gemini-3.1-pro-preview", () => {
  setCatalog(
    entry("gpt-5.6-terra", { ctx: 1_050_000 }),
    entry("gemini-3.1-pro-preview", { ctx: ONE_M }),
  )
  expect(genericModel()).toBe("gpt-5.6-terra")

  setCatalog(entry("gemini-3.1-pro-preview", { ctx: ONE_M }))
  expect(genericModel()).toBe("gemini-3.1-pro-preview")
})

// gpt-5.6-sol is deliberately absent from this chain: the OpenAI frontier coder
// is already `implementer`'s job, and a catch-all that quietly bills at frontier
// rates is the opposite of what the agent is for.
test("genericModel does NOT fall through to the OpenAI frontier", () => {
  setCatalog(
    entry("gpt-5.6-sol", { ctx: 1_050_000 }),
    entry("gpt-5.5", { ctx: 1_050_000 }),
  )
  expect(genericModel()).toBeUndefined()
})

test("genericFastModel prefers gemini-3.6-flash, falls back to gemini-3.5-flash", () => {
  setCatalog(
    entry("gemini-3.6-flash", { ctx: ONE_M }),
    entry("gemini-3.5-flash", { ctx: ONE_M }),
  )
  expect(genericFastModel()).toBe("gemini-3.6-flash")

  setCatalog(entry("gemini-3.5-flash", { ctx: ONE_M }))
  expect(genericFastModel()).toBe("gemini-3.5-flash")
})

// The fallback stays inside the Gemini flash family rather than taking luna,
// which would otherwise be the natural cross-vendor choice: luna is
// genericCheapModel's ONLY entry, so sharing it would collapse two roster
// entries onto one model in the degraded case.
test("genericFastModel does not borrow generic-cheap's model", () => {
  setCatalog(entry("gpt-5.6-luna", { ctx: 1_050_000 }))
  expect(genericFastModel()).toBeUndefined()
  expect(genericCheapModel()).toBe("gpt-5.6-luna")
})

test("genericCheapModel is single-entry: gpt-5.6-luna or nothing", () => {
  setCatalog(entry("gpt-5.6-luna", { ctx: 1_050_000 }))
  expect(genericCheapModel()).toBe("gpt-5.6-luna")

  setCatalog(
    entry("gpt-5.6-terra", { ctx: 1_050_000 }),
    entry("gemini-3.6-flash", { ctx: ONE_M }),
    entry("gpt-5.4-mini", { ctx: 400_000 }),
  )
  expect(genericCheapModel()).toBeUndefined()
})

// The drop-not-downgrade rule. A thin catalog must not silently promote these
// agents onto the lead's model.
test("every generic resolver returns undefined on an empty or absent catalog", () => {
  setCatalog()
  expect(genericModel()).toBeUndefined()
  expect(genericFastModel()).toBeUndefined()
  expect(genericCheapModel()).toBeUndefined()

  state.models = undefined
  expect(genericModel()).toBeUndefined()
  expect(genericFastModel()).toBeUndefined()
  expect(genericCheapModel()).toBeUndefined()
})

test("a chain entry without tool_calls is skipped, and absent metadata fails closed", () => {
  setCatalog(
    entry("gpt-5.6-terra", { ctx: 1_050_000, toolCalls: false }),
    entry("gemini-3.1-pro-preview", { ctx: ONE_M }),
  )
  expect(genericModel()).toBe("gemini-3.1-pro-preview")

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
  expect(genericCheapModel()).toBeUndefined()
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
  expect(genericModel()).toBe("gemini-3.1-pro-preview")

  setCatalog(
    entry("gemini-3.6-flash", { ctx: 128_000 }),
    entry("gemini-3.5-flash", { ctx: 200_000 }),
  )
  expect(genericFastModel()).toBeUndefined()

  setCatalog(entry("gpt-5.6-luna", { ctx: 400_000 }))
  expect(genericCheapModel()).toBeUndefined()
})

test("absent context metadata fails closed under the 1M floor", () => {
  setCatalog(entry("gpt-5.6-luna"))
  expect(genericCheapModel()).toBeUndefined()
})

// scout shares the walk but NOT the floor: `gpt-5.4-mini` is 400K and is
// retained as the last resort because its `restricted_to` is the widest of the
// three (it includes individual_trial and edu). On a thin non-enterprise
// catalog a 400K scout beats no scout.
test("scoutModel walks flash -> luna -> mini and keeps its sub-1M last resort", () => {
  setCatalog(
    entry("gemini-3.6-flash", { ctx: ONE_M }),
    entry("gpt-5.6-luna", { ctx: 1_050_000 }),
    entry("gpt-5.4-mini", { ctx: 400_000 }),
  )
  expect(scoutModel()).toBe("gemini-3.6-flash")

  setCatalog(
    entry("gpt-5.6-luna", { ctx: 1_050_000 }),
    entry("gpt-5.4-mini", { ctx: 400_000 }),
  )
  expect(scoutModel()).toBe("gpt-5.6-luna")

  setCatalog(entry("gpt-5.4-mini", { ctx: 400_000 }))
  expect(scoutModel()).toBe("gpt-5.4-mini")
})
