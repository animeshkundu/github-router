// `-m cheaplocal`: the cheapest profile whose Advisor and Oracle are served by
// the local Anthropic-Messages endpoint.
//
// `cheapest`/`cheapest2` keep their consultants on Copilot, and `local`/`local2`
// invert the split (the whole lead loop leaves, the consultants stay). This
// profile is the third shape, so these pins are about the boundary rather than
// the roster (covered in `cheaplocal-profile.test.ts`):
//
//   - the LEAD turn stays on Copilot's `/responses`, and so does the
//     continuation after an advisor round;
//   - the CONSULT leaves for the operator's endpoint with the minimal Anthropic
//     body and no Copilot credential, no catalog lookup and no model-shaped
//     knob;
//   - the curated digest and the reviewer's mentor posture are unchanged: moving
//     the consultant must not change what it is asked. What DOES change is the
//     consultant's own framing: the system prompt still names the known advisee
//     (Luna) but drops every claim about the endpoint's model — no "senior
//     mentor", no "faster, cheaper", no "frontier knowledge" — because those
//     were calibrated against a catalog model and may be false of this one;
//   - the consult is filed as a zero-cost request under the RAW local id, so the
//     status line reads honest rather than broken.
//
// The assertion style is deliberately assumption-free: nothing here names the
// model behind the endpoint, because the profile cannot observe it.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { __resetAicLedgerForTests, aicSnapshot } from "~/lib/aic-ledger"
import { CHEAPLOCAL_PROFILE_ADVISOR_CLIENT_MODEL } from "~/lib/cheaplocal-profile-contract"
import { clearLaunchRegistry, registerLaunch } from "~/lib/launch-registry"
import {
  configureLocalEgress,
  LOCAL_CONSULT_MAX_OUTPUT_TOKENS,
} from "~/lib/local-egress"
import { LAUNCH_SECRET_HEADER } from "~/lib/messages-identity-preflight"
import { state } from "~/lib/state"
import { server } from "~/server"
import { ADVISOR_INTERNAL_TOOL_NAME } from "~/services/advisor/advisor"

const originalFetch = globalThis.fetch
const savedModels = state.models
const savedCopilotToken = state.copilotToken
const savedVsCodeVersion = state.vsCodeVersion

const SECRET = "l".repeat(64)
const NONCE = "n".repeat(64)
const LOCAL_BASE = "http://127.0.0.1:9/v1"
const ADVISOR_BETA = "advisor-tool-2026-03-01"
const SESSION_ID = "session-cheaplocal"

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
      limits: {
        max_context_window_tokens: 1_050_000,
        max_prompt_tokens: 900_000,
        max_output_tokens: 16_000,
      },
      supports: {
        tool_calls: true,
        reasoning_effort: ["medium", "high", "xhigh", "max"],
      },
    },
  }
}

/** The local server's answer: a plain non-streaming Anthropic message. */
function jsonMessage(): Response {
  return Response.json({
    id: "msg_local",
    type: "message",
    role: "assistant",
    model: "opus",
    content: [{ type: "text", text: "Consult answer." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 1 },
  })
}

function responsesSse(events: Array<Record<string, unknown>>): Response {
  const body =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
    + "data: [DONE]\n\n"
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

/** The Copilot lead's first turn: it asks for the proxy-injected advisor. */
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
    {
      type: "response.completed",
      response: { usage: { input_tokens: 1, output_tokens: 1 } },
    },
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
    {
      type: "response.completed",
      response: { usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ])
}

interface Captured {
  url: string
  body: Record<string, unknown>
  headers: Record<string, string>
}

/**
 * Two endpoints, three calls: the Copilot lead stream, the local consult, then
 * the Copilot continuation. The local branch is matched first because its URL
 * also ends in `/messages`.
 */
function captureFetch(): Captured[] {
  const captured: Captured[] = []
  let leadStreams = 0

  globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>
    } catch {
      // A streamed or empty body: nothing to parse here.
    }
    captured.push({
      url: href,
      body: parsed,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })

    if (href.startsWith(LOCAL_BASE)) {
      return Promise.resolve(jsonMessage())
    }
    if (href.includes("/responses")) {
      leadStreams += 1
      return Promise.resolve(
        leadStreams === 1 ? leadResponsesSse() : continuationResponsesSse(),
      )
    }
    return Promise.resolve(new Response("unexpected endpoint", { status: 500 }))
  }) as unknown as typeof fetch

  return captured
}

function requestBody(): string {
  return JSON.stringify({
    model: "gpt-6-luna",
    max_tokens: 100,
    stream: true,
    messages: [
      { role: "user", content: "Review this change." },
      {
        role: "assistant",
        content: [{ type: "text", text: "BRIEF: check the retry loop." }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_big",
            content: "tool-output ".repeat(20_000),
          },
        ],
      },
    ],
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ],
  })
}

function requestOptions(agentId?: string, body: string = requestBody()) {
  return {
    method: "POST" as const,
    headers: {
      "content-type": "application/json",
      "anthropic-beta": ADVISOR_BETA,
      [LAUNCH_SECRET_HEADER]: SECRET,
      "x-claude-code-session-id": SESSION_ID,
      ...(agentId ? { "x-claude-code-agent-id": agentId } : {}),
    },
    body,
  }
}

/** The lead turn as Claude Code sends it when it declares the native Advisor
 *  tool at a given model id. */
function requestBodyWithAdvisorModel(model: string): string {
  const body = JSON.parse(requestBody()) as {
    tools: Array<Record<string, unknown>>
  }
  body.tools.push({
    type: "advisor_2026_03_01",
    name: "advisor",
    model,
    max_uses: 3,
  })
  return JSON.stringify(body)
}

function localCall(captured: Captured[]): Captured {
  const call = captured.find((entry) => entry.url.startsWith(LOCAL_BASE))
  if (!call) throw new Error("the consult never reached the local endpoint")
  return call
}

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const lowered: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) lowered[key.toLowerCase()] = value
  return lowered
}

beforeEach(() => {
  clearLaunchRegistry()
  registerLaunch({ profileId: "cheaplocal", nonce: NONCE, secret: SECRET })
  configureLocalEgress({ baseUrl: LOCAL_BASE })
  __resetAicLedgerForTests()
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.models = {
    object: "list",
    data: [catalogModel("gpt-6-luna"), catalogModel("gpt-5.6-sol")] as never,
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = savedModels
  state.copilotToken = savedCopilotToken
  state.vsCodeVersion = savedVsCodeVersion
  clearLaunchRegistry()
  configureLocalEgress({})
})

describe("the cheaplocal lead consult leaves Copilot", () => {
  test("only the consult moves: lead and continuation stay on /responses", async () => {
    const captured = captureFetch()

    const response = await server.request("/v1/messages", requestOptions())
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("advisor_tool_result")

    const localCalls = captured.filter((call) => call.url.startsWith(LOCAL_BASE))
    expect(localCalls).toHaveLength(1)
    expect(localCalls[0]!.url).toBe(`${LOCAL_BASE}/messages`)

    // Two Copilot streams: the lead turn that asked for the consult, then the
    // continuation. Neither may be diverted by the consultant's egress.
    const copilotStreams = captured.filter(
      (call) => !call.url.startsWith(LOCAL_BASE) && call.url.includes("/responses"),
    )
    expect(copilotStreams).toHaveLength(2)
    for (const call of copilotStreams) {
      expect(call.body.model).toBe("gpt-6-luna")
    }
  })

  test("the consult body is the minimal Anthropic shape", async () => {
    const captured = captureFetch()

    const response = await server.request("/v1/messages", requestOptions())
    expect(response.status).toBe(200)
    await response.text()

    const consult = localCall(captured)
    // Exactly these four fields. Every additional shape (thinking,
    // output_config, cache_control, stream, tools) would be a claim about a
    // model the profile has never been told anything about.
    expect(Object.keys(consult.body).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "system",
    ])
    // The plan's bare id. Not `claude-opus-5.5`, not decorated: the proxy does
    // not resolve a local slug through the Copilot catalog.
    expect(consult.body.model).toBe("opus")
    expect(consult.body.max_tokens).toBe(LOCAL_CONSULT_MAX_OUTPUT_TOKENS)
    expect(consult.body.max_tokens).toBe(4096)
    expect(typeof consult.body.system).toBe("string")

    const messages = consult.body.messages as Array<{ role: string; content: unknown }>
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe("user")
    expect(typeof messages[0]!.content).toBe("string")
    // The curated digest still applies on the local transport: the consult is
    // asked exactly what it was asked while its model lived on Copilot.
    const userText = String(messages[0]!.content)
    expect(userText).toContain("<operator_focus>")
    expect(userText).toContain("<session_transcript")
    expect(userText).toContain("<operator_focus_restated>")
  })

  test("the consult carries no Copilot credential and keeps the session id", async () => {
    const captured = captureFetch()

    const response = await server.request("/v1/messages", requestOptions())
    expect(response.status).toBe(200)
    await response.text()

    const headers = lowerHeaders(localCall(captured).headers)
    // Sending Copilot's bearer to a server the operator merely pointed us at
    // would leak a live token.
    expect(headers.authorization).toBeUndefined()
    expect(headers["copilot-integration-id"]).toBeUndefined()
    expect(headers["x-initiator"]).toBeUndefined()
    // The local server requires this header (a request without it is a 400),
    // and it is the prompt-cache routing key, so a consult must not lose it.
    expect(headers["x-claude-code-session-id"]).toBe(SESSION_ID)
  })

  test("the consult is billed at zero under the raw local id", async () => {
    const captured = captureFetch()

    const response = await server.request("/v1/messages", requestOptions())
    expect(response.status).toBe(200)
    await response.text()

    expect(localCall(captured).body.model).toBe("opus")
    // The raw id, not a catalog-resolved Claude slug: filing a free local turn
    // under a Copilot model would be a false attribution.
    expect(aicSnapshot().perModel["opus"]).toEqual({ nanoAiu: 0, requests: 1 })
    expect(aicSnapshot().perModel["claude-opus-5.5"]).toBeUndefined()
  })

  test("the lead consult keeps its non-binding posture", async () => {
    const captured = captureFetch()

    const response = await server.request("/v1/messages", requestOptions())
    expect(response.status).toBe(200)
    await response.text()

    const system = String(localCall(captured).body.system)
    expect(system).toContain("advising the lead model")
    // The advisee is the known Luna, so her name and failure modes stay: they
    // are the reason the consult is worth making at all.
    expect(system).toContain("Luna")
    expect(system).toContain("<operator_focus>")
    // The consultant is not. No catalog model is named, and none of the
    // comparative framing calibrated against `gpt-5.6-sol` survives: "faster,
    // cheaper" and "less equipped" rank the consultant above Luna, and
    // "frontier" claims knowledge it was never shown to have.
    expect(system).not.toMatch(/\bSol\b/)
    expect(system).not.toContain("gpt-")
    expect(system).not.toContain("faster, cheaper")
    expect(system).not.toContain("cost-efficient")
    expect(system).not.toContain("less equipped")
    expect(system).not.toContain("frontier")
  })
})

// The launcher pins a client-visible Advisor identity and the handler rejects
// any request whose native Advisor tool disagrees with it. Those two values
// live in different processes, so this pins that the pin the launcher inserts
// is accepted. The regression it guards: the pin was `opus`, Claude Code
// resolved that recognized alias through its own registry, and every turn
// 400'd with a mismatch the user could not fix through `/advisor`.
describe("the client-visible Advisor pin and the handler agree", () => {
  test("the pin the launcher inserts is accepted and consults locally", async () => {
    const captured = captureFetch()

    const response = await server.request(
      "/v1/messages",
      requestOptions(
        undefined,
        requestBodyWithAdvisorModel(CHEAPLOCAL_PROFILE_ADVISOR_CLIENT_MODEL),
      ),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("advisor_tool_result")
    expect(localCall(captured).body.model).toBe("opus")
  })

  test("a drifted Advisor identity is refused with profile-specific guidance", async () => {
    // The canonicalized form Claude Code produced for `--advisor opus`. It must
    // still be caught, and the repair it names must be the label this profile
    // actually pins.
    const response = await server.request(
      "/v1/messages",
      requestOptions(undefined, requestBodyWithAdvisorModel("claude-opus-5.5")),
    )

    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error?: { message?: string } }
    expect(payload.error?.message).toContain("Cheap local Advisor")
    expect(payload.error?.message).toContain(
      `/advisor ${CHEAPLOCAL_PROFILE_ADVISOR_CLIENT_MODEL}`,
    )
    expect(payload.error?.message).toContain("-m cheaplocal")
    expect(payload.error?.message).not.toContain("/advisor opus")
  })
})

describe("the cheaplocal reviewer consult takes the same path", () => {
  test("it leaves for the local endpoint with the mentor posture", async () => {
    const captured = captureFetch()

    const response = await server.request("/v1/messages", requestOptions("reviewer"))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("advisor_tool_result")

    const consult = localCall(captured)
    expect(consult.url).toBe(`${LOCAL_BASE}/messages`)
    expect(consult.body.model).toBe("opus")
    expect(consult.body.max_tokens).toBe(LOCAL_CONSULT_MAX_OUTPUT_TOKENS)

    const system = String(consult.body.system)
    expect(system).toContain("advising a reviewer model")
    // The reviewer is the known Luna; the consultant is not named or ranked.
    expect(system).toContain("(Luna)")
    expect(system).toContain("at most 5 rounds per review")
    expect(system).toContain("Verdict (SHIP / FIX / BLOCK)")
    // The gap language is about the known reviewer and stays ("ill-equipped to
    // weigh" has Luna as its subject). The consultant-side framing goes:
    // "senior mentor" ranks it above Luna, "weaker, faster" ranks Luna below
    // it, and "frontier" claims knowledge it was never shown to have.
    expect(system).toContain("fill exactly these gaps")
    expect(system).not.toContain("senior mentor")
    expect(system).not.toContain("weaker, faster")
    expect(system).not.toContain("frontier")
    expect(system).not.toMatch(/\bSol\b/)
    expect(system).not.toContain("gpt-")

    // The lead's own turn is still a Copilot call on the same request.
    const copilotStreams = captured.filter(
      (call) => call.url.includes("/responses") && !call.url.startsWith(LOCAL_BASE),
    )
    expect(copilotStreams.length).toBeGreaterThanOrEqual(1)
  })
})
