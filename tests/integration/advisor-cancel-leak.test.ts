/**
 * Regression test for the `buildAdvisorStream` consumer-cancel leak
 * in `src/services/advisor/advisor.ts` (Bug #2).
 *
 * The bug: the returned ReadableStream had only `start(controller)`
 * and no `cancel(reason)`. When a consumer disconnected mid-stream,
 * `safeEnqueueEvent` started returning `false`, but the outer turn
 * loop (`for (turnsRun = 0; turnsRun < ADVISOR_MAX_TURNS; ...)`)
 * had no cancel check between turns. If `advisorToolUse` had been
 * set this turn, the loop fired `runAdvisor()` (an expensive xhigh
 * `/responses` call) AND `createMessages()` (continuation) before
 * starting the next `processOneTurn`. Up to ~16 leaked upstream
 * calls per cancelled request.
 *
 * The fix:
 *   1. Add `cancel(reason)` to the ReadableStream init dict.
 *   2. Maintain an internal AbortController; thread its signal into
 *      `runAdvisor`, `createMessages`, and `createResponses` via
 *      their `callerSignal` parameter.
 *   3. Gate the turn loop with `signal.aborted` checks at the top of
 *      every iteration AND immediately after each await point.
 *   4. On cancel, abort the controller and null out the conversation
 *      reference (GC the accumulated tool_result text).
 *
 * Test pattern uses a real Bun.serve listener so consumer-cancel
 * propagates through the actual HTTP layer (per CLAUDE.md "Stream
 * lifecycle" gate). It cancels the inbound `/v1/messages` request
 * after the first advisor block is emitted and asserts:
 *   - the second `/v1/messages` continuation call is NEVER made
 *   - the `/responses` advisor call is NEVER made after cancel
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { server } from "../../src/server"
import { state } from "../../src/lib/state"
import { ADVISOR_INTERNAL_TOOL_NAME } from "../../src/services/advisor/advisor"

// `Bun.fetch` is Bun's native (sealed) fetch — unaffected by other
// test files that reassign `globalThis.fetch` at module top level
// (e.g. `tests/get-vscode-version.test.ts:10`). We use it for two
// purposes: (1) inside our mock to passthrough loopback
// `${baseUrl}/...` calls to the live listener, AND (2) so the
// test's own outer request doesn't recursively trigger our mock.
const realFetch: typeof globalThis.fetch =
  Bun.fetch as unknown as typeof globalThis.fetch
let savedFetch: typeof globalThis.fetch | undefined
let listener: ReturnType<typeof Bun.serve> | undefined
let baseUrl = ""

function resetState() {
  state.accountType = "individual"
  state.copilotToken = "token"
  state.githubToken = "gh"
  state.vsCodeVersion = "1.0.0"
  state.copilotVersion = "0.43.0"
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        vendor: "Anthropic",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        object: "model",
        capabilities: {
          type: "chat",
          family: "claude-opus-4-7",
          object: "model_capabilities",
          tokenizer: "claude",
          limits: { max_output_tokens: 4096 },
          supports: {},
        },
        supported_endpoints: ["/v1/messages"],
      },
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        vendor: "OpenAI",
        version: "gpt-5.5",
        preview: true,
        model_picker_enabled: true,
        object: "model",
        capabilities: {
          type: "chat",
          family: "gpt-5",
          object: "model_capabilities",
          tokenizer: "o200k_base",
          limits: { max_context_window_tokens: 200_000 },
          supports: {},
        },
        supported_endpoints: ["/v1/responses"],
      },
    ],
  }
}

beforeAll(() => {
  resetState()
  savedFetch = globalThis.fetch
  listener = Bun.serve({ port: 0, fetch: server.fetch })
  baseUrl = `http://127.0.0.1:${listener.port}`
})

afterAll(() => {
  if (savedFetch) globalThis.fetch = savedFetch
  if (listener) listener.stop(true)
})

afterEach(() => {
  if (savedFetch) globalThis.fetch = savedFetch
})

/**
 * Build an SSE response body with the events given. Each event is
 * emitted with a small delay so the consumer has time to read the
 * advisor block before we cancel.
 */
function buildDelayedSseResponse(
  events: Array<{ event: string; data: unknown }>,
  perEventDelayMs: number,
): Response {
  const encoder = new TextEncoder()
  let i = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= events.length) {
        try {
          controller.close()
        } catch {
          /* already closed */
        }
        return
      }
      const ev = events[i]!
      const line = `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`
      try {
        controller.enqueue(encoder.encode(line))
      } catch {
        /* enqueue after close */
      }
      i++
      await new Promise((r) => setTimeout(r, perEventDelayMs))
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

test(
  "advisor stream consumer cancel mid-loop does NOT fire follow-up advisor / continuation calls",
  async () => {
    let copilotMessagesCallCount = 0
    let advisorResponsesCallCount = 0
    let messagesCallStartedAfterCancel = false
    let advisorCallStartedAfterCancel = false
    let cancelObservedAt = -1

    globalThis.fetch = mock((url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString()
      if (u.startsWith(baseUrl)) {
        // Loopback to our proxy — use Bun.fetch directly so the
        // passthrough is unaffected by other test files installing a
        // top-level globalThis.fetch override.
        return realFetch(url, init)
      }

      if (u.includes("/responses")) {
        advisorResponsesCallCount++
        if (cancelObservedAt > 0) advisorCallStartedAfterCancel = true
        // Slow advisor response — gives the abort signal time to fire
        // through the threaded callerSignal. The fix's signal-aware
        // `runAdvisor` should reject this fetch via AbortError before
        // it returns; pre-fix the advisor call ran to completion.
        return new Promise((resolve, reject) => {
          const sig = init?.signal
          const t = setTimeout(() => {
            resolve(
              new Response(
                JSON.stringify({
                  id: "advisor_resp",
                  object: "response",
                  status: "completed",
                  output: [
                    {
                      type: "message",
                      role: "assistant",
                      content: [
                        {
                          type: "output_text",
                          text: "Advisor reply.",
                        },
                      ],
                    },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1 },
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              ),
            )
          }, 500)
          if (sig) {
            sig.addEventListener("abort", () => {
              clearTimeout(t)
              reject(new DOMException("Aborted", "AbortError"))
            })
          }
        })
      }

      if (u.includes("/v1/messages") || u.includes("/messages")) {
        copilotMessagesCallCount++
        if (cancelObservedAt > 0) messagesCallStartedAfterCancel = true
        if (copilotMessagesCallCount === 1) {
          // First call: emit message_start + advisor tool_use block,
          // then HOLD the stream open by emitting the tool_use STOP
          // and a few "thinking" stub events with delay, so the
          // consumer has a chance to cancel between blocks. Per the
          // protocol the proxy doesn't forward message_stop while
          // an advisor block is in flight, so we don't emit it here.
          return buildDelayedSseResponse(
            [
              {
                event: "message_start",
                data: {
                  type: "message_start",
                  message: {
                    id: "m1",
                    type: "message",
                    role: "assistant",
                    model: "claude-opus-4-7",
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 1, output_tokens: 0 },
                  },
                },
              },
              {
                event: "content_block_start",
                data: {
                  type: "content_block_start",
                  index: 0,
                  content_block: {
                    type: "tool_use",
                    id: "toolu_advisor_1",
                    name: ADVISOR_INTERNAL_TOOL_NAME,
                    input: {},
                  },
                },
              },
              {
                event: "content_block_stop",
                data: { type: "content_block_stop", index: 0 },
              },
              {
                event: "message_stop",
                data: { type: "message_stop" },
              },
            ],
            // 30ms per event — fast enough to deliver the advisor
            // block, but lets the consumer get one chunk in and cancel.
            30,
          )
        }
        // Continuation call. Pre-fix this is reached after the advisor
        // call (which was made despite the consumer cancel). Post-fix
        // the loop bails after the cancel-aware advisor call rejects.
        return buildDelayedSseResponse(
          [
            {
              event: "message_start",
              data: {
                type: "message_start",
                message: {
                  id: "m2",
                  type: "message",
                  role: "assistant",
                  model: "claude-opus-4-7",
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              },
            },
            {
              event: "content_block_start",
              data: {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              },
            },
            {
              event: "content_block_delta",
              data: {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "continuation" },
              },
            },
            {
              event: "content_block_stop",
              data: { type: "content_block_stop", index: 0 },
            },
            { event: "message_stop", data: { type: "message_stop" } },
          ],
          5,
        )
      }
      return new Response("?", { status: 500 })
    }) as unknown as typeof globalThis.fetch

    // Fire the request through the proxy. The advisor-tool- beta
    // header opts into the advisor translate-loop.
    const ac = new AbortController()
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-beta": "advisor-tool-2026-03-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
      signal: ac.signal,
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    // Read until we see the server_tool_use{advisor} block — that's
    // our cue that the proxy has entered the advisor-detected branch
    // and is about to call runAdvisor.
    const decoder = new TextDecoder()
    let buffer = ""
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const { value, done } = await reader.read().catch(() => ({
        value: undefined,
        done: true,
      }))
      if (done) break
      if (value) buffer += decoder.decode(value, { stream: true })
      if (buffer.includes("server_tool_use")) break
    }
    // Sanity: we actually entered the advisor branch. If this fires
    // the fixture is broken — without an advisor branch we're not
    // testing the right code path.
    expect(buffer).toContain("server_tool_use")

    // CANCEL the request. The fix's `cancel(reason)` handler aborts
    // the internal AbortController, which:
    //   - rejects any in-flight runAdvisor /responses call,
    //   - prevents the continuation createMessages call from being
    //     dispatched (top-of-loop `signal.aborted` check fires),
    //   - GCs the accumulated `conversation` array.
    cancelObservedAt = Date.now()
    ac.abort()
    try {
      while (true) {
        const r = await reader.read()
        if (r.done) break
      }
    } catch {
      // expected
    }

    // Give the proxy a generous window to either bail (fix) or fire
    // the leaked calls (pre-fix). 1 second is well past the 500ms
    // advisor-mock latency and the proxy's mid-loop dispatches.
    await new Promise((r) => setTimeout(r, 1000))

    // Pre-fix: at least one of these is TRUE because the proxy
    // dispatched the advisor and/or continuation call AFTER the
    // consumer cancelled.
    // Post-fix: both are FALSE — the loop observed `signal.aborted`
    // and bailed before either dispatch.
    expect(advisorCallStartedAfterCancel).toBe(false)
    expect(messagesCallStartedAfterCancel).toBe(false)
    // Sanity: we DID enter the advisor branch — the first Copilot
    // call ran. If this fires it means our fixture broke the SSE
    // path that triggers the advisor detection.
    expect(copilotMessagesCallCount).toBeGreaterThanOrEqual(1)
    // Post-fix `advisorResponsesCallCount` MAY be 0 (cancel landed
    // before runAdvisor dispatched) or 1 (runAdvisor was already
    // in-flight and rejected via abort). Pre-fix it's always >= 1.
    // Both are valid for the post-fix path — the load-bearing
    // assertion is `*StartedAfterCancel === false`.
    expect(advisorResponsesCallCount).toBeGreaterThanOrEqual(0)
  },
  15_000,
)

describe("Bug D2 — initial createMessages response not cancellable", () => {
  test(
    "consumer cancel aborts the initial upstream fetch signal within 500ms",
    async () => {
      // Track the AbortSignal passed to the FIRST /v1/messages upstream call.
      // Pre-fix: createMessages is called with no callerSignal, so the only
      // signal is the 5-minute UPSTREAM_FETCH_TIMEOUT_MS timeout — consumer
      // cancel does NOT propagate. Post-fix: the handler passes the shared
      // advisorAborter.signal, so cancel() → aborter.abort() → initial
      // fetch signal fires.
      let initialFetchSignal: AbortSignal | undefined
      let initialFetchSignalAbortedAt: number | undefined

      globalThis.fetch = mock((url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString()
        if (u.startsWith(baseUrl)) {
          return realFetch(url, init)
        }

        if (u.includes("/v1/messages") || u.includes("/messages")) {
          if (!initialFetchSignal) {
            // First call — capture the signal and return a slow SSE stream
            // that delays 5s before emitting any events. This simulates an
            // upstream that's "thinking" (quiet body after headers).
            initialFetchSignal = init?.signal ?? undefined
            if (initialFetchSignal) {
              initialFetchSignal.addEventListener("abort", () => {
                if (!initialFetchSignalAbortedAt) {
                  initialFetchSignalAbortedAt = Date.now()
                }
              })
            }
            const encoder = new TextEncoder()
            let emitted = false
            const stream = new ReadableStream<Uint8Array>({
              async pull(controller) {
                if (emitted) {
                  // Hold the stream open indefinitely — the cancel should
                  // terminate us before we emit anything else.
                  await new Promise((r) => setTimeout(r, 5000))
                  try { controller.close() } catch { /* */ }
                  return
                }
                // Wait 5s before emitting the first event (simulates thinking).
                await new Promise((r) => setTimeout(r, 5000))
                emitted = true
                try {
                  controller.enqueue(
                    encoder.encode(
                      `event: message_start\ndata: ${JSON.stringify({
                        type: "message_start",
                        message: {
                          id: "m_slow",
                          type: "message",
                          role: "assistant",
                          model: "claude-opus-4-7",
                          content: [],
                          stop_reason: null,
                          stop_sequence: null,
                          usage: { input_tokens: 1, output_tokens: 0 },
                        },
                      })}\n\n`,
                    ),
                  )
                } catch { /* enqueue after close */ }
              },
            })
            return Promise.resolve(
              new Response(stream, {
                status: 200,
                headers: { "content-type": "text/event-stream" },
              }),
            )
          }
          // Should not reach a second call — the cancel should prevent
          // the advisor loop from making continuation calls.
          return new Response("unexpected", { status: 500 })
        }

        if (u.includes("/responses")) {
          // Advisor call — should not be reached in this test because
          // the initial response never emits an advisor tool_use block.
          return new Response("unexpected advisor", { status: 500 })
        }
        return new Response("?", { status: 500 })
      }) as unknown as typeof globalThis.fetch

      // Fire the advisor-enabled request.
      const ac = new AbortController()
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "anthropic-beta": "advisor-tool-2026-03-01",
        },
        body: JSON.stringify({
          model: "claude-opus-4-7",
          max_tokens: 100,
          messages: [{ role: "user", content: "slow initial test" }],
          stream: true,
        }),
        signal: ac.signal,
      })
      expect(res.status).toBe(200)

      // Start reading the body — it should be quiet (the upstream SSE
      // stream is waiting 5s before emitting).
      const reader = res.body!.getReader()
      const readPromise = reader.read().catch(() => ({ done: true, value: undefined }))

      // Wait 100ms, then cancel the consumer.
      await new Promise((r) => setTimeout(r, 100))
      const cancelTime = Date.now()
      ac.abort()
      await readPromise
      try {
        while (true) {
          const r = await reader.read()
          if (r.done) break
        }
      } catch {
        // expected after abort
      }

      // Give the abort propagation up to 500ms to reach the initial signal.
      const deadline = Date.now() + 500
      while (!initialFetchSignalAbortedAt && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }

      // CRITICAL assertion: the initial fetch signal was aborted.
      // Pre-fix: initialFetchSignal has no callerSignal from the handler,
      // so it only carries the 5-min timeout — cancel never reaches it.
      // Post-fix: the shared advisorAborter.signal propagates cancel.
      expect(initialFetchSignal).toBeDefined()
      expect(initialFetchSignalAbortedAt).toBeDefined()
      // The abort should have arrived within 500ms of the cancel time.
      expect(initialFetchSignalAbortedAt! - cancelTime).toBeLessThan(500)
    },
    15_000,
  )
})
