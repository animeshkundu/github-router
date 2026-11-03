// Advisor grants for the `-m local` / `-m local2` launch profiles.
//
// `local2` is `cheapest2`'s curated Advisor on a local lead, so it inherits
// the same two grants the cheapest family already has:
//
//   - the LEAD gets the full curated Advisor tool;
//   - the REVIEWER gets the capped protege version (at most 5 rounds, mentor
//     posture), which is what the emitted reviewer `.md` promises.
//
// Every other local subagent is stripped, and `local` (no `2`) grants nothing
// at all. Both directions are easy to regress silently: a widened grant hands
// a weaker reviewer a tool it was never meant to hold, and a narrowed one
// leaves the reviewer `.md` naming a tool that is not in its request.
//
// The same tests pin the second half of the gate: a local endpoint is never
// assumed to understand Anthropic's native `advisor_*` server-tool type, so
// any request whose advisor behaviour is off must carry neither form.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  ADVISOR_INTERNAL_TOOL_NAME,
  CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS,
  CHEAPEST_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS,
  LOCAL_ADVISOR_TOOL_INSTRUCTIONS,
  LOCAL_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS,
} from "~/services/advisor/advisor"
import { clearLaunchRegistry, registerLaunch } from "~/lib/launch-registry"
import { configureLocalEgress } from "~/lib/local-egress"
import { LAUNCH_SECRET_HEADER } from "~/lib/messages-identity-preflight"
import { state } from "~/lib/state"
import type { LaunchProfileId } from "~/lib/launch-profile"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const savedModels = state.models
const savedCopilotToken = state.copilotToken

const SECRET = "l".repeat(64)
const NONCE = "n".repeat(64)
const LOCAL_BASE = "http://127.0.0.1:9/v1"
const ADVISOR_BETA = "advisor-tool-2026-03-01"

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

function jsonMessage(): Response {
  return Response.json({
    id: "msg_local",
    type: "message",
    role: "assistant",
    model: "opus",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 1 },
  })
}

interface Captured {
  url: string
  body: Record<string, unknown>
}

function captureFetch(): Captured[] {
  const captured: Captured[] = []
  globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>
    } catch {
      parsed = {}
    }
    captured.push({ url: String(url), body: parsed })
    return Promise.resolve(jsonMessage())
  }) as unknown as typeof fetch
  return captured
}

function toolsOf(captured: Captured): Array<{ name?: string; type?: string; description?: string }> {
  const tools = captured.body.tools
  return Array.isArray(tools) ? (tools as Array<{ name?: string; type?: string; description?: string }>) : []
}

function advisorToolOf(captured: Captured) {
  return toolsOf(captured).find((tool) => tool.name === ADVISOR_INTERNAL_TOOL_NAME)
}

function readToolBody(model: string, extraTools: Array<Record<string, unknown>> = []) {
  return JSON.stringify({
    model,
    max_tokens: 100,
    messages: [{ role: "user", content: "Review this change." }],
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
      ...extraTools,
    ],
  })
}

function requestOptions(
  body: string,
  opts: { agentId?: string; beta?: string } = {},
) {
  return {
    method: "POST" as const,
    headers: {
      "content-type": "application/json",
      ...(opts.beta ? { "anthropic-beta": opts.beta } : {}),
      [LAUNCH_SECRET_HEADER]: SECRET,
      ...(opts.agentId ? { "x-claude-code-agent-id": opts.agentId } : {}),
    },
    body,
  }
}

function register(profileId: LaunchProfileId): void {
  clearLaunchRegistry()
  registerLaunch({ profileId, nonce: NONCE, secret: SECRET })
}

beforeEach(() => {
  clearLaunchRegistry()
  configureLocalEgress({ baseUrl: LOCAL_BASE })
  state.copilotToken = "test-token"
  state.models = {
    object: "list",
    data: [
      catalogModel("gpt-6.1-sol"),
      catalogModel("gpt-5.6-sol"),
    ] as never,
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = savedModels
  state.copilotToken = savedCopilotToken
  clearLaunchRegistry()
  configureLocalEgress({})
})

describe("local2 reviewer protege grant", () => {
  test("reviewer subagent receives the capped protege advisor tool", async () => {
    register("local2")
    const captured = captureFetch()

    const response = await server.request(
      "/v1/messages",
      requestOptions(readToolBody("opus"), { agentId: "reviewer", beta: ADVISOR_BETA }),
    )
    expect(response.status).toBe(200)
    await response.text()

    expect(captured).toHaveLength(1)
    // The grant must not divert egress: this is still a LEAD-shaped call to
    // the operator's own endpoint.
    expect(captured[0]!.url).toBe(`${LOCAL_BASE}/messages`)
    expect(captured[0]!.body.model).toBe("opus")

    const advisor = advisorToolOf(captured[0]!)
    expect(advisor?.description).toBe(LOCAL_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS)
    expect(advisor?.description).toContain("at most 5 advisor rounds")
    // The local profile knows nothing about the model behind its endpoint, so
    // the description may not rank the Copilot-served Advisor against it. The
    // comparison stays in the cheapest variant, which observes both models.
    expect(advisor?.description).toContain("Copilot-served")
    expect(advisor?.description).not.toContain("stronger")
    expect(CHEAPEST_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS).toContain("stronger")
  })

  test("teammate-style reviewer id is granted (Agent-team spawns)", async () => {
    register("local2")
    const captured = captureFetch()

    // Agent-team teammates carry name-based ids ("reviewer-advisor-only"),
    // so the grant keys on the `reviewer-` prefix as well as the bare role.
    const response = await server.request(
      "/v1/messages",
      requestOptions(readToolBody("opus"), {
        agentId: "reviewer-advisor-only",
        beta: ADVISOR_BETA,
      }),
    )
    expect(response.status).toBe(200)
    await response.text()

    expect(captured).toHaveLength(1)
    expect(advisorToolOf(captured[0]!)?.description).toBe(
      LOCAL_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS,
    )
  })

  test("the lead keeps the full curated advisor, not the protege variant", async () => {
    register("local2")
    const captured = captureFetch()

    const response = await server.request(
      "/v1/messages",
      requestOptions(readToolBody("opus"), { beta: ADVISOR_BETA }),
    )
    expect(response.status).toBe(200)
    await response.text()

    expect(captured).toHaveLength(1)
    expect(captured[0]!.url).toBe(`${LOCAL_BASE}/messages`)
    const advisor = advisorToolOf(captured[0]!)
    expect(advisor?.description).toBe(LOCAL_ADVISOR_TOOL_INSTRUCTIONS)
    expect(advisor?.description ?? "").not.toContain("at most 5 advisor rounds")
    expect(advisor?.description ?? "").toContain("Copilot-served")
    expect(advisor?.description ?? "").not.toContain("stronger")
    expect(CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS).toContain("stronger")
  })

  test("a non-reviewer subagent gets no advisor tool of either form", async () => {
    register("local2")
    const captured = captureFetch()

    // The request also carries Claude Code's native typed tool, which the
    // local endpoint must never be asked about.
    const response = await server.request(
      "/v1/messages",
      requestOptions(
        readToolBody("haiku", [
          {
            type: "advisor_20260301",
            name: "advisor",
            model: "gpt-6.1-sol",
            max_uses: 3,
          },
        ]),
        { agentId: "Explore", beta: ADVISOR_BETA },
      ),
    )
    expect(response.status).toBe(200)
    await response.text()

    expect(captured).toHaveLength(1)
    expect(advisorToolOf(captured[0]!)).toBeUndefined()
    expect(JSON.stringify(captured[0]!.body)).not.toContain("advisor_20260301")
    expect(JSON.stringify(captured[0]!.body)).not.toContain("at most 5 advisor rounds")
  })

  test("a local2 lead without the advisor beta is stripped too", async () => {
    register("local2")
    const captured = captureFetch()

    // Without the beta the advisor behaviour is off, so this is the local
    // arm of the strip gate: a native typed tool must not reach the endpoint
    // even on a lead whose profile HAS an Advisor.
    const response = await server.request(
      "/v1/messages",
      requestOptions(
        readToolBody("opus", [
          { type: "advisor_20260301", name: "advisor", model: "gpt-6.1-sol" },
        ]),
      ),
    )
    expect(response.status).toBe(200)
    await response.text()

    expect(captured).toHaveLength(1)
    expect(advisorToolOf(captured[0]!)).toBeUndefined()
    expect(JSON.stringify(captured[0]!.body)).not.toContain("advisor_20260301")
  })
})

describe("local (no Advisor) grants nothing", () => {
  test("a reviewer subagent on local never receives the protege tool", async () => {
    register("local")
    const captured = captureFetch()

    const response = await server.request(
      "/v1/messages",
      requestOptions(
        readToolBody("opus", [
          { type: "advisor_20260301", name: "advisor", model: "gpt-6.1-sol" },
        ]),
        { agentId: "reviewer", beta: ADVISOR_BETA },
      ),
    )
    expect(response.status).toBe(200)
    await response.text()

    expect(captured).toHaveLength(1)
    expect(captured[0]!.url).toBe(`${LOCAL_BASE}/messages`)
    expect(advisorToolOf(captured[0]!)).toBeUndefined()
    expect(JSON.stringify(captured[0]!.body)).not.toContain("advisor_20260301")
    expect(JSON.stringify(captured[0]!.body)).not.toContain("at most 5 advisor rounds")
  })

  test("a local lead asking for the advisor is still stripped", async () => {
    register("local")
    const captured = captureFetch()

    const response = await server.request(
      "/v1/messages",
      requestOptions(readToolBody("opus"), { beta: ADVISOR_BETA }),
    )
    expect(response.status).toBe(200)
    await response.text()

    expect(captured).toHaveLength(1)
    expect(advisorToolOf(captured[0]!)).toBeUndefined()
    expect(captured[0]!.body.model).toBe("opus")
  })
})

// ---------------------------------------------------------------------------
// What the consult actually sends, and where the lead turn goes afterwards
//
// The grants above decide WHETHER `local2` may consult. These cover the two
// halves that are assembled server-side and are therefore easy to lose
// silently:
//
//   - the advisor system prompt, built from the profile flags at dispatch
//     time (the tool description is a separate surface, already pinned above);
//   - the LEAD's continuation after an advisor round, which the advisor loop
//     dispatches itself rather than the handler's first-call egress.
// ---------------------------------------------------------------------------

const SESSION_ID = "session-local-2"

interface StreamCaptured {
  url: string
  body: Record<string, unknown>
  headers: Record<string, string>
}

function sse(events: Array<{ event: string; data: Record<string, unknown> }>): Response {
  return new Response(
    events
      .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function advisorTurnSse(): Response {
  return sse([
    { event: "message_start", data: { type: "message_start", message: { id: "m1" } } },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_local_advisor",
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

function finalTurnSse(): Response {
  return sse([
    { event: "message_start", data: { type: "message_start", message: { id: "m2" } } },
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

function streamingLeadBody(): string {
  return JSON.stringify({
    model: "opus",
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

// Local turns stream; the advisor call does not. Capturing the headers is what
// pins the session id on the continuation.
function captureStreamFetch(): StreamCaptured[] {
  const captured: StreamCaptured[] = []
  let localTurns = 0
  globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>
    } catch {
      // A streamed or empty body — nothing to parse here.
    }
    captured.push({
      url: href,
      body: parsed,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    if (href.startsWith(LOCAL_BASE)) {
      localTurns += 1
      return Promise.resolve(localTurns === 1 ? advisorTurnSse() : finalTurnSse())
    }
    return Promise.resolve(
      Response.json({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Advisor advice." }],
          },
        ],
      }),
    )
  }) as unknown as typeof fetch
  return captured
}

function streamingRequestOptions(agentId?: string) {
  return {
    method: "POST" as const,
    headers: {
      "content-type": "application/json",
      "anthropic-beta": ADVISOR_BETA,
      [LAUNCH_SECRET_HEADER]: SECRET,
      "x-claude-code-session-id": SESSION_ID,
      ...(agentId ? { "x-claude-code-agent-id": agentId } : {}),
    },
    body: streamingLeadBody(),
  }
}

describe("local2 advisor dispatch", () => {
  test("the lead consult is assumption-free about the local model", async () => {
    register("local2")
    const captured = captureStreamFetch()

    const response = await server.request("/v1/messages", streamingRequestOptions())
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("advisor_tool_result")

    const advisorCall = captured.find((call) => call.url.includes("/responses"))
    expect(advisorCall).toBeDefined()
    const instructions = String(advisorCall!.body.instructions ?? "")
    expect(instructions).toContain("You are advising the lead model on a machine.")
    // The profile cannot observe which model answers its endpoint, so the
    // consult may not name it or grade it against the advisor.
    expect(instructions).not.toMatch(/\bLuna\b/)
    expect(instructions).not.toContain("faster, cheaper")
    expect(instructions).not.toContain("cost-efficient")
    expect(instructions).not.toContain("frontier")
  })

  test("the post-advisor turn stays on the local endpoint with the same session", async () => {
    register("local2")
    const captured = captureStreamFetch()

    const response = await server.request("/v1/messages", streamingRequestOptions())
    expect(response.status).toBe(200)
    await response.text()

    const localCalls = captured.filter((call) => call.url.startsWith(LOCAL_BASE))
    // First lead turn, then the continuation after the advisor round.
    expect(localCalls).toHaveLength(2)
    expect(localCalls[1]!.body.model).toBe("opus")
    // The session id is the local server's prompt-cache routing key; an
    // advisor round must not lose it.
    expect(localCalls[1]!.headers["x-claude-code-session-id"]).toBe(SESSION_ID)
    // And the advisor model call itself must NOT carry the local endpoint.
    for (const call of captured) {
      if (call.url.includes("/responses")) {
        expect(call.url.startsWith(LOCAL_BASE)).toBe(false)
      }
    }
  })

  test("the reviewer consult keeps the mentor contract without grading the local model", async () => {
    register("local2")
    const captured = captureStreamFetch()

    const response = await server.request(
      "/v1/messages",
      streamingRequestOptions("reviewer"),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("advisor_tool_result")

    const advisorCall = captured.find((call) => call.url.includes("/responses"))
    expect(advisorCall).toBeDefined()
    const instructions = String(advisorCall!.body.instructions ?? "")
    expect(instructions).toContain("You are advising a reviewer model")
    expect(instructions).toContain("Verdict (SHIP / FIX / BLOCK)")
    expect(instructions).toContain("at most 5 rounds per review")
    expect(instructions).not.toMatch(/\bLuna\b/)
    expect(instructions).not.toContain("senior mentor")
    expect(instructions).not.toContain("weaker, faster")
    expect(instructions).not.toContain("ill-equipped")
    expect(instructions).not.toContain("frontier")
  })
})
