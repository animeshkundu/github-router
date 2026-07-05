// Request-mapping unit tests for the Anthropic → Responses shim ingest.
// Pure functions — no fetch/state mocking needed.

import { expect, test, describe } from "bun:test"

import {
  parseAnthropicRequest,
  parsedToResponsesPayload,
} from "~/lib/anthropic-translate/anthropic-request"
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
    // no thinking → no reasoning field
    expect(build({ messages: [] }, model).payload.reasoning).toBeUndefined()
  })

  test("thinking effort clamps to a model without xhigh", () => {
    const model = gptModel(["low", "medium", "high"]) // e.g. gemini-like ceiling
    const effort = build(
      { messages: [], thinking: { type: "enabled", budget_tokens: 30000 } },
      model,
    ).payload.reasoning?.effort
    expect(effort).toBe("high")
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
