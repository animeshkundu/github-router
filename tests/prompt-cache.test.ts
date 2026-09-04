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
  webSearchCacheRepairEnabled,
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

  test("an explicit 0 in a higher-priority nested detail does not shadow a populated top-level cache-read field", () => {
    // A provider surface that always populates `input_tokens_details` with a
    // placeholder `cached_tokens: 0` — while the REAL count is reported only
    // at the top level — must not have that 0 win a `??` chain and hide the
    // real, positive count.
    expect(
      normalizeOpenAIUsage({
        input_tokens: 140,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 0 },
        cache_read_input_tokens: 40,
      }),
    ).toEqual({
      totalInput: 140,
      uncachedInput: 100,
      output: 5,
      cacheRead: 40,
      cacheWrite: 0,
      totalTokens: 145,
    })
  })

  test("an explicit 0 in a higher-priority nested detail does not shadow a populated top-level cache-write field", () => {
    expect(
      normalizeOpenAIUsage({
        input_tokens: 140,
        output_tokens: 5,
        input_tokens_details: { cache_write_tokens: 0 },
        cache_write_tokens: 25,
      }),
    ).toEqual({
      totalInput: 140,
      uncachedInput: 115,
      output: 5,
      cacheRead: 0,
      cacheWrite: 25,
      totalTokens: 145,
    })
  })

  test("a genuine all-zero cache reading is preserved, not misread as 'missing'", () => {
    // When every candidate really is zero, the result must be a real 0, not a
    // dropped field or an accidental fallthrough to some unrelated value.
    expect(
      normalizeOpenAIUsage({
        input_tokens: 50,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        cache_read_input_tokens: 0,
        cache_write_tokens: 0,
      }),
    ).toEqual({
      totalInput: 50,
      uncachedInput: 50,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 52,
    })
  })
})

describe("Responses cache policy", () => {
  const stable = "stable ".repeat(800)

  test("adds an opaque GPT-5.6 key and explicit stable breakpoint (reusable-prefix only)", () => {
    const payload = applyResponsesCachePolicy(
      {
        model: "gpt-5.6-sol",
        instructions: stable,
        input: [{ role: "system", content: "dynamic" }, { role: "user", content: "hi" }],
      },
      { workload: "reusable-prefix" },
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

  test("workload:'conversation' is UNCONDITIONALLY a no-op (growing-history regression fix)", () => {
    // Live-verified regression: explicit mode marking only the stable system
    // block on a GROWING multi-turn conversation measured strictly worse than
    // doing nothing — the un-marked, ever-growing message history stopped
    // getting Copilot's provider-managed automatic caching too, so only the
    // ~2k-token system block was ever cached while ~25k tokens of history
    // were recomputed from scratch every single turn. `"conversation"` must
    // therefore never receive explicit fields, regardless of prefix size,
    // model, or the kill switch (which only matters when explicit treatment
    // would otherwise apply).
    const bigEnoughForExplicitIfItWereReusablePrefix: ResponsesPayload = {
      model: "gpt-5.6-sol",
      instructions: stable,
      input: [{ role: "user", content: "hi" }],
    }
    const result = applyResponsesCachePolicy(
      bigEnoughForExplicitIfItWereReusablePrefix,
      { workload: "conversation" },
    )
    expect(result).toBe(bigEnoughForExplicitIfItWereReusablePrefix)
    expect(result.prompt_cache_key).toBeUndefined()
    expect(result.prompt_cache_options).toBeUndefined()
  })

  test("is a no-op for Gemini, Grok, older GPT, and caller-owned policy", () => {
    for (const model of [
      "gemini-3.8-flash",
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
        applyResponsesCachePolicy(payload, { workload: "reusable-prefix" }),
      ).toBe(payload)
    }
    const callerOwned: ResponsesPayload = {
      model: "gpt-5.6-sol",
      instructions: stable,
      input: "hi",
      prompt_cache_key: "caller",
    }
    expect(
      applyResponsesCachePolicy(callerOwned, { workload: "reusable-prefix" }),
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
      applyResponsesCachePolicy(disabled, { workload: "reusable-prefix" }),
    ).toBe(disabled)
    delete process.env.GH_ROUTER_DISABLE_GPT56_EXPLICIT_CACHE

    const short: ResponsesPayload = {
      model: "gpt-5.6-sol",
      instructions: "short",
      input: "hi",
    }
    expect(
      applyResponsesCachePolicy(short, { workload: "reusable-prefix" }),
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
        { workload: "reusable-prefix" },
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

  test("non-object JSON bodies are returned unchanged", () => {
    for (const rawBody of ["null", "[]", '"text"', "42"]) {
      expect(
        applyClaudeCachePolicy(rawBody, { workload: "reusable-prefix" }),
      ).toBe(rawBody)
    }
  })
  const tinyTools = [
    { name: "old", input_schema: { type: "object" }, defer_loading: true },
    { name: "read", input_schema: { type: "object" } },
  ]

  test("small tools stay unmarked; only the stable system boundary is worth a marker", () => {
    // `tinyTools`, serialized, is nowhere near MIN_CACHEABLE_PREFIX_BYTES on its
    // own — marking it would spend one of the two marker slots on a breakpoint
    // Anthropic's real per-model token minimum almost certainly never clears.
    // Eligibility is checked separately per breakpoint, so the large `stable`
    // system still qualifies its own marker even though tools don't.
    const body = applyClaudeCachePolicy(
      JSON.stringify({
        model: "claude-opus-5",
        system: stable,
        tools: tinyTools,
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
    expect(parsed.tools[1]?.cache_control).toBeUndefined()
    expect(JSON.stringify(parsed.messages)).not.toContain("cache_control")
    expect((body.match(/cache_control/g) ?? [])).toHaveLength(1)
  })

  test("a tools array large enough on its own is marked even with a tiny system", () => {
    const bigToolSchema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [
          `field_${i}`,
          { type: "string", description: "padding ".repeat(10) },
        ]),
      ),
    }
    const body = applyClaudeCachePolicy(
      JSON.stringify({
        model: "claude-opus-5",
        system: "short",
        tools: [{ name: "big_tool", input_schema: bigToolSchema }],
        messages: [{ role: "user", content: "hi" }],
      }),
      { workload: "reusable-prefix" },
    )
    const parsed = JSON.parse(body) as {
      system: unknown
      tools: Array<Record<string, unknown>>
    }
    expect(parsed.tools[0]?.cache_control).toEqual({ type: "ephemeral" })
    // "short" + the huge tools array still clears the COMBINED floor, so the
    // system breakpoint (which caches tools+system) is legitimately eligible
    // too — it is not "useless" here since it extends the already-large
    // cached prefix by a negligible amount, not the reverse.
    expect((body.match(/cache_control/g) ?? [])).toHaveLength(2)
  })

  test("both breakpoints mark when both tools and system independently qualify", () => {
    const body = applyClaudeCachePolicy(
      JSON.stringify({
        model: "claude-opus-5",
        system: stable,
        tools: [
          { name: "old", input_schema: { type: "object" }, defer_loading: true },
          { name: "read", input_schema: { type: "object", description: "padding ".repeat(600) } },
        ],
        messages: [{ role: "user", content: "dynamic transcript" }],
      }),
      { workload: "reusable-prefix" },
    )
    const parsed = JSON.parse(body) as {
      system: Array<Record<string, unknown>>
      tools: Array<Record<string, unknown>>
    }
    expect(parsed.system[0]?.cache_control).toEqual({ type: "ephemeral" })
    expect(parsed.tools[1]?.cache_control).toEqual({ type: "ephemeral" })
    expect((body.match(/cache_control/g) ?? [])).toHaveLength(2)
  })

  test("neither breakpoint qualifies below the floor: returned byte-for-byte unchanged", () => {
    const rawBody = JSON.stringify({
      model: "claude-opus-5",
      system: "short system",
      tools: [{ name: "read", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hi" }],
    })
    expect(applyClaudeCachePolicy(rawBody, { workload: "reusable-prefix" })).toBe(
      rawBody,
    )
  })

  test("eligibility is measured in UTF-8 bytes, not UTF-16 code units — multi-byte Unicode counts its real byte weight", () => {
    // Each 🎉 is 2 UTF-16 code units but 4 UTF-8 bytes. A run whose `.length`
    // would sit well under the floor but whose true byte count clears it must
    // still be treated as eligible — anything else silently undercounts every
    // non-ASCII system prompt.
    const emoji = "🎉".repeat(1200) // .length === 2400, byte length === 4800
    // 4096 mirrors prompt-cache.ts's private MIN_CACHEABLE_PREFIX_BYTES: the
    // UTF-16 `.length` sits below it while the true UTF-8 byte count clears it.
    expect(emoji.length).toBeLessThan(4096)
    const body = applyClaudeCachePolicy(
      JSON.stringify({
        model: "claude-opus-5",
        system: emoji,
        tools: [{ name: "read", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "hi" }],
      }),
      { workload: "reusable-prefix" },
    )
    const parsed = JSON.parse(body) as { system: Array<Record<string, unknown>> }
    expect(parsed.system[0]?.cache_control).toEqual({ type: "ephemeral" })
  })

  test("a highly-compressible run (repeated whitespace) is judged on raw bytes, honestly — not real tokens", () => {
    // This is the heuristic's documented honest limit: a long run of a single
    // repeated character clears the byte floor easily, even though a real
    // tokenizer would likely compress it into far fewer tokens than the byte
    // count suggests. The policy does not attempt tokenization (conservative,
    // synchronous, byte-based by design) and marks it anyway — this test pins
    // that documented behavior rather than a token-accurate one.
    const whitespaceRun = " ".repeat(5000)
    const body = applyClaudeCachePolicy(
      JSON.stringify({
        model: "claude-opus-5",
        system: whitespaceRun,
        tools: [{ name: "read", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "hi" }],
      }),
      { workload: "reusable-prefix" },
    )
    const parsed = JSON.parse(body) as { system: Array<Record<string, unknown>> }
    expect(parsed.system[0]?.cache_control).toEqual({ type: "ephemeral" })
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
    // Only the system breakpoint qualifies (the single small tool doesn't),
    // so exactly one real `cache_control: {type: "ephemeral"}` marker is
    // present alongside the tool schema's unrelated `cache_control` STRING
    // property, which the regex below must not mistake for a marker.
    expect((body.match(/"cache_control":\{"type":"ephemeral"\}/g) ?? []))
      .toHaveLength(1)
  })

  test("workload:'conversation' no longer adds message-level markers (dead path removed — no concrete production caller ever passed it)", () => {
    // Every production call site of `applyClaudeCachePolicy` passes
    // `workload: "reusable-prefix"`; nothing ever passed "conversation" to
    // this function, so the marking behavior for the two workload values is
    // now identical — this test pins that equivalence rather than a
    // message-level allocation that never ran in production.
    const rawBody = JSON.stringify({
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
    })
    const conversationResult = applyClaudeCachePolicy(rawBody, {
      workload: "conversation",
    })
    const reusablePrefixResult = applyClaudeCachePolicy(rawBody, {
      workload: "reusable-prefix",
    })
    expect(conversationResult).toBe(reusablePrefixResult)

    const parsed = JSON.parse(conversationResult) as {
      messages: Array<{ content: unknown }>
    }
    // Only the system breakpoint (tools=[read] is too small); no message is
    // ever touched, so the signed thinking block is untouched by construction.
    expect((conversationResult.match(/cache_control/g) ?? [])).toHaveLength(1)
    expect(JSON.stringify(parsed.messages)).not.toContain("cache_control")
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
      model: "gemini-3.8-flash",
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

describe("webSearchCacheRepairEnabled (parseBoolEnv semantics)", () => {
  const ROUTES = ["messages", "chat", "responses"] as const
  const ENV_KEY: Record<(typeof ROUTES)[number], string> = {
    messages: "GH_ROUTER_DISABLE_MESSAGES_WEB_CACHE_REPAIR",
    chat: "GH_ROUTER_DISABLE_CHAT_WEB_CACHE_REPAIR",
    responses: "GH_ROUTER_DISABLE_RESPONSES_WEB_CACHE_REPAIR",
  }

  afterEach(() => {
    for (const route of ROUTES) delete process.env[ENV_KEY[route]]
  })

  for (const route of ROUTES) {
    describe(route, () => {
      test.each(["1", "true", "TRUE", "on", "yes"])(
        "%s disables the repair (returns false)",
        (value) => {
          process.env[ENV_KEY[route]] = value
          expect(webSearchCacheRepairEnabled(route)).toBe(false)
        },
      )

      test.each(["0", "false", "off", "no", ""])(
        "%s leaves the repair enabled (returns true)",
        (value) => {
          process.env[ENV_KEY[route]] = value
          expect(webSearchCacheRepairEnabled(route)).toBe(true)
        },
      )

      test("unset leaves the repair enabled (returns true)", () => {
        delete process.env[ENV_KEY[route]]
        expect(webSearchCacheRepairEnabled(route)).toBe(true)
      })

      test("an unrecognized value leaves the repair enabled (fails safe, not silently disabled)", () => {
        process.env[ENV_KEY[route]] = "banana"
        expect(webSearchCacheRepairEnabled(route)).toBe(true)
      })
    })
  }
})
