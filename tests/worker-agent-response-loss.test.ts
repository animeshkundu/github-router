// Worker-stream response-direction loss.
//
// Three defects that all presented the same way — as a SUCCESSFUL result —
// which is why none of them was ever noticed:
//
//   1. A truncated `/chat/completions` stream (no `[DONE]`) fell out of the
//      read loop and was synthesized as `{type:"done", reason:"stop"}`.
//   2. Same for `/responses` (no `response.completed` / `.incomplete` /
//      `.failed`).
//   3. `finish_reason: "content_filter"` folded into "stop" via
//      `mapFinishReason`'s catch-all, so an upstream safety block looked
//      exactly like a model that finished with nothing to say.
//
// `fetch-event-stream`'s `events()` returns cleanly on a premature EOF rather
// than throwing, so a cut connection is indistinguishable from a finished one
// unless the terminal marker is tracked explicitly. The Anthropic egress has
// guarded this since it shipped; the worker path never did.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { Context, Model as PiModel } from "@earendil-works/pi-ai"

import { state } from "~/lib/state"
import type { Model } from "~/services/copilot/get-models"
import { createCopilotStreamFn, type ResolvedModel } from "~/lib/worker-agent/stream-fn"

const CHAT_MODEL = "gemini-3.6-flash"
const RESPONSES_MODEL = "gpt-5.4-mini"

function model(id: string, endpoint: string): Model {
  return {
    id,
    name: id,
    object: "model",
    vendor: "test",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: "test",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      supports: { tool_calls: true },
    },
    supported_endpoints: [endpoint],
  } as unknown as Model
}

function sse(lines: Array<string>): Response {
  return new Response(lines.map((l) => `${l}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

const NOOP_MODEL = { id: CHAT_MODEL } as unknown as PiModel<"openai-completions">
const originalFetch = globalThis.fetch
const originalModels = state.models

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.models = {
    object: "list",
    data: [model(CHAT_MODEL, "/chat/completions"), model(RESPONSES_MODEL, "/responses")],
  } as never
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = originalModels
})

/** Drive the worker stream to completion and return every emitted event type. */
async function drain(
  resolved: ResolvedModel,
  response: Response,
): Promise<Array<{ type: string; error?: { errorMessage?: string; stopReason?: string } }>> {
  globalThis.fetch = mock(() => response) as unknown as typeof fetch
  const streamFn = createCopilotStreamFn({ resolved })
  const stream = await streamFn(
    NOOP_MODEL,
    { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as unknown as Context,
    undefined,
  )
  const out: Array<{ type: string; error?: { errorMessage?: string; stopReason?: string } }> = []
  for await (const ev of stream) {
    out.push(ev as never)
  }
  return out
}

describe("truncated stream must not be reported as success", () => {
  test("chat: text then EOF with no [DONE] terminates as an error", async () => {
    const events = await drain(
      { modelId: CHAT_MODEL, thinking: "high" },
      sse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "half an ans" } }] })}`,
        // no [DONE] — the connection was cut mid-response
      ]),
    )
    const terminal = events.at(-1)
    expect(terminal?.type).toBe("error")
    expect(terminal?.error?.errorMessage).toMatch(/truncated/i)
    expect(events.some((e) => e.type === "done")).toBe(false)
  })

  test("chat: a clean [DONE] still ends as done", async () => {
    const events = await drain(
      { modelId: CHAT_MODEL, thinking: "high" },
      sse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "all of it" } }] })}`,
        "data: [DONE]",
      ]),
    )
    expect(events.at(-1)?.type).toBe("done")
  })

  test("responses: output then EOF with no terminal event is an error", async () => {
    const events = await drain(
      { modelId: RESPONSES_MODEL, thinking: "high" },
      sse([
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial", output_index: 0 })}`,
        // no response.completed / .incomplete / .failed
      ]),
    )
    const terminal = events.at(-1)
    expect(terminal?.type).toBe("error")
    expect(terminal?.error?.errorMessage).toMatch(/truncated/i)
    expect(events.some((e) => e.type === "done")).toBe(false)
  })

  test("responses: response.completed still ends as done", async () => {
    const events = await drain(
      { modelId: RESPONSES_MODEL, thinking: "high" },
      sse([
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "all", output_index: 0 })}`,
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}`,
      ]),
    )
    expect(events.at(-1)?.type).toBe("done")
  })

  test("partial text is preserved on the truncated result, not discarded", async () => {
    // Failing loudly must not also throw away what did arrive — the caller can
    // still salvage it; it just must not be labelled complete.
    const events = await drain(
      { modelId: CHAT_MODEL, thinking: "high" },
      sse([`data: ${JSON.stringify({ choices: [{ delta: { content: "kept" } }] })}`]),
    )
    expect(events.some((e) => e.type === "text_end")).toBe(true)
    expect(events.at(-1)?.type).toBe("error")
  })
})

describe("content filter is distinguishable from a normal stop", () => {
  test("finish_reason content_filter terminates as an error, not a silent empty stop", async () => {
    const events = await drain(
      { modelId: CHAT_MODEL, thinking: "high" },
      sse([
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "content_filter" }] })}`,
        "data: [DONE]",
      ]),
    )
    const terminal = events.at(-1)
    expect(terminal?.type).toBe("error")
    expect(terminal?.error?.errorMessage).toMatch(/content filter/i)
  })

  test("an ordinary stop is untouched", async () => {
    const events = await drain(
      { modelId: CHAT_MODEL, thinking: "high" },
      sse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "fine" }, finish_reason: "stop" }] })}`,
        "data: [DONE]",
      ]),
    )
    expect(events.at(-1)?.type).toBe("done")
  })
})

describe("a definitive finish reason is not masked by the truncation guard", () => {
  test("content_filter without a [DONE] sentinel reports the filter, not truncation", async () => {
    // Upstreams are known to drop the connection without `[DONE]` when they
    // terminate a stream for content_filter. Keying truncation off the sentinel
    // alone swallowed the specific cause and reported a generic truncation.
    const events = await drain(
      { modelId: CHAT_MODEL, thinking: "high" },
      sse([
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "content_filter" }] })}`,
        // connection cut here — no [DONE]
      ]),
    )
    const terminal = events.at(-1)
    expect(terminal?.type).toBe("error")
    expect(terminal?.error?.errorMessage).toMatch(/content filter/i)
    expect(terminal?.error?.errorMessage).not.toMatch(/truncated/i)
  })

  test("a normal finish_reason without [DONE] still completes rather than erroring", async () => {
    // `finish_reason` is the chat protocol's logical terminal; `[DONE]` is a
    // sentinel after it. Having seen the former, the message IS complete.
    const events = await drain(
      { modelId: CHAT_MODEL, thinking: "high" },
      sse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })}`,
      ]),
    )
    expect(events.at(-1)?.type).toBe("done")
  })

  test("no finish reason and no [DONE] is still a truncation", async () => {
    const events = await drain(
      { modelId: CHAT_MODEL, thinking: "high" },
      sse([`data: ${JSON.stringify({ choices: [{ delta: { content: "half" } }] })}`]),
    )
    expect(events.at(-1)?.error?.errorMessage).toMatch(/truncated/i)
  })
})
