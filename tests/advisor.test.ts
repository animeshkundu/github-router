import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"
import { server } from "../src/server"
import {
  ADVISOR_CLIENT_TOOL_NAME,
  ADVISOR_DEFAULT_EFFORT,
  ADVISOR_DEFAULT_MODEL,
  ADVISOR_INTERNAL_TOOL_NAME,
  ADVISOR_MAX_CONVERSATION_CHARS,
  ADVISOR_TOOL_INSTRUCTIONS,
  injectAdvisorTool,
  isAdvisorRequested,
  renderConversationAsText,
  toClientServerToolUseId,
} from "../src/services/advisor/advisor"

const originalFetch = globalThis.fetch
let savedModels: typeof state.models
let savedExtendedBetas: boolean

function makeClaudeModel(id: string) {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "anthropic",
    version: "1",
    model_picker_enabled: true,
    capabilities: {
      family: "claude",
      limits: { max_output_tokens: 8192 },
      object: "model",
      supports: {},
      tokenizer: "claude",
      type: "chat",
    },
  }
}

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "enterprise"
  savedExtendedBetas = state.extendedBetas
  state.extendedBetas = true
  savedModels = state.models
  state.models = {
    object: "list",
    data: [
      makeClaudeModel("claude-opus-4.7"),
      makeClaudeModel("claude-haiku-4.5"),
      // gpt-5.5 is the cross-lab advisor default
      {
        id: "gpt-5.5",
        name: "gpt-5.5",
        object: "model",
        preview: false,
        vendor: "openai",
        version: "1",
        model_picker_enabled: true,
        capabilities: {
          family: "gpt-5",
          limits: { max_output_tokens: 16384 },
          object: "model",
          supports: {},
          tokenizer: "o200k",
          type: "chat",
        },
      },
    ] as unknown as NonNullable<typeof state.models>["data"],
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = savedModels
  state.extendedBetas = savedExtendedBetas
  delete process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL
})

describe("ADVISOR defaults (Phase I)", () => {
  test("default model is gpt-5.5 (cross-lab)", () => {
    expect(ADVISOR_DEFAULT_MODEL).toBe("gpt-5.5")
  })
  test("default effort is xhigh (deepest reasoning bucket)", () => {
    expect(ADVISOR_DEFAULT_EFFORT).toBe("xhigh")
  })
})

// ─────────────────────────────────────────────────────────────────────
//  unit: isAdvisorRequested
// ─────────────────────────────────────────────────────────────────────

describe("isAdvisorRequested (Phase I)", () => {
  test("detects advisor-tool-* in beta header", () => {
    expect(isAdvisorRequested("advisor-tool-2026-03-01")).toBe(true)
    expect(
      isAdvisorRequested("interleaved-thinking-2025-05-14,advisor-tool-2026-03-01"),
    ).toBe(true)
  })

  test("returns false when header missing", () => {
    expect(isAdvisorRequested(undefined)).toBe(false)
    expect(isAdvisorRequested("")).toBe(false)
  })

  test("returns false when no advisor prefix", () => {
    expect(isAdvisorRequested("interleaved-thinking-2025-05-14")).toBe(false)
    expect(isAdvisorRequested("task-budgets-2026-03-13")).toBe(false)
  })

  test("returns false when CLAUDE_CODE_DISABLE_ADVISOR_TOOL set", () => {
    process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = "1"
    expect(isAdvisorRequested("advisor-tool-2026-03-01")).toBe(false)
  })

  test("trims whitespace around comma-separated values", () => {
    expect(
      isAdvisorRequested(" interleaved-thinking-2025-05-14 , advisor-tool-2026-03-01 "),
    ).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
//  unit: injectAdvisorTool
// ─────────────────────────────────────────────────────────────────────

describe("injectAdvisorTool (Phase I)", () => {
  test("adds __anthropic_advisor tool with ADVISOR_TOOL_INSTRUCTIONS description", () => {
    const body = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [],
    })
    const out = injectAdvisorTool(body)
    const parsed = JSON.parse(out) as { tools: Array<{ name: string; description: string }> }
    expect(parsed.tools).toHaveLength(1)
    expect(parsed.tools[0].name).toBe(ADVISOR_INTERNAL_TOOL_NAME)
    expect(parsed.tools[0].description).toBe(ADVISOR_TOOL_INSTRUCTIONS)
  })

  test("preserves existing tools array when injecting", () => {
    const body = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [],
      tools: [
        { name: "MyCustomTool", description: "x", input_schema: { type: "object" } },
      ],
    })
    const out = injectAdvisorTool(body)
    const parsed = JSON.parse(out) as { tools: Array<{ name: string }> }
    expect(parsed.tools).toHaveLength(2)
    // Default sort: "M" (0x4D) < "_" (0x5F), so MyCustomTool comes first.
    expect(parsed.tools.map((t) => t.name).sort()).toEqual([
      "MyCustomTool",
      ADVISOR_INTERNAL_TOOL_NAME,
    ])
  })

  test("idempotent: doesn't double-inject if __anthropic_advisor already present", () => {
    const body = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [],
      tools: [
        { name: ADVISOR_INTERNAL_TOOL_NAME, description: "existing", input_schema: { type: "object" } },
      ],
    })
    const out = injectAdvisorTool(body)
    expect(out).toBe(body) // unchanged
  })

  test("returns body unchanged on JSON parse failure", () => {
    const body = "not-json"
    expect(injectAdvisorTool(body)).toBe(body)
  })

  test("strips Anthropic-native advisor typed tool (advisor_20260301) — Copilot 400s on the unknown tool type", () => {
    // When CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1 (auto-set
    // by the proxy), Claude Code adds its own advisor tool to tools[]
    // with `type: "advisor_20260301"`. Copilot doesn't recognize the
    // type and 400s with "Input tag 'advisor_20260301' found using
    // 'type' does not match any of the expected tags". The proxy must
    // strip it BEFORE forwarding while still injecting our own
    // __anthropic_advisor custom tool that the model can invoke.
    const body = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [],
      tools: [
        { name: "Read", input_schema: { type: "object" } },
        { type: "advisor_20260301" },
        { name: "Write", input_schema: { type: "object" } },
      ],
    })
    const out = injectAdvisorTool(body)
    const parsed = JSON.parse(out) as { tools: Array<Record<string, unknown>> }
    // Anthropic-typed advisor tool stripped.
    expect(
      parsed.tools.some(
        (t) => typeof t.type === "string" && t.type.startsWith("advisor_"),
      ),
    ).toBe(false)
    // Other tools preserved.
    expect(parsed.tools.some((t) => t.name === "Read")).toBe(true)
    expect(parsed.tools.some((t) => t.name === "Write")).toBe(true)
    // Our custom __anthropic_advisor tool added.
    expect(parsed.tools.some((t) => t.name === ADVISOR_INTERNAL_TOOL_NAME)).toBe(
      true,
    )
  })

  test("strips advisor typed tool even when __anthropic_advisor is already present (no double-inject + still strip)", () => {
    const body = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [],
      tools: [
        { type: "advisor_20260301" },
        {
          name: ADVISOR_INTERNAL_TOOL_NAME,
          description: "existing",
          input_schema: { type: "object" },
        },
      ],
    })
    const out = injectAdvisorTool(body)
    const parsed = JSON.parse(out) as { tools: Array<Record<string, unknown>> }
    expect(parsed.tools.length).toBe(1)
    expect(parsed.tools[0].name).toBe(ADVISOR_INTERNAL_TOOL_NAME)
  })

  test("does not strip future advisor type variants beyond advisor_ prefix unless they also start with advisor_", () => {
    // Defensive: only strip tools whose `type` literally starts with
    // "advisor_". A tool named "advisor" or with a different type
    // string should pass through.
    const body = JSON.stringify({
      model: "claude-opus-4.7",
      messages: [],
      tools: [
        { name: "advisor", input_schema: { type: "object" } }, // custom tool named advisor — keep
        { type: "custom" }, // generic custom tool — keep
        { type: "advisor_20270101" }, // future variant — strip
      ],
    })
    const out = injectAdvisorTool(body)
    const parsed = JSON.parse(out) as { tools: Array<Record<string, unknown>> }
    expect(parsed.tools.some((t) => t.name === "advisor")).toBe(true)
    expect(parsed.tools.some((t) => t.type === "custom")).toBe(true)
    expect(parsed.tools.some((t) => t.type === "advisor_20270101")).toBe(false)
  })

  test("input_schema requires no parameters (advisor takes the conversation context implicitly)", () => {
    const body = JSON.stringify({ model: "claude-opus-4.7", messages: [] })
    const out = injectAdvisorTool(body)
    const parsed = JSON.parse(out) as {
      tools: Array<{ input_schema: { type: string; properties: Record<string, unknown>; required: Array<string> } }>
    }
    expect(parsed.tools[0].input_schema.type).toBe("object")
    expect(Object.keys(parsed.tools[0].input_schema.properties)).toHaveLength(0)
    expect(parsed.tools[0].input_schema.required).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────
//  integration: streaming advisor translate-loop
// ─────────────────────────────────────────────────────────────────────

describe("ADVISOR streaming integration (Phase I)", () => {
  /**
   * Build an SSE stream body from a list of (event, data) pairs.
   * Mocks Copilot's streaming response shape.
   */
  function buildSseStream(
    events: Array<{ event: string; data: unknown }>,
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        for (const ev of events) {
          const line = `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`
          controller.enqueue(encoder.encode(line))
        }
        controller.close()
      },
    })
  }

  /** Drain a stream body into a string. */
  async function streamToString(body: ReadableStream<Uint8Array>): Promise<string> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let out = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) out += decoder.decode(value, { stream: true })
    }
    out += decoder.decode()
    return out
  }

  test("when no advisor-tool- header, request flows through normal relay (no translate)", async () => {
    // Mock fetch returns a normal SSE stream with text + message_stop.
    const fetchMock = mock((url: string) => {
      if (url.includes("/v1/messages")) {
        return new Response(
          buildSseStream([
            { event: "message_start", data: { type: "message_start", message: { id: "m1" } } },
            { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
            { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } } },
            { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
            { event: "message_stop", data: { type: "message_stop" } },
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const text = await streamToString(response.body!)
    expect(text).toContain("Hello")
    // No advisor translation happened.
    expect(text).not.toContain("__anthropic_advisor")
    expect(text).not.toContain("server_tool_use")
  })

  test("when advisor-tool- header set: NO advisor invocation by model → identical to passthrough", async () => {
    // This case: header set but model doesn't actually call advisor.
    // The translate-loop should pass through cleanly.
    const fetchMock = mock((url: string) => {
      if (url.includes("/v1/messages")) {
        return new Response(
          buildSseStream([
            { event: "message_start", data: { type: "message_start", message: { id: "m1" } } },
            { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
            { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "No advisor needed" } } },
            { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
            { event: "message_stop", data: { type: "message_stop" } },
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-beta": "advisor-tool-2026-03-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    expect(response.status).toBe(200)
    const text = await streamToString(response.body!)
    expect(text).toContain("No advisor needed")
    expect(text).toContain("message_stop")
  })

  test("when model calls __anthropic_advisor: translates to server_tool_use{advisor}, runs advisor, emits advisor_tool_result, continues", async () => {
    // First Copilot call (/v1/messages stream): returns text + tool_use{__anthropic_advisor}.
    // Second Copilot call (continuation, /v1/messages stream): returns more text + message_stop.
    // Advisor call (gpt-5.5 via /responses, non-stream): returns advisor's text.
    let copilotMessagesCallCount = 0
    let advisorResponsesCallCount = 0
    let continuationRequestBody: string | undefined
    const fetchMock = mock((url: string, init?: { body?: string }) => {
      // ADVISOR call: gpt-5.5 → /responses with reasoning.effort=xhigh
      if (url.includes("/responses")) {
        const parsedBody = JSON.parse((init?.body ?? "{}") as string) as {
          model?: string
          reasoning?: { effort?: string }
          stream?: boolean
        }
        // Verify the advisor call uses gpt-5.5 + xhigh + non-streaming
        expect(parsedBody.model).toBe("gpt-5.5")
        expect(parsedBody.reasoning?.effort).toBe("xhigh")
        expect(parsedBody.stream).toBe(false)
        advisorResponsesCallCount++
        return new Response(
          JSON.stringify({
            id: "advisor_resp",
            object: "response",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "Advisor says: you're on track. Proceed.",
                  },
                ],
              },
            ],
            usage: { input_tokens: 50, output_tokens: 10 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }

      if (url.includes("/v1/messages")) {
        // Copilot main-loop call: streaming. First call returns the
        // advisor tool_use; second (continuation) returns final text.
        copilotMessagesCallCount++
        if (copilotMessagesCallCount === 1) {
          return new Response(
            buildSseStream([
              { event: "message_start", data: { type: "message_start", message: { id: "m1" } } },
              // Thinking block — must be preserved with .thinking text
              // and .signature (Anthropic spec) when replayed to
              // Copilot in the continuation turn.
              { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
              { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "I should ask the advisor." } } },
              { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abcdef" } } },
              { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "0123456789" } } },
              { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
              { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
              { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Let me consult." } } },
              { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
              // Non-advisor tool_use with non-empty input streamed via
              // input_json_delta — must be parsed into an OBJECT (not
              // string) on Copilot replay (gemini round-6 fix).
              { event: "content_block_start", data: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_read_1", name: "Read", input: {} } } },
              { event: "content_block_delta", data: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"file_p" } } },
              { event: "content_block_delta", data: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "ath\":\"/tmp/x" } } },
              { event: "content_block_delta", data: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: ".txt\"}" } } },
              { event: "content_block_stop", data: { type: "content_block_stop", index: 2 } },
              { event: "content_block_start", data: { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "toolu_advisor_1", name: ADVISOR_INTERNAL_TOOL_NAME, input: {} } } },
              { event: "content_block_stop", data: { type: "content_block_stop", index: 3 } },
              { event: "message_stop", data: { type: "message_stop" } },
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          )
        }
        // Continuation after advisor result. Capture body for assertions.
        continuationRequestBody = init?.body ?? ""
        return new Response(
          buildSseStream([
            { event: "message_start", data: { type: "message_start", message: { id: "m2" } } },
            { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
            { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Based on advisor: proceeding." } } },
            { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
            { event: "message_stop", data: { type: "message_stop" } },
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-beta": "advisor-tool-2026-03-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    expect(response.status).toBe(200)
    const text = await streamToString(response.body!)

    // Verify the translate-loop:
    // 1. Original text from turn 1 is forwarded
    expect(text).toContain("Let me consult.")
    // 2. The tool_use block is translated to server_tool_use{advisor}
    expect(text).toContain('"server_tool_use"')
    expect(text).toContain(`"name":"${ADVISOR_CLIENT_TOOL_NAME}"`)
    // 3. The internal name is NOT exposed to client
    expect(text).not.toContain(ADVISOR_INTERNAL_TOOL_NAME)
    // 4. advisor_tool_result block is emitted
    expect(text).toContain('"advisor_tool_result"')
    expect(text).toContain('"advisor_result"')
    expect(text).toContain("Advisor says:")
    // 5. Continuation text from turn 2 is forwarded
    expect(text).toContain("Based on advisor: proceeding")
    // 6. Single message_stop event at the very end (only one for the
    //    whole loop). Count `event: message_stop` lines specifically —
    //    the substring `message_stop` appears twice per SSE event (once
    //    in `event: message_stop` and once in `"type":"message_stop"`
    //    inside the data payload).
    const messageStopEventCount = (text.match(/^event: message_stop$/gm) ?? []).length
    expect(messageStopEventCount).toBe(1)

    // Verify the advisor model was called once via /responses with xhigh
    expect(advisorResponsesCallCount).toBe(1)
    // Verify Copilot was called twice via /v1/messages (main + continuation)
    expect(copilotMessagesCallCount).toBe(2)

    // ── round-5 codex/gemini bug fix: id format spec compliance ──
    // server_tool_use.id (client-facing) must be `srvtoolu_*` per
    // Anthropic spec. The original model id was `toolu_advisor_1`, so
    // the derived client id is `srvtoolu_advisor_1`.
    const serverToolUseMatches = text.match(
      /"type":"server_tool_use","id":"([^"]+)"/g,
    )
    expect(serverToolUseMatches).not.toBeNull()
    expect(serverToolUseMatches!.length).toBeGreaterThan(0)
    for (const m of serverToolUseMatches!) {
      const id = m.match(/"id":"([^"]+)"/)![1]!
      expect(id).toMatch(/^srvtoolu_[a-zA-Z0-9_]+$/)
      expect(id).toBe("srvtoolu_advisor_1")
    }

    // advisor_tool_result.tool_use_id (client-facing) must pair with
    // the server_tool_use.id and match the same spec.
    const advisorResultMatches = text.match(
      /"type":"advisor_tool_result","tool_use_id":"([^"]+)"/g,
    )
    expect(advisorResultMatches).not.toBeNull()
    expect(advisorResultMatches!.length).toBeGreaterThan(0)
    for (const m of advisorResultMatches!) {
      const id = m.match(/"tool_use_id":"([^"]+)"/)![1]!
      expect(id).toMatch(/^srvtoolu_[a-zA-Z0-9_]+$/)
      expect(id).toBe("srvtoolu_advisor_1") // pairs with server_tool_use
    }

    // Copilot replay (the continuation request body) must use the
    // ORIGINAL `toolu_*` id, NOT the client-facing `srvtoolu_*`.
    // Copilot's spec validator expects `^toolu_*$` for tool_use ids
    // and the matching `tool_result.tool_use_id` reference.
    expect(continuationRequestBody).toBeDefined()
    expect(continuationRequestBody!).toContain('"id":"toolu_advisor_1"')
    expect(continuationRequestBody!).toContain(
      '"tool_use_id":"toolu_advisor_1"',
    )
    // Belt-and-suspenders: continuation body must NOT leak the client-
    // facing srvtoolu_ id into the Copilot replay.
    expect(continuationRequestBody!).not.toContain("srvtoolu_")

    // ── round-7 holistic fix: thinking-block + tool_use input replay ──
    // The mocked first turn included a `thinking` block streamed via
    // thinking_delta + signature_delta events. The continuation
    // request body MUST include the thinking block with both .thinking
    // text and .signature preserved verbatim, or Copilot 400s with
    // `messages.N.content.M.thinking.thinking: Field required`.
    const continuationParsed = JSON.parse(continuationRequestBody!) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }
    // Find the assistant message (the one we constructed from the
    // upstream stream).
    const assistantMsg = continuationParsed.messages.find(
      (m) => m.role === "assistant",
    )
    expect(assistantMsg).toBeDefined()
    const thinkingBlock = assistantMsg!.content.find(
      (b) => b.type === "thinking",
    )
    expect(thinkingBlock).toBeDefined()
    expect(thinkingBlock!.thinking).toBe("I should ask the advisor.")
    // signature_delta arrived in two chunks; verbatim concat per
    // Anthropic spec (cryptographic verification).
    expect(thinkingBlock!.signature).toBe("abcdef0123456789")

    // Non-advisor `tool_use` block must have its `input` field as a
    // PARSED OBJECT (not the raw `partial_json` string accumulator).
    // gemini round-6 finding.
    const readToolUseBlock = assistantMsg!.content.find(
      (b) => b.type === "tool_use" && b.name === "Read",
    )
    expect(readToolUseBlock).toBeDefined()
    expect(typeof readToolUseBlock!.input).toBe("object")
    expect(readToolUseBlock!.input).toEqual({ file_path: "/tmp/x.txt" })
    expect(readToolUseBlock!.id).toBe("toolu_read_1")
  })

  test("CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 disables advisor — request flows as normal passthrough", async () => {
    process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = "1"
    let injectedTool = false
    const fetchMock = mock((url: string, init?: { body?: string }) => {
      if (url.includes("/v1/messages")) {
        const parsed = JSON.parse(init?.body ?? "{}") as {
          tools?: Array<{ name: string }>
        }
        if (
          parsed.tools?.some((t) => t.name === ADVISOR_INTERNAL_TOOL_NAME)
        ) {
          injectedTool = true
        }
        return new Response(
          buildSseStream([
            { event: "message_start", data: { type: "message_start", message: { id: "m1" } } },
            { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
            { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
            { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
            { event: "message_stop", data: { type: "message_stop" } },
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-beta": "advisor-tool-2026-03-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    expect(response.status).toBe(200)
    // Tool was NOT injected (advisor disabled).
    expect(injectedTool).toBe(false)
  })
})

describe("toClientServerToolUseId charset hardening (round-5 codex critic)", () => {
  test("normal toolu_ id → srvtoolu_ id with prefix swap", () => {
    expect(toClientServerToolUseId("toolu_abc123XYZ", 0)).toBe(
      "srvtoolu_abc123XYZ",
    )
  })

  test("synthesized toolu_advisor_N fallback id → srvtoolu_advisor_N", () => {
    expect(toClientServerToolUseId("toolu_advisor_5", 5)).toBe(
      "srvtoolu_advisor_5",
    )
  })

  test("non-toolu_ prefix with valid charset → srvtoolu_ + raw suffix", () => {
    // e.g., a future provider's id that doesn't start with toolu_ but
    // is otherwise spec-compliant; pass through with srvtoolu_ prefix.
    expect(toClientServerToolUseId("call_oai_xyz", 9)).toBe(
      "srvtoolu_call_oai_xyz",
    )
  })

  test("malformed id with hyphens → synthesized fallback (defensive)", () => {
    // Hyphens are NOT in the spec charset [a-zA-Z0-9_]. Without the
    // fallback, srvtoolu_abc-123 would be a malformed block and 400.
    expect(toClientServerToolUseId("toolu_abc-123", 7)).toBe(
      "srvtoolu_advisor_7",
    )
  })

  test("non-ascii id → synthesized fallback", () => {
    expect(toClientServerToolUseId("toolu_abcé", 11)).toBe(
      "srvtoolu_advisor_11",
    )
  })

  test("empty suffix after toolu_ stripping → fallback (regex requires at least one char)", () => {
    expect(toClientServerToolUseId("toolu_", 13)).toBe("srvtoolu_advisor_13")
  })

  test("output always matches Anthropic spec /^srvtoolu_[a-zA-Z0-9_]+$/", () => {
    const inputs = [
      "toolu_normal_id_42",
      "toolu_with-hyphen",
      "call_oai_chunk",
      "toolu_",
      "weird id with spaces",
      "",
    ]
    for (let i = 0; i < inputs.length; i++) {
      const out = toClientServerToolUseId(inputs[i]!, i)
      expect(out).toMatch(/^srvtoolu_[a-zA-Z0-9_]+$/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// renderConversationAsText front-truncation (Phase L)
// Long Claude Code sessions render to >272K tokens (gpt-5.5's prompt
// cap on /v1/responses). Without truncation the advisor fails with
// `model_max_prompt_tokens_exceeded` and falls back silently. The
// front-truncation drops oldest turns first because the advisor's
// value is on the current state, not the original prompt.
// ─────────────────────────────────────────────────────────────────────

describe("renderConversationAsText (Phase L truncation)", () => {
  test("default char budget matches gpt-5.5 prompt cap with headroom", () => {
    // 720K chars at ~3 chars/token ≈ 240K tokens, leaving ~32K
    // headroom under gpt-5.5's 272K limit. If this constant changes,
    // re-derive the headroom and update the inline doc comment.
    expect(ADVISOR_MAX_CONVERSATION_CHARS).toBe(720_000)
  })

  test("short conversation passes through unchanged (no truncation marker)", () => {
    const conversation = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]
    const out = renderConversationAsText(conversation)
    expect(out).not.toContain("[TRUNCATED")
    expect(out).toContain("### Turn 1 — user")
    expect(out).toContain("hello")
    expect(out).toContain("### Turn 2 — assistant")
    expect(out).toContain("hi there")
  })

  test("front-truncates oldest turns when budget exceeded; keeps tail", () => {
    // Each turn is ~1100 chars; with a 5000-char budget we should keep
    // the latest ~4 turns and drop the rest.
    const filler = "x".repeat(1000)
    const conversation = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i + 1} ${filler}`,
    }))
    const out = renderConversationAsText(conversation, 5000)
    expect(out.startsWith("[TRUNCATED:")).toBe(true)
    expect(out).toContain("earlier turn(s) omitted")
    // The latest turn must be present; older turns must be dropped.
    expect(out).toContain("### Turn 20 — assistant")
    expect(out).toContain("turn 20")
    expect(out).not.toContain("### Turn 1 — user")
    expect(out).not.toContain("turn 1 ")
    // Total length stays at or under budget (modulo the truncation
    // notice itself, which is tiny).
    expect(out.length).toBeLessThanOrEqual(5500)
  })

  test("preserves most-recent turn even when it alone exceeds budget (tail-truncate)", () => {
    const huge = "y".repeat(10000)
    const conversation = [
      { role: "user", content: "early turn" },
      { role: "assistant", content: huge },
    ]
    const out = renderConversationAsText(conversation, 2000)
    // Must announce a hard truncation and only show the tail of turn 2.
    expect(out).toContain("[TRUNCATED:")
    expect(out).toContain("turn 2")
    expect(out).toContain("yyyy") // the tail of the huge string
    expect(out.length).toBeLessThanOrEqual(2000)
    expect(out).not.toContain("early turn")
  })

  test("truncation notice reports correct counts", () => {
    const filler = "z".repeat(500)
    const conversation = Array.from({ length: 10 }, (_, i) => ({
      role: "user",
      content: `t${i + 1} ${filler}`,
    }))
    // Each turn ≈ 580 chars. Budget 1500 keeps the latest ~2 turns,
    // drops 8 earlier ones.
    const out = renderConversationAsText(conversation, 1500)
    const match = /\[TRUNCATED: (\d+) earlier turn\(s\) omitted .* (\d+) most-recent turn\(s\) shown/.exec(out)
    expect(match).not.toBeNull()
    const dropped = Number(match![1])
    const kept = Number(match![2])
    expect(dropped + kept).toBe(10)
    expect(kept).toBeGreaterThan(0)
    expect(dropped).toBeGreaterThan(0)
  })

  test("empty conversation returns empty string with no notice", () => {
    expect(renderConversationAsText([])).toBe("")
  })

  test("custom budget parameter overrides default", () => {
    const conversation = Array.from({ length: 5 }, (_, i) => ({
      role: "user",
      content: `turn ${i + 1} ${"a".repeat(2000)}`,
    }))
    // With a tiny budget, only the latest turn (or part of it) survives.
    const tight = renderConversationAsText(conversation, 3000)
    expect(tight).toContain("[TRUNCATED:")
    // With a generous budget, everything fits.
    const generous = renderConversationAsText(conversation, 100_000)
    expect(generous).not.toContain("[TRUNCATED:")
    expect(generous).toContain("### Turn 1 — user")
    expect(generous).toContain("### Turn 5 — user")
  })

  test("tool_use and tool_result blocks counted in budget; truncated together", () => {
    const conversation = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "assistant" : "user",
      content: [
        {
          type: i % 2 === 0 ? "tool_use" : "tool_result",
          ...(i % 2 === 0
            ? {
                id: `toolu_${i}`,
                name: "Read",
                input: { file_path: `/some/path/${i}` },
              }
            : {
                tool_use_id: `toolu_${i - 1}`,
                content: "x".repeat(800),
              }),
        },
      ],
    }))
    const out = renderConversationAsText(conversation, 3000)
    expect(out).toContain("[TRUNCATED:")
    // The latest few turns must include their tool_use / tool_result
    // serialization (i.e. the renderer didn't strip them when truncating).
    expect(out).toMatch(/tool_(use|result)/)
  })
})

