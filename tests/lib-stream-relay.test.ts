import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test"
import consola from "consola"

import {
  buildAnthropicErrorEvent,
  buildOpenAIErrorEvent,
  logStreamError,
  peekAndRelay,
  relayAnthropicStream,
} from "../src/lib/stream-relay"

let originalError: typeof consola.error
let originalWarn: typeof consola.warn
let captured: { error: Array<unknown[]>; warn: Array<unknown[]> }

beforeEach(() => {
  originalError = consola.error
  originalWarn = consola.warn
  captured = { error: [], warn: [] }
  consola.error = mock((...args: Array<unknown>) => {
    captured.error.push(args)
  }) as unknown as typeof consola.error
  consola.warn = mock((...args: Array<unknown>) => {
    captured.warn.push(args)
  }) as unknown as typeof consola.warn
})

afterEach(() => {
  consola.error = originalError
  consola.warn = originalWarn
})

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let out = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) out += DECODER.decode(value, { stream: true })
  }
  return out
}

interface FakeChunkSpec {
  delayMs?: number
  bytes?: Uint8Array
  error?: Error
  done?: boolean
}

function makeUpstream(
  chunks: Array<FakeChunkSpec>,
  counters?: { reads: number },
): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (counters) counters.reads += 1
      if (i >= chunks.length) {
        controller.close()
        return
      }
      const spec = chunks[i++]!
      if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs))
      if (spec.error) {
        controller.error(spec.error)
        return
      }
      if (spec.done) {
        controller.close()
        return
      }
      if (spec.bytes) controller.enqueue(spec.bytes)
    },
  })
}

describe("peekAndRelay + relayAnthropicStream — happy path", () => {
  test("clean upstream pipes through unchanged and does not log", async () => {
    const upstream = makeUpstream([
      { bytes: ENCODER.encode("event: message_start\ndata: {}\n\n") },
      { bytes: ENCODER.encode("event: message_stop\ndata: {}\n\n") },
    ])

    const wrapped = await peekAndRelay(upstream, "/v1/messages")
    const out = await collect(wrapped)

    expect(out).toBe(
      "event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n",
    )
    expect(captured.error.length).toBe(0)
  })
})

describe("peekAndRelay — pre-byte error path", () => {
  test("upstream errors on first read → peekAndRelay rejects (handler will route via forwardError)", async () => {
    const upstream = makeUpstream([
      { error: Object.assign(new TypeError("terminated"), {}) },
    ])

    let thrown: unknown
    try {
      await peekAndRelay(upstream, "/v1/messages")
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(TypeError)
    expect((thrown as Error).message).toBe("terminated")
  })

  test("upstream returns done immediately → peekAndRelay throws empty-stream error", async () => {
    const upstream = makeUpstream([{ done: true }])

    let thrown: unknown
    try {
      await peekAndRelay(upstream, "/v1/messages")
    } catch (err) {
      thrown = err
    }
    expect((thrown as Error).message).toContain("empty SSE stream")
    expect((thrown as Error).message).toContain("/v1/messages")
  })
})

describe("relayAnthropicStream — mid-stream error path", () => {
  test("upstream errors after several chunks → emits event:error and logs bytes-relayed", async () => {
    const upstream = makeUpstream([
      { bytes: ENCODER.encode("event: a\ndata: 1\n\n") },
      { error: new TypeError("terminated") },
    ])
    const wrapped = await peekAndRelay(upstream, "/v1/messages")
    const out = await collect(wrapped)

    expect(out).toContain("event: a")
    expect(out).toContain("event: error")
    expect(out).toContain('"type":"api_error"')
    expect(out).toContain("terminated")

    expect(captured.error.length).toBe(1)
    const log = String(captured.error[0]?.[0] ?? "")
    expect(log).toContain("/v1/messages")
    expect(log).toContain("errType=TypeError")
    expect(log).toMatch(/bytes=\d+/)
  })
})

describe("relayAnthropicStream — inactivity timeout", () => {
  test("upstream stalls past inactivityTimeoutMs → emits InactivityTimeout error event", async () => {
    // First chunk is sent immediately (peeked). Second never arrives.
    const upstream = makeUpstream([
      { bytes: ENCODER.encode("event: msg\ndata: 1\n\n") },
      // No more chunks; pull() awaits forever
      { delayMs: 5000 },
    ])
    const wrapped = await peekAndRelay(upstream, "/v1/messages", 100)
    const out = await collect(wrapped)

    expect(out).toContain("event: msg")
    expect(out).toContain("event: error")
    expect(out).toContain("upstream_inactive")
    expect(out).toContain('"type":"request_canceled"')
    expect(captured.error.length).toBe(1)
    const log = String(captured.error[0]?.[0] ?? "")
    expect(log).toContain("errType=InactivityTimeout")
  })
})

describe("relayAnthropicStream — concurrent cancel", () => {
  test("consumer cancels mid-stream → wrapper propagates cancel to upstream reader", async () => {
    let cancelCalled = false
    const upstream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(ENCODER.encode("event: a\ndata: 1\n\n"))
        await new Promise((r) => setTimeout(r, 200))
        controller.enqueue(ENCODER.encode("event: b\ndata: 2\n\n"))
      },
      cancel() {
        cancelCalled = true
      },
    })

    const wrapped = await peekAndRelay(upstream, "/v1/messages")
    const reader = wrapped.getReader()
    const first = await reader.read()
    expect(DECODER.decode(first.value)).toContain("event: a")
    await reader.cancel("test-cancel")
    expect(cancelCalled).toBe(true)
  })
})

describe("relayAnthropicStream — backpressure (pull-based)", () => {
  test("slow consumer keeps upstream read invocations bounded", async () => {
    // Construct an upstream of 50 quick chunks. Consumer reads with a 10ms
    // delay between reads. After consuming N chunks, we expect upstream pulls
    // to be ≤ N + 2 (one for peek, possibly one buffered ahead).
    const counters = { reads: 0 }
    const chunks: Array<FakeChunkSpec> = []
    for (let i = 0; i < 50; i++) {
      chunks.push({ bytes: ENCODER.encode(`event: ${i}\ndata: ${i}\n\n`) })
    }
    const upstream = makeUpstream(chunks, counters)
    const wrapped = await peekAndRelay(upstream, "/v1/messages")
    const reader = wrapped.getReader()

    let consumed = 0
    while (consumed < 5) {
      const { done } = await reader.read()
      if (done) break
      consumed += 1
      await new Promise((r) => setTimeout(r, 10))
    }
    await reader.cancel()

    // Upstream should NOT have been fully drained eagerly. With highWaterMark=1,
    // pull is called once at startup and once per consumer demand.
    expect(counters.reads).toBeLessThan(15)
  })
})

describe("buildAnthropicErrorEvent", () => {
  test("emits well-formed Anthropic SSE event with api_error type", () => {
    const event = buildAnthropicErrorEvent("TypeError", "terminated")
    expect(event.startsWith("event: error\ndata: ")).toBe(true)
    expect(event.endsWith("\n\n")).toBe(true)
    const dataLine = event.split("\n")[1]?.replace("data: ", "") ?? ""
    const parsed = JSON.parse(dataLine) as {
      type: string
      error: { type: string; message: string }
    }
    expect(parsed.type).toBe("error")
    expect(parsed.error.type).toBe("api_error")
    expect(parsed.error.message).toContain("terminated")
  })

  test("classifies AbortError and InactivityTimeout as request_canceled", () => {
    for (const errName of ["AbortError", "InactivityTimeout"]) {
      const event = buildAnthropicErrorEvent(errName, "x")
      const dataLine = event.split("\n")[1]?.replace("data: ", "") ?? ""
      const parsed = JSON.parse(dataLine) as { error: { type: string } }
      expect(parsed.error.type).toBe("request_canceled")
    }
  })
})

describe("buildOpenAIErrorEvent", () => {
  test("emits well-formed OpenAI SSE event followed by [DONE] terminator", () => {
    const event = buildOpenAIErrorEvent("TypeError", "terminated")
    expect(event).toContain("data: ")
    expect(event).toContain('"error"')
    expect(event).toContain("data: [DONE]\n\n")
    const firstData = event.split("\n\n")[0]?.replace("data: ", "") ?? ""
    const parsed = JSON.parse(firstData) as {
      error: { type: string; message: string }
    }
    expect(parsed.error.type).toBe("api_error")
    expect(parsed.error.message).toContain("terminated")
  })
})

describe("logStreamError", () => {
  test("logs structured details and returns errName/errMessage", () => {
    const result = logStreamError(
      "/v1/chat/completions",
      new TypeError("fetch failed"),
    )
    expect(result.errName).toBe("TypeError")
    expect(result.errMessage).toBe("fetch failed")
    expect(captured.error.length).toBe(1)
    const log = String(captured.error[0]?.[0] ?? "")
    expect(log).toContain("/v1/chat/completions")
    expect(log).toContain("errType=TypeError")
  })
})

describe("relayAnthropicStream — direct invocation (low-level)", () => {
  test("preserves the firstChunk argument as the first emitted bytes", async () => {
    const upstream = makeUpstream([
      { bytes: ENCODER.encode("second\n") },
      { done: true },
    ])
    const reader = upstream.getReader()
    const wrapped = relayAnthropicStream(
      reader as unknown as Parameters<typeof relayAnthropicStream>[0],
      ENCODER.encode("first\n"),
      { routePath: "/v1/messages", inactivityTimeoutMs: 1000 },
    )
    const out = await collect(wrapped)
    expect(out).toBe("first\nsecond\n")
  })
})
