// The local egress on `createMessages` / `countTokens`.
//
// The local profiles forward the lead's Anthropic Messages traffic to an
// operator-run server, so the properties that matter are the ones a
// mis-implementation would silently break: the URL, the ABSENCE of every
// Copilot header (sending them would leak a live credential to an endpoint the
// operator merely pointed us at), the presence of the session id the server
// requires, and that omitting the option leaves today's Copilot call
// byte-identical.

import { afterEach, describe, expect, mock, test } from "bun:test"

import { state } from "~/lib/state"
import { createMessages, countTokens } from "~/services/copilot/create-messages"

const originalFetch = globalThis.fetch
const originalToken = state.copilotToken

afterEach(() => {
  globalThis.fetch = originalFetch
  state.copilotToken = originalToken
})

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      type: "message",
      id: "msg_local",
      role: "assistant",
      model: "opus",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    }),
  )
}

function capture(): {
  url: () => string
  headers: () => Record<string, string>
} {
  let url = ""
  let headers: Record<string, string> = {}
  const fetchMock = mock((u: string, opts: { headers: Record<string, string> }) => {
    url = u
    headers = opts.headers
    return Promise.resolve(okResponse())
  })
  // @ts-expect-error - override fetch
  globalThis.fetch = fetchMock
  return { url: () => url, headers: () => headers }
}

const EGRESS = {
  baseUrl: "http://localhost:11111/v1",
  sessionId: "conversation-abc",
}

describe("createMessages local egress", () => {
  test("posts to the local /messages URL, with no beta query", async () => {
    const seen = capture()
    await createMessages('{"model":"opus","messages":[]}', undefined, undefined, false, EGRESS)
    expect(seen.url()).toBe("http://localhost:11111/v1/messages")
    expect(seen.url()).not.toContain("beta=true")
  })

  test("sends only the headers a local server may see", async () => {
    const seen = capture()
    await createMessages('{}', undefined, undefined, false, EGRESS)
    const headers = seen.headers()

    expect(headers["content-type"]).toBe("application/json")
    expect(headers["x-claude-code-session-id"]).toBe("conversation-abc")
    expect(headers["anthropic-version"]).toBe("2023-06-01")

    // Nothing Copilot-specific, and above all no credential.
    expect(headers.Authorization).toBeUndefined()
    expect(headers["copilot-integration-id"]).toBeUndefined()
    expect(headers["editor-version"]).toBeUndefined()
    expect(headers["user-agent"]).toBeUndefined()
    expect(headers["x-interaction-type"]).toBeUndefined()
    expect(headers["X-Initiator"]).toBeUndefined()
  })

  test("the client's own anthropic-beta and -version win", async () => {
    const seen = capture()
    await createMessages(
      "{}",
      { "anthropic-beta": "prompt-caching-2024-07-31", "anthropic-version": "2024-01-01" },
      undefined,
      false,
      EGRESS,
    )
    expect(seen.headers()["anthropic-beta"]).toBe("prompt-caching-2024-07-31")
    expect(seen.headers()["anthropic-version"]).toBe("2024-01-01")
  })

  test("a local call needs no Copilot token", async () => {
    state.copilotToken = ""
    capture()
    await expect(
      createMessages('{"model":"opus","messages":[]}', undefined, undefined, false, EGRESS),
    ).resolves.toBeInstanceOf(Response)
  })

  test("a non-local call still requires the Copilot token", async () => {
    state.copilotToken = ""
    capture()
    await expect(createMessages("{}")).rejects.toThrow(/Copilot token not found/)
  })

  test("without the local option the Copilot URL and headers are unchanged", async () => {
    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.0.0"
    state.accountType = "individual"
    const seen = capture()
    await createMessages("{}")
    expect(seen.url()).toContain("/v1/messages?beta=true")
    expect(seen.headers().Authorization).toBe("Bearer test-token")
    expect(seen.headers()["copilot-integration-id"]).toBe("vscode-chat")
  })
})

describe("countTokens local egress", () => {
  test("posts to the local count_tokens URL with the session id", async () => {
    const seen = capture()
    await countTokens('{"model":"opus","messages":[]}', undefined, undefined, false, EGRESS)
    expect(seen.url()).toBe("http://localhost:11111/v1/messages/count_tokens")
    expect(seen.headers()["x-claude-code-session-id"]).toBe("conversation-abc")
    expect(seen.headers().Authorization).toBeUndefined()
  })

  test("without the local option the Copilot count_tokens URL is unchanged", async () => {
    state.copilotToken = "test-token"
    const seen = capture()
    await countTokens("{}")
    expect(seen.url()).toContain("/v1/messages/count_tokens?beta=true")
    expect(seen.headers().Authorization).toBe("Bearer test-token")
  })
})
