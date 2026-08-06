// Upstream-teardown coverage for the synthesized Anthropic SSE surface.
//
// The defect: the stall branch tore the upstream down (`onCancel` to abort the
// fetch + `events.return()` to drive the generator's `finally`, commented
// "Skipping this leaks the fetch"), and the `catch` branch immediately below
// it did NEITHER. Since `UPSTREAM_FETCH_TIMEOUT_MS` defaults to 0 (disabled by
// design), a translation/serialization throw leaked that socket for the life
// of the process.
//
// The fix routes all three premature-end paths (stall, error, consumer cancel)
// through one idempotent `teardownUpstream()`. The dangerous way to write that
// is an unconditional `finally` around `pull` — it re-enters per chunk, so it
// would abort the upstream on every SUCCESSFUL chunk, and aborting a completed
// fetch destroys the socket instead of returning it to the keep-alive pool.
// Hence the success-path test below, which is the one that catches that.

import { expect, test } from "bun:test"

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

/** Drain a stream to completion, returning the decoded body. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) out += dec.decode(value, { stream: true })
  }
  return out + dec.decode()
}

test("a mid-stream throw tears the upstream down exactly once", async () => {
  // Counting, not just observing: the teardown must be idempotent, so a
  // boolean would hide a double-abort.
  let cancelCalls = 0
  let returnCalls = 0

  const gen = (async function* (): AsyncGenerator<AnthropicStreamEvent> {
    try {
      yield makeMessageStart("msg_throw", "gpt-5.5")
      yield makeContentBlockStart(0, { type: "text", text: "" })
      yield makeTextDelta(0, "partial")
      // Stand-in for any non-socket failure: a translation/IR bug, a
      // serialization throw. Before the fix this path leaked the fetch.
      throw new Error("translation exploded")
    } finally {
      returnCalls += 1
    }
  })()

  const stream = anthropicSseStreamFromEvents(gen, {
    routePath: "/v1/messages",
    onCancel: () => {
      cancelCalls += 1
    },
  })

  const body = await drain(stream)

  // The consumer still gets a terminal error event (unchanged behavior).
  expect(body).toContain("event: error")
  expect(body).toContain("translation exploded")

  // The regression: both halves ran, and exactly once each. `onCancel` aborts
  // the upstream fetch; the generator's `finally` releases its reader.
  expect(cancelCalls).toBe(1)
  expect(returnCalls).toBe(1)
})

test("a fully-consumed stream does NOT tear the upstream down", async () => {
  // The guard against the tempting-but-wrong fix. `pull` re-enters per chunk,
  // so an unconditional `finally` would fire `onCancel` on every successful
  // chunk — and aborting an AbortController whose fetch already completed
  // DESTROYS the socket rather than returning it to the keep-alive pool. Every
  // successful turn would then pay a fresh TLS handshake, proxy-wide.
  let cancelCalls = 0

  const gen = (async function* (): AsyncGenerator<AnthropicStreamEvent> {
    yield makeMessageStart("msg_ok", "gpt-5.5")
    yield makeContentBlockStart(0, { type: "text", text: "" })
    for (let i = 0; i < 5; i++) yield makeTextDelta(0, `chunk-${i}`)
    yield makeContentBlockStop(0)
    yield makeMessageDelta("end_turn", null, { output_tokens: 5 })
    yield makeMessageStop()
  })()

  const stream = anthropicSseStreamFromEvents(gen, {
    routePath: "/v1/messages",
    onCancel: () => {
      cancelCalls += 1
    },
  })

  const body = await drain(stream)

  // Sanity: the whole stream really did arrive (otherwise "no teardown" would
  // be trivially true because nothing ran).
  expect(body).toContain("event: message_start")
  expect(body).toContain("chunk-4")
  expect(body).toContain("event: message_stop")

  // The assertion that matters.
  expect(cancelCalls).toBe(0)
})

test("teardown is idempotent across cancel after an error", async () => {
  // Two premature-end paths racing: the generator throws, and the consumer
  // then cancels. `tornDown` must collapse them to one teardown.
  let cancelCalls = 0

  const gen = (async function* (): AsyncGenerator<AnthropicStreamEvent> {
    yield makeMessageStart("msg_both", "gpt-5.5")
    throw new Error("boom")
  })()

  const stream = anthropicSseStreamFromEvents(gen, {
    routePath: "/v1/messages",
    onCancel: () => {
      cancelCalls += 1
    },
  })

  const reader = stream.getReader()
  await reader.read() // message_start
  await reader.read() // drives the throw → error event
  // Cancel AFTER the error path already tore down.
  await reader.cancel("client went away")

  expect(cancelCalls).toBe(1)
})

test("a stalled upstream still tears down exactly once", async () => {
  // Regression guard on the branch that was already correct, now that it
  // shares the closure with the two that were not.
  let cancelCalls = 0
  let returnCalls = 0

  const gen = (async function* (): AsyncGenerator<AnthropicStreamEvent> {
    try {
      yield makeMessageStart("msg_stall", "gpt-5.5")
      // Never settles: the inactivity clock is the only thing that ends this.
      await new Promise<never>(() => {})
      yield makeMessageStop()
    } finally {
      returnCalls += 1
    }
  })()

  const stream = anthropicSseStreamFromEvents(gen, {
    routePath: "/v1/messages",
    inactivityTimeoutMs: 30,
    onCancel: () => {
      cancelCalls += 1
    },
  })

  const body = await drain(stream)
  expect(body).toContain("event: error")
  expect(body).toContain("Upstream stalled")
  expect(cancelCalls).toBe(1)
  // `returnCalls` is deliberately NOT asserted as 1 here. The generator is
  // parked on a never-settling await, and `events.return()` queues BEHIND that
  // await — so its `finally` cannot run until something makes the pending read
  // settle. In production `onCancel` does that by aborting the real upstream
  // fetch; this fixture has no fetch to abort, so the generator legitimately
  // stays parked. That asymmetry is precisely why `onCancel` is the
  // load-bearing half and `return()` alone would be insufficient, which the
  // source comment states. Asserting 1 here would be asserting a property of
  // the fixture, not of the code.
  expect(returnCalls).toBe(0)
})

test("onCancel aborting the upstream is what releases a parked generator", async () => {
  // The production mechanism the previous test cannot show with an inert
  // fixture: a generator suspended on a real abortable wait. `return()` alone
  // queues behind that wait; `onCancel` is what makes it settle. This models
  // the shim's actual shape (an AbortController owned by the caller and wired
  // into `onCancel`) so the ordering is asserted, not assumed.
  const aborter = new AbortController()
  let returnCalls = 0

  const gen = (async function* (): AsyncGenerator<AnthropicStreamEvent> {
    try {
      yield makeMessageStart("msg_parked", "gpt-5.5")
      // Settles only on abort — exactly like a pending upstream read.
      await new Promise<void>((resolve) => {
        aborter.signal.addEventListener("abort", () => resolve(), { once: true })
      })
      yield makeMessageStop()
    } finally {
      returnCalls += 1
    }
  })()

  const stream = anthropicSseStreamFromEvents(gen, {
    routePath: "/v1/messages",
    inactivityTimeoutMs: 30,
    onCancel: () => aborter.abort(),
  })

  const body = await drain(stream)
  expect(body).toContain("Upstream stalled")
  expect(aborter.signal.aborted).toBe(true)

  // The generator resumes on the abort and runs its `finally`. Yield to the
  // microtask queue so that resumption lands before we assert.
  await new Promise((r) => setTimeout(r, 10))
  expect(returnCalls).toBe(1)
})
