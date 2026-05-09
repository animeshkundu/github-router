import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test"
import consola from "consola"

import {
  buildAnthropicErrorEvent,
  buildOpenAIErrorEvent,
  isControllerClosedError,
  logStreamError,
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

describe("relayAnthropicStream — happy path", () => {
  test("clean upstream pipes through unchanged and does not log", async () => {
    const upstream = makeUpstream([
      { bytes: ENCODER.encode("event: message_start\ndata: {}\n\n") },
      { bytes: ENCODER.encode("event: message_stop\ndata: {}\n\n") },
    ])

    const wrapped = relayAnthropicStream(upstream, { routePath: "/v1/messages" })
    const out = await collect(wrapped)

    expect(out).toBe(
      "event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n",
    )
    expect(captured.error.length).toBe(0)
  })
})

describe("relayAnthropicStream — pre-byte error path", () => {
  test("upstream errors on first read → emits event:error and closes (no JSON-fallback path needed)", async () => {
    const upstream = makeUpstream([{ error: new TypeError("terminated") }])

    const wrapped = relayAnthropicStream(upstream, { routePath: "/v1/messages" })
    const out = await collect(wrapped)

    expect(out).toContain("event: error")
    expect(out).toContain("terminated")
    expect(out).toContain('"type":"api_error"')
    expect(captured.error.length).toBe(1)
    expect(String(captured.error[0]?.[0] ?? "")).toContain("bytes=0")
  })

  test("upstream returns done immediately → emits empty stream cleanly (no error)", async () => {
    const upstream = makeUpstream([{ done: true }])
    const wrapped = relayAnthropicStream(upstream, { routePath: "/v1/messages" })
    const out = await collect(wrapped)

    expect(out).toBe("")
    expect(captured.error.length).toBe(0)
  })
})

describe("relayAnthropicStream — mid-stream error path", () => {
  test("upstream errors after several chunks → emits event:error and logs bytes-relayed", async () => {
    const upstream = makeUpstream([
      { bytes: ENCODER.encode("event: a\ndata: 1\n\n") },
      { error: new TypeError("terminated") },
    ])
    const wrapped = relayAnthropicStream(upstream, { routePath: "/v1/messages" })
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
  test("upstream stalls past inactivityTimeoutMs → emits InactivityTimeout error event with timeout_error type", async () => {
    const upstream = makeUpstream([
      { bytes: ENCODER.encode("event: msg\ndata: 1\n\n") },
      { delayMs: 5000 },
    ])
    const wrapped = relayAnthropicStream(upstream, {
      routePath: "/v1/messages",
      inactivityTimeoutMs: 100,
    })
    const out = await collect(wrapped)

    expect(out).toContain("event: msg")
    expect(out).toContain("event: error")
    expect(out).toContain("upstream_inactive")
    expect(out).toContain('"type":"timeout_error"')
    expect(captured.error.length).toBe(1)
    const log = String(captured.error[0]?.[0] ?? "")
    expect(log).toContain("errType=InactivityTimeout")
  })
})

describe("relayAnthropicStream — unhandled-rejection sentinel (Node 24 crash regression)", () => {
  test("100 high-pressure timeout iterations produce zero unhandled rejections", async () => {
    const unhandled: Array<unknown> = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)

    try {
      // Each iteration: upstream yields one chunk fast, then never yields
      // again. With inactivityTimeoutMs=10, the timer fires; with the chunk
      // arriving quickly, there's a tight race between reader.read() and
      // setTimeout. Without `timeoutPromise.catch(() => {})`, this leaks
      // unhandled rejections under Node 24's default --unhandled-rejections=throw.
      for (let i = 0; i < 100; i++) {
        const upstream = makeUpstream([
          { bytes: ENCODER.encode(`event: ${i}\ndata: ${i}\n\n`) },
          { delayMs: 1000 },
        ])
        const wrapped = relayAnthropicStream(upstream, {
          routePath: "/v1/messages",
          inactivityTimeoutMs: 10,
        })
        await collect(wrapped)
      }

      // Drain microtasks so any pending unhandled rejections fire.
      await new Promise((r) => setTimeout(r, 50))
      expect(unhandled.length).toBe(0)
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
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

    const wrapped = relayAnthropicStream(upstream, { routePath: "/v1/messages" })
    const reader = wrapped.getReader()
    const first = await reader.read()
    expect(DECODER.decode(first.value)).toContain("event: a")
    await reader.cancel("test-cancel")
    expect(cancelCalled).toBe(true)
  })
})

describe("relayAnthropicStream — backpressure (pull-based)", () => {
  test("slow consumer keeps upstream read invocations bounded", async () => {
    const counters = { reads: 0 }
    const chunks: Array<FakeChunkSpec> = []
    for (let i = 0; i < 50; i++) {
      chunks.push({ bytes: ENCODER.encode(`event: ${i}\ndata: ${i}\n\n`) })
    }
    const upstream = makeUpstream(chunks, counters)
    const wrapped = relayAnthropicStream(upstream, { routePath: "/v1/messages" })
    const reader = wrapped.getReader()

    let consumed = 0
    while (consumed < 5) {
      const { done } = await reader.read()
      if (done) break
      consumed += 1
      await new Promise((r) => setTimeout(r, 10))
    }
    await reader.cancel()

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

  test("classifies AbortError and InactivityTimeout as documented timeout_error", () => {
    for (const errName of ["AbortError", "InactivityTimeout"]) {
      const event = buildAnthropicErrorEvent(errName, "x")
      const dataLine = event.split("\n")[1]?.replace("data: ", "") ?? ""
      const parsed = JSON.parse(dataLine) as { error: { type: string } }
      expect(parsed.error.type).toBe("timeout_error")
    }
  })

  test("never emits the non-canonical request_canceled type", () => {
    for (const name of ["AbortError", "InactivityTimeout", "TypeError", "Error"]) {
      const event = buildAnthropicErrorEvent(name, "x")
      expect(event).not.toContain("request_canceled")
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

describe("isControllerClosedError", () => {
  test("recognizes Bun's 'Controller is already closed' message", () => {
    expect(
      isControllerClosedError(
        new TypeError("Invalid state: Controller is already closed"),
      ),
    ).toBe(true)
  })

  test("recognizes other 'closed/closing/errored' WHATWG variants", () => {
    for (const msg of [
      "The stream is closing",
      "ReadableStream is closed",
      "Cannot enqueue: ReadableStream is already closed",
      "Controller is already errored",
      "stream is closed",
    ]) {
      expect(isControllerClosedError(new TypeError(msg))).toBe(true)
    }
  })

  test("does NOT match unrelated errors", () => {
    for (const e of [
      new TypeError("terminated"),
      new Error("upstream_inactive"),
      Object.assign(new Error("aborted"), { name: "AbortError" }),
      new Error("fetch failed"),
      "string error",
      undefined,
      null,
    ]) {
      expect(isControllerClosedError(e as unknown)).toBe(false)
    }
  })
})

describe("relayAnthropicStream — consumer-cancel race (the live regression)", () => {
  test("consumer cancels mid-stream → no spurious error log when next pull would have raced", async () => {
    // Production scenario: pull() has read a chunk and is about to enqueue;
    // meanwhile the consumer cancelled. Before the fix the catch path
    // logged "Upstream stream interrupted" and tried to enqueue an error
    // event (which also threw and may have corrupted terminal wire bytes,
    // surfacing as "JSON Parse error: Expected ':' before value" in
    // Claude Code). After the fix: detected as consumer-cancel, silent.
    let upstreamCancelCalled = false
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(ENCODER.encode("event: a\ndata: 1\n\n"))
      },
      cancel() {
        upstreamCancelCalled = true
      },
    })

    const wrapped = relayAnthropicStream(upstream, { routePath: "/v1/messages" })
    const reader = wrapped.getReader()
    const first = await reader.read()
    expect(DECODER.decode(first.value)).toContain("event: a")

    // Cancel — this sets consumerCancelled=true and propagates to upstream.
    await reader.cancel("test-cancel")
    expect(upstreamCancelCalled).toBe(true)

    // Critical: no error log, no warn — consumer cancel is normal.
    expect(captured.error.length).toBe(0)
    expect(captured.warn.length).toBe(0)
  })

  test("upstream errors with controller-closed-family message → silent recovery (no event:error spam)", async () => {
    // Pathological upstream: yields one chunk on first pull, then throws
    // a controller-closed-family error on the second pull. Wrapper must
    // recognize the family and bail without logging or emitting event:error
    // (which would itself fail and possibly corrupt the wire).
    let firstPull = true
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (firstPull) {
          firstPull = false
          controller.enqueue(ENCODER.encode("event: a\ndata: 1\n\n"))
          return
        }
        controller.error(
          new TypeError("Invalid state: Controller is already closed"),
        )
      },
    })

    const wrapped = relayAnthropicStream(upstream, { routePath: "/v1/messages" })
    const out = await collect(wrapped)

    expect(out).toContain("event: a")
    // No event:error appended — wrapper recognized the controller-closed
    // family and bailed silently.
    expect(out).not.toContain("event: error")
    expect(captured.error.length).toBe(0)
    expect(captured.warn.length).toBe(0)
  })
})
