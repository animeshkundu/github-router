import { test, expect, mock, afterEach } from "bun:test"

import { server } from "../src/server"
import { state } from "../src/lib/state"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>

const originalFetch = globalThis.fetch

function resetState() {
  state.accountType = "individual"
  state.copilotToken = "token"
  state.githubToken = "gh"
  state.vsCodeVersion = "1.0.0"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.showToken = false
  state.models = { object: "list", data: [] }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

const compactRequestBody = {
  model: "gpt-5.3-codex",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi!" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Summarize our chat" }] },
  ],
  instructions: "You are a helpful assistant.",
}

test("forwards response when Copilot returns 200", async () => {
  resetState()

  const copilotResponse = {
    id: "resp_native_compact",
    object: "response.compaction",
    created_at: 1700000000,
    output: [{ type: "compaction", encrypted_content: "gAAAA..." }],
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  }

  const fetchMock = mock((url: string) => {
    if (typeof url === "string" && url.endsWith("/responses/compact")) {
      return new Response(JSON.stringify(copilotResponse))
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  const response = await server.request("/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(compactRequestBody),
  })

  expect(response.status).toBe(200)
  const body = (await response.json()) as AnyRecord
  expect(body.id).toBe("resp_native_compact")
  expect(body.object).toBe("response.compaction")
  expect(body.output[0].type).toBe("compaction")
})

test("performs synthetic compaction when Copilot returns 404", async () => {
  resetState()

  let syntheticRequestBody: string | undefined

  const fetchMock = mock((url: string, opts?: { body?: string }) => {
    if (typeof url === "string" && url.endsWith("/responses/compact")) {
      return new Response("404 page not found", { status: 404 })
    }
    if (typeof url === "string" && url.endsWith("/responses")) {
      syntheticRequestBody = opts?.body
      return new Response(
        JSON.stringify({
          id: "resp_synth",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Summary: user greeted, assistant responded." }],
            },
          ],
          usage: { input_tokens: 50, output_tokens: 30, total_tokens: 80 },
        }),
      )
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  const response = await server.request("/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(compactRequestBody),
  })

  expect(response.status).toBe(200)
  const body = (await response.json()) as AnyRecord

  // Verify compact response envelope
  expect(body.object).toBe("response.compaction")
  expect(body.id).toMatch(/^resp_compact_/)
  expect(typeof body.created_at).toBe("number")
  expect(body.usage).toBeDefined()

  // Verify output contains model's summary
  expect(body.output).toHaveLength(1)
  expect(body.output[0].type).toBe("message")
  expect(body.output[0].role).toBe("assistant")

  // Verify the synthetic /responses call included the compaction prompt
  expect(syntheticRequestBody).toBeDefined()
  const parsedBody = JSON.parse(syntheticRequestBody!)
  expect(parsedBody.stream).toBe(false)
  expect(parsedBody.store).toBe(false)
  expect(parsedBody.model).toBe("gpt-5.3-codex")
  expect(parsedBody.instructions).toBe("You are a helpful assistant.")
  // Last input item should be the compaction prompt
  const lastInput = parsedBody.input.at(-1)
  expect(lastInput.role).toBe("user")
  expect(lastInput.content[0].text).toContain("CONTEXT CHECKPOINT COMPACTION")
})

test("throws error when Copilot returns 500", async () => {
  resetState()

  const fetchMock = mock((url: string) => {
    if (typeof url === "string" && url.endsWith("/responses/compact")) {
      return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 })
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  const response = await server.request("/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(compactRequestBody),
  })

  // forwardError converts HTTPError to a JSON error response
  expect(response.status).toBe(500)
  const body = (await response.json()) as AnyRecord
  expect(body.error).toBeDefined()
})

test("synthetic compact preserves original input items", async () => {
  resetState()

  let capturedInput: Array<Record<string, unknown>> | undefined

  const fetchMock = mock((url: string, opts?: { body?: string }) => {
    if (typeof url === "string" && url.endsWith("/responses/compact")) {
      return new Response("not found", { status: 404 })
    }
    if (typeof url === "string" && url.endsWith("/responses")) {
      const parsed = JSON.parse(opts?.body ?? "{}")
      capturedInput = parsed.input
      return new Response(
        JSON.stringify({
          id: "resp_synth",
          object: "response",
          status: "completed",
          output: [],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
      )
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  await server.request("/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(compactRequestBody),
  })

  // Original 3 input items + 1 compaction prompt = 4 items
  expect(capturedInput).toHaveLength(4)
  // First 3 are the original input items
  expect(capturedInput![0]).toEqual(compactRequestBody.input[0])
  expect(capturedInput![1]).toEqual(compactRequestBody.input[1])
  expect(capturedInput![2]).toEqual(compactRequestBody.input[2])
})

test("returns error when synthetic /responses call fails", async () => {
  resetState()

  const fetchMock = mock((url: string) => {
    if (typeof url === "string" && url.endsWith("/responses/compact")) {
      return new Response("not found", { status: 404 })
    }
    if (typeof url === "string" && url.endsWith("/responses")) {
      return new Response(JSON.stringify({ error: "server error" }), { status: 500 })
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  const response = await server.request("/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(compactRequestBody),
  })

  expect(response.status).toBe(500)
  const body = (await response.json()) as AnyRecord
  expect(body.error).toBeDefined()
})
