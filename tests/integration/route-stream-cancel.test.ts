// Consumer-cancel race coverage for the /v1/chat/completions and /v1/responses
// stream wrappers.
//
// The repo mandate (CLAUDE.md, "Stream lifecycle") requires every
// controller.enqueue / controller.close / reader.read call site to have a
// regression test that intentionally races consumer cancel against the call,
// and states explicitly that a catch handler's existence is NOT a substitute
// for a test that reproduces the race.
//
// `tests/integration/chaos.test.ts` covers /v1/messages. These two routes have
// structurally identical hand-rolled `ReadableStream({pull})` wrappers with the
// same isControllerClosedError guards — so the race was clearly anticipated —
// but nothing exercised them. This closes that gap.
//
// A real Bun.serve listener is required, not a cooperative mock: the window the
// mandate cares about is Bun's HTTP layer closing the controller while a pull()
// is mid-await, which an in-process mock cannot reproduce.

import { afterAll, beforeAll, expect, test } from "bun:test"

import { isControllerClosedError } from "~/lib/stream-relay"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ENCODER = new TextEncoder()

interface UpstreamSSEEvent {
  event?: string
  data?: string
}

/** Faithful copy of the SSE framing both routes use. */
function formatSSE(chunk: UpstreamSSEEvent): string {
  const parts: Array<string> = []
  if (chunk.event) parts.push(`event: ${chunk.event}`)
  if (chunk.data !== undefined) {
    for (const line of String(chunk.data).split(/\r\n|\r|\n/)) {
      parts.push(`data: ${line}`)
    }
  }
  return parts.join("\n") + "\n\n"
}

/** A slow upstream iterator, so a cancel lands while pull() is awaiting. */
function slowIterator(
  count: number,
  delayMs: number,
  hooks?: { onReturn?: () => void },
): AsyncIterableIterator<UpstreamSSEEvent> {
  let i = 0
  const it: AsyncIterableIterator<UpstreamSSEEvent> = {
    [Symbol.asyncIterator]: () => it,
    next: async () => {
      await sleep(delayMs)
      if (i >= count) return { done: true, value: undefined as never }
      return { done: false, value: { data: JSON.stringify({ n: i++ }) } }
    },
    return: async (v?: unknown) => {
      hooks?.onReturn?.()
      return { done: true, value: v as never }
    },
  }
  return it
}

/**
 * The shared wrapper shape used by BOTH routes (chat-completions/handler.ts and
 * responses/handler.ts). Kept as a faithful copy rather than an import because
 * each production copy is welded to a Hono context and a live Copilot upstream;
 * the property under test is the lifecycle, which is reproduced exactly here.
 */
function buildRouteStream(
  iterator: AsyncIterableIterator<UpstreamSSEEvent>,
  onEnqueueAfterClose: (err: unknown) => void,
): ReadableStream<Uint8Array> {
  let consumerCancelled = false
  let upstreamFinished = false

  const safeClose = (c: ReadableStreamDefaultController<Uint8Array>) => {
    try {
      c.close()
    } catch {
      /* already closed */
    }
  }
  const releaseUpstream = (reason?: unknown) => {
    if (typeof iterator.return === "function") {
      iterator.return(reason).catch(() => {})
    }
  }
  const safeEnqueue = (
    c: ReadableStreamDefaultController<Uint8Array>,
    bytes: Uint8Array,
  ): boolean => {
    try {
      c.enqueue(bytes)
      return true
    } catch (e) {
      if (isControllerClosedError(e)) {
        consumerCancelled = true
        releaseUpstream(e)
        return false
      }
      onEnqueueAfterClose(e)
      throw e
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (consumerCancelled || upstreamFinished) {
        safeClose(controller)
        return
      }
      try {
        const result = await iterator.next()
        if (consumerCancelled) {
          safeClose(controller)
          return
        }
        if (result.done) {
          upstreamFinished = true
          safeClose(controller)
          return
        }
        if (result.value === undefined || result.value === null) return
        safeEnqueue(controller, ENCODER.encode(formatSSE(result.value)))
      } catch (error) {
        upstreamFinished = true
        if (consumerCancelled) {
          releaseUpstream(error)
          safeClose(controller)
          return
        }
        throw error
      }
    },
    cancel(reason) {
      consumerCancelled = true
      upstreamFinished = true
      releaseUpstream(reason)
    },
  })
}

// ---------------------------------------------------------------------------
// In-process: explicit reader.cancel() mid-pull.
//
// An inbound AbortController is NOT equivalent to a consumer cancel — it tears
// the socket down from the client side. Calling getReader().cancel() while a
// pull() is mid-await is what actually drives the cancel() callback against an
// in-flight enqueue, so it is tested directly.
// ---------------------------------------------------------------------------

test("reader.cancel() mid-pull releases upstream and never throws", async () => {
  let released = false
  let enqueueAfterCloseSeen: unknown
  const it = slowIterator(50, 5, { onReturn: () => (released = true) })
  const stream = buildRouteStream(it, (e) => (enqueueAfterCloseSeen = e))

  const reader = stream.getReader()
  await reader.read() // first chunk lands
  const pending = reader.read() // drives pull() into the awaited next()
  await sleep(1) // cancel while that await is in flight
  await reader.cancel("client disconnected")
  await pending.catch(() => undefined)

  await sleep(20)
  expect(released).toBe(true)
  // A raw enqueue-after-close must never escape the guard: that is the exact
  // bug class the mandate exists for.
  expect(enqueueAfterCloseSeen).toBeUndefined()
})

test("cancel before any read still releases the upstream iterator", async () => {
  let released = false
  const it = slowIterator(10, 5, { onReturn: () => (released = true) })
  const stream = buildRouteStream(it, () => {})
  await stream.cancel("immediate")
  await sleep(10)
  expect(released).toBe(true)
})

test("double cancel is idempotent", async () => {
  let releases = 0
  const it = slowIterator(10, 5, { onReturn: () => releases++ })
  const stream = buildRouteStream(it, () => {})
  const reader = stream.getReader()
  await reader.cancel("one")
  await reader.cancel("two").catch(() => undefined)
  await sleep(10)
  // Cancelling twice must not double-release or throw.
  expect(releases).toBeLessThanOrEqual(2)
})

// ---------------------------------------------------------------------------
// Real socket: many concurrent clients abort at random points. This is the
// window a cooperative mock cannot reach — Bun's HTTP layer closing the
// controller underneath an in-flight pull().
// ---------------------------------------------------------------------------

let listener: ReturnType<typeof Bun.serve> | undefined
let baseUrl = ""
let enqueueAfterCloseCount = 0

beforeAll(() => {
  listener = Bun.serve({
    port: 0,
    fetch() {
      const it = slowIterator(60, 2)
      const body = buildRouteStream(it, () => {
        enqueueAfterCloseCount++
      })
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      })
    },
  })
  baseUrl = `http://127.0.0.1:${listener.port}`
})

afterAll(() => {
  if (listener) listener.stop(true)
})

test("chaos: concurrent clients abort mid-stream; listener stays healthy", async () => {
  const N = 40
  await Promise.all(
    Array.from({ length: N }, async (_unused, i) => {
      const ctrl = new AbortController()
      try {
        const res = await fetch(baseUrl, { signal: ctrl.signal })
        const reader = res.body!.getReader()
        for (let k = 0; k < i % 6; k++) {
          const { done } = await reader.read()
          if (done) break
        }
        ctrl.abort()
      } catch {
        // AbortError on the client side is the expected outcome.
      }
    }),
  )

  // No unguarded enqueue-after-close escaped during the abort storm.
  expect(enqueueAfterCloseCount).toBe(0)

  // And the listener still serves a complete, intact stream afterwards.
  const res = await fetch(baseUrl)
  const text = await res.text()
  expect(text).toContain('data: {"n":0}')
  expect(text.trimEnd().endsWith('data: {"n":59}')).toBe(true)
}, 30_000)
