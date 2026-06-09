import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  __resetCompressorBackendForTests,
  compressorAvailable,
  pickBackendFromCatalog,
} from "../src/lib/browser-mcp/compressor"
import { state } from "../src/lib/state"
import type { ModelsResponse } from "../src/services/copilot/get-models"

// A catalog model that advertises tool_calls support (the only capability
// `pickBackendFromCatalog` gates on). `withToolCalls: false` produces an
// otherwise-identical entry that the picker must skip.
const model = (id: string, withToolCalls = true) => ({
  id,
  name: id,
  vendor: "Test" as const,
  version: id,
  preview: true,
  model_picker_enabled: true,
  object: "model" as const,
  capabilities: {
    type: "chat",
    family: id,
    object: "model_capabilities",
    tokenizer: "o200k_base",
    limits: { max_context_window_tokens: 200_000 },
    supports: withToolCalls ? { tool_calls: true } : {},
  },
  supported_endpoints: ["/v1/chat/completions"],
})

function setCatalog(entries: Array<ReturnType<typeof model>>) {
  state.models = { object: "list", data: entries } as ModelsResponse
}

describe("browser-mcp compressor backend selection", () => {
  let savedModels: typeof state.models

  beforeEach(() => {
    savedModels = state.models
    __resetCompressorBackendForTests()
  })
  afterEach(() => {
    state.models = savedModels
    __resetCompressorBackendForTests()
  })

  test("prefers gpt-5.4-mini when all three chain entries are present (catalog order irrelevant)", () => {
    // Scrambled catalog order proves CHAIN order, not catalog order, wins.
    setCatalog([
      model("claude-haiku-4-5"),
      model("gemini-3.5-flash"),
      model("gpt-5.4-mini"),
    ])
    expect(pickBackendFromCatalog()).toBe("gpt-5.4-mini")
  })

  test("falls through to claude-haiku-4-5 when gpt-5.4-mini is absent", () => {
    setCatalog([model("gemini-3.5-flash"), model("claude-haiku-4-5")])
    expect(pickBackendFromCatalog()).toBe("claude-haiku-4-5")
  })

  test("selects gemini-3.5-flash only as the last resort", () => {
    setCatalog([model("gemini-3.5-flash")])
    expect(pickBackendFromCatalog()).toBe("gemini-3.5-flash")
  })

  test("skips a chain entry that lacks tool_calls support", () => {
    // gpt-5.4-mini present but without tool_calls → demote to haiku.
    setCatalog([
      model("gpt-5.4-mini", false),
      model("claude-haiku-4-5"),
    ])
    expect(pickBackendFromCatalog()).toBe("claude-haiku-4-5")
  })

  test("compressorAvailable() is false when no chain entry is in the catalog", () => {
    setCatalog([model("gpt-5.5"), model("claude-opus-4-8")])
    expect(compressorAvailable()).toBe(false)
    expect(pickBackendFromCatalog()).toBeUndefined()
  })
})
