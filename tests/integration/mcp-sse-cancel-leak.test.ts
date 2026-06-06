/**
 * Regression test for the SSE-path consumer-cancel slot/heartbeat
 * leak in `src/routes/mcp/handler.ts:handleToolsCallSSE` (Bug #1).
 *
 * The bug: when an SSE consumer reader was cancelled mid-`tools/call`,
 * the `cancel()` handler aborted the registered AbortController but
 *   (a) did NOT clear the 5s heartbeat `setInterval` — the timer kept
 *       firing into a closed controller until `callPromise` settled
 *       (potentially the full UPSTREAM_FETCH_TIMEOUT_MS = ~5 min), AND
 *   (b) did NOT free the inflight slot synchronously — the slot stayed
 *       locked until `handleToolsCall`'s `finally` ran, which only
 *       happened after the upstream fetch unwound.
 *
 * For `web_search` specifically the situation was worse pre-fix:
 * `searchWeb()` didn't accept an AbortSignal, so the upstream MCP
 * fetches kept running to natural completion — the slot leaked for
 * the full upstream-call wall time on every cancel. Eight cancels in
 * five minutes saturated the cap=8 budget and stalled `/mcp` for
 * every other client.
 *
 * Test pattern follows `tests/integration/chaos.test.ts`:
 *   - real Bun.serve listener so consumer-cancel propagates through
 *     the actual HTTP layer (mock-fetch + app.request() does NOT
 *     reproduce the Bun request-signal quirk, per CLAUDE.md).
 *   - delayed upstream MCP responses (the slow-`pull` web_search
 *     pattern) so the cancel lands mid-flight.
 *   - consumer-side `reader.cancel()` after observing the heartbeat
 *     chunk → deterministically lands inside the upstream-call await
 *     window, the same race the chaos-test pattern targets.
 *
 * Assertions (must FAIL on the unfixed code path, PASS on the fix):
 *   1. `__getInFlightForTests()` returns 0 within 500ms of cancel.
 *      Pre-fix: stays at 1 until the upstream call settles (~slow).
 *   2. Number of heartbeat-interval ticks after cancel <= 1 (one
 *      already-scheduled tick can fire before clearInterval lands).
 *      Pre-fix: heartbeats keep firing until callPromise settles.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { server } from "../../src/server"
import { state } from "../../src/lib/state"
import {
  __getInFlightForTests,
  __resetInFlightForTests,
} from "../../src/routes/mcp/handler"
import type { ModelsResponse } from "../../src/services/copilot/get-models"

const NONCE = "0123456789abcdef".repeat(4)

const fakeModels: ModelsResponse = {
  object: "list",
  data: [
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

// `Bun.fetch` is Bun's native (sealed) fetch — unaffected by other
// test files that reassign `globalThis.fetch` at top level (e.g.
// `tests/get-vscode-version.test.ts:10`). We use it for two purposes:
// (1) inside our mock to passthrough loopback `${baseUrl}/...` calls
// to the live listener, AND (2) for the test's own outer request so
// we don't recursively invoke our own mock for the consumer-side
// connection. Without this the leak-detection assertions hit a stale
// mock chain and the upstream-call branch of the mock never runs.
const realFetch: typeof globalThis.fetch = Bun.fetch as unknown as typeof globalThis.fetch
let savedFetch: typeof globalThis.fetch | undefined
let listener: ReturnType<typeof Bun.serve> | undefined
let baseUrl = ""

function resetState() {
  state.peerMcpNonce = NONCE
  state.copilotToken = "token"
  state.githubToken = "gh"
  state.vsCodeVersion = "1.0.0"
  state.copilotVersion = "0.43.0"
  state.accountType = "individual"
  state.models = fakeModels
  __resetInFlightForTests()
}

beforeAll(async () => {
  resetState()
  savedFetch = globalThis.fetch
  listener = Bun.serve({ port: 0, fetch: server.fetch })
  baseUrl = `http://127.0.0.1:${listener.port}`
  // Drain searchWeb()'s module-global throttleTimestamps window
  // (MAX_SEARCHES_PER_SECOND = 3). Other tests in the suite (notably
  // `tests/web-search.test.ts`) run many searches in quick succession,
  // and the timestamps survive across test files because the module
  // is loaded once. Waiting 1.2s past startup ensures the next search
  // we make isn't artificially delayed by stale timestamps from prior
  // tests — keeps the tcStarted poll deadline reliable.
  await new Promise((r) => setTimeout(r, 1200))
})

afterAll(() => {
  if (savedFetch) globalThis.fetch = savedFetch
  state.peerMcpNonce = undefined
  state.models = undefined
  if (listener) listener.stop(true)
})

afterEach(() => {
  // Restore whatever `globalThis.fetch` was when our suite started.
  // Cannot use `Bun.fetch` here — it's a separate function from the
  // canonical `globalThis.fetch`, and some tests in the wider suite
  // capture `globalThis.fetch` themselves as a baseline. Restoring
  // to our `beforeAll` snapshot keeps the rest of the suite stable.
  if (savedFetch) globalThis.fetch = savedFetch
  __resetInFlightForTests()
})

beforeEach(() => {
  // Defensive reset — if a prior test in another file ran a tools/call
  // and the inflight slot leaked (or the global counter is being
  // shared, which it is via src/lib/mcp-inflight.ts), make sure each
  // of our tests starts from a known-zero baseline.
  __resetInFlightForTests()
})

/**
 * Build a fake upstream MCP `Response` for the `web_search` flow.
 * `searchWeb()` makes 3 sequential POSTs (initialize → notifications/
 * initialized → tools/call). The `tools/call` SSE stream is delayed
 * by `delayMs` — long enough that our consumer-cancel lands mid-call
 * but short enough not to time out the test.
 *
 * Tracks `aborted: true` when the upstream fetch's body reader is torn
 * down (proves the AbortSignal threaded all the way through).
 */
interface UpstreamTracker {
  tcStarted: boolean
  tcCompleted: boolean
  bodyAborted: boolean
}

function mockUpstreamMcp(
  tracker: UpstreamTracker,
  callBodyDelayMs: number,
): typeof globalThis.fetch {
  return mock(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString()
    if (u.startsWith(baseUrl)) {
      // Loopback to our proxy — pass through to Bun's native fetch
      // (NOT the globalThis snapshot, which may itself be a mock
      // installed by another test file in the suite). Using
      // `Bun.fetch` directly is the only reliable way to get the
      // unhooked native fetch across test-file boundaries.
      return realFetch(url, init)
    }
    const method = (init?.method ?? "GET").toUpperCase()
    if (method === "DELETE") {
      // Best-effort session teardown — return immediately.
      return new Response(null, { status: 204 })
    }
    let body: { method?: string; id?: number } = {}
    try {
      body = JSON.parse((init?.body as string) ?? "{}") as typeof body
    } catch {
      // ignore
    }
    if (body.method === "initialize") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2024-11-05", capabilities: {} },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "test-sid",
          },
        },
      )
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 })
    }
    if (body.method === "tools/call") {
      tracker.tcStarted = true
      // Slow SSE body — emits a single byte every callBodyDelayMs.
      // The fetch's AbortSignal (threaded through searchWeb's postMcp)
      // should tear down this body reader via `cancel()` when the
      // outer MCP cancel fires.
      const inner = {
        text: { value: "search content", annotations: [] },
      }
      const payload =
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(inner) }],
          },
        })}\n\n`
      const bytes = new TextEncoder().encode(payload)
      const sig = init?.signal
      // Fast pre-aborted reject path — fetch normally throws AbortError
      // synchronously when signal is already aborted before dispatch.
      if (sig?.aborted) {
        throw new DOMException("Aborted", "AbortError")
      }
      let i = 0
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          // Honor abort mid-stream — what undici/Bun do when the
          // fetch's AbortSignal fires. We `controller.error` the body
          // (NOT controller.close) so the consumer's
          // for-await-of/iterator rejects with an AbortError, matching
          // real undici behavior. Without this the mock body keeps
          // happily emitting bytes past the abort, defeating the test.
          if (sig?.aborted) {
            tracker.bodyAborted = true
            try {
              controller.error(new DOMException("Aborted", "AbortError"))
            } catch {
              /* already errored/closed */
            }
            return
          }
          if (i >= bytes.length) {
            tracker.tcCompleted = true
            try {
              controller.close()
            } catch {
              /* already closed */
            }
            return
          }
          try {
            controller.enqueue(bytes.subarray(i, i + 1))
            i++
            await new Promise((r) => setTimeout(r, callBodyDelayMs))
          } catch {
            /* enqueue after close */
          }
        },
        cancel() {
          tracker.bodyAborted = true
        },
      })
      // Also expose the abort signal to consumer-driven cleanup. Real
      // undici attaches its own listener and calls reader.cancel()
      // internally; in the mock we just record bodyAborted so the
      // outer assertion has something to check even if `pull` happens
      // to be idle (it might not run again post-abort).
      if (sig) {
        sig.addEventListener("abort", () => {
          tracker.bodyAborted = true
        })
      }
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    }
    return new Response("unexpected", { status: 500 })
  }) as unknown as typeof globalThis.fetch
}

describe("MCP SSE cancel — slot + heartbeat leak regression", () => {
  test(
    "consumer cancel mid web search frees inflight slot within 500ms (was: leaked for full upstream wall time)",
    async () => {
      const tracker: UpstreamTracker = {
        tcStarted: false,
        tcCompleted: false,
        bodyAborted: false,
      }
      // 30 ms per byte × hundreds of bytes = several seconds of work —
      // long enough that the cancel deterministically lands mid-call.
      globalThis.fetch = mockUpstreamMcp(tracker, 30)

      // Establish baseline.
      expect(__getInFlightForTests()).toBe(0)

      // Hit /mcp tools/call for the `web` tool (the search MCP's
      // web-search entry; renamed from `web_search` in the five-server
      // split) with SSE Accept so the handleToolsCallSSE path runs. AbortController on the fetch
      // request is the most reliable way to trigger the server-side
      // ReadableStream.cancel() callback under Bun.serve — bare
      // reader.cancel() can fail to propagate through the HTTP
      // layer in time, but signal.abort() reliably tears down the
      // socket and fires the server-side cancel synchronously.
      const ac = new AbortController()
      const reqBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 9001,
        method: "tools/call",
        params: {
          name: "web",
          arguments: { query: "test query" },
        },
      })
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${NONCE}`,
          host: `127.0.0.1:${listener!.port}`,
        },
        body: reqBody,
        signal: ac.signal,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("text/event-stream")
      const reader = res.body!.getReader()
      // Read first chunk (the initial heartbeat) — proves the SSE
      // controller is open and handleToolsCallSSE has started.
      const first = await reader.read()
      expect(first.done).toBe(false)
      expect(new TextDecoder().decode(first.value)).toContain(
        "notifications/progress",
      )

      // The slot was acquired before the SSE start() was even invoked
      // (handleToolsCall runs synchronously up to its first await), so
      // we should see 1 inflight right now.
      expect(__getInFlightForTests()).toBe(1)
      // Wait for the upstream initialize call to actually start.
      // searchWeb()'s `throttleSearch()` uses a module-global timestamps
      // array — if other tests in the suite ran web_search recently, our
      // call can be throttled up to ~1s. Generous deadline accommodates
      // that without slowing the happy path.
      const tcDeadline = Date.now() + 1500
      while (Date.now() < tcDeadline && !tracker.tcStarted) {
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(tracker.tcStarted).toBe(true)

      // Abort the HTTP request — this tears down the TCP socket which
      // fires the SSE ReadableStream's cancel() callback on the
      // server side. Pre-fix the cancel() handler signalled the
      // AbortController but did NOT release the slot synchronously,
      // so the slot stayed locked until handleToolsCall's `finally`
      // ran — which only happens after the upstream fetch unwinds.
      ac.abort()
      // Drain whatever the reader has buffered until the abort
      // propagates (this throws AbortError — that's the expected path).
      try {
        while (true) {
          const r = await reader.read()
          if (r.done) break
        }
      } catch {
        // AbortError on next read is the expected path.
      }

      // Poll briefly for the slot to drain. Post-fix this is immediate
      // (cancelInflight() calls release() synchronously from inside
      // the SSE cancel handler). Pre-fix this never happens within the
      // window because the upstream MCP call keeps running (and
      // without the AbortSignal threading the call ignores the abort
      // entirely).
      const deadline = Date.now() + 1500
      while (Date.now() < deadline && __getInFlightForTests() !== 0) {
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(__getInFlightForTests()).toBe(0)

      // Belt-and-braces: the upstream body reader should also tear down
      // (proves the AbortSignal threaded through searchWeb → postMcp →
      // fetch). The signal-listener in the mock invokes stream.cancel()
      // which sets tracker.bodyAborted. Pre-fix: searchWeb ignored the
      // signal entirely, so the upstream stream ran to natural
      // completion and bodyAborted was never set within the window.
      const abortDeadline = Date.now() + 500
      while (Date.now() < abortDeadline && !tracker.bodyAborted) {
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(tracker.bodyAborted).toBe(true)
    },
    10_000,
  )

  test(
    "SSE cancel clears the heartbeat interval synchronously (was: clearInterval only ran in start() finally, deferred until callPromise settled)",
    async () => {
      // The pre-fix bug: heartbeatHandle was a `const` local to
      // `start()`, only cleared in start()'s `finally` AFTER the
      // upstream callPromise resolved. With the upstream blocked on
      // ~UPSTREAM_FETCH_TIMEOUT_MS (~5 min) — or even just a few
      // seconds — the 5-second interval kept ticking into a closed
      // controller until the upstream call unwound.
      //
      // We intercept setInterval/clearInterval and track BOTH the
      // SSE-heartbeat handle (delay = 5000ms, matches the constant in
      // handler.ts:SSE_HEARTBEAT_INTERVAL_MS) and whether
      // clearInterval(handle) was called within a tight window after
      // the consumer cancel.
      const originalSetInterval = globalThis.setInterval
      const originalClearInterval = globalThis.clearInterval
      // Loosely typed handle — Bun's `Timer` and Node's `Timeout`
      // disagree on shape, but they're both returned by setInterval
      // and accepted by clearInterval interchangeably.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type Handle = any
      const intervals: Array<{
        handle: Handle
        delayMs: number
        clearedAt: number
      }> = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(globalThis as any).setInterval = ((fn: () => void, ms?: number, ...rest: Array<unknown>) => {
        const handle = originalSetInterval(fn, ms, ...rest)
        intervals.push({ handle, delayMs: ms ?? 0, clearedAt: -1 })
        return handle
      }) as unknown as typeof setInterval
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(globalThis as any).clearInterval = ((handle?: Handle) => {
        const entry = intervals.find((it) => it.handle === handle)
        if (entry && entry.clearedAt === -1) entry.clearedAt = Date.now()
        return originalClearInterval(handle)
      }) as unknown as typeof clearInterval

      try {
        const tracker: UpstreamTracker = {
          tcStarted: false,
          tcCompleted: false,
          bodyAborted: false,
        }
        // 50 ms × many bytes — keeps the upstream live for ~7 seconds
        // (well past the 5s heartbeat interval), so pre-fix the
        // clearInterval would not run for >5s.
        globalThis.fetch = mockUpstreamMcp(tracker, 50)

        const ac = new AbortController()
        const reqBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 9002,
          method: "tools/call",
          params: {
            name: "web",
            arguments: { query: "another query" },
          },
        })
        const res = await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${NONCE}`,
            host: `127.0.0.1:${listener!.port}`,
          },
          body: reqBody,
          signal: ac.signal,
        })
        expect(res.status).toBe(200)
        const reader = res.body!.getReader()
        // Drain the initial heartbeat.
        await reader.read()

        // Find the SSE heartbeat interval — it's the one registered
        // with the 5000ms delay from SSE_HEARTBEAT_INTERVAL_MS in
        // handler.ts. (Other intervals from the rest of the stack
        // won't match this delay.)
        const heartbeat = intervals.find(
          (it) => it.delayMs === 5000 && it.clearedAt === -1,
        )
        expect(heartbeat).toBeDefined()

        const cancelAt = Date.now()
        ac.abort()
        try {
          while (true) {
            const r = await reader.read()
            if (r.done) break
          }
        } catch {
          // expected
        }

        // Give the cancel() handler a generous window to run.
        // Post-fix: clearInterval is called synchronously inside
        // handleToolsCallSSE.cancel() — observed clearedAt should be
        // within a handful of ms of cancelAt.
        // Pre-fix: clearInterval is only called from start()'s
        // finally after callPromise settles. With our 50ms × ~150 byte
        // slow upstream that's ~7+ seconds — well past the window
        // below.
        const waitMs = 600
        await new Promise((r) => setTimeout(r, waitMs))

        expect(heartbeat!.clearedAt).toBeGreaterThan(0)
        const clearLatencyMs = heartbeat!.clearedAt - cancelAt
        // Loose tolerance for CI; the real fix vs no-fix gap is
        // multi-seconds, so anything under 500ms easily distinguishes.
        expect(clearLatencyMs).toBeLessThan(500)
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(globalThis as any).setInterval = originalSetInterval
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(globalThis as any).clearInterval = originalClearInterval
      }
    },
    10_000,
  )
})
