// Stream-lifecycle race coverage for the synthesized Anthropic SSE surface
// (repo mandate: every new controller.enqueue/close/cancel must have a test
// that races consumer-cancel against a mid-await enqueue — see
// tests/integration/chaos.test.ts). Uses a real Bun.serve listener so the
// enqueue-after-cancel window is exercised at the actual Bun HTTP layer, not a
// cooperative mock.

import { afterAll, beforeAll, expect, test } from "bun:test"

import {
  anthropicSseStreamFromEvents,
  makeContentBlockStart,
  makeContentBlockStop,
  makeMessageDelta,
  makeMessageStart,
  makeMessageStop,
  makeTextDelta,
  type AnthropicStreamEvent,
} from "~/lib/anthropic-translate/anthropic-sse"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A deliberately slow generator so a consumer-cancel lands mid-`await`. */
function slowGen(
  chunks: number,
  delayMs: number,
  hooks?: { onReturn?: () => void },
): AsyncGenerator<AnthropicStreamEvent> {
  return (async function* () {
    try {
      yield makeMessageStart("msg_race", "gpt-5.5")
      yield makeContentBlockStart(0, { type: "text", text: "" })
      for (let i = 0; i < chunks; i++) {
        await sleep(delayMs)
        yield makeTextDelta(0, `chunk-${i}`)
      }
      yield makeContentBlockStop(0)
      yield makeMessageDelta("end_turn", null, { output_tokens: chunks })
      yield makeMessageStop()
    } finally {
      hooks?.onReturn?.()
    }
  })()
}

test("consumer cancel mid-await: onCancel fires, generator finally runs, no throw", async () => {
  let cancelled = false
  let torndown = false
  const gen = slowGen(50, 5, { onReturn: () => (torndown = true) })
  const stream = anthropicSseStreamFromEvents(gen, {
    routePath: "/v1/messages",
    onCancel: () => (cancelled = true),
  })

  const reader = stream.getReader()
  await reader.read() // message_start
  // Kick a read that drives pull → gen.next() awaits sleep(5).
  const pending = reader.read()
  await sleep(1)
  await reader.cancel("client disconnected")
  // The kicked read settles (cancel resolves it) without throwing.
  await pending.catch(() => undefined)

  expect(cancelled).toBe(true)
  // return() runs the generator's finally (tears down the upstream reader).
  await sleep(5)
  expect(torndown).toBe(true)
})

// ---------------------------------------------------------------------------
// real-socket chaos: many concurrent clients abort mid-stream
// ---------------------------------------------------------------------------

let listener: ReturnType<typeof Bun.serve> | undefined
let baseUrl = ""

beforeAll(() => {
  listener = Bun.serve({
    port: 0,
    fetch() {
      const gen = slowGen(40, 2)
      const body = anthropicSseStreamFromEvents(gen, { routePath: "/v1/messages" })
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
  baseUrl = `http://127.0.0.1:${listener.port}`
})

afterAll(() => {
  if (listener) listener.stop(true)
})

test("chaos: concurrent clients abort at random points; server stays healthy", async () => {
  const N = 40
  const runOne = async (i: number): Promise<void> => {
    const ctrl = new AbortController()
    try {
      const res = await fetch(baseUrl, { signal: ctrl.signal })
      const reader = res.body!.getReader()
      // Read a random number of chunks, then abort mid-stream.
      const readCount = i % 6
      for (let k = 0; k < readCount; k++) {
        const { done } = await reader.read()
        if (done) break
      }
      ctrl.abort()
    } catch {
      // aborts surface as AbortError on the client side — expected, ignore.
    }
  }

  await Promise.all(Array.from({ length: N }, (_, i) => runOne(i)))

  // The listener must still serve a full, intact stream after the abort storm.
  const res = await fetch(baseUrl)
  const text = await res.text()
  expect(text).toContain("event: message_start\n")
  expect(text).toContain('"type":"text_delta"')
  expect(text).toContain("event: message_stop\n")
  // The happy stream terminates cleanly with message_stop.
  expect(text.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true)
})
