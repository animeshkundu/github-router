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
  FAST_PROFILE_ASTRA_MODEL,
  FAST_PROFILE_ASTRA_EFFORT,
  fastScoutModel,
  fastPlanModel,
  fastGeneralPurposeModel,
  fastImplementerModel,
  fastReviewerModel,
  fastAdvisorModel,
  fastOracleModel,
  fastAstraModel,
  cheapAdvisorModel,
  cheapOracleModel,
  cheapReviewerModel,
  cheapAstraModel,
} from "~/lib/mcp-capabilities"
import {
  CHEAP_PROFILE_ASTRA_EFFORT,
  CHEAP_PROFILE_ASTRA_MODEL,
  CHEAP_PROFILE_ASTRA_PROMPT_TOKENS,
  CHEAP_PROFILE_MODELS,
  CHEAP_PROFILE_NATIVE_EFFORTS,
  CHEAP_PROFILE_ORACLE_EFFORT,
  CHEAP_PROFILE_ORACLE_MODEL,
  CHEAP_PROFILE_SUBAGENT_CONTEXT_TOKENS,
} from "~/lib/cheap-profile-contract"
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
    tokenizer?: string
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
      tokenizer: opts?.tokenizer ?? "o200k_base",
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

test("fast Explore pins to Luna and General-Purpose pins to Gemini, requiring tool_calls + 1M", () => {
  expect(FAST_EXPLORE_MODEL).toBe("gpt-5.6-luna")
  expect(FAST_EXPLORE_EFFORT).toBe("high")
  expect(FAST_GENERAL_PURPOSE_MODEL).toBe("gemini-3.8-flash")
  expect(FAST_GENERAL_PURPOSE_EFFORT).toBe("high")

  setCatalog(entry("gpt-5.6-luna", { ctx: 1_050_000, efforts: ["high", "max"], endpoints: ["/responses"] }))
  expect(fastScoutModel()).toBe("gpt-5.6-luna")

  setCatalog(entry("gemini-3.8-flash", { ctx: ONE_M, efforts: ["high"], endpoints: ["/chat/completions"] }))
  expect(fastGeneralPurposeModel()).toBe("gemini-3.8-flash")

  // Below the 1M floor -> dropped, not downgraded.
  setCatalog(entry("gpt-5.6-luna", { ctx: 400_000, efforts: ["high", "max"], endpoints: ["/responses"] }))
  expect(fastScoutModel()).toBeUndefined()
  setCatalog(entry("gemini-3.8-flash", { ctx: 400_000, efforts: ["high"], endpoints: ["/chat/completions"] }))
  expect(fastGeneralPurposeModel()).toBeUndefined()

  // No tool_calls -> dropped.
  setCatalog(entry("gpt-5.6-luna", { ctx: 1_050_000, toolCalls: false, efforts: ["high", "max"], endpoints: ["/responses"] }))
  expect(fastScoutModel()).toBeUndefined()
  setCatalog(entry("gemini-3.8-flash", { ctx: ONE_M, toolCalls: false, efforts: ["high"], endpoints: ["/chat/completions"] }))
  expect(fastGeneralPurposeModel()).toBeUndefined()

  // Missing required effort -> dropped.
  setCatalog(entry("gpt-5.6-luna", { ctx: 1_050_000, efforts: ["high"], endpoints: ["/responses"] }))
  expect(fastScoutModel()).toBe("gpt-5.6-luna")

  // Wrong endpoint -> dropped.
  setCatalog(entry("gpt-5.6-luna", { ctx: 1_050_000, efforts: ["high", "max"], endpoints: ["/chat/completions"] }))
  expect(fastScoutModel()).toBeUndefined()
  setCatalog(entry("gemini-3.8-flash", { ctx: ONE_M, efforts: ["high"], endpoints: ["/responses"] }))
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

test("retired fast implementer alias still resolves to Gemini Flash for compat", () => {
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

test("cheap Advisor pins to Sol/medium at the 200K default window on responses (no 1M gate)", () => {
  setCatalog(entry("gpt-5.6-sol", { ctx: 500_000, efforts: ["medium"], endpoints: ["/responses"] }))
  expect(cheapAdvisorModel()).toBe("gpt-5.6-sol")

  // Below the 200K subagent floor -> dropped.
  setCatalog(entry("gpt-5.6-sol", { ctx: 100_000, efforts: ["medium"], endpoints: ["/responses"] }))
  expect(cheapAdvisorModel()).toBeUndefined()

  // Missing medium effort -> dropped.
  setCatalog(entry("gpt-5.6-sol", { ctx: 500_000, efforts: ["high"], endpoints: ["/responses"] }))
  expect(cheapAdvisorModel()).toBeUndefined()

  // No tool_calls -> dropped.
  setCatalog(entry("gpt-5.6-sol", { ctx: 500_000, toolCalls: false, efforts: ["medium"], endpoints: ["/responses"] }))
  expect(cheapAdvisorModel()).toBeUndefined()

  // Wrong endpoint -> dropped.
  setCatalog(entry("gpt-5.6-sol", { ctx: 500_000, efforts: ["medium"], endpoints: ["/v1/messages"] }))
  expect(cheapAdvisorModel()).toBeUndefined()
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

test("cheap Oracle pins to exact Grok 4.6 200K/medium on responses", () => {
  expect(CHEAP_PROFILE_ORACLE_MODEL).toBe("grok-4.6")
  expect(CHEAP_PROFILE_ORACLE_EFFORT).toBe("medium")
  expect(CHEAP_PROFILE_SUBAGENT_CONTEXT_TOKENS).toBe(200_000)

  setCatalog(
    entry("grok-4.6", {
      ctx: 500_000,
      maxPrompt: 372_000,
      efforts: ["low", "medium"],
      endpoints: ["/responses"],
    }),
  )
  expect(cheapOracleModel()).toBe("grok-4.6")

  // Context below the 200K subagent floor rejects.
  setCatalog(
    entry("grok-4.6", {
      ctx: 100_000,
      maxPrompt: 372_000,
      efforts: ["low", "medium"],
      endpoints: ["/responses"],
    }),
  )
  expect(cheapOracleModel()).toBeUndefined()

  // Missing the fixed medium effort rejects.
  setCatalog(
    entry("grok-4.6", {
      ctx: 500_000,
      maxPrompt: 372_000,
      efforts: ["high"],
      endpoints: ["/responses"],
    }),
  )
  expect(cheapOracleModel()).toBeUndefined()

  // Wrong endpoint rejects (grok serves no messages endpoint anyway).
  setCatalog(
    entry("grok-4.6", {
      ctx: 500_000,
      maxPrompt: 372_000,
      efforts: ["low", "medium"],
      endpoints: ["/v1/chat/completions"],
    }),
  )
  expect(cheapOracleModel()).toBeUndefined()
})

test("cheap reviewer pins to Luna/max at the 200K default window on responses", () => {
  expect(CHEAP_PROFILE_MODELS.reviewer).toBe("gpt-5.6-luna")
  expect(CHEAP_PROFILE_NATIVE_EFFORTS.reviewer).toBe("max")

  setCatalog(entry("gpt-5.6-luna", { ctx: 500_000, efforts: ["high", "max"], endpoints: ["/responses"] }))
  expect(cheapReviewerModel()).toBe("gpt-5.6-luna")

  // Below the 200K subagent floor -> dropped.
  setCatalog(entry("gpt-5.6-luna", { ctx: 100_000, efforts: ["high", "max"], endpoints: ["/responses"] }))
  expect(cheapReviewerModel()).toBeUndefined()

  // Missing max effort -> dropped.
  setCatalog(entry("gpt-5.6-luna", { ctx: 500_000, efforts: ["high"], endpoints: ["/responses"] }))
  expect(cheapReviewerModel()).toBeUndefined()

  // No tool_calls -> dropped.
  setCatalog(entry("gpt-5.6-luna", { ctx: 500_000, toolCalls: false, efforts: ["high", "max"], endpoints: ["/responses"] }))
  expect(cheapReviewerModel()).toBeUndefined()

  // Wrong endpoint -> dropped.
  setCatalog(entry("gpt-5.6-luna", { ctx: 500_000, efforts: ["high", "max"], endpoints: ["/v1/messages"] }))
  expect(cheapReviewerModel()).toBeUndefined()
})

test("cheap Astra pins to exact gpt-6-astra 200K/medium on responses", () => {
  expect(CHEAP_PROFILE_ASTRA_MODEL).toBe("gpt-6-astra")
  expect(CHEAP_PROFILE_ASTRA_EFFORT).toBe("medium")
  expect(CHEAP_PROFILE_ASTRA_PROMPT_TOKENS).toBe(200_000)

  setCatalog(
    entry("gpt-6-astra", {
      ctx: 200_000,
      maxPrompt: 200_000,
      efforts: ["medium"],
      endpoints: ["/responses"],
    }),
  )
  expect(cheapAstraModel()).toBe("gpt-6-astra")

  // Under the 200K prompt-token floor rejects.
  setCatalog(
    entry("gpt-6-astra", {
      ctx: 200_000,
      maxPrompt: 100_000,
      efforts: ["medium"],
      endpoints: ["/responses"],
    }),
  )
  expect(cheapAstraModel()).toBeUndefined()

  // Missing medium effort rejects.
  setCatalog(
    entry("gpt-6-astra", {
      ctx: 200_000,
      maxPrompt: 200_000,
      efforts: ["high"],
      endpoints: ["/responses"],
    }),
  )
  expect(cheapAstraModel()).toBeUndefined()

  // Wrong endpoint rejects.
  setCatalog(
    entry("gpt-6-astra", {
      ctx: 200_000,
      maxPrompt: 200_000,
      efforts: ["medium"],
      endpoints: ["/v1/chat/completions"],
    }),
  )
  expect(cheapAstraModel()).toBeUndefined()
})

test("fast Astra pins to exact gpt-6-astra 200k high on responses", () => {
  expect(FAST_PROFILE_ASTRA_MODEL).toBe("gpt-6-astra")
  expect(FAST_PROFILE_ASTRA_EFFORT).toBe("high")
  setCatalog(
    entry("gpt-6-astra", {
      ctx: 200_000,
      maxPrompt: 200_000,
      efforts: ["high"],
      endpoints: ["/responses"],
      tokenizer: "o200k_base",
    }),
  )
  expect(fastAstraModel()).toBe("gpt-6-astra")

  // Under 200k tokens context/prompt rejects
  setCatalog(
    entry("gpt-6-astra", {
      ctx: 100_000,
      maxPrompt: 200_000,
      efforts: ["high"],
      endpoints: ["/responses"],
      tokenizer: "o200k_base",
    }),
  )
  expect(fastAstraModel()).toBeUndefined()

  // Missing high effort rejects
  setCatalog(
    entry("gpt-6-astra", {
      ctx: 200_000,
      maxPrompt: 200_000,
      efforts: ["low"],
      endpoints: ["/responses"],
      tokenizer: "o200k_base",
    }),
  )
  expect(fastAstraModel()).toBeUndefined()

  // Wrong endpoint rejects
  setCatalog(
    entry("gpt-6-astra", {
      ctx: 200_000,
      maxPrompt: 200_000,
      efforts: ["high"],
      endpoints: ["/v1/chat/completions"],
      tokenizer: "o200k_base",
    }),
  )
  expect(fastAstraModel()).toBeUndefined()
})
