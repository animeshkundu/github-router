import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test"
import consola from "consola"

import { parseJsonOrDiagnose } from "../src/lib/diagnose-response"

let originalError: typeof consola.error
let captured: Array<unknown[]>

beforeEach(() => {
  originalError = consola.error
  captured = []
  consola.error = mock((...args: Array<unknown>) => {
    captured.push(args)
  }) as unknown as typeof consola.error
})

afterEach(() => {
  consola.error = originalError
})

describe("parseJsonOrDiagnose", () => {
  test("returns parsed JSON on success without logging", async () => {
    const response = new Response(JSON.stringify({ input_tokens: 42 }), {
      headers: { "content-type": "application/json" },
    })
    const result = await parseJsonOrDiagnose<{ input_tokens: number }>(
      response,
      "/v1/messages/count_tokens",
    )
    expect(result.input_tokens).toBe(42)
    expect(captured.length).toBe(0)
  })

  test("logs status, content-type, body preview, and re-throws when body is SSE", async () => {
    const sseBody =
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_x\"}}\n\n"
    const response = new Response(sseBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })

    let thrown: unknown
    try {
      await parseJsonOrDiagnose(response, "/v1/messages/count_tokens")
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(SyntaxError)
    expect(captured.length).toBe(1)
    const message = String(captured[0]?.[0] ?? "")
    expect(message).toContain("/v1/messages/count_tokens")
    expect(message).toContain("status=200")
    expect(message).toContain('content-type="text/event-stream"')
    expect(message).toContain("event: message_start")
  })

  test("truncates long bodies in preview", async () => {
    const longBody = "event: " + "x".repeat(500)
    const response = new Response(longBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })

    let thrown: unknown
    try {
      await parseJsonOrDiagnose(response, "/v1/messages")
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(SyntaxError)
    expect(captured.length).toBe(1)
    const message = String(captured[0]?.[0] ?? "")
    expect(message).toContain("...(truncated)")
  })

  test("handles missing content-type gracefully", async () => {
    const response = new Response("event: foo\n", { status: 502 })
    // strip default content-type so the helper sees null
    response.headers.delete("content-type")

    try {
      await parseJsonOrDiagnose(response, "/v1/messages")
    } catch {
      // expected
    }

    expect(captured.length).toBe(1)
    const message = String(captured[0]?.[0] ?? "")
    expect(message).toContain('content-type="(none)"')
    expect(message).toContain("status=502")
  })
})
