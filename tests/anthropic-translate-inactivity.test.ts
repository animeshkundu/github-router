// Inactivity-timeout coverage for the Anthropic-translation shim.
//
// The shim (`src/lib/anthropic-translate/`) runs Claude Code's main loop on
// non-Claude Copilot models. Every OTHER streaming path in the proxy wraps its
// upstream reads in `readIteratorWithTimeout` (chat-completions/handler.ts:155,
// responses/handler.ts:139), but the shim had NO timeout of any kind. Combined
// with `UPSTREAM_FETCH_TIMEOUT_MS` defaulting to 0 (disabled, port.ts), an
// upstream that holds the socket open but stops emitting froze the user's main
// agent loop FOREVER on `github-router claude -m gpt-5.6-sol`.
//
// These tests pin the fix AND the two ways a naive `Promise.race` fix breaks:
//   1. the abandoned `events.next()` must not surface as an unhandled rejection
//      (it would crash the process under Node's --unhandled-rejections=throw);
//   2. the generator must be `return()`ed and the upstream aborted, or the
//      fetch leaks for the life of the process.
//
// A stall is distinguished from slow-but-alive: a generator that keeps yielding
// under the deadline must NOT be truncated, because long-reasoning models
// legitimately stream for many minutes.

import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  anthropicSseStreamFromEvents,
  makeContentBlockStart,
  makeMessageStart,
  makeTextDelta,
  type AnthropicStreamEvent,
} from "~/lib/anthropic-translate/anthropic-sse"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Collect unhandled rejections so a detached `next()` throw is provable. */
let unhandled: unknown[] = []
const onUnhandled = (err: unknown) => {
  unhandled.push(err)
}
beforeEach(() => {
  unhandled = []
  process.on("unhandledRejection", onUnhandled)
})
afterEach(() => {
  process.off("unhandledRejection", onUnhandled)
})

/**
 * A generator that emits a preamble then STALLS forever — the exact upstream
 * behavior that hung the shim.
 *
 * `abortSignal` models the real egress generators: both consume the upstream
 * via `for await (const evt of upstream)` over a fetch wired to the caller's
 * AbortController (`create-responses.ts:57`, `create-chat-completions.ts`), so
 * aborting makes the pending read throw and the generator's `finally` runs.
 * That abort — NOT `return()` — is what actually releases a stalled generator:
 * `return()` queues behind the never-settling `await` and its `finally` cannot
 * run until the await itself settles (verified directly against the runtime).
 */
function stallingGen(hooks?: {
  onReturn?: () => void
  stallRejectsAfterMs?: number
  abortSignal?: AbortSignal
}): AsyncGenerator<AnthropicStreamEvent> {
  return (async function* () {
    try {
      yield makeMessageStart("msg_stall", "gpt-5.6-sol")
      yield makeContentBlockStart(0, { type: "text", text: "" })
      // Hang until aborted. Optionally reject later, simulating an upstream
      // socket error arriving AFTER the timeout gave up on this read.
      await new Promise((_resolve, reject) => {
        if (hooks?.stallRejectsAfterMs !== undefined) {
          setTimeout(
            () => reject(new Error("upstream socket reset")),
            hooks.stallRejectsAfterMs,
          ).unref?.()
        }
        hooks?.abortSignal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        )
      })
    } finally {
      hooks?.onReturn?.()
    }
  })()
}

/** Slow but genuinely progressing — must never be truncated. */
function slowButAliveGen(
  chunks: number,
  delayMs: number,
): AsyncGenerator<AnthropicStreamEvent> {
  return (async function* () {
    yield makeMessageStart("msg_slow", "gpt-5.6-sol")
    yield makeContentBlockStart(0, { type: "text", text: "" })
    for (let i = 0; i < chunks; i++) {
      await sleep(delayMs)
      yield makeTextDelta(0, `chunk-${i}`)
    }
  })()
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder()
  let out = ""
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += dec.decode(value, { stream: true })
  }
  return out
}

test("stalled upstream terminates with an error event instead of hanging forever", async () => {
  const gen = stallingGen()
  const stream = anthropicSseStreamFromEvents(gen, {
    routePath: "/v1/messages",
    inactivityTimeoutMs: 50,
  })

  // Without the fix this never settles; the test times out instead of failing.
  const text = await Promise.race([
    drain(stream),
    sleep(4000).then(() => "TIMED_OUT_STREAM_NEVER_ENDED"),
  ])

  expect(text).not.toBe("TIMED_OUT_STREAM_NEVER_ENDED")
  // Preamble was delivered, then a terminal error frame.
  expect(text).toContain("event: message_start\n")
  expect(text).toContain("event: error\n")
})

test("timeout aborts upstream and runs the generator's finally (no leaked fetch)", async () => {
  let torndown = false
  const aborter = new AbortController()
  const gen = stallingGen({
    onReturn: () => (torndown = true),
    abortSignal: aborter.signal,
  })
  const stream = anthropicSseStreamFromEvents(gen, {
    routePath: "/v1/messages",
    inactivityTimeoutMs: 50,
    // Exactly how both shim paths wire it (index.ts:149,261).
    onCancel: () => aborter.abort(),
  })

  await drain(stream)
  await sleep(50)

  // The abort is the load-bearing half: it makes the generator's pending
  // upstream read throw, which runs its finally and releases the fetch. Had
  // the timeout path skipped onCancel, this fetch would leak for the life of
  // the process.
  expect(aborter.signal.aborted).toBe(true)
  expect(torndown).toBe(true)
})

test("a late rejection from the abandoned read does not become an unhandled rejection", async () => {
  // The read the timeout gave up on rejects 100ms later. A bare Promise.race
  // leaves that promise unhandled -> process crash under Node 24.
  const gen = stallingGen({ stallRejectsAfterMs: 100 })
  const stream = anthropicSseStreamFromEvents(gen, {
    routePath: "/v1/messages",
    inactivityTimeoutMs: 30,
  })

  await drain(stream)
  await sleep(250) // let the late rejection land

  expect(unhandled).toEqual([])
})

test("slow-but-progressing stream is NOT truncated", async () => {
  // Each chunk arrives well inside the deadline; the total run far exceeds it.
  const gen = slowButAliveGen(12, 20) // ~240ms total, 100ms deadline per read
  const stream = anthropicSseStreamFromEvents(gen, {
    routePath: "/v1/messages",
    inactivityTimeoutMs: 100,
  })

  const text = await drain(stream)

  expect(text).not.toContain("event: error\n")
  for (let i = 0; i < 12; i++) expect(text).toContain(`chunk-${i}`)
})

test("no timeout configured keeps the previous unbounded behavior for slow streams", async () => {
  // Back-compat: callers that pass no timeout must behave exactly as before.
  const gen = slowButAliveGen(5, 10)
  const stream = anthropicSseStreamFromEvents(gen, { routePath: "/v1/messages" })
  const text = await drain(stream)
  expect(text).not.toContain("event: error\n")
  expect(text).toContain("chunk-4")
})
