// Request-mapping unit tests for the Anthropic → Responses shim ingest.
// Pure functions — no fetch/state mocking needed.

import { expect, test, describe } from "bun:test"

import {
  parseAnthropicRequest,
  parsedToResponsesPayload,
} from "~/lib/anthropic-translate/anthropic-request"
import { parsedToChatPayload } from "~/lib/anthropic-translate/chat-request"
import type { AnthropicStreamEvent } from "~/lib/anthropic-translate/anthropic-sse"
import { synthAnthropicFromResponses } from "~/lib/anthropic-translate/responses-egress"
import { WEB_SEARCH_RESULT_INSTRUCTION } from "~/lib/web-search-context"
import type { Model } from "~/services/copilot/get-models"

const MODEL_ID = "gpt-5.5"
// The other model Copilot serves on the SAME `/responses` path. Both share the
// one Responses shim — this is fixture fidelity, not a second code path.
const CODEX_MODEL_ID = "gpt-5.3-codex"

function gptModel(reasoningEfforts?: Array<string>): Model {
  return {
    id: MODEL_ID,
    name: "GPT 5.5",
    object: "model",
    vendor: "openai",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: "gpt",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      supports: {
        tool_calls: true,
        ...(reasoningEfforts && { reasoning_effort: reasoningEfforts }),
      },
    },
    supported_endpoints: ["/responses"],
  }
}

function codexModel(reasoningEfforts?: Array<string>): Model {
  return {
    id: CODEX_MODEL_ID,
    name: "GPT 5.3 Codex",
    object: "model",
    vendor: "openai",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: "gpt",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      supports: {
        tool_calls: true,
        ...(reasoningEfforts && { reasoning_effort: reasoningEfforts }),
      },
    },
    supported_endpoints: ["/responses"],
  }
}

function build(body: Record<string, unknown>, model?: Model) {
  const parsed = parseAnthropicRequest(body, MODEL_ID, model)
  const payload = parsedToResponsesPayload(parsed)
  return { parsed, payload }
}

/** Same as `build`, but lets a test pin the request/catalog model id. */
function buildFor(modelId: string, body: Record<string, unknown>, model?: Model) {
  const parsed = parseAnthropicRequest(body, modelId, model)
  const payload = parsedToResponsesPayload(parsed)
  return { parsed, payload }
}

function hasOwnKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasOwnKeyDeep(item, key))
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return (
      Object.prototype.hasOwnProperty.call(record, key)
      || Object.values(record).some((item) => hasOwnKeyDeep(item, key))
    )
  }
  return false
}

async function* upstreamFrom(events: Array<object>): AsyncGenerator<{ data?: string }> {
  for (const e of events) yield { data: JSON.stringify(e) }
}

async function collectStream(events: Array<object>): Promise<Array<AnthropicStreamEvent>> {
  const out: Array<AnthropicStreamEvent> = []
  for await (const ev of synthAnthropicFromResponses(upstreamFrom(events), {
    modelId: MODEL_ID,
    messageId: "msg_test",
  })) {
    out.push(ev)
  }
  return out
}

const streamTypes = (evs: Array<AnthropicStreamEvent>) => evs.map((e) => e.type)

describe("anthropic-translate request mapping", () => {
  test("plain user text → input user message", () => {
    const { payload } = build({
      model: MODEL_ID,
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    })
    expect(payload.model).toBe(MODEL_ID)
    expect(payload.input).toEqual([{ role: "user", content: "hello" }])
    expect(payload.max_output_tokens).toBe(100)
  })

  test("system string → instructions; system text-block array → joined", () => {
    const a = build({ messages: [], system: "be terse" }).payload
    expect(a.instructions).toBe("be terse")
    const b = build({
      messages: [],
      system: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ],
    }).payload
    expect(b.instructions).toBe("line1line2")
  })

  test("cache_control on system/content/tool blocks does not leak to Responses payload", () => {
    const { payload } = build({
      system: [
        {
          type: "text",
          text: "be cached but do not forward cache metadata",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "look",
              cache_control: { type: "ephemeral" },
            },
            {
              type: "image",
              source: { type: "url", url: "https://ex.com/a.png" },
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "search",
          description: "search docs",
          input_schema: { type: "object", properties: { q: { type: "string" } } },
          cache_control: { type: "ephemeral" },
        },
      ],
    })

    expect(payload.instructions).toBe("be cached but do not forward cache metadata")
    expect(payload.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: "https://ex.com/a.png" },
        ],
      },
    ])
    expect(payload.tools).toEqual([
      {
        type: "function",
        name: "search",
        description: "search docs",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    ])
    expect(hasOwnKeyDeep(payload, "cache_control")).toBe(false)
  })

  test("gpt-5.6 shim conversations do NOT get GPT-5.6 explicit caching (growing-history regression fix)", () => {
    // The shim always builds its Responses payload with `cachePolicy:
    // {workload: "conversation"}` (`parsedToResponsesPayload`), and
    // `applyResponsesCachePolicy` deliberately excludes that workload: a
    // live-verified regression showed marking only the stable system block
    // on a GROWING multi-turn conversation performs substantially worse than
    // leaving caching implicit (see `prompt-cache.ts` for the measurements).
    // A long stable system prefix through the shim must therefore stay
    // exactly as parsed — no `prompt_cache_key`/`prompt_cache_options`, no
    // `prompt_cache_breakpoint`, `instructions` untouched — relying entirely
    // on Copilot's own provider-managed automatic caching instead.
    const stable = "stable ".repeat(800)
    const { payload } = buildFor("gpt-5.6-sol", {
      system: stable,
      messages: [{ role: "user", content: "dynamic" }],
    })
    expect(payload.instructions).toBe(stable)
    expect(payload.prompt_cache_options).toBeUndefined()
    expect(payload.prompt_cache_key).toBeUndefined()
    expect(payload.input).toEqual([{ role: "user", content: "dynamic" }])
  })

  test("router web-search suffix stays after the stable translated prefix (no explicit-cache marking on the conversation path)", () => {
    const stable = "stable ".repeat(800)
    const search = "[Web Search Results]\nresult\n[End Web Search Results]"
    const parsed = parseAnthropicRequest(
      {
        system: [
          {
            type: "text",
            text: stable,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: search },
          { type: "text", text: WEB_SEARCH_RESULT_INSTRUCTION },
        ],
        messages: [{ role: "user", content: "question" }],
      },
      "gpt-5.6-sol",
    )
    const payload = parsedToResponsesPayload(parsed)
    // instructions carries the stable prefix untouched (no explicit-cache
    // rewrite for the shim's "conversation" workload); the dynamic web-search
    // suffix rides ahead of the user message as its own system input item.
    expect(payload.instructions).toBe(stable)
    expect(payload.prompt_cache_key).toBeUndefined()
    expect(payload.input).toEqual([
      {
        role: "system",
        // Two separate Anthropic text blocks (search results, then the
        // authoritative tail) are joined with a blank-line delimiter, not
        // concatenated raw — a bare join would glue "[End Web Search
        // Results]Use factual claims…" into one run-on sentence.
        content: `${search}\n\n${WEB_SEARCH_RESULT_INSTRUCTION}`,
      },
      { role: "user", content: "question" },
    ])
  })

  test("unicode text survives intact into Responses input", () => {
    const text = "Hello 👋🏽 — café — 中文・日本語・한국어 — Привет — مرحبا"
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text }],
        },
      ],
    })

    expect(payload.input).toEqual([{ role: "user", content: text }])
  })

  test("image block (base64) → input_image data URI", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "QUJD" },
            },
          ],
        },
      ],
    })
    expect(payload.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: "data:image/jpeg;base64,QUJD" },
        ],
      },
    ])
  })

  test("image block (url) → input_image url passthrough", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: "https://ex.com/a.png" } },
          ],
        },
      ],
    })
    expect(payload.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_image", image_url: "https://ex.com/a.png" }],
      },
    ])
  })

  test("document block (base64 PDF) → input_file with file_data data URI + filename", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              title: "smoke.pdf",
              source: { type: "base64", media_type: "application/pdf", data: "JVBERi0x" },
            },
            { type: "text", text: "what is in this pdf?" },
          ],
        },
      ],
    })
    expect(payload.input).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_file",
            filename: "smoke.pdf",
            file_data: "data:application/pdf;base64,JVBERi0x",
          },
          { type: "input_text", text: "what is in this pdf?" },
        ],
      },
    ])
  })

  test("document block without a title → default filename document.pdf", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: "QUJD" },
            },
          ],
        },
      ],
    })
    expect(payload.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_file", filename: "document.pdf", file_data: "data:application/pdf;base64,QUJD" },
        ],
      },
    ])
  })

  test("document block (url source) → input_file with file_url", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              title: "spec.pdf",
              source: { type: "url", url: "https://ex.com/spec.pdf" },
            },
          ],
        },
      ],
    })
    expect(payload.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_file", filename: "spec.pdf", file_url: "https://ex.com/spec.pdf" }],
      },
    ])
  })

  test("document block (text source) → folded into user text (no input_file part)", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "text", media_type: "text/plain", data: "AAA" },
            },
            { type: "text", text: "BBB" },
          ],
        },
      ],
    })
    // A plain-text document is inlined as text; with no image/document part left
    // the turn collapses to a single string (doc text first, in wire order).
    expect(payload.input).toEqual([{ role: "user", content: "AAABBB" }])
  })

  test("document block (content source) → text blocks folded into user text", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "content",
                content: [
                  { type: "text", text: "part1" },
                  { type: "text", text: "part2" },
                ],
              },
            },
          ],
        },
      ],
    })
    expect(payload.input).toEqual([{ role: "user", content: "part1part2" }])
  })

  test("assistant text + tool_use → output_text message + function_call (order preserved)", () => {
    const { payload } = build({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool_use", id: "toolu_1", name: "search", input: { q: "x" } },
          ],
        },
      ],
    })
    expect(payload.input).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "calling" }] },
      { type: "function_call", call_id: "toolu_1", name: "search", arguments: '{"q":"x"}' },
    ])
  })

  test("assistant thinking blocks are dropped from neutral IR and Responses payload", () => {
    const { parsed, payload } = build({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private chain", signature: "sig_1" },
            { type: "text", text: "visible" },
            { type: "redacted_thinking", data: "encrypted" },
          ],
        },
      ],
    })

    expect(parsed.messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "visible" }] },
    ])
    expect(payload.input).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "visible" }] },
    ])
    expect(hasOwnKeyDeep(parsed.messages, "thinking")).toBe(false)
    expect(hasOwnKeyDeep(payload.input, "thinking")).toBe(false)
    expect(JSON.stringify(payload.input)).not.toContain("private chain")
  })

  test("tool_result (string) → function_call_output", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "42" }],
        },
      ],
    })
    expect(payload.input).toEqual([
      { type: "function_call_output", call_id: "toolu_1", output: "42" },
    ])
  })

  test("tool_result (block array) is flattened to text", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              content: [
                { type: "text", text: "part-a" },
                { type: "text", text: "part-b" },
              ],
            },
          ],
        },
      ],
    })
    expect(payload.input).toEqual([
      { type: "function_call_output", call_id: "toolu_2", output: "part-apart-b" },
    ])
  })

  test("user message mixing tool_result + text fans out in wire order", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "done" },
            { type: "text", text: "now do next" },
          ],
        },
      ],
    })
    expect(payload.input).toEqual([
      { type: "function_call_output", call_id: "toolu_1", output: "done" },
      { role: "user", content: "now do next" },
    ])
  })

  test("I7: tool_result with an image block → function_call_output + follow-up user input_image", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_9",
              content: [
                { type: "text", text: "screenshot:" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "QUJD" },
                },
              ],
            },
          ],
        },
      ],
    })
    // The text lands in the string-only function_call_output; the image can't
    // ride there, so it follows as its own user message in wire order.
    expect(payload.input).toEqual([
      { type: "function_call_output", call_id: "toolu_9", output: "screenshot:" },
      {
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,QUJD" }],
      },
    ])
  })

  test("I7: image-only tool_result → placeholder output + follow-up input_image", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_10",
              content: [
                { type: "image", source: { type: "url", url: "https://ex.com/s.png" } },
              ],
            },
          ],
        },
      ],
    })
    expect(payload.input).toEqual([
      { type: "function_call_output", call_id: "toolu_10", output: "[image result below]" },
      {
        role: "user",
        content: [{ type: "input_image", image_url: "https://ex.com/s.png" }],
      },
    ])
  })

  test("I7: is_error is preserved as a text prefix on the function_call_output", () => {
    const { payload } = build({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_11",
              is_error: true,
              content: "boom",
            },
          ],
        },
      ],
    })
    expect(payload.input).toEqual([
      { type: "function_call_output", call_id: "toolu_11", output: "[tool error] boom" },
    ])
  })

  test("tools[] → Responses function tools; tool_choice variants", () => {
    const tools = [
      {
        name: "get_weather",
        description: "weather",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]
    const auto = build({ messages: [], tools, tool_choice: { type: "auto" } }).payload
    expect(auto.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    ])
    expect(auto.tool_choice).toBe("auto")

    expect(build({ messages: [], tools, tool_choice: { type: "any" } }).payload.tool_choice).toBe("required")
    expect(build({ messages: [], tools, tool_choice: { type: "none" } }).payload.tool_choice).toBe("none")
    expect(
      build({ messages: [], tools, tool_choice: { type: "tool", name: "get_weather" } }).payload.tool_choice,
    ).toEqual({ type: "function", name: "get_weather" })
    // tool_choice omitted but tools present → default auto
    expect(build({ messages: [], tools }).payload.tool_choice).toBe("auto")
  })

  test("complex nested tool input_schema is preserved verbatim as function parameters", () => {
    const inputSchema = {
      type: "object",
      additionalProperties: false,
      required: ["query", "filters"],
      properties: {
        query: { type: "string" },
        filters: {
          type: "object",
          required: ["tags", "range", "mode"],
          properties: {
            tags: {
              type: "array",
              items: {
                type: "object",
                required: ["name", "weight"],
                properties: {
                  name: { type: "string", enum: ["bug", "feature", "docs"] },
                  weight: {
                    anyOf: [
                      { type: "integer", minimum: 1 },
                      { type: "string", enum: ["low", "medium", "high"] },
                    ],
                  },
                },
              },
            },
            range: {
              type: "object",
              properties: {
                start: { type: "string", format: "date-time" },
                end: {
                  anyOf: [
                    { type: "string", format: "date-time" },
                    { type: "null" },
                  ],
                },
              },
            },
            mode: { type: "string", enum: ["fast", "thorough"] },
          },
        },
        limit: {
          anyOf: [
            { type: "integer", minimum: 1, maximum: 100 },
            { type: "null" },
          ],
        },
      },
    }

    const { payload } = build({
      messages: [],
      tools: [{ name: "complex_search", description: "nested schema", input_schema: inputSchema }],
    })

    expect(payload.tools).toEqual([
      {
        type: "function",
        name: "complex_search",
        description: "nested schema",
        parameters: inputSchema,
      },
    ])
    expect(payload.tools?.[0]?.parameters).toEqual(inputSchema)
  })

  test("I8a: name-less {type:'tool'} does NOT silently downgrade a forced call to auto", () => {
    // A forced tool call with no `name` is malformed; the shim must NOT flip it
    // to "auto" (model discretion). It leaves tool_choice unset so the caller's
    // documented default applies instead of a silent behaviour change.
    expect(build({ messages: [], tool_choice: { type: "tool" } }).parsed.toolChoice).toBeUndefined()
    // An empty-string name is equally unusable.
    expect(
      build({ messages: [], tool_choice: { type: "tool", name: "" } }).parsed.toolChoice,
    ).toBeUndefined()
    // With no tools present, no wire tool_choice is emitted at all.
    expect(
      (build({ messages: [], tool_choice: { type: "tool" } }).payload as Record<string, unknown>)
        .tool_choice,
    ).toBeUndefined()
    // A named forced call is unchanged.
    expect(
      build({ messages: [], tool_choice: { type: "tool", name: "get_weather" } }).parsed.toolChoice,
    ).toEqual({ type: "function", name: "get_weather" })

    // MALFORMED input WITH tools PRESENT: parseToolChoice still returns
    // undefined (a name-less {type:"tool"} is malformed — Anthropic requires a
    // `name`), so the shared builder falls back to its documented default for an
    // UNDEFINED tool_choice when tools exist: `tool_choice: "auto"`. This is the
    // intentional wire outcome for malformed forced-tool input — NOT a silent
    // downgrade of a WELL-FORMED forced call (that stays {type:"function",name},
    // preserved by the named-call assertion above).
    const tools = [
      { name: "get_weather", input_schema: { type: "object", properties: {} } },
    ]
    const malformedWithTools = build({
      messages: [],
      tools,
      tool_choice: { type: "tool" },
    })
    expect(malformedWithTools.parsed.toolChoice).toBeUndefined()
    expect(malformedWithTools.payload.tool_choice).toBe("auto")
  })

  test("thinking budget → reasoning.effort (bucketed + clamped)", () => {
    const model = gptModel(["low", "medium", "high", "xhigh"])
    const mk = (budget: number) =>
      build({ messages: [], thinking: { type: "enabled", budget_tokens: budget } }, model).payload
        .reasoning?.effort
    expect(mk(1000)).toBe("low")
    expect(mk(5000)).toBe("medium")
    expect(mk(10000)).toBe("high")
    expect(mk(30000)).toBe("xhigh")
    // no thinking → `high`, the only effort the router injects on its own. The
    // client's level otherwise maps 1:1, with no floor raising a lower level.
    expect(build({ messages: [] }, model).payload.reasoning?.effort).toBe("high")
  })

  test("thinking budget bucket boundaries are exact", () => {
    const model = gptModel(["low", "medium", "high", "xhigh"])
    const mk = (budget: number) =>
      build({ messages: [], thinking: { type: "enabled", budget_tokens: budget } }, model).payload
        .reasoning?.effort

    const lowToMedium = 2000
    expect(mk(lowToMedium - 1)).toBe("low")
    expect(mk(lowToMedium)).toBe("medium")
    expect(mk(lowToMedium + 1)).toBe("medium")

    const mediumToHigh = 8000
    expect(mk(mediumToHigh - 1)).toBe("medium")
    expect(mk(mediumToHigh)).toBe("high")
    expect(mk(mediumToHigh + 1)).toBe("high")

    const highToXhigh = 24000
    expect(mk(highToXhigh - 1)).toBe("high")
    expect(mk(highToXhigh)).toBe("xhigh")
    expect(mk(highToXhigh + 1)).toBe("xhigh")
  })

  test("thinking effort clamps to a model without xhigh", () => {
    const model = gptModel(["low", "medium", "high"]) // e.g. gemini-like ceiling
    const effort = build(
      { messages: [], thinking: { type: "enabled", budget_tokens: 30000 } },
      model,
    ).payload.reasoning?.effort
    expect(effort).toBe("high")
  })

  test("absent thinking defaults a frontier model (gpt-5.5) to high, not xhigh (1:1 mapping)", () => {
    // The router injects `high` and nothing else when the client sends no
    // thinking block. Forcing xhigh here would make the frontier models the one
    // place where the provider level does not match the client's, and there is
    // no client level to match when the field is absent.
    const model = gptModel(["low", "medium", "high", "xhigh"])
    const { payload } = build({ messages: [] }, model)
    expect(payload.reasoning?.effort).toBe("high")
  })

  test("absent thinking on a non-frontier model is high too (no per-model split in the default)", () => {
    // gpt-5.3-codex was never in the xhigh effort-policy set; now neither is any
    // model by default, so this and the frontier case agree.
    const model = codexModel(["low", "medium", "high", "xhigh"])
    const { payload } = build({ messages: [] }, model)
    expect(payload.reasoning?.effort).toBe("high")
  })

  test("absent thinking on a frontier model WITHOUT xhigh in its allowlist falls back to high (explicit guard, no silent surprise)", () => {
    const model = gptModel(["low", "medium", "high"]) // gpt-5.5 but no xhigh tier
    const { payload } = build({ messages: [] }, model)
    expect(payload.reasoning?.effort).toBe("high")
  })

  test("GH_ROUTER_FRONTIER_XHIGH_DEFAULT opt-IN restores xhigh for frontier models (accepts 1/true/yes/on)", () => {
    // Inverted from the old opt-OUT: under a 1:1 default the old flag's name
    // would have meant its opposite, so it was replaced rather than reused.
    const model = gptModel(["low", "medium", "high", "xhigh"])
    const saved = process.env.GH_ROUTER_FRONTIER_XHIGH_DEFAULT
    try {
      for (const val of ["1", "true", "yes", "on"]) {
        process.env.GH_ROUTER_FRONTIER_XHIGH_DEFAULT = val
        expect(build({ messages: [] }, model).payload.reasoning?.effort).toBe("xhigh")
      }
      // Opt-in is frontier-scoped: a non-frontier model stays high.
      process.env.GH_ROUTER_FRONTIER_XHIGH_DEFAULT = "1"
      const nonFrontier = codexModel(["low", "medium", "high", "xhigh"])
      expect(build({ messages: [] }, nonFrontier).payload.reasoning?.effort).toBe("high")
    } finally {
      if (saved === undefined) delete process.env.GH_ROUTER_FRONTIER_XHIGH_DEFAULT
      else process.env.GH_ROUTER_FRONTIER_XHIGH_DEFAULT = saved
    }
  })

  test("the old opt-OUT env var no longer has any effect (renamed, not silently honored)", () => {
    // A stale `GH_ROUTER_DISABLE_FRONTIER_XHIGH_DEFAULT=1` in someone's shell
    // must not read as "disable the high default" and produce something else.
    const model = gptModel(["low", "medium", "high", "xhigh"])
    const saved = process.env.GH_ROUTER_DISABLE_FRONTIER_XHIGH_DEFAULT
    try {
      process.env.GH_ROUTER_DISABLE_FRONTIER_XHIGH_DEFAULT = "1"
      expect(build({ messages: [] }, model).payload.reasoning?.effort).toBe("high")
    } finally {
      if (saved === undefined) delete process.env.GH_ROUTER_DISABLE_FRONTIER_XHIGH_DEFAULT
      else process.env.GH_ROUTER_DISABLE_FRONTIER_XHIGH_DEFAULT = saved
    }
  })

  test("absent thinking on a model with NO reasoning_effort allowlist → no reasoning field (not forced high)", () => {
    const model = gptModel() // model does not advertise reasoning_effort support
    const { payload } = build({ messages: [] }, model)
    expect("reasoning" in payload).toBe(false)
  })

  test("enabled thinking budget overrides the default reasoning effort", () => {
    const model = gptModel(["low", "medium", "high", "xhigh"])
    const { payload } = build(
      { messages: [], thinking: { type: "enabled", budget_tokens: 1000 } },
      model,
    )
    expect(payload.reasoning?.effort).toBe("low")
  })

  test("disabled or non-enabled thinking suppresses reasoning effort", () => {
    const model = gptModel(["low", "medium", "high", "xhigh"])
    const disabled = build(
      { messages: [], thinking: { type: "disabled", budget_tokens: 30000 } },
      model,
    ).payload
    expect("reasoning" in disabled).toBe(false)

    const nonEnabled = build(
      { messages: [], thinking: { type: "auto", budget_tokens: 30000 } },
      model,
    ).payload
    expect("reasoning" in nonEnabled).toBe(false)
  })

  test("max_tokens → max_output_tokens", () => {
    const { payload } = build({ messages: [], max_tokens: 2048 })
    expect(payload.max_output_tokens).toBe(2048)
  })

  test("max_tokens below Copilot's /responses minimum (1, 15) clamps up to 16", () => {
    // Copilot's /responses rejects max_output_tokens < 16 with a 400 (verified
    // live: gpt-5.5, gpt-5.3-codex); Anthropic allows max_tokens >= 1. The shim
    // must raise a sub-16 value so a valid low request doesn't 400.
    expect(build({ messages: [], max_tokens: 1 }).payload.max_output_tokens).toBe(16)
    expect(build({ messages: [], max_tokens: 15 }).payload.max_output_tokens).toBe(16)
  })

  test("max_tokens at/above the minimum (16, 256) passes through unchanged", () => {
    expect(build({ messages: [], max_tokens: 16 }).payload.max_output_tokens).toBe(16)
    expect(build({ messages: [], max_tokens: 256 }).payload.max_output_tokens).toBe(256)
  })

  test("max_tokens absent → no max_output_tokens field emitted", () => {
    const { payload } = build({ messages: [] })
    expect("max_output_tokens" in payload).toBe(false)
  })

  test("I6: stop_sequences → Responses `stop` (forwarded; Copilot accepts it)", () => {
    const { parsed, payload } = build({
      messages: [],
      stop_sequences: ["END"],
    })
    expect(parsed.stopSequences).toEqual(["END"])
    expect(payload.stop).toEqual(["END"])
    // The Anthropic field name is never leaked onto the wire.
    expect("stop_sequences" in payload).toBe(false)
  })

  test("I6: absent stop_sequences → no `stop` field emitted", () => {
    const { parsed, payload } = build({ messages: [] })
    expect(parsed.stopSequences).toBeUndefined()
    expect("stop" in payload).toBe(false)
  })

  test("I8b: tool_choice.disable_parallel_tool_use:true → parallel_tool_calls:false", () => {
    const tools = [
      { name: "get_weather", input_schema: { type: "object", properties: {} } },
    ]
    const { parsed, payload } = build({
      messages: [],
      tools,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    })
    expect(parsed.parallelToolCalls).toBe(false)
    expect(payload.parallel_tool_calls).toBe(false)
    // tool_choice itself still maps normally.
    expect(payload.tool_choice).toBe("auto")
  })

  test("I8b: absent / false disable_parallel_tool_use → no parallel_tool_calls field", () => {
    const tools = [
      { name: "get_weather", input_schema: { type: "object", properties: {} } },
    ]
    // Omitted entirely.
    const a = build({ messages: [], tools, tool_choice: { type: "auto" } })
    expect(a.parsed.parallelToolCalls).toBeUndefined()
    expect("parallel_tool_calls" in a.payload).toBe(false)
    // Explicit false is NOT the disable signal → still omitted (never send true).
    const b = build({
      messages: [],
      tools,
      tool_choice: { type: "auto", disable_parallel_tool_use: false },
    })
    expect(b.parsed.parallelToolCalls).toBeUndefined()
    expect("parallel_tool_calls" in b.payload).toBe(false)
  })

  test("stream flag is carried through", () => {
    expect(build({ messages: [], stream: true }).payload.stream).toBe(true)
    expect(build({ messages: [], stream: false }).payload.stream).toBe(false)
  })

  test("streamed response.incomplete terminates cleanly with max_tokens stop_reason", async () => {
    const evs = await collectStream([
      { type: "response.output_text.delta", output_index: 0, delta: "partial" },
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            input_tokens_details: { cached_tokens: 3 },
          },
        },
      },
    ])

    expect(streamTypes(evs)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect((evs[2].delta as Record<string, unknown>)).toEqual({
      type: "text_delta",
      text: "partial",
    })
    const delta = evs[4]
    expect((delta.delta as Record<string, unknown>).stop_reason).toBe("max_tokens")
    expect((delta.usage as Record<string, unknown>).input_tokens).toBe(8)
    expect((delta.usage as Record<string, unknown>).output_tokens).toBe(7)
    expect((delta.usage as Record<string, unknown>).cache_read_input_tokens).toBe(3)
  })
})

// Fixture-fidelity coverage: `gpt-5.3-codex` rides the SAME `/responses` shim as
// `gpt-5.5` (the rest of this suite pins gpt-5.5). Explicitly assert the
// document→input_file and the sub-16 max_output_tokens clamp on the codex id so
// the codex surface can't regress unnoticed.
describe("anthropic-translate request mapping (gpt-5.3-codex)", () => {
  test("model id is carried onto the payload", () => {
    const { payload } = buildFor(
      CODEX_MODEL_ID,
      { messages: [{ role: "user", content: "hi" }] },
      codexModel(),
    )
    expect(payload.model).toBe(CODEX_MODEL_ID)
  })

  test("document (base64 PDF) → input_file with file_data data URI + filename", () => {
    const { payload } = buildFor(
      CODEX_MODEL_ID,
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                title: "smoke.pdf",
                source: { type: "base64", media_type: "application/pdf", data: "JVBERi0x" },
              },
              { type: "text", text: "what is in this pdf?" },
            ],
          },
        ],
      },
      codexModel(),
    )
    expect(payload.input).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_file",
            filename: "smoke.pdf",
            file_data: "data:application/pdf;base64,JVBERi0x",
          },
          { type: "input_text", text: "what is in this pdf?" },
        ],
      },
    ])
  })

  test("max_output_tokens below the /responses minimum (1, 15) clamps up to 16", () => {
    expect(
      buildFor(CODEX_MODEL_ID, { messages: [], max_tokens: 1 }, codexModel()).payload.max_output_tokens,
    ).toBe(16)
    expect(
      buildFor(CODEX_MODEL_ID, { messages: [], max_tokens: 15 }, codexModel()).payload.max_output_tokens,
    ).toBe(16)
    // At/above the minimum passes through unchanged.
    expect(
      buildFor(CODEX_MODEL_ID, { messages: [], max_tokens: 256 }, codexModel()).payload.max_output_tokens,
    ).toBe(256)
  })
})

describe("anthropic-translate file-tool steering", () => {
  const MARKER = "<file_tools>"
  const editTool = { name: "Edit", description: "edit a file", input_schema: { type: "object" } }
  const writeTool = { name: "Write", description: "write a file", input_schema: { type: "object" } }
  const bashTool = { name: "Bash", description: "run a command", input_schema: { type: "object" } }

  test("Edit tool present → guidance appended to Responses instructions, original system preserved", () => {
    const { parsed, payload } = build({
      system: "You are Claude Code.",
      messages: [{ role: "user", content: "hi" }],
      tools: [editTool, bashTool],
    })
    expect(parsed.instructions).toContain(MARKER)
    // Original system text preserved and ORDERED before the guidance (recency).
    expect(parsed.instructions).toContain("You are Claude Code.")
    expect(parsed.instructions?.indexOf("You are Claude Code.")).toBeLessThan(
      parsed.instructions?.indexOf(MARKER) ?? -1,
    )
    expect(payload.instructions).toContain(MARKER)
  })

  test("Write tool alone also triggers the guidance", () => {
    const { parsed } = build({
      system: "sys",
      messages: [],
      tools: [writeTool],
    })
    expect(parsed.instructions).toContain(MARKER)
  })

  test("no system + Edit tool → guidance becomes the whole instructions", () => {
    const { parsed } = build({
      messages: [],
      tools: [editTool],
    })
    expect(parsed.instructions).toContain(MARKER)
    // No prior system text ⇒ guidance is the entire string, no leading blank lines.
    expect(parsed.instructions?.startsWith(MARKER)).toBe(true)
  })

  test("no Edit/Write tool → guidance absent (non-editing chat not polluted)", () => {
    const withBashOnly = build({
      system: "sys",
      messages: [],
      tools: [bashTool],
    })
    expect(withBashOnly.parsed.instructions).not.toContain(MARKER)
    expect(withBashOnly.parsed.instructions).toBe("sys")

    const noTools = build({ system: "sys", messages: [] })
    expect(noTools.parsed.instructions).not.toContain(MARKER)
  })

  test("lowercase / MCP-style tool names do NOT trigger (precise capitalized match)", () => {
    const { parsed } = build({
      system: "sys",
      messages: [],
      tools: [
        { name: "write_file", description: "x", input_schema: { type: "object" } },
        { name: "edit", description: "x", input_schema: { type: "object" } },
      ],
    })
    expect(parsed.instructions).not.toContain(MARKER)
  })

  test("guidance reaches the chat/completions system message too", () => {
    const parsed = parseAnthropicRequest(
      { system: "sys", messages: [{ role: "user", content: "hi" }], tools: [editTool] },
      "gemini-3.1-pro-preview",
    )
    const chat = parsedToChatPayload(parsed)
    expect(chat.messages[0]?.role).toBe("system")
    expect(chat.messages[0]?.content).toContain(MARKER)
    expect(chat.messages[0]?.content).toContain("sys")
  })

  test("GH_ROUTER_DISABLE_SHIM_TOOL_STEERING=1 opts out", () => {
    const prev = process.env.GH_ROUTER_DISABLE_SHIM_TOOL_STEERING
    process.env.GH_ROUTER_DISABLE_SHIM_TOOL_STEERING = "1"
    try {
      const { parsed } = build({ system: "sys", messages: [], tools: [editTool] })
      expect(parsed.instructions).toBe("sys")
      expect(parsed.instructions).not.toContain(MARKER)
    } finally {
      if (prev === undefined) delete process.env.GH_ROUTER_DISABLE_SHIM_TOOL_STEERING
      else process.env.GH_ROUTER_DISABLE_SHIM_TOOL_STEERING = prev
    }
  })

  test("guidance stays in the stable prefix when a web-search dynamic suffix is present (cache determinism)", () => {
    const search = "[Web Search Results]\nresult\n[End Web Search Results]"
    const withoutSearch = build({
      system: "You are Claude Code.",
      messages: [{ role: "user", content: "hi" }],
      tools: [editTool],
    })
    const withSearch = build({
      system: [
        { type: "text", text: "You are Claude Code." },
        { type: "text", text: search },
        { type: "text", text: WEB_SEARCH_RESULT_INSTRUCTION },
      ],
      messages: [{ role: "user", content: "hi" }],
      tools: [editTool],
    })
    // The stable prefix — and therefore the guidance riding on it — is byte-
    // identical whether or not a dynamic web-search suffix trails it.
    expect(withSearch.parsed.instructions).toBe(withoutSearch.parsed.instructions)
    expect(withSearch.parsed.instructions).toContain(MARKER)
    // The dynamic suffix carries only the search content, never the guidance.
    expect(withSearch.parsed.dynamicInstructions).not.toContain(MARKER)
    expect(withSearch.parsed.dynamicInstructions).toBe(
      `${search}\n\n${WEB_SEARCH_RESULT_INSTRUCTION}`,
    )
    expect(withoutSearch.parsed.dynamicInstructions).toBeUndefined()
  })

  test("the stable prefix payload.instructions is byte-identical whether or not the web-search suffix is present", () => {
    // GPT-5.6 explicit caching does not apply on this (shim/"conversation")
    // path at all (see the dedicated regression test above and
    // `prompt-cache.ts`'s doc comment), so there is no `prompt_cache_key` to
    // compare here. What still matters for Copilot's own provider-managed
    // automatic caching is that `payload.instructions` — the literal bytes a
    // prefix-matching cache keys off — is identical regardless of whether a
    // volatile web-search suffix trails it on a given turn.
    const longSystem = "You are Claude Code. ".repeat(300)
    const search = "[Web Search Results]\nresult\n[End Web Search Results]"

    const without = buildFor("gpt-5.6-sol", {
      system: longSystem,
      messages: [{ role: "user", content: "hi" }],
      tools: [editTool],
    })
    const withSearch = buildFor("gpt-5.6-sol", {
      system: [
        { type: "text", text: longSystem },
        { type: "text", text: search },
        { type: "text", text: WEB_SEARCH_RESULT_INSTRUCTION },
      ],
      messages: [{ role: "user", content: "hi" }],
      tools: [editTool],
    })

    expect(without.payload.prompt_cache_key).toBeUndefined()
    expect(without.payload.instructions).toContain(MARKER)
    expect(without.payload.instructions).toBe(withSearch.payload.instructions)

    // The dynamic web-search item is the only extra input item on that turn.
    const withoutInput = without.payload.input as Array<Record<string, unknown>>
    const withSearchInput = withSearch.payload.input as Array<Record<string, unknown>>
    expect(withSearchInput).toHaveLength(2)
    expect(withoutInput).toHaveLength(1)
  })
})

// Claude Code's effort picker puts its choice on the wire as
// `output_config.effort`. `stripAnthropicOnlyFields` explicitly preserves that
// field (`PROXY_OWNED_FIELDS`), but until the shim read it the value was simply
// dropped, making the picker a no-op on every non-Claude model in three
// distinct ways — each pinned below.
describe("anthropic-translate output_config.effort (client-selected effort)", () => {
  const ALL = ["low", "medium", "high", "xhigh", "max"]

  test("wins over the absent-thinking default", () => {
    const model = gptModel(ALL)
    const { payload } = build(
      { messages: [], output_config: { effort: "xhigh" } },
      model,
    )
    expect(payload.reasoning?.effort).toBe("xhigh")
  })

  test("carries the max tier through", () => {
    const model = gptModel(ALL)
    const { payload } = build(
      { messages: [], output_config: { effort: "max" } },
      model,
    )
    expect(payload.reasoning?.effort).toBe("max")
  })

  test("wins over a conflicting thinking budget", () => {
    // budget 5000 buckets to `medium`; the explicit selection must not lose to
    // it, matching the passthrough path's documented precedence.
    const model = gptModel(ALL)
    const { payload } = build(
      {
        messages: [],
        output_config: { effort: "xhigh" },
        thinking: { type: "enabled", budget_tokens: 5000 },
      },
      model,
    )
    expect(payload.reasoning?.effort).toBe("xhigh")
  })

  test("survives thinking:{type:'adaptive'}, which previously dropped reasoning entirely", () => {
    // The adaptive shape is neither `undefined` nor `enabled`, so both of the
    // other branches decline it and no reasoning field was emitted at all.
    const model = gptModel(ALL)
    const { payload } = build(
      {
        messages: [],
        output_config: { effort: "xhigh" },
        thinking: { type: "adaptive" },
      },
      model,
    )
    expect(payload.reasoning?.effort).toBe("xhigh")
  })

  test("clamps to a model that does not advertise the selected tier", () => {
    const model = gptModel(["low", "medium", "high"]) // gemini-like ceiling
    for (const selected of ["xhigh", "max"]) {
      const { payload } = build(
        { messages: [], output_config: { effort: selected } },
        model,
      )
      expect(payload.reasoning?.effort).toBe("high")
    }
  })

  test("an unrecognized tier clamps DOWN to the highest supported, never up", () => {
    const model = gptModel(["low", "medium", "high"])
    const { payload } = build(
      { messages: [], output_config: { effort: "ludicrous" } },
      model,
    )
    expect(payload.reasoning?.effort).toBe("high")
  })

  test("a non-effort output_config leaves the default path untouched", () => {
    const model = gptModel(ALL)
    const { payload } = build(
      { messages: [], output_config: { schema: { type: "object" } } },
      model,
    )
    expect(payload.reasoning?.effort).toBe("high")
  })

  test("a model advertising no allowlist honors a recognized tier but drops an unrecognized one", () => {
    // Nothing to clamp against. A known tier is well-formed so the client's
    // explicit choice stands; an arbitrary string would become a synthesized
    // `reasoning.effort` on a payload we build, which is the 400 that
    // `defaultReasoningEffort` already refuses to risk for this model class.
    expect(
      build({ messages: [], output_config: { effort: "xhigh" } }, gptModel())
        .payload.reasoning?.effort,
    ).toBe("xhigh")
    expect(
      build({ messages: [], output_config: { effort: "ludicrous" } }, gptModel())
        .payload.reasoning?.effort,
    ).toBeUndefined()
  })

  test("a malformed effort falls through to the thinking/default path", () => {
    const model = gptModel(ALL)
    for (const bad of [42, null, "", { nested: true }]) {
      const { payload } = build(
        { messages: [], output_config: { effort: bad } },
        model,
      )
      expect(payload.reasoning?.effort).toBe("high")
    }
  })
})

// The same tier-ladder invariants, exercised through the shim rather than the
// passthrough clamp, since the two share EFFORT_ORDER.
describe("anthropic-translate effort ladder ends (none / max)", () => {
  test("`none` on a model that lacks it clamps to the LOWEST supported, not the highest", () => {
    const model = gptModel(["low", "medium", "high"])
    const { payload } = build(
      { messages: [], output_config: { effort: "none" } },
      model,
    )
    expect(payload.reasoning?.effort).toBe("low")
  })

  test("`none` passes through on a model that advertises it", () => {
    const model = gptModel(["none", "low", "medium", "high", "xhigh"])
    const { payload } = build(
      { messages: [], output_config: { effort: "none" } },
      model,
    )
    expect(payload.reasoning?.effort).toBe("none")
  })

  test("an unrecognized effort does NOT escalate to `max` on a max-capable model", () => {
    const model = gptModel(["low", "medium", "high", "xhigh", "max"])
    const { payload } = build(
      { messages: [], output_config: { effort: "ludicrous" } },
      model,
    )
    expect(payload.reasoning?.effort).toBe("xhigh")
  })

  test("a thinking budget never reaches `max`, however large", () => {
    const model = gptModel(["low", "medium", "high", "xhigh", "max"])
    for (const budget of [24000, 200000, 10_000_000]) {
      const { payload } = build(
        { messages: [], thinking: { type: "enabled", budget_tokens: budget } },
        model,
      )
      expect(payload.reasoning?.effort).toBe("xhigh")
    }
  })
})
