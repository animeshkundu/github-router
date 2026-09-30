import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  ADVISOR_REVIEWER_MAX_TURNS,
  ADVISOR_INTERNAL_TOOL_NAME,
  CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS,
  CHEAPEST_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS,
  advisorSystemPrompt,
} from "~/services/advisor/advisor"
import { CHEAPEST_EXPLORE_ALIAS_ID, CHEAPEST_REVIEWER_ALIAS_ID } from "~/lib/launch-profile"
import {
  clearLaunchRegistry,
  registerLaunch,
} from "~/lib/launch-registry"
import { LAUNCH_SECRET_HEADER } from "~/lib/messages-identity-preflight"
import { state } from "~/lib/state"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const savedModels = state.models
const savedCopilotToken = state.copilotToken
const savedVsCodeVersion = state.vsCodeVersion
const CHEAPEST_SECRET = "c".repeat(64)

function catalogModel(id: string) {
  return {
    id,
    name: id,
    object: "model",
    vendor: "openai",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    supported_endpoints: ["/responses"],
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

function simpleResponsesSse(): Response {
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
      response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ]
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
    + "data: [DONE]\n\n"
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

function readToolBody(model: string) {
  return JSON.stringify({
    model,
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "Review this change." }],
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ],
  })
}

function cheapestOptions(body: string, agentId?: string) {
  return {
    method: "POST" as const,
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "advisor-tool-2026-03-01",
      [LAUNCH_SECRET_HEADER]: CHEAPEST_SECRET,
      ...(agentId ? { "x-claude-code-agent-id": agentId } : {}),
    },
    body,
  }
}

beforeEach(() => {
  clearLaunchRegistry()
  registerLaunch({
    profileId: "cheapest",
    nonce: "n".repeat(64),
    secret: CHEAPEST_SECRET,
  })
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.models = {
    object: "list",
    data: [
      catalogModel("gpt-6-luna"),
      catalogModel("gpt-5.6-sol"),
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

describe("cheapest reviewer protege grant", () => {
  test("reviewer subagent receives the protege advisor tool, other subagents do not", async () => {
    const forwarded: Array<string> = []
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      forwarded.push(String(init?.body ?? ""))
      return Promise.resolve(simpleResponsesSse())
    }) as unknown as typeof fetch

    const reviewer = await server.request(
      "/v1/messages",
      cheapestOptions(readToolBody(CHEAPEST_REVIEWER_ALIAS_ID), "reviewer"),
    )
    expect(reviewer.status).toBe(200)
    await reviewer.text()

    const explore = await server.request(
      "/v1/messages",
      cheapestOptions(readToolBody("gpt-6-luna"), "Explore"),
    )
    expect(explore.status).toBe(200)
    await explore.text()

    expect(forwarded).toHaveLength(2)
    // Reviewer: injected protege tool with the capped-budget description.
    // (Parse: forwarded bodies are serialized JSON, so compare the decoded
    // description field rather than the raw string.)
    const reviewerTools = (JSON.parse(forwarded[0]) as {
      tools?: Array<{ name?: string; description?: string }>
    }).tools
    const reviewerAdvisor = reviewerTools?.find((tool) => tool.name === ADVISOR_INTERNAL_TOOL_NAME)
    expect(reviewerAdvisor?.description).toBe(CHEAPEST_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS)
    expect(reviewerAdvisor?.description).toContain("at most 5 advisor rounds")
    // Explore: stripped, no advisor tool of either form.
    expect(forwarded[1]).not.toContain(ADVISOR_INTERNAL_TOOL_NAME)
    expect(forwarded[1]).not.toContain("advisor_20260301")
    expect(forwarded[1]).not.toContain("at most 5 advisor rounds")
  })

  test("teammate-style reviewer id with the reviewer alias is granted (Agent-team spawns)", async () => {
    const forwarded: Array<string> = []
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      forwarded.push(String(init?.body ?? ""))
      return Promise.resolve(simpleResponsesSse())
    }) as unknown as typeof fetch

    // Agent-team teammates carry name-based ids ("reviewer-advisor-only"),
    // not the bare role — detection must key on the pinned model alias.
    const reviewer = await server.request(
      "/v1/messages",
      cheapestOptions(readToolBody(CHEAPEST_REVIEWER_ALIAS_ID), "reviewer-advisor-only"),
    )
    expect(reviewer.status).toBe(200)
    await reviewer.text()

    expect(forwarded).toHaveLength(1)
    const reviewerTools = (JSON.parse(forwarded[0]) as {
      tools?: Array<{ name?: string; description?: string }>
    }).tools
    const reviewerAdvisor = reviewerTools?.find((tool) => tool.name === ADVISOR_INTERNAL_TOOL_NAME)
    expect(reviewerAdvisor?.description).toBe(CHEAPEST_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS)
  })

  test("bracketed reviewer alias is still detected (suffix stripped before lookup)", async () => {
    const forwarded: Array<string> = []
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      forwarded.push(String(init?.body ?? ""))
      return Promise.resolve(simpleResponsesSse())
    }) as unknown as typeof fetch

    const reviewer = await server.request(
      "/v1/messages",
      cheapestOptions(readToolBody(`${CHEAPEST_REVIEWER_ALIAS_ID}[1m]`), "reviewer-teammate"),
    )
    expect(reviewer.status).toBe(200)
    await reviewer.text()

    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]).toContain(ADVISOR_INTERNAL_TOOL_NAME)
  })

  test("teammate-style id with a non-reviewer alias stays stripped", async () => {
    const forwarded: Array<string> = []
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      forwarded.push(String(init?.body ?? ""))
      return Promise.resolve(simpleResponsesSse())
    }) as unknown as typeof fetch

    const explore = await server.request(
      "/v1/messages",
      cheapestOptions(readToolBody(CHEAPEST_EXPLORE_ALIAS_ID), "explore-helper"),
    )
    expect(explore.status).toBe(200)
    await explore.text()

    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]).not.toContain(ADVISOR_INTERNAL_TOOL_NAME)
    expect(forwarded[0]).not.toContain("advisor_20260301")
  })

  test("cheapest lead keeps its own (non-protege) advisor instructions", async () => {
    const forwarded: Array<string> = []
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      forwarded.push(String(init?.body ?? ""))
      return Promise.resolve(simpleResponsesSse())
    }) as unknown as typeof fetch

    const lead = await server.request(
      "/v1/messages",
      cheapestOptions(readToolBody("gpt-6-luna")),
    )
    expect(lead.status).toBe(200)
    await lead.text()

    expect(forwarded).toHaveLength(1)
    const leadTools = (JSON.parse(forwarded[0]) as {
      tools?: Array<{ name?: string; description?: string }>
    }).tools
    const leadAdvisor = leadTools?.find((tool) => tool.name === ADVISOR_INTERNAL_TOOL_NAME)
    expect(leadAdvisor?.description).toBe(CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS)
    expect(leadAdvisor?.description ?? "").not.toContain("at most 5 advisor rounds")
  })
})

describe("advisorSystemPrompt reviewer profile", () => {
  test("reviewer variant names the weaker-executor relationship and the output contract", () => {
    const prompt = advisorSystemPrompt(false, false, false, true)
    expect(prompt).toContain("weaker, faster executor")
    expect(prompt).toContain("at most 5 rounds per review")
    expect(prompt).toContain("Verdict (SHIP / FIX / BLOCK)")
    expect(prompt).toContain("non-binding counsel")
    // Reviewer variant replaces the lead consultant clause, not appends it.
    expect(prompt).not.toContain("primary lead")
  })

  test("existing variants are unchanged by the fourth flag default", () => {
    expect(advisorSystemPrompt(false, false, false)).not.toContain("weaker, faster executor")
    expect(advisorSystemPrompt(false, true, false)).toContain("primary lead")
    expect(advisorSystemPrompt(false, true, false)).not.toContain("at most 5 rounds per review")
  })

  test("reviewer turn cap is 5, below the lead-global 16", () => {
    expect(ADVISOR_REVIEWER_MAX_TURNS).toBe(5)
  })
})
