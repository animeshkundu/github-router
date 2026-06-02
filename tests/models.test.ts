import { test, expect } from "bun:test"

import { __testing } from "../src/models"
import type { Model } from "../src/services/copilot/get-models"

const { filterModels, groupByVendor, formatModel, formatTokens } = __testing

function makeModel(over: Partial<Model> & Pick<Model, "id" | "vendor">): Model {
  return {
    id: over.id,
    vendor: over.vendor,
    name: over.name ?? over.id,
    object: over.object ?? "model",
    preview: over.preview ?? false,
    model_picker_enabled: over.model_picker_enabled ?? true,
    version: over.version ?? "1",
    capabilities: over.capabilities ?? {
      family: "test-family",
      type: "chat",
      object: "model_capabilities",
      tokenizer: "cl100k_base",
      limits: {},
      supports: {},
    },
    supported_endpoints: over.supported_endpoints,
    requestHeaders: over.requestHeaders,
    policy: over.policy,
    billing: over.billing,
    is_chat_default: over.is_chat_default,
    is_chat_fallback: over.is_chat_fallback,
    model_picker_category: over.model_picker_category,
    info_messages: over.info_messages,
  }
}

test("filterModels matches by id substring (case-insensitive)", () => {
  const ms = [
    makeModel({ id: "claude-opus-4.7", vendor: "Anthropic" }),
    makeModel({ id: "gpt-5", vendor: "OpenAI" }),
    makeModel({ id: "gemini-3.1-pro", vendor: "Google" }),
  ]
  expect(filterModels(ms, "opus").map((m) => m.id)).toEqual(["claude-opus-4.7"])
  expect(filterModels(ms, "OPUS").map((m) => m.id)).toEqual(["claude-opus-4.7"])
  expect(filterModels(ms, "5").map((m) => m.id)).toEqual(["gpt-5"])
})

test("filterModels matches by vendor and family", () => {
  const ms = [
    makeModel({
      id: "model-a",
      vendor: "Anthropic",
      capabilities: {
        family: "claude-opus",
        type: "chat",
        object: "model_capabilities",
        tokenizer: "cl100k",
        limits: {},
        supports: {},
      },
    }),
    makeModel({
      id: "model-b",
      vendor: "OpenAI",
      capabilities: {
        family: "gpt-5",
        type: "chat",
        object: "model_capabilities",
        tokenizer: "o200k",
        limits: {},
        supports: {},
      },
    }),
  ]
  expect(filterModels(ms, "anthropic").map((m) => m.id)).toEqual(["model-a"])
  expect(filterModels(ms, "claude-opus").map((m) => m.id)).toEqual(["model-a"])
  expect(filterModels(ms, "gpt-5").map((m) => m.id)).toEqual(["model-b"])
})

test("filterModels returns empty when no match (CLI shows 'no matches' UX)", () => {
  const ms = [makeModel({ id: "claude-opus-4.7", vendor: "Anthropic" })]
  expect(filterModels(ms, "deepseek")).toEqual([])
})

test("groupByVendor groups by vendor and sorts alphabetically (stable output)", () => {
  const ms = [
    makeModel({ id: "model-x", vendor: "OpenAI" }),
    makeModel({ id: "model-y", vendor: "Anthropic" }),
    makeModel({ id: "model-z", vendor: "OpenAI" }),
    makeModel({ id: "model-w", vendor: "Google" }),
  ]
  const grouped = groupByVendor(ms)
  expect(grouped.map(([v, list]) => [v, list.map((m) => m.id)])).toEqual([
    ["Anthropic", ["model-y"]],
    ["Google", ["model-w"]],
    ["OpenAI", ["model-x", "model-z"]],
  ])
})

test("groupByVendor buckets empty-vendor models under '(unknown vendor)'", () => {
  const ms = [
    makeModel({ id: "no-vendor-1", vendor: "" }),
    makeModel({ id: "no-vendor-2", vendor: "" }),
  ]
  const grouped = groupByVendor(ms)
  expect(grouped).toEqual([["(unknown vendor)", ms]])
})

test("formatTokens renders compact token counts", () => {
  // Exact multiples of 1M / 1024 / 1000 collapse to suffixed form.
  expect(formatTokens(1_048_576)).toBe("1M")
  expect(formatTokens(2_097_152)).toBe("2M")
  expect(formatTokens(4096)).toBe("4k")
  expect(formatTokens(131_072)).toBe("128k")
  expect(formatTokens(8000)).toBe("8k")
  // Non-exact stays numeric (no false-precision rounding).
  expect(formatTokens(1024)).toBe("1k")
  expect(formatTokens(1500)).toBe("1500")
  expect(formatTokens(999)).toBe("999")
})

test("formatModel emits id, family/type/tokenizer, limits, supports, endpoints", () => {
  const m = makeModel({
    id: "claude-opus-4.7-1m-internal",
    name: "Claude Opus 4.7 (1M)",
    vendor: "Anthropic",
    version: "20251115",
    preview: true,
    capabilities: {
      family: "claude-opus-4.7",
      type: "chat",
      object: "model_capabilities",
      tokenizer: "cl100k_base",
      limits: {
        max_context_window_tokens: 1_048_576,
        max_output_tokens: 16_384,
        max_inputs: 1,
      },
      supports: {
        tool_calls: true,
        parallel_tool_calls: true,
        streaming: true,
        vision: true,
        structured_outputs: true,
        adaptive_thinking: true,
        min_thinking_budget: 1024,
        max_thinking_budget: 64_000,
        reasoning_effort: ["low", "medium", "high", "xhigh"],
      },
    },
    supported_endpoints: ["/v1/messages", "/v1/messages/count_tokens"],
    billing: { is_premium: true, multiplier: 1, restricted_to: ["enterprise"] },
  })
  const out = formatModel(m).join("\n")
  expect(out).toContain("claude-opus-4.7-1m-internal")
  expect(out).toContain("preview")
  expect(out).toContain("premium")
  expect(out).toContain("restricted:enterprise")
  expect(out).toContain("Claude Opus 4.7 (1M)")
  expect(out).toContain("family: claude-opus-4.7")
  expect(out).toContain("tokenizer: cl100k_base")
  expect(out).toContain("version: 20251115")
  expect(out).toContain("ctx 1M")
  expect(out).toContain("out 16k")
  expect(out).toContain("tools")
  expect(out).toContain("parallel-tools")
  expect(out).toContain("vision")
  expect(out).toContain("structured-outputs")
  expect(out).toContain("adaptive-thinking(1k-64k)")
})

test("formatModel handles minimal models without limits/supports/billing", () => {
  const m = makeModel({ id: "minimal-model", vendor: "TestVendor" })
  const out = formatModel(m).join("\n")
  expect(out).toContain("minimal-model")
  expect(out).toContain("family: test-family")
  // No crash on empty limits/supports; no spurious sections.
  expect(out).not.toContain("limits:")
  expect(out).not.toContain("supports:")
  expect(out).not.toContain("endpoints:")
  expect(out).not.toContain("billing:")
})

test("formatModel handles models whose capabilities omit limits/supports entirely", () => {
  // Copilot's live catalog returns at least one model (e.g. embeddings) whose
  // capabilities.limits is undefined; reproduces the npx 0.3.43 crash:
  // "Cannot read properties of undefined (reading 'max_context_window_tokens')".
  const m = makeModel({
    id: "text-embedding-3-small",
    vendor: "OpenAI",
    capabilities: {
      family: "text-embedding-3-small",
      type: "embeddings",
      object: "model_capabilities",
      tokenizer: "cl100k_base",
    },
  })
  expect(() => formatModel(m)).not.toThrow()
  const out = formatModel(m).join("\n")
  expect(out).toContain("text-embedding-3-small")
  expect(out).toContain("family: text-embedding-3-small")
  expect(out).toContain("type: embeddings")
  expect(out).not.toContain("limits:")
  expect(out).not.toContain("supports:")
})

test("formatModel surfaces model_picker_category and chat-default flags", () => {
  const m = makeModel({
    id: "default-chat",
    vendor: "X",
    is_chat_default: true,
    is_chat_fallback: false,
  })
  const out = formatModel(m).join("\n")
  expect(out).toContain("chat-default")
})
