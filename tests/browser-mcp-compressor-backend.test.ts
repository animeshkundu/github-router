import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  __resetCompressorBackendForTests,
  compressorAvailable,
  pickBackendFromCatalog,
} from "../src/lib/browser-mcp/compressor"
import { state } from "../src/lib/state"
import type { ModelsResponse } from "../src/services/copilot/get-models"

// A catalog model. `toolCalls` gates the tool_calls capability; `endpoints`
// is the catalog `supported_endpoints` the endpoint-aware selector reads
// (live strings are "/chat/completions" and "/responses" — NO /v1 prefix).
const model = (
  id: string,
  opts: { toolCalls?: boolean; endpoints?: Array<string> } = {},
) => ({
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
    supports: opts.toolCalls === false ? {} : { tool_calls: true },
  },
  supported_endpoints: opts.endpoints ?? ["/chat/completions"],
})

function setCatalog(entries: Array<ReturnType<typeof model>>) {
  state.models = { object: "list", data: entries } as ModelsResponse
}

describe("browser-mcp compressor backend selection (endpoint-aware)", () => {
  let savedModels: typeof state.models

  beforeEach(() => {
    savedModels = state.models
    __resetCompressorBackendForTests()
  })
  afterEach(() => {
    state.models = savedModels
    __resetCompressorBackendForTests()
  })

  test("prefers gpt-5.4-mini (selected for /responses) when present", () => {
    // gpt-5.4-mini is /responses-only — the chain head must still pick it.
    setCatalog([
      model("claude-haiku-4-5"),
      model("claude-sonnet-4-6"),
      model("gpt-5.4-mini", { endpoints: ["/responses", "ws:/responses"] }),
    ])
    expect(pickBackendFromCatalog()).toBe("gpt-5.4-mini")
  })

  test("falls through to claude-sonnet-4-6 when gpt-5.4-mini is absent", () => {
    setCatalog([model("claude-sonnet-4-6"), model("claude-haiku-4-5")])
    expect(pickBackendFromCatalog()).toBe("claude-sonnet-4-6")
  })

  test("selects claude-haiku-4-5 as the last resort", () => {
    setCatalog([model("claude-haiku-4-5")])
    expect(pickBackendFromCatalog()).toBe("claude-haiku-4-5")
  })

  test("skips a chain entry that lacks tool_calls support", () => {
    setCatalog([
      model("gpt-5.4-mini", { toolCalls: false, endpoints: ["/responses"] }),
      model("claude-sonnet-4-6"),
    ])
    expect(pickBackendFromCatalog()).toBe("claude-sonnet-4-6")
  })

  test("regression: skips a chain entry that serves NEITHER /chat/completions NOR /responses", () => {
    // The class of bug that broke the compressor: a model advertising
    // tool_calls but reachable through neither of our clients must be
    // skipped, not cached as a dead backend that 400s every call.
    setCatalog([
      model("gpt-5.4-mini", { endpoints: ["ws:/responses"] }),
      model("claude-sonnet-4-6"),
    ])
    expect(pickBackendFromCatalog()).toBe("claude-sonnet-4-6")
  })

  test("compressorAvailable() is false when no chain entry is in the catalog", () => {
    setCatalog([model("gpt-5.5"), model("claude-opus-4-8")])
    expect(compressorAvailable()).toBe(false)
    expect(pickBackendFromCatalog()).toBeUndefined()
  })
})
