import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"
import { CLIENT_REDUNDANCY_MARKERS } from "../src/lib/tool-loop-guard"
import { server } from "../src/server"

const originalFetch = globalThis.fetch
let savedModels: typeof state.models

const MARKER = [...CLIENT_REDUNDANCY_MARKERS][0]!

/** Records upstream traffic so a test can assert nothing escaped the proxy. */
function installFetchMock(): { calls: number; bodies: Array<string> } {
  const record: { calls: number; bodies: Array<string> } = {
    calls: 0,
    bodies: [],
  }
  globalThis.fetch = Object.assign(
    mock(
      (
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ): Promise<Response> => {
        record.calls++
        record.bodies.push(typeof init?.body === "string" ? init.body : "")
        return Promise.resolve(new Response(JSON.stringify({ ok: true })))
      },
    ),
    { preconnect: () => {} },
  )
  return record
}

function anthropicLoopBody(repeats: number): string {
  const messages: Array<unknown> = [{ role: "user", content: "go" }]
  for (let i = 0; i < repeats; i++) {
    messages.push(
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `toolu_${i}`,
            name: "Read",
            input: { file_path: "a.js", offset: 250, limit: 100 },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: `toolu_${i}`, content: MARKER },
        ],
      },
    )
  }
  return JSON.stringify({ model: "claude-opus-4.7", max_tokens: 64, messages })
}

function chatLoopBody(repeats: number): string {
  const messages: Array<unknown> = [{ role: "user", content: "go" }]
  for (let i = 0; i < repeats; i++) {
    messages.push(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${i}`,
            type: "function",
            function: { name: "read", arguments: '{"path":"a.js"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: `call_${i}`, content: MARKER },
    )
  }
  return JSON.stringify({ model: "gpt-5.5", messages })
}

function responsesLoopInput(repeats: number): Array<unknown> {
  const input: Array<unknown> = []
  for (let i = 0; i < repeats; i++) {
    input.push(
      {
        type: "function_call",
        call_id: `fc_${i}`,
        name: "read",
        arguments: '{"path":"a.js"}',
      },
      { type: "function_call_output", call_id: `fc_${i}`, output: MARKER },
    )
  }
  return input
}

function post(path: string, body: string) {
  return server.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
}

beforeEach(() => {
  savedModels = state.models
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = savedModels
})

describe("loop guard at the route boundary", () => {
  test("/v1/messages aborts with the Anthropic envelope and calls no upstream", async () => {
    const record = installFetchMock()
    const response = await post("/v1/messages", anthropicLoopBody(7))

    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      type: string
      error: { type: string; message: string }
    }
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("github-router")
    // The whole point: the request never reaches the model.
    expect(record.calls).toBe(0)
  })

  test("every abort is marked non-retryable so the refusal cannot become a retry loop", async () => {
    // The proxy cannot kill a client's agent loop, only refuse. Claude Code's
    // `shouldRetry` consults `x-should-retry` BEFORE any status test, so this
    // header keeps the refusal terminal even if its retryable-status list
    // changes. Without it, a guard that stops a tool loop could start a retry
    // loop instead — the same bug wearing a different hat.
    installFetchMock()
    const cases: Array<[string, string]> = [
      ["/v1/messages", anthropicLoopBody(7)],
      ["/v1/chat/completions", chatLoopBody(7)],
      [
        "/v1/responses",
        JSON.stringify({ model: "gpt-5.5", input: responsesLoopInput(7) }),
      ],
    ]
    for (const [path, body] of cases) {
      const response = await post(path, body)
      expect(response.status).toBe(400)
      expect(response.headers.get("x-should-retry")).toBe("false")
    }
  })

  test("/v1/chat/completions aborts with the OpenAI envelope, not the Anthropic one", async () => {
    const record = installFetchMock()
    const response = await post("/v1/chat/completions", chatLoopBody(7))

    expect(response.status).toBe(400)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.error).toBeDefined()
    // An OpenAI-format client parses `{error:{...}}`; emitting the Anthropic
    // `{type:"error",...}` envelope here would be a compatibility regression.
    expect(body.type).toBeUndefined()
    expect(record.calls).toBe(0)
  })

  test("/v1/responses aborts with the OpenAI envelope", async () => {
    const record = installFetchMock()
    const response = await post(
      "/v1/responses",
      JSON.stringify({ model: "gpt-5.5", input: responsesLoopInput(7) }),
    )

    expect(response.status).toBe(400)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.error).toBeDefined()
    expect(body.type).toBeUndefined()
    expect(record.calls).toBe(0)
  })

  test("/v1/responses/compact is NEVER blocked, however long the loop", async () => {
    // Compaction is the client's own way out of a runaway history. Rejecting it
    // would remove the escape hatch instead of providing one.
    const record = installFetchMock()
    const response = await post(
      "/v1/responses/compact",
      JSON.stringify({ model: "gpt-5.5", input: responsesLoopInput(40) }),
    )

    expect(response.status).not.toBe(400)
    expect(record.calls).toBeGreaterThan(0)
  })

  test("a short run passes through to upstream untouched", async () => {
    const record = installFetchMock()
    const response = await post("/v1/messages", anthropicLoopBody(2))

    expect(response.status).not.toBe(400)
    expect(record.calls).toBe(1)
    // Below the nudge threshold nothing is injected, so the history upstream
    // sees still holds exactly the two turns the client sent.
    const sent = JSON.parse(record.bodies[0]!) as {
      messages: Array<{ role: string }>
    }
    expect(sent.messages).toHaveLength(5)
  })

  test("a nudged request still reaches upstream, carrying the extra block", async () => {
    const record = installFetchMock()
    const response = await post("/v1/messages", anthropicLoopBody(4))

    expect(response.status).not.toBe(400)
    expect(record.calls).toBe(1)
    const sent = JSON.parse(record.bodies[0]!) as {
      messages: Array<{ role: string; content: Array<{ type: string }> }>
    }
    const lastContent = sent.messages.at(-1)!.content
    expect(lastContent.at(-1)!.type).toBe("text")
    // The tool_result that preceded it is untouched.
    expect(lastContent.at(-2)!.type).toBe("tool_result")
  })
})
