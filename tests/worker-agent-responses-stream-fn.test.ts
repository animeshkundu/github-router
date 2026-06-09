// Unit coverage for the /responses streaming path in `createCopilotStreamFn`.
// Drives the REAL `createResponses` + the REAL stream parser by mocking
// `globalThis.fetch` to replay a recorded /responses SSE event sequence
// (captured against gpt-5.4-mini). Asserts the Pi AssistantMessageEventStream
// protocol (start → text/toolcall → done) and the final assembled message.
// Endpoint routing is exercised for real: `state.models` advertises the test
// model as /responses-only so `endpointForModelId` picks the responses branch.
// NO live model, NO browser.

import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model as PiModel,
} from "@earendil-works/pi-ai"

import { state } from "~/lib/state"
import type { Model } from "~/services/copilot/get-models"
import {
  createCopilotStreamFn,
  type ResolvedModel,
} from "~/lib/worker-agent/stream-fn"

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const RESPONSES_MODEL_ID = "gpt-5.4-mini"

const RESOLVED: ResolvedModel = {
  modelId: RESPONSES_MODEL_ID,
  thinking: "high",
}

const NOOP_MODEL = { id: RESPONSES_MODEL_ID } as unknown as PiModel<"openai-completions">

const USER_CTX: Context = {
  messages: [{ role: "user", content: "drive the browser", timestamp: 0 }],
}

const originalFetch = globalThis.fetch
const originalModels = state.models

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
      supports: { tool_calls: true },
    },
    supported_endpoints: ["/responses"],
  }
}

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

beforeEach(() => {
  // Make endpointForModelId(RESPONSES_MODEL_ID) === "responses".
  state.models = { object: "list", data: [responsesOnlyModel(RESPONSES_MODEL_ID)] }
  globalThis.fetch = mock(() => sseResponse([])) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = originalModels
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Build an SSE Response from /responses event objects (each becomes one
 *  `data:` frame). A trailing `[DONE]` is appended — /responses does not emit
 *  it, but the parser tolerates it and it proves the loop stops cleanly. */
function sseResponse(events: Array<object>): Response {
  const body =
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  })
}

async function drain(
  ctx: Context,
): Promise<{ events: Array<AssistantMessageEvent>; final: AssistantMessage }> {
  const streamFn = createCopilotStreamFn({ resolved: RESOLVED })
  const stream = await streamFn(NOOP_MODEL, ctx, undefined)
  const events: Array<AssistantMessageEvent> = []
  for await (const ev of stream) events.push(ev)
  const final = await stream.result()
  return { events, final }
}

function lastFetchBody(): Record<string, unknown> {
  const fm = globalThis.fetch as unknown as {
    mock: { calls: Array<[string, RequestInit]> }
  }
  const last = fm.mock?.calls?.at(-1)
  if (!last) throw new Error("fetch not called")
  return JSON.parse((last[1].body as string) ?? "{}") as Record<string, unknown>
}

// Recorded /responses event sequences (shape matches the live probe).
const REASONING_PROLOGUE = [
  { type: "response.created", response: { status: "in_progress" } },
  { type: "response.in_progress", response: { status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "r0" } },
  { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "r0" } },
]

// ---------------------------------------------------------------------------
// tool-call path
// ---------------------------------------------------------------------------

test("/responses function_call SSE assembles into a Pi toolCall", async () => {
  globalThis.fetch = mock(() =>
    sseResponse([
      ...REASONING_PROLOGUE,
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "navigate" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"tabId"' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: ':1,"action":"goto"}' },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        arguments: '{"tabId":1,"action":"goto"}',
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "navigate",
          arguments: '{"tabId":1,"action":"goto"}',
        },
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]),
  ) as unknown as typeof fetch

  const { events, final } = await drain(USER_CTX)

  // Final message carries exactly the assembled tool call.
  expect(final.content).toHaveLength(1)
  expect(final.content[0]).toEqual({
    type: "toolCall",
    id: "call_1",
    name: "navigate",
    arguments: { tabId: 1, action: "goto" },
  })
  expect(final.stopReason).toBe("toolUse")
  expect(final.usage.input).toBe(10)
  expect(final.usage.output).toBe(5)
  expect(final.usage.totalTokens).toBe(15)

  // Pi event protocol: start → toolcall_start → toolcall_delta(s) → toolcall_end → done.
  expect(events[0]?.type).toBe("start")
  expect(events.some((e) => e.type === "toolcall_start")).toBe(true)
  expect(events.filter((e) => e.type === "toolcall_delta")).toHaveLength(2)
  const end = events.find((e) => e.type === "toolcall_end")
  expect(end).toBeDefined()
  expect((end as { toolCall: { name: string } }).toolCall.name).toBe("navigate")
  expect(events.at(-1)?.type).toBe("done")
  // No spurious text events.
  expect(events.some((e) => e.type === "text_delta")).toBe(false)
})

// ---------------------------------------------------------------------------
// text path
// ---------------------------------------------------------------------------

test("/responses output_text SSE assembles into a single TextContent", async () => {
  globalThis.fetch = mock(() =>
    sseResponse([
      ...REASONING_PROLOGUE,
      { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "m0" } },
      { type: "response.content_part.added", item_id: "m0" },
      { type: "response.output_text.delta", item_id: "m0", delta: "the" },
      { type: "response.output_text.delta", item_id: "m0", delta: " sky" },
      { type: "response.output_text.done", item_id: "m0", text: "the sky" },
      { type: "response.output_item.done", output_index: 1, item: { type: "message", id: "m0" } },
      { type: "response.completed", response: { status: "completed" } },
    ]),
  ) as unknown as typeof fetch

  const { events, final } = await drain(USER_CTX)

  expect(final.content).toHaveLength(1)
  expect(final.content[0]).toEqual({ type: "text", text: "the sky" })
  expect(final.stopReason).toBe("stop")

  expect(events.some((e) => e.type === "text_start")).toBe(true)
  expect(events.filter((e) => e.type === "text_delta")).toHaveLength(2)
  expect(events.some((e) => e.type === "text_end")).toBe(true)
  expect(events.some((e) => e.type === "toolcall_start")).toBe(false)
  expect(events.at(-1)?.type).toBe("done")
})

// ---------------------------------------------------------------------------
// edge cases
// ---------------------------------------------------------------------------

test("/responses output_text.done with no prior deltas is not dropped", async () => {
  globalThis.fetch = mock(() =>
    sseResponse([
      ...REASONING_PROLOGUE,
      { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "m0" } },
      // No delta events — only the terminal done carrying the full text.
      { type: "response.output_text.done", item_id: "m0", text: "whole answer" },
      { type: "response.output_item.done", output_index: 1, item: { type: "message", id: "m0" } },
      { type: "response.completed", response: { status: "completed" } },
    ]),
  ) as unknown as typeof fetch

  const { final } = await drain(USER_CTX)
  expect(final.content).toHaveLength(1)
  expect(final.content[0]).toEqual({ type: "text", text: "whole answer" })
})

test("corrupted arg-deltas are superseded by the authoritative function_call_arguments.done", async () => {
  // gpt-5.4-mini's loop bug: deltas arrive but are partial/corrupt; the .done
  // event carries the full valid args. The final tool call MUST use the .done
  // args, not the unparseable delta accumulation (which → {} → empty-args
  // no-op → the model repeats the call forever).
  globalThis.fetch = mock(() =>
    sseResponse([
      ...REASONING_PROLOGUE,
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "navigate" },
      },
      // Partial / corrupted delta stream (invalid JSON on its own).
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"tabId":1,"act' },
      // Authoritative full args.
      { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"tabId":1,"action":"goto"}' },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "navigate",
          arguments: '{"tabId":1,"action":"goto"}',
        },
      },
      { type: "response.completed", response: { status: "completed" } },
    ]),
  ) as unknown as typeof fetch

  const { final } = await drain(USER_CTX)
  expect(final.content).toHaveLength(1)
  expect(final.content[0]).toEqual({
    type: "toolCall",
    id: "call_1",
    name: "navigate",
    arguments: { tabId: 1, action: "goto" }, // NOT {}
  })
})

test("a duplicate output_item.added for the same item.id yields ONE tool call", async () => {
  globalThis.fetch = mock(() =>
    sseResponse([
      ...REASONING_PROLOGUE,
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "navigate" },
      },
      // Duplicate added for the SAME item.id — must be ignored.
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "navigate" },
      },
      { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"tabId":1}' },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "navigate", arguments: '{"tabId":1}' },
      },
      { type: "response.completed", response: { status: "completed" } },
    ]),
  ) as unknown as typeof fetch

  const { events, final } = await drain(USER_CTX)
  expect(events.filter((e) => e.type === "toolcall_start")).toHaveLength(1)
  expect(events.filter((e) => e.type === "toolcall_end")).toHaveLength(1)
  expect(final.content).toHaveLength(1)
  expect(final.content[0]).toMatchObject({ type: "toolCall", name: "navigate", arguments: { tabId: 1 } })
})

test("tool item is ended at its output_item.done, before a following text block", async () => {
  globalThis.fetch = mock(() =>
    sseResponse([
      ...REASONING_PROLOGUE,
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_page" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"tabId":1}' },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_page", arguments: '{"tabId":1}' },
      },
      // A trailing message item after the tool call.
      { type: "response.output_item.added", output_index: 2, item: { type: "message", id: "m0" } },
      { type: "response.output_text.delta", item_id: "m0", delta: "done reading" },
      { type: "response.output_text.done", item_id: "m0", text: "done reading" },
      { type: "response.output_item.done", output_index: 2, item: { type: "message", id: "m0" } },
      { type: "response.completed", response: { status: "completed" } },
    ]),
  ) as unknown as typeof fetch

  const { events, final } = await drain(USER_CTX)

  // Final message preserves block order: toolCall THEN text.
  expect(final.content).toHaveLength(2)
  expect(final.content[0]).toMatchObject({ type: "toolCall", name: "read_page" })
  expect(final.content[1]).toEqual({ type: "text", text: "done reading" })

  // toolcall_end fires before the following text block starts (no late/duplicate end).
  const endIdx = events.findIndex((e) => e.type === "toolcall_end")
  const textStartIdx = events.findIndex((e) => e.type === "text_start")
  expect(endIdx).toBeGreaterThanOrEqual(0)
  expect(textStartIdx).toBeGreaterThan(endIdx)
  expect(events.filter((e) => e.type === "toolcall_end")).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// request payload translation (Context → ResponsesPayload)
// ---------------------------------------------------------------------------

test("builds a ResponsesPayload: instructions, flat tools, function_call replay", async () => {
  globalThis.fetch = mock(() =>
    sseResponse([
      ...REASONING_PROLOGUE,
      { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "m0" } },
      { type: "response.output_text.delta", item_id: "m0", delta: "ok" },
      { type: "response.output_text.done", item_id: "m0", text: "ok" },
      { type: "response.completed", response: { status: "completed" } },
    ]),
  ) as unknown as typeof fetch

  // Prior assistant tool call + its result must round-trip into the
  // Responses `function_call` / `function_call_output` input-item shapes.
  const ctx = {
    systemPrompt: "You drive a browser.",
    tools: [
      {
        name: "navigate",
        description: "navigate the tab",
        parameters: { type: "object", properties: { tabId: { type: "number" } } },
      },
    ],
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
  } as unknown as Context

  await drain(ctx)
  const body = lastFetchBody()

  expect(body.instructions).toBe("You drive a browser.")
  expect(body.stream).toBe(true)
  expect(body.tool_choice).toBe("auto")
  expect(body.reasoning).toEqual({ effort: "high" })
  expect(body).not.toHaveProperty("messages")

  // Tools are FLAT (name/description/parameters at top level).
  const tools = body.tools as Array<Record<string, unknown>>
  expect(tools).toHaveLength(1)
  expect(tools[0]).toMatchObject({ type: "function", name: "navigate", description: "navigate the tab" })

  // Input items: user message, assistant text, function_call, function_call_output.
  const input = body.input as Array<Record<string, unknown>>
  expect(input).toContainEqual({ role: "user", content: "go" })
  expect(input).toContainEqual({
    role: "assistant",
    content: [{ type: "output_text", text: "calling" }],
  })
  expect(input).toContainEqual({
    type: "function_call",
    call_id: "call_9",
    name: "navigate",
    arguments: '{"tabId":1}',
  })
  expect(input).toContainEqual({
    type: "function_call_output",
    call_id: "call_9",
    output: "navigated",
  })
})

// ---------------------------------------------------------------------------
// error path
// ---------------------------------------------------------------------------

test("/responses upstream HTTP error becomes a terminal Pi error event", async () => {
  globalThis.fetch = mock(
    () => new Response("nope", { status: 500, statusText: "Server Error" }),
  ) as unknown as typeof fetch

  const { events, final } = await drain(USER_CTX)

  expect(events.at(-1)?.type).toBe("error")
  expect(final.stopReason).toBe("error")
  expect(typeof final.errorMessage).toBe("string")
})
