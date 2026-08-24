import { afterEach, describe, expect, test } from "bun:test"

import {
  applyClaudeCachePolicy,
  applyResponsesCachePolicy,
  normalizeOpenAIUsage,
} from "../src/lib/prompt-cache"
import {
  injectAnthropicWebSearchContext,
  injectChatWebSearchContext,
  injectResponsesWebSearchContext,
  WEB_SEARCH_RESULT_INSTRUCTION,
} from "../src/lib/web-search-context"
import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "../src/services/copilot/create-responses"

const savedEnv = {
  gpt: process.env.GH_ROUTER_DISABLE_GPT56_EXPLICIT_CACHE,
  claude: process.env.GH_ROUTER_DISABLE_CLAUDE_CACHE_POLICY,
  messages: process.env.GH_ROUTER_DISABLE_MESSAGES_WEB_CACHE_REPAIR,
  chat: process.env.GH_ROUTER_DISABLE_CHAT_WEB_CACHE_REPAIR,
  responses: process.env.GH_ROUTER_DISABLE_RESPONSES_WEB_CACHE_REPAIR,
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    const envKey =
      key === "gpt" ? "GH_ROUTER_DISABLE_GPT56_EXPLICIT_CACHE"
      : key === "claude" ? "GH_ROUTER_DISABLE_CLAUDE_CACHE_POLICY"
      : `GH_ROUTER_DISABLE_${key.toUpperCase()}_WEB_CACHE_REPAIR`
    if (value === undefined) delete process.env[envKey]
    else process.env[envKey] = value
  }
})

describe("normalizeOpenAIUsage", () => {
  test("splits inclusive input totals into disjoint read/write/uncached buckets", () => {
    expect(
      normalizeOpenAIUsage({
        input_tokens: 100,
        output_tokens: 7,
        total_tokens: 107,
        input_tokens_details: {
          cached_tokens: 40,
          cache_write_tokens: 25,
          cache_ttl_seconds: 1800,
        },
      }),
    ).toEqual({
      totalInput: 100,
      uncachedInput: 35,
      output: 7,
      cacheRead: 40,
      cacheWrite: 25,
      totalTokens: 107,
      cacheTtlSeconds: 1800,
    })
  })

  test("clamps malformed and inconsistent component counts", () => {
    expect(
      normalizeOpenAIUsage({
        prompt_tokens: 10,
        completion_tokens: -4,
        prompt_tokens_details: {
          cached_tokens: 20,
          cache_creation_tokens: 30,
        },
      }),
    ).toEqual({
      totalInput: 10,
      uncachedInput: 0,
      output: 0,
      cacheRead: 10,
      cacheWrite: 0,
      totalTokens: 10,
    })
  })
})

describe("Responses cache policy", () => {
  const stable = "stable ".repeat(800)

  test("adds an opaque GPT-5.6 key and explicit stable breakpoint", () => {
    const payload = applyResponsesCachePolicy(
      {
        model: "gpt-5.6-sol",
        instructions: stable,
        input: [{ role: "system", content: "dynamic" }, { role: "user", content: "hi" }],
      },
      { workload: "conversation" },
    )
    expect(payload.instructions).toBeUndefined()
    expect(payload.prompt_cache_key).toMatch(/^ghr-cache-v1-[0-9a-f]{48}$/)
    expect(payload.prompt_cache_key).not.toContain("stable")
    expect(payload.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" })
    expect(payload.input).toEqual([
      {
        role: "system",
        content: [{
          type: "input_text",
          text: stable,
          prompt_cache_breakpoint: { mode: "explicit" },
        }],
      },
      { role: "system", content: "dynamic" },
      { role: "user", content: "hi" },
    ])
  })

  test("is a no-op for Gemini, Grok, older GPT, and caller-owned policy", () => {
    for (const model of [
      "gemini-3.7-flash",
      "grok-4.6",
      "gpt-5.5",
      "gpt-5.6-future",
    ]) {
      const payload: ResponsesPayload = {
        model,
        instructions: stable,
        input: "hi",
      }
      expect(
        applyResponsesCachePolicy(payload, { workload: "conversation" }),
      ).toBe(payload)
    }
    const callerOwned: ResponsesPayload = {
      model: "gpt-5.6-sol",
      instructions: stable,
      input: "hi",
      prompt_cache_key: "caller",
    }
    expect(
      applyResponsesCachePolicy(callerOwned, { workload: "conversation" }),
    ).toBe(callerOwned)
  })

  test("kill switch and short prefixes suppress explicit writes", () => {
    process.env.GH_ROUTER_DISABLE_GPT56_EXPLICIT_CACHE = "1"
    const disabled: ResponsesPayload = {
      model: "gpt-5.6-sol",
      instructions: stable,
      input: "hi",
    }
    expect(
      applyResponsesCachePolicy(disabled, { workload: "conversation" }),
    ).toBe(disabled)
    delete process.env.GH_ROUTER_DISABLE_GPT56_EXPLICIT_CACHE

    const short: ResponsesPayload = {
      model: "gpt-5.6-sol",
      instructions: "short",
      input: "hi",
    }
    expect(
      applyResponsesCachePolicy(short, { workload: "conversation" }),
    ).toBe(short)
  })

  test("marks an existing stable system input without duplicating it", () => {
    const payload = applyResponsesCachePolicy(
      {
        model: "gpt-5.6-terra",
        input: [
          { role: "system", content: stable },
          { role: "user", content: "dynamic" },
        ],
      },
      { workload: "reusable-prefix", stablePrefix: stable },
    )
    expect(payload.input).toHaveLength(2)
    expect(payload.input).toEqual([
      {
        role: "system",
        content: [{
          type: "input_text",
          text: stable,
          prompt_cache_breakpoint: { mode: "explicit" },
        }],
      },
      { role: "user", content: "dynamic" },
    ])
  })

  test("opaque keys are stable for one prefix and isolated across prefixes/models", () => {
    const make = (model: string, prefix: string) =>
      applyResponsesCachePolicy(
        { model, instructions: prefix, input: "dynamic" },
        { workload: "conversation" },
      ).prompt_cache_key
    expect(make("gpt-5.6-sol", stable)).toBe(make("gpt-5.6-sol", stable))
    expect(make("gpt-5.6-sol", stable)).not.toBe(
      make("gpt-5.6-sol", `${stable}changed`),
    )
    expect(make("gpt-5.6-sol", stable)).not.toBe(
      make("gpt-5.6-terra", stable),
    )
  })
})

describe("Claude cache policy", () => {
  const stable = "stable ".repeat(800)

  test("marks stable system/tools without caching the dynamic user prompt", () => {
    const body = applyClaudeCachePolicy(
      JSON.stringify({
        model: "claude-opus-5",
        system: stable,
        tools: [
          { name: "old", input_schema: { type: "object" }, defer_loading: true },
          { name: "read", input_schema: { type: "object" } },
        ],
        messages: [{ role: "user", content: "dynamic transcript" }],
      }),
      { workload: "reusable-prefix" },
    )
    const parsed = JSON.parse(body) as {
      system: Array<Record<string, unknown>>
      tools: Array<Record<string, unknown>>
      messages: Array<Record<string, unknown>>
    }
    expect(parsed.system[0]?.cache_control).toEqual({ type: "ephemeral" })
    expect(parsed.tools[0]?.cache_control).toBeUndefined()
    expect(parsed.tools[1]?.cache_control).toEqual({ type: "ephemeral" })
    expect(JSON.stringify(parsed.messages)).not.toContain("cache_control")
    expect((body.match(/cache_control/g) ?? [])).toHaveLength(2)
  })

  test("preserves caller-owned marker placement byte-for-byte", () => {
    const body = JSON.stringify({
      model: "claude-opus-5",
      system: [{
        type: "text",
        text: stable,
        cache_control: { type: "ephemeral", ttl: "1h" },
      }],
      messages: [{ role: "user", content: "hi" }],
    })
    expect(
      applyClaudeCachePolicy(body, { workload: "conversation" }),
    ).toBe(body)
  })

  test("a tool schema property named cache_control is not mistaken for a marker", () => {
    const body = applyClaudeCachePolicy(
      JSON.stringify({
        model: "claude-opus-5",
        system: stable,
        tools: [{
          name: "inspect",
          input_schema: {
            type: "object",
            properties: { cache_control: { type: "string" } },
          },
        }],
        messages: [{ role: "user", content: "dynamic" }],
      }),
      { workload: "reusable-prefix" },
    )
    expect((body.match(/"cache_control":\{"type":"ephemeral"\}/g) ?? []))
      .toHaveLength(2)
  })

  test("conversation allocation never exceeds four markers or edits signed thinking", () => {
    const body = applyClaudeCachePolicy(
      JSON.stringify({
        model: "claude-opus-5",
        system: stable,
        tools: [{ name: "read", input_schema: { type: "object" } }],
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "", signature: "opaque" },
              { type: "text", text: "three" },
            ],
          },
          { role: "user", content: "four" },
        ],
      }),
      { workload: "conversation" },
    )
    const parsed = JSON.parse(body) as {
      messages: Array<{ content: unknown }>
    }
    expect((body.match(/cache_control/g) ?? [])).toHaveLength(4)
    expect(parsed.messages[2]?.content).toEqual([
      { type: "thinking", thinking: "", signature: "opaque" },
      { type: "text", text: "three" },
    ])
  })
})

describe("web-search stable-prefix placement", () => {
  test("Anthropic appends volatile results and an authoritative tail", () => {
    const body: Record<string, unknown> = {
      system: [{
        type: "text",
        text: "stable",
        cache_control: { type: "ephemeral" },
      }],
    }
    injectAnthropicWebSearchContext(body, "[Web Search Results]\nnew")
    const system = body.system as Array<Record<string, unknown>>
    expect(system[0]?.text).toBe("stable")
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" })
    expect(system[1]?.text).toContain("[Web Search Results]")
    expect(system[2]?.text).toBe(WEB_SEARCH_RESULT_INSTRUCTION)
  })

  test("Chat inserts results after the stable system prefix", () => {
    const payload: ChatCompletionsPayload = {
      model: "gemini-3.7-flash",
      messages: [
        { role: "system", content: "stable" },
        { role: "user", content: "question" },
      ],
    }
    injectChatWebSearchContext(payload, "[Web Search Results]\nnew")
    expect(payload.messages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "user",
    ])
    expect(payload.messages[0]?.content).toBe("stable")
    expect(payload.messages[1]?.content).toContain("[Web Search Results]")
  })

  test("Responses preserves instructions and inserts results before user input", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.6-sol",
      instructions: "stable",
      input: [{ role: "user", content: "question" }],
    }
    injectResponsesWebSearchContext(payload, "[Web Search Results]\nnew")
    expect(payload.instructions).toBe("stable")
    expect(payload.input).toEqual([
      { role: "system", content: "[Web Search Results]\nnew" },
      { role: "user", content: "question" },
    ])
  })

  test("per-route kill switches restore the legacy prepend behavior", () => {
    process.env.GH_ROUTER_DISABLE_RESPONSES_WEB_CACHE_REPAIR = "1"
    const payload: ResponsesPayload = {
      model: "gpt-5.5",
      instructions: "stable",
      input: "question",
    }
    injectResponsesWebSearchContext(payload, "dynamic")
    expect(payload.instructions).toBe("dynamic\n\nstable")
    expect(payload.input).toBe("question")
  })
})
