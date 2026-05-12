import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"
import { server } from "../src/server"
import {
  ADVISOR_CLIENT_TOOL_NAME,
  ADVISOR_INTERNAL_TOOL_NAME,
  ADVISOR_TOOL_INSTRUCTIONS,
  injectAdvisorTool,
  isAdvisorRequested,
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
    // First Copilot call: returns text + tool_use{__anthropic_advisor}.
    // Second Copilot call (continuation after advisor): returns more text + message_stop.
    // Third call (advisor model itself): returns advisor's reviewer response.
    let copilotCallCount = 0
    let advisorCallCount = 0
    const fetchMock = mock((url: string, init?: { body?: string }) => {
      if (url.includes("/v1/messages")) {
        const parsedBody = JSON.parse((init?.body ?? "{}") as string) as {
          model?: string
          stream?: boolean
        }
        // Advisor model call: model=gpt-5.5, stream:false. Returns
        // a normal /v1/messages JSON response.
        if (parsedBody.model === "gpt-5.5" && parsedBody.stream === false) {
          advisorCallCount++
          return new Response(
            JSON.stringify({
              id: "advisor_resp",
              type: "message",
              role: "assistant",
              model: "gpt-5.5",
              content: [
                {
                  type: "text",
                  text: "Advisor says: you're on track. Proceed.",
                },
              ],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 50, output_tokens: 10 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }

        // Copilot main-loop call: streaming. First call returns the
        // advisor tool_use; second (continuation) returns final text.
        copilotCallCount++
        if (copilotCallCount === 1) {
          return new Response(
            buildSseStream([
              { event: "message_start", data: { type: "message_start", message: { id: "m1" } } },
              { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
              { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me consult." } } },
              { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
              { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_advisor_1", name: ADVISOR_INTERNAL_TOOL_NAME, input: {} } } },
              { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
              { event: "message_stop", data: { type: "message_stop" } },
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          )
        }
        // Continuation after advisor result.
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

    // Verify the advisor model was called once
    expect(advisorCallCount).toBe(1)
    // Verify Copilot was called twice (main + continuation)
    expect(copilotCallCount).toBe(2)
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
