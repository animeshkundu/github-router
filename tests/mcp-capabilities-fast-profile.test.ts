// Unit tests for the fast-launch-profile native model resolvers
// (`fastScoutModel`/`fastPlanModel`/`fastGeneralPurposeModel`/`fastImplementerModel`/`fastReviewerModel`).

import { afterEach, expect, test } from "bun:test"

import {
  FAST_EXPLORE_MODEL,
  FAST_EXPLORE_EFFORT,
  FAST_PLAN_MODEL,
  FAST_PLAN_EFFORT,
  FAST_GENERAL_PURPOSE_MODEL,
  FAST_GENERAL_PURPOSE_EFFORT,
  FAST_IMPLEMENTER_MODEL,
  FAST_IMPLEMENTER_EFFORT,
  FAST_REVIEWER_MODEL,
  FAST_REVIEWER_EFFORT,
  FAST_ADVISOR_MODEL,
  FAST_ADVISOR_EFFORT,
  FAST_ORACLE_MODEL,
  FAST_ORACLE_EFFORT,
  fastScoutModel,
  fastPlanModel,
  fastGeneralPurposeModel,
  fastImplementerModel,
  fastReviewerModel,
  fastAdvisorModel,
  fastOracleModel,
} from "~/lib/mcp-capabilities"
import { state } from "~/lib/state"

const savedModels = state.models
const ONE_M = 1_000_000

function entry(
  id: string,
  opts?: {
    ctx?: number
    maxPrompt?: number
    toolCalls?: boolean
    efforts?: string[]
    endpoints?: string[]
    adaptiveThinking?: boolean
  },
) {
  return {
    id,
    name: id,
    object: "model",
    vendor: id.startsWith("grok") ? "xai" : id.startsWith("gemini") ? "google" : id.startsWith("claude") ? "anthropic" : "openai",
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
      supports: {
        tool_calls: opts?.toolCalls !== false,
        ...(opts?.efforts ? { reasoning_effort: opts.efforts } : {}),
        ...(opts?.adaptiveThinking !== undefined ? { adaptive_thinking: opts.adaptiveThinking } : {}),
      },
    },
    ...(opts?.endpoints ? { supported_endpoints: opts.endpoints } : {}),
  }
}

function setCatalog(...entries: Array<ReturnType<typeof entry>>) {
  state.models = { object: "list", data: entries as never }
}

afterEach(() => {
  state.models = savedModels
})

test("fast Explore and general-purpose pin to Luna, requiring tool_calls + 1M + Responses", () => {
  expect(FAST_EXPLORE_MODEL).toBe("gpt-5.6-luna")
  expect(FAST_EXPLORE_EFFORT).toBe("high")
  expect(FAST_GENERAL_PURPOSE_MODEL).toBe("gpt-5.6-luna")
  expect(FAST_GENERAL_PURPOSE_EFFORT).toBe("max")

  setCatalog(entry("gpt-5.6-luna", { ctx: 1_050_000, efforts: ["high", "max"], endpoints: ["/responses"] }))
  expect(fastScoutModel()).toBe("gpt-5.6-luna")
  expect(fastGeneralPurposeModel()).toBe("gpt-5.6-luna")

  // Below the 1M floor -> dropped, not downgraded.
  setCatalog(entry("gpt-5.6-luna", { ctx: 400_000, efforts: ["high", "max"], endpoints: ["/responses"] }))
  expect(fastScoutModel()).toBeUndefined()
  expect(fastGeneralPurposeModel()).toBeUndefined()

  // No tool_calls -> dropped.
  setCatalog(entry("gpt-5.6-luna", { ctx: 1_050_000, toolCalls: false, efforts: ["high", "max"], endpoints: ["/responses"] }))
  expect(fastScoutModel()).toBeUndefined()
  expect(fastGeneralPurposeModel()).toBeUndefined()

  // Missing required effort -> dropped.
  setCatalog(entry("gpt-5.6-luna", { ctx: 1_050_000, efforts: ["high"], endpoints: ["/responses"] }))
  expect(fastScoutModel()).toBe("gpt-5.6-luna")
  expect(fastGeneralPurposeModel()).toBeUndefined()

  // Wrong endpoint -> dropped.
  setCatalog(entry("gpt-5.6-luna", { ctx: 1_050_000, efforts: ["high", "max"], endpoints: ["/chat/completions"] }))
  expect(fastScoutModel()).toBeUndefined()
  expect(fastGeneralPurposeModel()).toBeUndefined()
})

test("fast Plan pins to Sol high, requiring tool_calls + 1M + Responses", () => {
  expect(FAST_PLAN_MODEL).toBe("gpt-5.6-sol")
  expect(FAST_PLAN_EFFORT).toBe("high")

  setCatalog(entry("gpt-5.6-sol", { ctx: 1_050_000, efforts: ["high"], endpoints: ["/responses"] }))
  expect(fastPlanModel()).toBe("gpt-5.6-sol")

  // Below 1M -> dropped
  setCatalog(entry("gpt-5.6-sol", { ctx: 400_000, efforts: ["high"], endpoints: ["/responses"] }))
  expect(fastPlanModel()).toBeUndefined()

  // Missing tool calls -> dropped
  setCatalog(entry("gpt-5.6-sol", { ctx: 1_050_000, toolCalls: false, efforts: ["high"], endpoints: ["/responses"] }))
  expect(fastPlanModel()).toBeUndefined()

  // Wrong endpoint -> dropped
  setCatalog(entry("gpt-5.6-sol", { ctx: 1_050_000, efforts: ["high"], endpoints: ["/chat/completions"] }))
  expect(fastPlanModel()).toBeUndefined()
})

test("fast implementer pins to Gemini Flash with tool calls, 1M, high, and chat", () => {
  expect(FAST_IMPLEMENTER_MODEL).toBe("gemini-3.8-flash")
  expect(FAST_IMPLEMENTER_EFFORT).toBe("high")
  setCatalog(entry("gemini-3.8-flash", { ctx: ONE_M, efforts: ["high"], endpoints: ["/chat/completions"] }))
  expect(fastImplementerModel()).toBe("gemini-3.8-flash")
  for (const opts of [
    { ctx: ONE_M, efforts: ["medium"], endpoints: ["/chat/completions"] },
    { ctx: 400_000, efforts: ["high"], endpoints: ["/chat/completions"] },
    { ctx: ONE_M, efforts: ["high"], endpoints: ["/responses"] },
    { ctx: ONE_M, efforts: ["high"], endpoints: ["/chat/completions"], toolCalls: false },
  ]) {
    setCatalog(entry("gemini-3.8-flash", opts))
    expect(fastImplementerModel()).toBeUndefined()
  }
})

test("fast reviewer pins to Sonnet 5 via 1M context, adaptive thinking, tool calls, and Messages xhigh", () => {
  expect(FAST_REVIEWER_MODEL).toBe("claude-sonnet-5")
  expect(FAST_REVIEWER_EFFORT).toBe("xhigh")

  setCatalog(entry("claude-sonnet-5", { ctx: ONE_M, efforts: ["xhigh"], endpoints: ["/v1/messages"], adaptiveThinking: true }))
  expect(fastReviewerModel()).toBe("claude-sonnet-5")

  // Below 1M context -> dropped.
  setCatalog(entry("claude-sonnet-5", { ctx: 500_000, efforts: ["xhigh"], endpoints: ["/v1/messages"], adaptiveThinking: true }))
  expect(fastReviewerModel()).toBeUndefined()

  // No tool_calls -> dropped.
  setCatalog(entry("claude-sonnet-5", { ctx: ONE_M, toolCalls: false, efforts: ["xhigh"], endpoints: ["/v1/messages"], adaptiveThinking: true }))
  expect(fastReviewerModel()).toBeUndefined()

  // Absent entirely -> dropped, no fallback to any other model.
  setCatalog(entry("gemini-3.8-flash", { ctx: ONE_M, maxPrompt: ONE_M }))
  expect(fastReviewerModel()).toBeUndefined()
})

test("fast Advisor decouples to dedicated GPT-5.6 Sol 1M high on responses", () => {
  expect(FAST_ADVISOR_MODEL).toBe("gpt-5.6-sol")
  expect(FAST_ADVISOR_EFFORT).toBe("high")
  setCatalog(entry("gpt-5.6-sol", { ctx: ONE_M, efforts: ["high"], endpoints: ["/responses"] }))
  expect(fastAdvisorModel()).toBe("gpt-5.6-sol")
})

test("fast Oracle pins to exact Opus 5 1M high on messages with adaptive thinking", () => {
  expect(FAST_ORACLE_MODEL).toBe("claude-opus-5")
  expect(FAST_ORACLE_EFFORT).toBe("high")
  setCatalog(
    entry("claude-opus-5", {
      ctx: ONE_M,
      maxPrompt: 900_000,
      efforts: ["high"],
      endpoints: ["/v1/messages"],
      adaptiveThinking: true,
    }),
  )
  expect(fastOracleModel()).toBe("claude-opus-5")
})
