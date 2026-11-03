// End-to-end egress for the `-m local` / `-m local2` launch profiles, against
// a real HTTP server on an ephemeral port.
//
// The unit tests pin the pieces; this pins the seam: a client request enters
// through `/v1/messages`, leaves through the operator's endpoint, and comes
// back. Everything asserted here is something a plausible implementation could
// get wrong while every unit test stayed green:
//
//   - the model id reaches the local server untouched (`opus`, never
//     `claude-opus-5.5` from the `resolveModel` cascade);
//   - the client's `x-claude-code-session-id` reaches it too (a request
//     without one is a 400 there);
//   - no Copilot credential or header rides along;
//   - the proxy talks to the endpoint EXACTLY once per lead turn — a launch
//     probe or a second internal call would show up here;
//   - a `copilot_usage` block in the local response is NOT priced (the turn
//     was already recorded at zero), and a non-local profile is untouched.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { __resetAicLedgerForTests, aicSnapshot } from "~/lib/aic-ledger"
import { clearLaunchRegistry, registerLaunch } from "~/lib/launch-registry"
import { configureLocalEgress } from "~/lib/local-egress"
import { LAUNCH_SECRET_HEADER } from "~/lib/messages-identity-preflight"
import { state } from "~/lib/state"
import { server } from "~/server"

const SECRET = "l".repeat(64)
const NONCE = "n".repeat(64)
const SESSION_ID = "conversation-e2e-1"

interface SeenRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: Record<string, unknown> | undefined
}

interface Stub {
  baseUrl: string
  seen: SeenRequest[]
  stop: () => void
}

/**
 * A stand-in for the operator's local model server. Records every request so
 * the "exactly one call, no probe" assertion is possible, and answers with the
 * native Anthropic shape the real endpoint was measured to return.
 */
function startStub(respond: () => Response): Stub {
  const seen: SeenRequest[] = []
  const stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const raw = await req.text()
      let body: Record<string, unknown> | undefined
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined
      } catch {
        body = undefined
      }
      seen.push({
        method: req.method,
        path: url.pathname,
        headers: Object.fromEntries(req.headers),
        body,
      })
      return respond()
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${stub.port}/v1`,
    seen,
    stop: () => stub.stop(true),
  }
}

function jsonMessage(text: string, usage: Record<string, unknown> = {}): Response {
  return Response.json({
    id: "msg_local",
    type: "message",
    role: "assistant",
    model: "opus",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 9, output_tokens: 2 },
    // A local server is not Copilot and should never emit this. If it does,
    // the proxy must still not price a turn it already recorded at zero.
    copilot_usage: { total_nano_aiu: 5_000_000, token_details: [] },
    ...usage,
  })
}

const SSE_BODY = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"msg_sse","type":"message","role":"assistant","model":"opus","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":7,"output_tokens":0}}}',
  "",
  "event: content_block_start",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello from the local server"}}',
  "",
  "event: content_block_stop",
  'data: {"type":"content_block_stop","index":0}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":6}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
].join("\n")

function sseResponse(): Response {
  return new Response(SSE_BODY, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

async function postMessages(
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
  secret = SECRET,
): Promise<Response> {
  return await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      [LAUNCH_SECRET_HEADER]: secret,
      "x-claude-code-session-id": SESSION_ID,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })
}

const LEAD_BODY = {
  model: "opus",
  max_tokens: 64,
  messages: [{ role: "user", content: "say hello" }],
}

let dir: string
let savedBaseUrl: string | undefined
let savedLedger: string | undefined
let savedFetch: typeof globalThis.fetch
let savedToken: string | undefined
let savedModels: typeof state.models
let stub: Stub | undefined

beforeEach(async () => {
  __resetAicLedgerForTests()
  clearLaunchRegistry()
  configureLocalEgress({})

  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-router-local-e2e-"))
  savedBaseUrl = process.env.GH_ROUTER_LOCAL_BASE_URL
  savedLedger = process.env.GH_ROUTER_AIC_LEDGER
  process.env.GH_ROUTER_AIC_LEDGER = path.join(dir, "ledger.json")

  savedFetch = globalThis.fetch
  savedToken = state.copilotToken
  savedModels = state.models

  registerLaunch({ profileId: "local", nonce: NONCE, secret: SECRET })
})

afterEach(async () => {
  stub?.stop()
  stub = undefined

  globalThis.fetch = savedFetch
  state.copilotToken = savedToken
  state.models = savedModels

  clearLaunchRegistry()
  configureLocalEgress({})
  __resetAicLedgerForTests()
  if (savedBaseUrl === undefined) delete process.env.GH_ROUTER_LOCAL_BASE_URL
  else process.env.GH_ROUTER_LOCAL_BASE_URL = savedBaseUrl
  if (savedLedger === undefined) delete process.env.GH_ROUTER_AIC_LEDGER
  else process.env.GH_ROUTER_AIC_LEDGER = savedLedger
  await fs.rm(dir, { recursive: true, force: true })
})

describe("local profile egress", () => {
  test("a non-streaming turn round-trips through the endpoint untouched", async () => {
    stub = startStub(() => jsonMessage("hello from the local server"))
    process.env.GH_ROUTER_LOCAL_BASE_URL = stub.baseUrl

    // Give any launch-time reachability check the chance to fire. The profile
    // must never issue one, so this is a real assertion, not a formality.
    await new Promise((r) => setTimeout(r, 50))
    expect(stub.seen).toHaveLength(0)

    const response = await postMessages(LEAD_BODY)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      content: Array<{ type: string; text: string }>
    }
    expect(body.content[0]?.text).toBe("hello from the local server")

    // Exactly the client's own call — no probe, no second internal request.
    expect(stub.seen).toHaveLength(1)
    const forwarded = stub.seen[0]!
    expect(forwarded.method).toBe("POST")
    expect(forwarded.path).toBe("/v1/messages")

    // The model id is the raw tier id, never a Copilot slug. `resolveModel`
    // would rewrite `opus` to `claude-opus-5.5`; the local server's own id
    // must win.
    expect(forwarded.body?.model).toBe("opus")

    // The session id the local server requires, taken from the client.
    expect(forwarded.headers["x-claude-code-session-id"]).toBe(SESSION_ID)

    // No credential or Copilot identity may leak to an endpoint the operator
    // merely pointed us at.
    expect(forwarded.headers["authorization"]).toBeUndefined()
    expect(forwarded.headers["copilot-integration-id"]).toBeUndefined()
    expect(forwarded.headers["editor-version"]).toBeUndefined()
    expect(forwarded.headers["x-initiator"]).toBeUndefined()
    expect(forwarded.headers["x-interaction-id"]).toBeUndefined()
  })

  test("counts exactly one zero-cost request even when the endpoint reports usage", async () => {
    stub = startStub(() => jsonMessage("ok"))
    process.env.GH_ROUTER_LOCAL_BASE_URL = stub.baseUrl
    // A local turn needs no Copilot credential at all.
    state.copilotToken = ""

    const response = await postMessages(LEAD_BODY)
    expect(response.status).toBe(200)

    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.totalNanoAiu).toBe(0)
    expect(snap.perModel.opus).toEqual({ nanoAiu: 0, requests: 1 })
    // The raw id, never the resolved Copilot slug.
    expect(snap.perModel["claude-opus-5.5"]).toBeUndefined()
  })

  test("a streaming turn relays the endpoint's own SSE bytes", async () => {
    stub = startStub(sseResponse)
    process.env.GH_ROUTER_LOCAL_BASE_URL = stub.baseUrl

    const response = await postMessages(
      { ...LEAD_BODY, stream: true },
      { accept: "text/event-stream" },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")

    const text = await response.text()
    expect(text).toContain("event: message_start")
    expect(text).toContain('"model":"opus"')
    expect(text).toContain("hello from the local server")
    expect(text).toContain("event: message_stop")

    expect(stub.seen).toHaveLength(1)
    expect(stub.seen[0]?.body?.stream).toBe(true)
    expect(stub.seen[0]?.body?.model).toBe("opus")
    expect(stub.seen[0]?.headers["x-claude-code-session-id"]).toBe(SESSION_ID)

    // The streaming tap is skipped on the local path, so the priced block the
    // stub invents never reaches the ledger.
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.totalNanoAiu).toBe(0)
  })

  test("the client's own anthropic-beta is forwarded verbatim", async () => {
    stub = startStub(() => jsonMessage("ok"))
    process.env.GH_ROUTER_LOCAL_BASE_URL = stub.baseUrl

    await postMessages(LEAD_BODY, {
      // The second value is on no Copilot allowlist. The local profile filters
      // nothing, because it refuses to assume what the server supports.
      "anthropic-beta": "interleaved-thinking-2025-05-14,local-only-beta-2026-01-01",
    })

    expect(stub.seen[0]?.headers["anthropic-beta"]).toBe(
      "interleaved-thinking-2025-05-14,local-only-beta-2026-01-01",
    )
  })

  test("a non-local profile never reaches the local endpoint and is priced as before", async () => {
    stub = startStub(() => jsonMessage("should never be called"))
    process.env.GH_ROUTER_LOCAL_BASE_URL = stub.baseUrl
    clearLaunchRegistry()
    registerLaunch({ profileId: "standard", nonce: NONCE, secret: SECRET })

    state.copilotToken = "test-token"
    state.models = undefined

    // The proxy's own upstream call is what a standard launch makes; intercept
    // it so the test never touches the network.
    let copilotCalls = 0
    globalThis.fetch = Object.assign(
      () => {
        copilotCalls++
        return Promise.resolve(
          Response.json({
            id: "msg_copilot",
            type: "message",
            role: "assistant",
            model: "claude-opus-5.5",
            content: [{ type: "text", text: "from copilot" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 9, output_tokens: 2 },
            copilot_usage: { total_nano_aiu: 5_000_000, token_details: [] },
          }),
        )
      },
      { preconnect: () => {} },
    )

    const response = await postMessages(LEAD_BODY)
    expect(response.status).toBe(200)

    // The local endpoint saw nothing: a non-local profile keeps today's egress
    // exactly.
    expect(stub.seen).toHaveLength(0)
    expect(copilotCalls).toBe(1)

    // And the ledger is PRICED, not zero-recorded: the turn is worth the
    // credits the upstream reported, which is the opposite of the local path.
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.totalNanoAiu).toBe(5_000_000)
    expect(snap.perModel.opus?.nanoAiu).toBe(5_000_000)
  })
})
