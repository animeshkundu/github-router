import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { clearLaunchRegistry, registerLaunch } from "~/lib/launch-registry"
import { LAUNCH_SECRET_HEADER } from "~/lib/messages-identity-preflight"
import { state } from "~/lib/state"
import { server } from "~/server"
import {
  ADVISOR_ESCALATION_MODEL,
  ADVISOR_FAST_PROFILE_MODEL,
  ADVISOR_INTERNAL_TOOL_NAME,
} from "~/services/advisor/advisor"

const originalFetch = globalThis.fetch
const savedModels = state.models
const savedCopilotToken = state.copilotToken
const savedVsCodeVersion = state.vsCodeVersion
const savedAdvisorModel = process.env.GH_ROUTER_ADVISOR_MODEL
const FAST_SECRET = "f".repeat(64)

const LEADS = [
  { id: "gpt-5.6-luna", transport: "responses" as const },
  { id: "gpt-5.6-sol", transport: "responses" as const },
  { id: "grok-4.6", transport: "responses" as const },
  { id: "gemini-3.8-flash", transport: "chat" as const },
  { id: "claude-opus-5", transport: "messages" as const },
]

function catalogModel(id: string) {
  const isClaude = id.startsWith("claude")
  const isGemini = id.startsWith("gemini")
  return {
    id,
    name: id,
    object: "model",
    vendor: isClaude ? "anthropic" : isGemini ? "google" : "openai",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    supported_endpoints: isClaude
      ? ["/v1/messages"]
      : isGemini
        ? ["/chat/completions"]
        : ["/responses"],
    capabilities: {
      family: id,
      object: "model",
      tokenizer: "o200k_base",
      type: "chat",
      limits: {
        max_context_window_tokens: 1_050_000,
        max_prompt_tokens: 900_000,
        max_output_tokens: 16_000,
      },
      supports: {
        tool_calls: true,
        adaptive_thinking: isClaude,
        reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
      },
    },
  }
}

function anthropicSse(
  events: Array<{ event: string; data: Record<string, unknown> }>,
): Response {
  const body = events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("")
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function responsesSse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
    + "data: [DONE]\n\n"
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function leadResponsesSse(): Response {
  return responsesSse([
    { type: "response.created", response: { status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_advisor",
        call_id: "call_advisor",
        name: ADVISOR_INTERNAL_TOOL_NAME,
      },
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: "fc_advisor",
      arguments: "{}",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_advisor",
        call_id: "call_advisor",
        name: ADVISOR_INTERNAL_TOOL_NAME,
        arguments: "{}",
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ])
}

function continuationResponsesSse(): Response {
  return responsesSse([
    { type: "response.created", response: { status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "message_continuation" },
    },
    { type: "response.output_text.delta", output_index: 0, delta: "continued" },
    { type: "response.output_text.done", output_index: 0, text: "continued" },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ])
}

function leadChatSse(): Response {
  return responsesSse([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_advisor",
                function: { name: ADVISOR_INTERNAL_TOOL_NAME, arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  ])
}

function continuationChatSse(): Response {
  return responsesSse([
    { choices: [{ delta: { content: "continued" }, finish_reason: "stop" }] },
  ])
}

function leadMessagesSse(): Response {
  return anthropicSse([
    {
      event: "message_start",
      data: { type: "message_start", message: { id: "message_initial" } },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_advisor",
          name: ADVISOR_INTERNAL_TOOL_NAME,
          input: {},
        },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ])
}

function continuationMessagesSse(): Response {
  return anthropicSse([
    {
      event: "message_start",
      data: { type: "message_start", message: { id: "message_continuation" } },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "continued" },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ])
}

function advisorChatResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "advisor_chat",
      object: "chat.completion",
      created: 0,
      model: ADVISOR_FAST_PROFILE_MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Advisor advice." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function requestBody(model: string): string {
  return JSON.stringify({
    model,
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "Inspect the repository." }],
    tools: [
      {
        type: "advisor_20260301",
        name: "advisor",
        model: `${ADVISOR_FAST_PROFILE_MODEL}[1m]`,
        input_schema: { type: "object", properties: {} },
      },
    ],
  })
}

beforeEach(() => {
  delete process.env.GH_ROUTER_ADVISOR_MODEL
  clearLaunchRegistry()
  registerLaunch({ profileId: "fast", nonce: "n".repeat(64), secret: FAST_SECRET })
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.models = {
    object: "list",
    data: LEADS.map(({ id }) => catalogModel(id)),
  } as never
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = savedModels
  state.copilotToken = savedCopilotToken
  state.vsCodeVersion = savedVsCodeVersion
  if (savedAdvisorModel === undefined) delete process.env.GH_ROUTER_ADVISOR_MODEL
  else process.env.GH_ROUTER_ADVISOR_MODEL = savedAdvisorModel
  clearLaunchRegistry()
})

describe("authenticated fast Advisor route matrix", () => {
  test("all fixed fast leads preserve their endpoint, model, and Gemini Advisor", async () => {
    for (const lead of LEADS) {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = []
      let leadCalls = 0

      globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = String(url)
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        calls.push({ url: requestUrl, body })

        if (requestUrl.includes("/responses")) {
          leadCalls++
          return Promise.resolve(leadCalls === 1 ? leadResponsesSse() : continuationResponsesSse())
        }
        if (requestUrl.includes("/chat/completions")) {
          if (body.stream === false) return Promise.resolve(advisorChatResponse())
          leadCalls++
          return Promise.resolve(leadCalls === 1 ? leadChatSse() : continuationChatSse())
        }
        if (requestUrl.includes("/v1/messages") || requestUrl.endsWith("/messages")) {
          leadCalls++
          return Promise.resolve(leadCalls === 1 ? leadMessagesSse() : continuationMessagesSse())
        }
        return Promise.resolve(new Response("unexpected endpoint", { status: 500 }))
      }) as unknown as typeof fetch

      const response = await server.request("/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-beta": "advisor-tool-2026-03-01",
          [LAUNCH_SECRET_HEADER]: FAST_SECRET,
        },
        body: requestBody(lead.id),
      })

      expect(response.status).toBe(200)
      expect(await response.text()).toContain("advisor_tool_result")

      const leadCall = calls[0]
      expect(leadCall).toBeDefined()
      expect(leadCall!.body.model).toBe(lead.id)
      expect(leadCall!.body.stream).toBe(true)
      expect(leadCall!.url).toContain(
        lead.transport === "responses"
          ? "/responses"
          : lead.transport === "chat"
            ? "/chat/completions"
            : "/v1/messages",
      )

      const advisorCall = calls.find(
        (call) => call.body.model === ADVISOR_FAST_PROFILE_MODEL && call.body.stream === false,
      )
      expect(advisorCall).toBeDefined()
      expect(advisorCall!.url).toContain("/chat/completions")
      expect((advisorCall!.body as { reasoning_effort?: string }).reasoning_effort).toBe("high")
      const advisorMessages = advisorCall!.body.messages as Array<{ role?: string; content?: string }>
      expect(advisorMessages.find((message) => message.role === "system")?.content)
        .toContain("non-binding consultant")

      const continuationCall = calls.find(
        (call) => call !== leadCall && call.body.model === lead.id && call.body.stream === true,
      )
      expect(continuationCall).toBeDefined()
      expect(continuationCall!.url).toContain(
        lead.transport === "responses"
          ? "/responses"
          : lead.transport === "chat"
            ? "/chat/completions"
            : "/v1/messages",
      )
    }
  })

  test("explicit Opus environment pin cannot override fixed Gemini", async () => {
    process.env.GH_ROUTER_ADVISOR_MODEL = ADVISOR_ESCALATION_MODEL
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    let leadCalls = 0

    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url)
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      calls.push({ url: requestUrl, body })
      if (requestUrl.includes("/responses")) {
        leadCalls++
        return Promise.resolve(
          leadCalls === 1 ? leadResponsesSse() : continuationResponsesSse(),
        )
      }
      if (requestUrl.includes("/chat/completions")) {
        return Promise.resolve(advisorChatResponse())
      }
      return Promise.resolve(new Response("unexpected endpoint", { status: 500 }))
    }) as unknown as typeof fetch

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "advisor-tool-2026-03-01",
        [LAUNCH_SECRET_HEADER]: FAST_SECRET,
      },
      body: requestBody("gpt-5.6-sol"),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("advisor_tool_result")
    const advisorCall = calls.find(
      (call) => call.body.model === ADVISOR_FAST_PROFILE_MODEL && call.body.stream === false,
    )
    expect(advisorCall).toBeDefined()
    expect(advisorCall!.url).toContain("/chat/completions")
    expect(calls.some((call) => call.body.model === ADVISOR_ESCALATION_MODEL))
      .toBe(false)
    const advisorMessages = advisorCall!.body.messages as Array<{
      role?: string
      content?: string
    }>
    const system = advisorMessages.find((message) => message.role === "system")?.content
    expect(system).toContain("non-binding consultant")
    expect(system).toContain("Do not approve, veto, dictate")
    expect(system).not.toContain(
      "Give a directive recommendation and commit to the decision",
    )
  })
})
