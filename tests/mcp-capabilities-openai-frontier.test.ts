// Unit tests for the OpenAI-frontier resolver introduced with the
// gpt-5.6-sol swap: `resolveOpenAiFrontier` (prefer gpt-5.6-sol, fall back to
// gpt-5.5) and its two consumers `standInToolEnabled` / `nativeSubagentModel`.
//
// The load-bearing property: no capability that works on a gpt-5.5-only
// (rollout-lag) catalog regresses — the gate must still pass and the
// implementer subagent must still resolve, dispatching gpt-5.5.

import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  OPENAI_FRONTIER_MODELS,
  nativeSubagentModel,
  resolveOpenAiFrontier,
  standInToolEnabled,
} from "~/lib/mcp-capabilities"
import { state } from "~/lib/state"

const savedModels = state.models

function entry(id: string, toolCalls?: boolean) {
  return {
    id,
    name: id,
    object: "model",
    vendor: id.startsWith("gemini") ? "google" : id.startsWith("claude") ? "anthropic" : "openai",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: id,
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      limits: {},
      supports: toolCalls === undefined ? {} : { tool_calls: toolCalls },
    },
  }
}

function setCatalog(entries: Array<ReturnType<typeof entry>>) {
  state.models = { object: "list", data: entries as never }
}

afterEach(() => {
  state.models = savedModels
})

beforeEach(() => {
  state.models = undefined
})

test("OPENAI_FRONTIER_MODELS is [gpt-5.6-sol, gpt-5.5] in preference order", () => {
  expect(Array.from(OPENAI_FRONTIER_MODELS)).toEqual(["gpt-5.6-sol", "gpt-5.5"])
})

test("prefers gpt-5.6-sol when present", () => {
  setCatalog([entry("gpt-5.6-sol", true), entry("gpt-5.5", true)])
  expect(resolveOpenAiFrontier()).toBe("gpt-5.6-sol")
})

test("falls back to gpt-5.5 when gpt-5.6-sol is absent (rollout lag)", () => {
  setCatalog([entry("gpt-5.5", true), entry("gpt-5.4", true)])
  expect(resolveOpenAiFrontier()).toBe("gpt-5.5")
})

test("returns undefined when neither frontier model is present (fail closed)", () => {
  setCatalog([entry("gpt-5.4", true), entry("gemini-3.1-pro-preview", true)])
  expect(resolveOpenAiFrontier()).toBeUndefined()
})

test("returns undefined when the catalog is unset", () => {
  state.models = undefined
  expect(resolveOpenAiFrontier()).toBeUndefined()
})

test("requireToolCalls skips a frontier model that lacks tool_calls and falls through", () => {
  // gpt-5.6-sol present but WITHOUT tool_calls → skip; gpt-5.5 has them → win.
  setCatalog([entry("gpt-5.6-sol", false), entry("gpt-5.5", true)])
  expect(resolveOpenAiFrontier()).toBe("gpt-5.6-sol") // no requirement → first present
  expect(resolveOpenAiFrontier({ requireToolCalls: true })).toBe("gpt-5.5")
})

test("requireToolCalls returns undefined when no frontier model has tool_calls", () => {
  setCatalog([entry("gpt-5.6-sol", false), entry("gpt-5.5", false)])
  expect(resolveOpenAiFrontier({ requireToolCalls: true })).toBeUndefined()
})

test("nativeSubagentModel prefers gpt-5.6-sol, falls back to gpt-5.5, requires tool_calls", () => {
  setCatalog([entry("gpt-5.6-sol", true)])
  expect(nativeSubagentModel()).toBe("gpt-5.6-sol")

  setCatalog([entry("gpt-5.5", true)]) // rollout lag
  expect(nativeSubagentModel()).toBe("gpt-5.5")

  setCatalog([entry("gpt-5.6-sol", false)]) // present but no tool_calls
  expect(nativeSubagentModel()).toBeUndefined()

  setCatalog([entry("gpt-5.4", true)]) // neither frontier model
  expect(nativeSubagentModel()).toBeUndefined()
})

test("standInToolEnabled passes on a gpt-5.5-only (rollout-lag) catalog when opus + gemini are present", () => {
  setCatalog([
    entry("gpt-5.5", true), // sol absent — the OpenAI slot resolves to gpt-5.5
    entry("claude-opus-5", true),
    entry("gemini-3.1-pro-preview", true),
  ])
  expect(standInToolEnabled()).toBe(true)
})

test("standInToolEnabled keeps the Google slot on the Flash fallback", () => {
  setCatalog([
    entry("gpt-5.6-sol", true),
    entry("claude-opus-5", true),
    entry("gemini-3.8-flash", true),
  ])
  expect(standInToolEnabled()).toBe(true)
})

test("max standInToolEnabled ignores Gemini Pro and prefers Grok/high or Flash 1M/high", () => {
  const capable = (id: string, context: number, endpoint: string) => ({
    ...entry(id, true),
    supported_endpoints: [endpoint],
    capabilities: {
      ...entry(id, true).capabilities,
      limits: {
        max_context_window_tokens: context,
        max_prompt_tokens: Math.max(1, context - 20_000),
        max_output_tokens: 16_000,
      },
      supports: { tool_calls: true, reasoning_effort: ["medium", "high"] },
    },
  })
  setCatalog([
    capable("gpt-5.6-sol", 1_050_000, "/responses"),
    capable("claude-opus-5", 1_000_000, "/v1/messages"),
    capable("gemini-3.1-pro-preview", 1_000_000, "/chat/completions"),
    capable("gemini-3.8-flash", 1_000_000, "/chat/completions"),
    capable("grok-4.6", 500_000, "/responses"),
  ])
  expect(standInToolEnabled({ maxProfile: true })).toBe(true)

  setCatalog([
    capable("gpt-5.6-sol", 1_050_000, "/responses"),
    capable("claude-opus-5", 1_000_000, "/v1/messages"),
    capable("gemini-3.1-pro-preview", 1_000_000, "/chat/completions"),
  ])
  expect(standInToolEnabled({ maxProfile: true })).toBe(false)
})

test("standInToolEnabled fails closed when neither gpt-5.6-sol nor gpt-5.5 is present", () => {
  setCatalog([
    entry("gpt-5.4", true), // no OpenAI frontier model
    entry("claude-opus-5", true),
    entry("gemini-3.1-pro-preview", true),
  ])
  expect(standInToolEnabled()).toBe(false)
})

test("standInToolEnabled fails closed when the Anthropic peer is missing even with gpt-5.6-sol present", () => {
  setCatalog([
    entry("gpt-5.6-sol", true),
    entry("gemini-3.1-pro-preview", true),
  ])
  expect(standInToolEnabled()).toBe(false)
})
