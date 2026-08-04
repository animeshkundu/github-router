// Golden lock on the /responses request payload shape.
//
// Both /responses callers — the worker-agent stream (`buildResponsesPayload`
// in src/lib/worker-agent/stream-fn.ts) and the Anthropic-translation shim
// (`parsedToResponsesPayload`) — funnel through the SHARED builder
// `assembleResponsesPayload` (src/services/copilot/responses-request.ts). These
// exact-shape assertions pin the wire encoding so a future refactor of the
// shared builder (or the worker's Pi Context → neutral conversion) can't
// silently drift the worker hot path.
//
// Part 1 asserts the shared builder directly (pure, no mocking). Part 2 drives
// the REAL worker stream end-to-end (createCopilotStreamFn on a /responses
// model, mocked fetch) and captures the exact upstream request body, locking
// the Pi Context → neutral → payload path the worker actually executes.

import { afterEach, beforeEach, expect, mock, test, describe } from "bun:test"

import type {
  AssistantMessage,
  Context,
  Model as PiModel,
} from "@earendil-works/pi-ai"

import { state } from "~/lib/state"
import type { Model } from "~/services/copilot/get-models"
import { assembleResponsesPayload } from "~/services/copilot/responses-request"
import {
  createCopilotStreamFn,
  type ResolvedModel,
} from "~/lib/worker-agent/stream-fn"

const MODEL = "gpt-5.4-mini"

// ---------------------------------------------------------------------------
// Part 1 — shared builder golden (assembleResponsesPayload)
// ---------------------------------------------------------------------------

describe("assembleResponsesPayload golden (shared /responses builder)", () => {
  test("no tools: model + input + stream, nothing else", () => {
    const payload = assembleResponsesPayload({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    })
    expect(payload).toEqual({
      model: MODEL,
      input: [{ role: "user", content: "hi" }],
      stream: false,
    })
    expect("tools" in payload).toBe(false)
    expect("tool_choice" in payload).toBe(false)
    expect("reasoning" in payload).toBe(false)
  })

  test("tools without tool_choice → tool_choice defaults to 'auto'", () => {
    const payload = assembleResponsesPayload({
      model: MODEL,
      messages: [],
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      stream: true,
    })
    expect(payload).toEqual({
      model: MODEL,
      input: [],
      stream: true,
      tools: [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      tool_choice: "auto",
    })
  })

  test("empty system prompt is omitted (no instructions field)", () => {
    const payload = assembleResponsesPayload({
      model: MODEL,
      instructions: "",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    })
    expect("instructions" in payload).toBe(false)
    expect(payload).toEqual({
      model: MODEL,
      input: [{ role: "user", content: "hi" }],
      stream: false,
    })
  })

  test("non-empty instructions are carried", () => {
    const payload = assembleResponsesPayload({
      model: MODEL,
      instructions: "be terse",
      messages: [],
      stream: false,
    })
    expect(payload.instructions).toBe("be terse")
  })

  test("thinking off → no reasoning field", () => {
    const payload = assembleResponsesPayload({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "off",
      stream: true,
    })
    expect("reasoning" in payload).toBe(false)
  })

  test("thinking low/high → reasoning.effort set verbatim", () => {
    const low = assembleResponsesPayload({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "low",
      stream: true,
    })
    expect(low.reasoning).toEqual({ effort: "low" })

    const high = assembleResponsesPayload({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "high",
      stream: true,
    })
    expect(high.reasoning).toEqual({ effort: "high" })
  })

  test("user images → input_text + input_image (base64 data URI and url passthrough)", () => {
    const payload = assembleResponsesPayload({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
            { type: "image", url: "https://ex.com/y.png" },
          ],
        },
      ],
      stream: true,
    })
    expect(payload.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
          { type: "input_image", image_url: "https://ex.com/y.png" },
        ],
      },
    ])
  })

  test("assistant tool calls preserve interleaved text/call ordering", () => {
    const payload = assembleResponsesPayload({
      model: MODEL,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "a" },
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "f" } },
            { type: "text", text: "b" },
            { type: "toolCall", id: "c2", name: "glob", arguments: {} },
          ],
        },
      ],
      stream: true,
    })
    expect(payload.input).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "a" }] },
      { type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"f"}' },
      { role: "assistant", content: [{ type: "output_text", text: "b" }] },
      { type: "function_call", call_id: "c2", name: "glob", arguments: "{}" },
    ])
  })

  test("tool results → function_call_output", () => {
    const payload = assembleResponsesPayload({
      model: MODEL,
      messages: [{ role: "toolResult", toolCallId: "c1", output: "result text" }],
      stream: true,
    })
    expect(payload.input).toEqual([
      { type: "function_call_output", call_id: "c1", output: "result text" },
    ])
  })
})

// ---------------------------------------------------------------------------
// Part 2 — worker hot-path golden (Pi Context → /responses request body)
// ---------------------------------------------------------------------------

const NOOP_MODEL = { id: MODEL } as unknown as PiModel<"openai-completions">

function responsesOnlyModel(id: string): Model {
  return {
    id,
    name: id,
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
      // Mirrors the live catalog: gpt-5.4-mini really does advertise vision
      // with a 1-image / 3 MiB ceiling. Keeping the fixture faithful matters —
      // the outbound preflight reads exactly these fields.
      supports: { tool_calls: true, vision: true },
      limits: {
        vision: {
          max_prompt_images: 1,
          max_prompt_image_size: 3145728,
          supported_media_types: ["image/jpeg", "image/png", "image/webp", "image/gif"],
        },
      },
    },
    supported_endpoints: ["/responses"],
  }
}

/** A minimal SSE that completes cleanly so `drain` terminates. The request
 *  body is captured at fetch time, so the SSE content is irrelevant here. */
function completingSse(): Response {
  const body =
    `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`
    + "data: [DONE]\n\n"
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

const originalFetch = globalThis.fetch
const originalModels = state.models

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

beforeEach(() => {
  state.models = { object: "list", data: [responsesOnlyModel(MODEL)] }
  globalThis.fetch = mock(() => completingSse()) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = originalModels
})

async function drainWith(
  resolved: ResolvedModel,
  ctx: Context,
): Promise<Record<string, unknown>> {
  const streamFn = createCopilotStreamFn({ resolved })
  const stream = await streamFn(NOOP_MODEL, ctx, undefined)
  // Drive the stream to completion so the upstream fetch runs and is captured.
  for await (const ev of stream) {
    if (ev.type === "error") break
  }
  const final: AssistantMessage = await stream.result()
  expect(final.role).toBe("assistant")
  const fm = globalThis.fetch as unknown as {
    mock: { calls: Array<[string, RequestInit]> }
  }
  const last = fm.mock?.calls?.at(-1)
  if (!last) throw new Error("fetch not called")
  return JSON.parse((last[1].body as string) ?? "{}") as Record<string, unknown>
}

const HIGH: ResolvedModel = { modelId: MODEL, thinking: "high" }

describe("worker buildResponsesPayload golden (Pi Context → /responses body)", () => {
  test("no tools + thinking high", async () => {
    const body = await drainWith(HIGH, {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    } as unknown as Context)
    expect(body).toEqual({
      model: MODEL,
      input: [{ role: "user", content: "hi" }],
      stream: true,
      reasoning: { effort: "high" },
    })
  })

  test("tools present → flat tools + tool_choice 'auto'", async () => {
    const body = await drainWith(HIGH, {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    } as unknown as Context)
    expect(body).toEqual({
      model: MODEL,
      input: [{ role: "user", content: "hi" }],
      stream: true,
      reasoning: { effort: "high" },
      tools: [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      tool_choice: "auto",
    })
  })

  test("thinking off → no reasoning field", async () => {
    const body = await drainWith(
      { modelId: MODEL, thinking: "off" },
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as unknown as Context,
    )
    expect(body).toEqual({
      model: MODEL,
      input: [{ role: "user", content: "hi" }],
      stream: true,
    })
  })

  test("empty system prompt omits instructions; a set one is carried", async () => {
    const empty = await drainWith(HIGH, {
      systemPrompt: "",
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    } as unknown as Context)
    expect("instructions" in empty).toBe(false)

    const set = await drainWith(HIGH, {
      systemPrompt: "be terse",
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    } as unknown as Context)
    expect(set.instructions).toBe("be terse")
  })

  test("user image → input_text + input_image data URI", async () => {
    const body = await drainWith(HIGH, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
          ],
          timestamp: 0,
        },
      ],
    } as unknown as Context)
    expect(body.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
        ],
      },
    ])
  })

  test("assistant tool call + tool result round-trip", async () => {
    const body = await drainWith(HIGH, {
      messages: [
        { role: "user", content: "go", timestamp: 0 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "toolCall", id: "call_9", name: "navigate", arguments: { tabId: 1 } },
          ],
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "call_9",
          content: [{ type: "text", text: "navigated" }],
          timestamp: 0,
        },
      ],
    } as unknown as Context)
    expect(body).toEqual({
      model: MODEL,
      stream: true,
      reasoning: { effort: "high" },
      input: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "output_text", text: "calling" }] },
        { type: "function_call", call_id: "call_9", name: "navigate", arguments: '{"tabId":1}' },
        { type: "function_call_output", call_id: "call_9", output: "navigated" },
      ],
    })
  })
})
