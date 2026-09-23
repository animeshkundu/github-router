/**
 * End-to-end wiring tests for the AIC ledger: upstream `copilot_usage`
 * reaches the client untouched AND is recorded exactly once per request.
 *
 * Unit tests (`aic-usage`, `aic-ledger`, `aic-sse-tap`) cover parsing and
 * accumulation in isolation; these drive the real route handlers, shim
 * egress functions, and advisor stream with mocked upstream fetch/SSE and
 * assert the two load-bearing properties together:
 *
 *   1. passthrough integrity — response bytes still carry `copilot_usage`;
 *   2. exactly-once recording — repeated terminal frames (retries, duplicate
 *      events) never double-count.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  __resetAicLedgerForTests,
  aicSnapshot,
} from "~/lib/aic-ledger"
import {
  chatResponseToAnthropicMessage,
  synthAnthropicFromChat,
} from "~/lib/anthropic-translate/chat-egress"
import {
  responsesResponseToAnthropicMessage,
  synthAnthropicFromResponses,
} from "~/lib/anthropic-translate/responses-egress"
import { state } from "~/lib/state"
import { server } from "~/server"
import { buildAdvisorStream } from "~/services/advisor/advisor"
import type { ResponsesApiResponse } from "~/services/copilot/create-responses"

const originalFetch = globalThis.fetch
let savedModels: typeof state.models
let savedEnv: string | undefined
let routesDir = ""

const COPILOT_USAGE = {
  token_details: [
    { batch_size: 1000000, cost_per_batch: 20000000000, model: "gpt-6-luna", token_count: 11, token_type: "input" },
    { batch_size: 1000000, cost_per_batch: 120000000000, model: "gpt-6-luna", token_count: 5, token_type: "output" },
  ],
  total_nano_aiu: 820000,
}

function catalogEntry(id: string, family: string) {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "test",
    version: "1",
    model_picker_enabled: true,
    capabilities: {
      family,
      limits: { max_output_tokens: 8192 },
      object: "model",
      supports: {},
      tokenizer: "o200k",
      type: "chat",
    },
  }
}

function requestUrl(input: unknown): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return String(input)
  if (input && typeof input === "object" && "url" in input) {
    return String((input as { url: unknown }).url)
  }
  return String(input)
}

function assertExpectedFetchUrl(url: string, allowed: ReadonlyArray<string>): void {
  if (!allowed.some((part) => url.includes(part))) {
    throw new Error(`unexpected fetch URL: ${url}`)
  }
}

function installFetchMock(
  handler: () => Response,
  allowed: ReadonlyArray<string> = ["/v1/messages", "/chat/completions", "/responses"],
): void {
  globalThis.fetch = Object.assign(
    mock((input: unknown): Promise<Response> => {
      assertExpectedFetchUrl(requestUrl(input), allowed)
      return Promise.resolve(handler())
    }),
    { preconnect: () => {} },
  )
}

function sseResponse(frames: Array<string>): Response {
  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

async function readAllText(res: Response | ReadableStream<Uint8Array>): Promise<string> {
  const body = res instanceof Response ? res.body! : res
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

beforeEach(async () => {
  __resetAicLedgerForTests()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-router-aic-routes-"))
  routesDir = dir
  savedEnv = process.env.GH_ROUTER_AIC_LEDGER
  process.env.GH_ROUTER_AIC_LEDGER = path.join(dir, "ledger.json")
  savedModels = state.models
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "enterprise"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.models = {
    object: "list",
    data: [
      catalogEntry("claude-haiku-4.5", "claude"),
      catalogEntry("gpt-6-luna", "gpt-5"),
      catalogEntry("gemini-3.5-flash", "gemini"),
    ] as unknown as NonNullable<typeof state.models>["data"],
  }
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  state.models = savedModels
  if (savedEnv === undefined) delete process.env.GH_ROUTER_AIC_LEDGER
  else process.env.GH_ROUTER_AIC_LEDGER = savedEnv
  __resetAicLedgerForTests()
  if (routesDir) await fs.rm(routesDir, { recursive: true, force: true })
})

describe("/v1/messages native", () => {
  test("non-stream: forwards copilot_usage untouched + records once", async () => {
    installFetchMock(
      () =>
        new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4.5",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 4 },
            copilot_usage: COPILOT_USAGE,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    )
    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4.5",
        max_tokens: 5,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.copilot_usage).toEqual(COPILOT_USAGE)
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.totalNanoAiu).toBe(820000)
    expect(snap.perModel["claude-haiku-4.5"]?.nanoAiu).toBe(820000)
  })

  test("stream: terminal message_delta forwarded verbatim + recorded once", async () => {
    const terminal = `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":12,"output_tokens":4},"copilot_usage":${JSON.stringify(COPILOT_USAGE)}}\n\n`
    installFetchMock(() =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
        terminal,
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    )
    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        model: "claude-haiku-4.5",
        max_tokens: 5,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    const text = await readAllText(res)
    expect(text).toContain(JSON.stringify(COPILOT_USAGE))
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.totalNanoAiu).toBe(820000)
  })

  test("independent main and subagent requests record separately (no aggregation)", async () => {
    const mainUsage = {
      token_details: [
        { batch_size: 1000000, cost_per_batch: 20000000000, model: "claude-haiku-4.5", token_count: 5, token_type: "input" },
      ],
      total_nano_aiu: 100000,
    }
    const subagentUsage = {
      token_details: [
        { batch_size: 1000000, cost_per_batch: 20000000000, model: "claude-sonnet-4.6", token_count: 13, token_type: "input" },
      ],
      total_nano_aiu: 260000,
    }
    state.models = {
      object: "list",
      data: [
        catalogEntry("claude-haiku-4.5", "claude"),
        catalogEntry("claude-sonnet-4.6", "claude"),
      ] as unknown as NonNullable<typeof state.models>["data"],
    }
    globalThis.fetch = Object.assign(
      mock((input: unknown, init?: RequestInit): Promise<Response> => {
        const url = requestUrl(input)
        assertExpectedFetchUrl(url, ["/v1/messages"])
        const body = typeof init?.body === "string" ? init.body : ""
        if (body.includes('"model":"claude-sonnet-4.6"')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "msg_sub",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4.6",
                content: [{ type: "text", text: "sub" }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 13, output_tokens: 2 },
                copilot_usage: subagentUsage,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          )
        }
        if (body.includes('"model":"claude-haiku-4.5"')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "msg_main",
                type: "message",
                role: "assistant",
                model: "claude-haiku-4.5",
                content: [{ type: "text", text: "main" }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 5, output_tokens: 1 },
                copilot_usage: mainUsage,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          )
        }
        throw new Error(`unexpected /v1/messages body: ${body.slice(0, 200)}`)
      }),
      { preconnect: () => {} },
    )

    const mainRes = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4.5",
        max_tokens: 5,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(mainRes.status).toBe(200)
    expect(((await mainRes.json()) as { copilot_usage: unknown }).copilot_usage).toEqual(mainUsage)

    const subRes = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-agent-id": "implementer",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        max_tokens: 5,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(subRes.status).toBe(200)
    expect(((await subRes.json()) as { copilot_usage: unknown }).copilot_usage).toEqual(subagentUsage)

    const snap = aicSnapshot()
    expect(snap.requests).toBe(2)
    expect(snap.totalNanoAiu).toBe(360000)
    expect(snap.perModel["claude-haiku-4.5"]?.requests).toBe(1)
    expect(snap.perModel["claude-haiku-4.5"]?.nanoAiu).toBe(100000)
    expect(snap.perModel["claude-sonnet-4.6"]?.requests).toBe(1)
    expect(snap.perModel["claude-sonnet-4.6"]?.nanoAiu).toBe(260000)
  })
})

describe("/v1/chat/completions", () => {
  test("non-stream: forwards copilot_usage untouched + records once", async () => {
    installFetchMock(
      () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1,
            model: "gemini-3.5-flash",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, logprobs: null, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            copilot_usage: COPILOT_USAGE,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    )
    const res = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.5-flash",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.copilot_usage).toEqual(COPILOT_USAGE)
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.perModel["gemini-3.5-flash"]?.nanoAiu).toBe(820000)
  })

  test("stream: repeated terminal copilot_usage frames record once", async () => {
    const terminalChunk = JSON.stringify({
      id: "chatcmpl-1",
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      copilot_usage: COPILOT_USAGE,
    })
    installFetchMock(() =>
      sseResponse([
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
        `data: ${terminalChunk}\n\n`,
        // A repeated terminal frame must not double-count.
        `data: ${terminalChunk}\n\n`,
      ]),
    )
    const res = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.5-flash",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    expect(res.status).toBe(200)
    const text = await readAllText(res)
    expect(text).toContain("copilot_usage")
    expect(aicSnapshot().requests).toBe(1)
    expect(aicSnapshot().totalNanoAiu).toBe(820000)
  })

  test("stream: interim zero-nano frame does not latch ahead of the terminal reading", async () => {
    // Live shape on gemini chat streams: an interim chunk with
    // total_nano_aiu: 0 precedes the terminal priced chunk. The tap must
    // skip the zero frame and record the terminal value exactly once.
    const interimZero = JSON.stringify({
      id: "chatcmpl-1",
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      copilot_usage: { total_nano_aiu: 0, token_details: [] },
    })
    const terminalChunk = JSON.stringify({
      id: "chatcmpl-1",
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      copilot_usage: COPILOT_USAGE,
    })
    installFetchMock(() =>
      sseResponse([
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
        `data: ${interimZero}\n\n`,
        `data: ${terminalChunk}\n\n`,
      ]),
    )
    const res = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.5-flash",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    expect(res.status).toBe(200)
    const text = await readAllText(res)
    // Bytes relay verbatim — both frames reach the client.
    expect(text).toContain('"total_nano_aiu":0')
    expect(text).toContain(JSON.stringify(COPILOT_USAGE))
    // But the ledger holds exactly the terminal reading, once.
    expect(aicSnapshot().requests).toBe(1)
    expect(aicSnapshot().totalNanoAiu).toBe(820000)
    expect(aicSnapshot().perModel["gemini-3.5-flash"]?.nanoAiu).toBe(820000)
  })
})

describe("/v1/responses", () => {
  test("non-stream: forwards copilot_usage untouched + records once", async () => {
    installFetchMock(
      () =>
        new Response(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            status: "completed",
            output: [],
            usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
            copilot_usage: COPILOT_USAGE,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    )
    const res = await server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-6-luna",
        input: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.copilot_usage).toEqual(COPILOT_USAGE)
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.perModel["gpt-6-luna"]?.nanoAiu).toBe(820000)
  })

  test("stream: terminal response.completed recorded once", async () => {
    const completed = JSON.stringify({
      type: "response.completed",
      sequence_number: 8,
      copilot_usage: COPILOT_USAGE,
      response: { id: "resp_1", status: "completed", usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 } },
    })
    installFetchMock(() =>
      sseResponse([
        'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","status":"in_progress"}}\n\n',
        `data: ${completed}\n\n`,
      ]),
    )
    const res = await server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-6-luna",
        input: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    expect(res.status).toBe(200)
    const text = await readAllText(res)
    expect(text).toContain("copilot_usage")
    expect(aicSnapshot().requests).toBe(1)
  })
})

describe("translation shim egress", () => {
  test("responses non-stream maps message + records under shim model", () => {
    const msg = responsesResponseToAnthropicMessage(
      {
        id: "resp_1",
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
        copilot_usage: COPILOT_USAGE,
      } as unknown as ResponsesApiResponse,
      "gpt-6-luna",
    )
    expect(msg.usage.output_tokens).toBe(5)
    // Client-visible usage stays the 4-key Anthropic shape (no copilot_usage leak).
    expect("copilot_usage" in msg).toBe(false)
    expect(aicSnapshot().requests).toBe(1)
    expect(aicSnapshot().perModel["gpt-6-luna"]?.nanoAiu).toBe(820000)
  })

  test("responses stream synth records duplicate terminal events once", async () => {
    async function* upstream(): AsyncIterable<{ data?: string }> {
      const completed = JSON.stringify({
        type: "response.completed",
        sequence_number: 8,
        copilot_usage: COPILOT_USAGE,
        response: { status: "completed", usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 } },
      })
      yield { data: completed }
      yield { data: completed }
    }
    const events = []
    for await (const e of synthAnthropicFromResponses(upstream(), { modelId: "gpt-6-luna" })) {
      events.push(e)
    }
    expect(events.some((e) => e.type === "message_stop")).toBe(true)
    expect(aicSnapshot().requests).toBe(1)
  })

  test("chat non-stream maps message + records under shim model", () => {
    const msg = chatResponseToAnthropicMessage(
      {
        id: "chatcmpl-1",
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
        copilot_usage: COPILOT_USAGE,
      } as unknown as Parameters<typeof chatResponseToAnthropicMessage>[0],
      "gemini-3.5-flash",
    )
    expect(msg.stop_reason).toBe("end_turn")
    expect(aicSnapshot().requests).toBe(1)
    expect(aicSnapshot().perModel["gemini-3.5-flash"]?.nanoAiu).toBe(820000)
  })

  test("chat stream synth records repeated trailing usage chunks once", async () => {
    async function* upstream(): AsyncIterable<{ data?: string }> {
      yield { data: JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) }
      const trailing = JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
        copilot_usage: COPILOT_USAGE,
      })
      yield { data: trailing }
      yield { data: trailing }
      yield { data: "[DONE]" }
    }
    const events = []
    for await (const e of synthAnthropicFromChat(upstream(), { modelId: "gemini-3.5-flash" })) {
      events.push(e)
    }
    expect(events.some((e) => e.type === "message_stop")).toBe(true)
    expect(aicSnapshot().requests).toBe(1)
  })

  test("chat stream synth skips interim zero-nano chunk, records terminal once", async () => {
    const zeroTrailing = JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      copilot_usage: { total_nano_aiu: 0, token_details: [] },
    })
    const pricedTrailing = JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
      copilot_usage: COPILOT_USAGE,
    })
    async function* upstream(): AsyncIterable<{ data?: string }> {
      yield { data: JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) }
      yield { data: zeroTrailing }
      yield { data: pricedTrailing }
      yield { data: "[DONE]" }
    }
    const events = []
    for await (const e of synthAnthropicFromChat(upstream(), { modelId: "gemini-3.5-flash" })) {
      events.push(e)
    }
    expect(events.some((e) => e.type === "message_stop")).toBe(true)
    expect(aicSnapshot().requests).toBe(1)
    expect(aicSnapshot().totalNanoAiu).toBe(820000)
  })
})

describe("advisor stream", () => {
  test("lead-turn AIC recorded under baseBody.model + re-emitted merged", async () => {
    const terminal = JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 12, output_tokens: 4 },
      copilot_usage: COPILOT_USAGE,
    })
    const firstResponse = new Response(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        `event: message_delta\ndata: ${terminal}\n\n`,
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
    const stream = buildAdvisorStream({
      firstResponse,
      initialConversation: [],
      baseBody: { model: "claude-haiku-4.5", max_tokens: 5, messages: [] },
      requestHeaders: {},
    })
    const text = await readAllText(stream)
    // The suppressed per-turn delta is re-emitted once at the terminal with
    // the accumulated AIC (already recorded — not re-recorded downstream).
    expect(text).toContain('"copilot_usage"')
    expect(text).toContain('"total_nano_aiu":820000')
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.perModel["claude-haiku-4.5"]?.nanoAiu).toBe(820000)
  })
})

describe("/v1/messages shim non-streaming exactly-once", () => {
  test("chat-shim (gemini lead, e.g. cheap profile) records once", async () => {
    state.models = {
      object: "list",
      data: [
        {
          ...catalogEntry("gemini-3.5-flash", "gemini"),
          supported_endpoints: ["/chat/completions"],
        },
      ] as unknown as NonNullable<typeof state.models>["data"],
    }
    installFetchMock(
      () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1,
            model: "gemini-3.5-flash",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, logprobs: null, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            copilot_usage: COPILOT_USAGE,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    )
    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.5-flash",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.totalNanoAiu).toBe(820000)
    expect(snap.perModel["gemini-3.5-flash"]?.nanoAiu).toBe(820000)
  })

  test("responses-shim (gpt lead) records once", async () => {
    state.models = {
      object: "list",
      data: [
        {
          ...catalogEntry("gpt-6-luna", "gpt-5"),
          supported_endpoints: ["/responses"],
        },
      ] as unknown as NonNullable<typeof state.models>["data"],
    }
    installFetchMock(
      () =>
        new Response(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            status: "completed",
            output: [],
            usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
            copilot_usage: COPILOT_USAGE,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    )
    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-6-luna",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.totalNanoAiu).toBe(820000)
    expect(snap.perModel["gpt-6-luna"]?.nanoAiu).toBe(820000)
  })

  test("chat-shim streaming (cheap-profile lead path) skips interim zero, records terminal", async () => {
    state.models = {
      object: "list",
      data: [
        {
          ...catalogEntry("gemini-3.5-flash", "gemini"),
          supported_endpoints: ["/chat/completions"],
        },
      ] as unknown as NonNullable<typeof state.models>["data"],
    }
    const interimZero = JSON.stringify({
      id: "chatcmpl-1",
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      copilot_usage: { total_nano_aiu: 0, token_details: [] },
    })
    const terminalChunk = JSON.stringify({
      id: "chatcmpl-1",
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      copilot_usage: COPILOT_USAGE,
    })
    installFetchMock(() =>
      sseResponse([
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
        `data: ${interimZero}\n\n`,
        `data: ${terminalChunk}\n\n`,
        "data: [DONE]\n\n",
      ]),
    )
    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.5-flash",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    const text = await readAllText(res)
    expect(text).toContain("message_stop")
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.totalNanoAiu).toBe(820000)
    expect(snap.perModel["gemini-3.5-flash"]?.nanoAiu).toBe(820000)
  })
})

describe("/v1/responses/compact", () => {
  test("synthetic-compaction fallback records AIC under the compact model", async () => {
    globalThis.fetch = Object.assign(
      mock(async (url: unknown): Promise<Response> => {
        const href = requestUrl(url)
        if (href.endsWith("/responses/compact") || href.includes("/responses/compact")) {
          return new Response("not found", { status: 404 })
        }
        if (!href.includes("/responses")) {
          throw new Error(`unexpected fetch URL: ${href}`)
        }
        return new Response(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            status: "completed",
            output: [],
            usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
            copilot_usage: COPILOT_USAGE,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }),
      { preconnect: () => {} },
    )
    const res = await server.request("/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-6-luna",
        input: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.totalNanoAiu).toBe(820000)
    expect(snap.perModel["gpt-6-luna"]?.nanoAiu).toBe(820000)
  })
})
