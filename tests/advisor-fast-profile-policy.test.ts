import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  LUNA_IMPLEMENTER_ALIAS_ID,
  LUNA_SCOUT_ALIAS_ID,
} from "~/lib/launch-profile"
import {
  clearLaunchRegistry,
  registerLaunch,
} from "~/lib/launch-registry"
import { LAUNCH_SECRET_HEADER } from "~/lib/messages-identity-preflight"
import { state } from "~/lib/state"
import { server } from "~/server"
import {
  ADVISOR_FAST_PROFILE_MODEL,
  ADVISOR_INTERNAL_TOOL_NAME,
  ADVISOR_TOOL_INSTRUCTIONS,
  FAST_ADVISOR_TOOL_INSTRUCTIONS,
  injectAdvisorTool,
} from "~/services/advisor/advisor"

const originalFetch = globalThis.fetch
const savedModels = state.models
const savedCopilotToken = state.copilotToken
const savedVsCodeVersion = state.vsCodeVersion
const FAST_SECRET = "f".repeat(64)

function catalogModel(id: string) {
  const isClaude = id.startsWith("claude")
  return {
    id,
    name: id,
    object: "model",
    vendor: isClaude ? "anthropic" : id.startsWith("gemini") ? "google" : "openai",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    supported_endpoints: isClaude
      ? ["/v1/messages"]
      : id.startsWith("gemini")
        ? ["/chat/completions"]
        : ["/responses"],
    capabilities: {
      family: id,
      object: "model",
      tokenizer: "o200k_base",
      type: "chat",
      limits: { max_context_window_tokens: 1_050_000 },
      supports: {
        tool_calls: true,
        reasoning_effort: ["medium", "high", "xhigh", "max"],
      },
    },
  }
}

function responsesObjectResponse() {
  return new Response(
    JSON.stringify({
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { headers: { "content-type": "application/json" } },
  )
}

function requestBody(model: string, stream = false) {
  return JSON.stringify({
    model,
    max_tokens: 100,
    stream,
    messages: [{ role: "user", content: "Inspect the repository." }],
    tools: [
      {
        type: "advisor_20260301",
        name: "advisor",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: ADVISOR_INTERNAL_TOOL_NAME,
        description: ADVISOR_TOOL_INSTRUCTIONS,
        input_schema: { type: "object", properties: {} },
      },
    ],
  })
}

beforeEach(() => {
  clearLaunchRegistry()
  registerLaunch({
    profileId: "fast",
    nonce: "n".repeat(64),
    secret: FAST_SECRET,
  })
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.models = {
    object: "list",
    data: [
      catalogModel("gpt-5.6-luna"),
      catalogModel("gpt-5.6-sol"),
      catalogModel("grok-4.6"),
      catalogModel("gemini-3.7-flash"),
      catalogModel("claude-opus-5"),
    ] as never,
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = savedModels
  state.copilotToken = savedCopilotToken
  state.vsCodeVersion = savedVsCodeVersion
  clearLaunchRegistry()
})

describe("fast Advisor request policy", () => {
  test("the authenticated lead receives the restrained fast instructions", async () => {
    let forwarded = ""
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      forwarded = String(init?.body ?? "")
      const events = [
        { type: "response.created", response: { status: "in_progress" } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "m0" },
        },
        { type: "response.output_text.delta", output_index: 0, delta: "ok" },
        { type: "response.output_text.done", output_index: 0, text: "ok" },
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ]
      const body =
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
        + "data: [DONE]\n\n"
      return Promise.resolve(
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
      )
    }) as unknown as typeof fetch

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "advisor-tool-2026-03-01",
        [LAUNCH_SECRET_HEADER]: FAST_SECRET,
      },
      body: requestBody("gpt-5.6-luna", true),
    })

    expect(response.status).toBe(200)
    await response.text()
    expect(forwarded).toContain(ADVISOR_INTERNAL_TOOL_NAME)
    expect(forwarded).toContain("optional, transcript-aware")
    expect(forwarded).toContain("non-binding consultation")
    expect(forwarded).not.toContain("Call advisor BEFORE substantive work")
  })

  test("every authenticated fast Task subagent has all Advisor tool forms stripped", async () => {
    const forwarded: Array<string> = []
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      forwarded.push(String(init?.body ?? ""))
      return Promise.resolve(responsesObjectResponse())
    }) as unknown as typeof fetch

    for (const [agentId, model] of [
      ["scout", LUNA_SCOUT_ALIAS_ID],
      ["implementer", LUNA_IMPLEMENTER_ALIAS_ID],
      ["reviewer", "grok-4.6"],
      ["planner", "gpt-5.6-sol"],
      ["critic", "gemini-3.7-flash"],
    ] as const) {
      const response = await server.request("/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-beta": "advisor-tool-2026-03-01",
          "x-claude-code-agent-id": agentId,
          [LAUNCH_SECRET_HEADER]: FAST_SECRET,
        },
        body: requestBody(model),
      })
      expect(response.status).toBe(200)
    }

    expect(forwarded).toHaveLength(5)
    for (const body of forwarded) {
      expect(body).not.toContain(ADVISOR_INTERNAL_TOOL_NAME)
      expect(body).not.toContain("advisor_20260301")
      expect(body).not.toContain(FAST_ADVISOR_TOOL_INSTRUCTIONS)
    }
  })

  test("a fast launch keeps consultative Advisor policy on the Claude passthrough route", async () => {
    let messagesCalls = 0
    let advisorSystemPrompt = ""
    let advisorEffort = ""
    const anthropicSse = (events: Array<{ event: string; data: Record<string, unknown> }>) =>
      new Response(
        events
          .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      )

    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      const url = String(_url)
      if (url.includes("/chat/completions")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: Array<{ role?: string; content?: string }>
          reasoning_effort?: string
          model?: string
        }
        expect(body.model).toBe(ADVISOR_FAST_PROFILE_MODEL)
        advisorSystemPrompt =
          body.messages?.find((message) => message.role === "system")?.content ?? ""
        advisorEffort = body.reasoning_effort ?? ""
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: { role: "assistant", content: "Advisor advice." },
                  finish_reason: "stop",
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          ),
        )
      }

      messagesCalls++
      if (messagesCalls === 1) {
        return Promise.resolve(
          anthropicSse([
            {
              event: "message_start",
              data: { type: "message_start", message: { id: "m1" } },
            },
            {
              event: "content_block_start",
              data: {
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "tool_use",
                  id: "toolu_advisor_fast_claude",
                  name: ADVISOR_INTERNAL_TOOL_NAME,
                  input: {},
                },
              },
            },
            {
              event: "content_block_stop",
              data: { type: "content_block_stop", index: 0 },
            },
            {
              event: "message_delta",
              data: {
                type: "message_delta",
                delta: { stop_reason: "tool_use", stop_sequence: null },
                usage: { output_tokens: 1 },
              },
            },
            { event: "message_stop", data: { type: "message_stop" } },
          ]),
        )
      }
      return Promise.resolve(
        anthropicSse([
          {
            event: "message_start",
            data: { type: "message_start", message: { id: "m2" } },
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
              delta: { type: "text_delta", text: "done" },
            },
          },
          {
            event: "content_block_stop",
            data: { type: "content_block_stop", index: 0 },
          },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            },
          },
          { event: "message_stop", data: { type: "message_stop" } },
        ]),
      )
    }) as unknown as typeof fetch

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "advisor-tool-2026-03-01",
        [LAUNCH_SECRET_HEADER]: FAST_SECRET,
      },
      body: requestBody("claude-opus-5", true),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("advisor_tool_result")
    expect(advisorSystemPrompt).toContain("non-binding consultant")
    expect(advisorSystemPrompt).toContain("Do not approve, veto, dictate")
    expect(advisorSystemPrompt).not.toContain(
      "Give a directive recommendation and commit to the decision",
    )
    expect(advisorEffort).toBe("high")
    expect(messagesCalls).toBe(2)
  })

  test("standard injection keeps the existing mandatory policy byte-for-byte", () => {
    const body = JSON.stringify({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hello" }],
    })
    const parsed = JSON.parse(injectAdvisorTool(body)) as {
      tools: Array<{ description: string }>
    }
    expect(parsed.tools[0]?.description).toBe(ADVISOR_TOOL_INSTRUCTIONS)
  })
})
