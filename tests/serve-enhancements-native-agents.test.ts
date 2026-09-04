import { afterEach, expect, test } from "bun:test"

import { resolveServeNativeAgentOptions } from "~/lib/serve/enhancements"
import { state } from "~/lib/state"

const savedModels = state.models

function model(id: string) {
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
      limits: { max_context_window_tokens: 1_000_000 },
      supports: { tool_calls: true },
    },
  }
}

afterEach(() => {
  state.models = savedModels
})

test("serve resolves reviewer-fast once and propagates matching availability", () => {
  state.models = {
    object: "list",
    data: [model("gemini-3.8-flash")] as never,
  }
  const resolved = resolveServeNativeAgentOptions()
  expect(resolved.models.reviewerFastModel).toBe("gemini-3.8-flash")
  expect(resolved.nativeAvailability.reviewerFastAvailable).toBe(true)
})

test("serve omits reviewer-fast consistently when its model is unavailable", () => {
  state.models = { object: "list", data: [] as never }
  const resolved = resolveServeNativeAgentOptions()
  expect(resolved.models.reviewerFastModel).toBeUndefined()
  expect(resolved.nativeAvailability.reviewerFastAvailable).toBe(false)
})
