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
    expect(advisor?.description).toBe(CHEAPEST_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS)
    expect(advisor?.description).toContain("at most 5 advisor rounds")
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
      CHEAPEST_REVIEWER_ADVISOR_TOOL_INSTRUCTIONS,
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
    expect(advisor?.description).toBe(CHEAPEST_ADVISOR_TOOL_INSTRUCTIONS)
    expect(advisor?.description ?? "").not.toContain("at most 5 advisor rounds")
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
