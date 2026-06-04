/**
 * Regression tests for Bug F2: streaming /v1/chat/completions and /v1/responses
 * lacked per-chunk inactivity timeouts. A stalled-but-alive upstream would hang
 * the streaming response indefinitely (until the 5-minute absolute fetch timeout).
 *
 * The fix wraps all `iterator.next()` calls in both handlers with
 * `readIteratorWithTimeout(iterator, UPSTREAM_INACTIVITY_TIMEOUT_MS)`.
 * On timeout, an InactivityTimeout error is thrown, caught in pull()'s catch
 * block, and emitted to the client as an OpenAI-format error event followed
 * by `data: [DONE]`.
 *
 * Test isolation note: this file lives in tests/isolated/ because it uses
 * mock.module("~/lib/port") to inject a 200ms inactivity timeout — avoiding
 * the 5-minute default that would make the test hang forever. mock.module is
 * global for the test run in Bun, so it must be isolated from the production-
 * path tests that rely on the real port constants.
 *
 * FAIL before fix: the stream hangs indefinitely (or until the 5-min absolute
 * timeout) and never emits an error event within the test's deadline window.
 * PASS after fix: the stream emits an OpenAI-format error event containing
 * "timeout_error" or "InactivityTimeout" or "upstream_inactive" within the
 * bounded timeout window.
 */

// IMPORTANT: mock.module must appear before any imports that transitively
// import ~/lib/port. In Bun, mock.module is hoisted to module-evaluation time.
import { mock } from "bun:test"

// Inject a small UPSTREAM_INACTIVITY_TIMEOUT_MS so tests complete in ~200ms
// instead of 5 minutes. All other port constants use the same defaults as
// the real module so other code paths behave normally.
const INACTIVITY_TIMEOUT_MS = 200

mock.module("~/lib/port", () => ({
  DEFAULT_PORT: 8787,
  DEFAULT_CLAUDE_MODEL: "claude-opus-4-8",
  DEFAULT_CLAUDE_MODEL_FALLBACKS: ["claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"],
  DEFAULT_CODEX_MODEL: "gpt-5.5",
  DEFAULT_CODEX_MODEL_FALLBACKS: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"],
  UPSTREAM_FETCH_TIMEOUT_MS: 0,
  UPSTREAM_INACTIVITY_TIMEOUT_MS: INACTIVITY_TIMEOUT_MS,
  generateRandomPort: () => Math.floor(Math.random() * (65535 - 11000 + 1)) + 11000,
  pickClaudeDefault: (family?: string) => `claude-opus-${family ?? "4-7"}`,
}))

// Now import server after the mock is in place.
import { test, expect, beforeAll, afterAll } from "bun:test"

import { server } from "../../src/server"
import { state } from "../../src/lib/state"

const chatModel = {
  id: "gpt-4o",
  model_picker_enabled: true,
  name: "GPT-4o",
  object: "model",
  preview: false,
  vendor: "azure",
  version: "1",
  capabilities: {
    family: "gpt",
    limits: { max_output_tokens: 256 },
    object: "model",
    supports: {},
    tokenizer: "cl100k_base",
    type: "chat",
  },
}

const responsesModel = {
  id: "gpt-5.2-codex",
  model_picker_enabled: true,
  name: "GPT-5.2 Codex",
  object: "model",
  preview: false,
  vendor: "azure",
  version: "1",
  capabilities: {
    family: "gpt",
    limits: { max_output_tokens: 256 },
    object: "model",
    supports: { streaming: true },
    tokenizer: "cl100k_base",
    type: "chat",
    supported_endpoints: ["/v1/responses"],
  },
}

const originalFetch = globalThis.fetch
let proxyListener: ReturnType<typeof Bun.serve> | undefined
let fakeUpstreamCC: ReturnType<typeof Bun.serve> | undefined
let fakeUpstreamResp: ReturnType<typeof Bun.serve> | undefined
let proxyUrl = ""

beforeAll(() => {
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.githubToken = "gh-test"
  state.vsCodeVersion = "1.0.0"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.showToken = false
  state.models = { object: "list", data: [chatModel, responsesModel] }

  // Fake upstream for /chat/completions: sends one SSE chunk then stalls forever.
  fakeUpstreamCC = Bun.serve({
    port: 0,
    fetch() {
      const firstChunk =
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n'
      let sent = false
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true
            controller.enqueue(new TextEncoder().encode(firstChunk))
            return
          }
          // Stall forever — never yield another chunk.
          return new Promise<void>(() => {})
        },
        cancel() {
          // consumer cancelled — fine
        },
      })
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })

  // Fake upstream for /responses: sends one SSE chunk then stalls forever.
  fakeUpstreamResp = Bun.serve({
    port: 0,
    fetch() {
      const firstChunk =
        'data: {"type":"response.created","response":{"id":"resp-1","status":"in_progress"}}\n\n'
      let sent = false
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true
            controller.enqueue(new TextEncoder().encode(firstChunk))
            return
          }
          // Stall forever.
          return new Promise<void>(() => {})
        },
        cancel() {
          // consumer cancelled — fine
        },
      })
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })

  proxyListener = Bun.serve({ port: 0, fetch: server.fetch })
  proxyUrl = `http://127.0.0.1:${proxyListener.port}`

  const fakeUrlCC = `http://127.0.0.1:${fakeUpstreamCC.port}`
  const fakeUrlResp = `http://127.0.0.1:${fakeUpstreamResp.port}`
  const native = originalFetch
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString()
    if (!u.startsWith(proxyUrl) && u.includes("/chat/completions")) {
      return native(fakeUrlCC + "/", init)
    }
    if (!u.startsWith(proxyUrl) && u.includes("/responses")) {
      return native(fakeUrlResp + "/", init)
    }
    return native(url, init)
  }) as typeof globalThis.fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
  proxyListener?.stop(true)
  fakeUpstreamCC?.stop(true)
  fakeUpstreamResp?.stop(true)
})

/**
 * Collect all SSE text from a streaming response, with a hard wall-clock
 * deadline to avoid hanging the test suite if the fix is absent.
 */
async function collectSSE(res: Response, deadlineMs: number): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let out = ""
  const start = Date.now()
  while (true) {
    if (Date.now() - start > deadlineMs) break
    const remaining = deadlineMs - (Date.now() - start)
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), remaining),
      ),
    ])
    if (done) break
    if (value) out += decoder.decode(value, { stream: true })
    // Once we have a [DONE] sentinel, the stream is finished.
    if (out.includes("[DONE]")) break
  }
  try {
    await reader.cancel()
  } catch {
    // best effort
  }
  return out
}

test(
  "streaming /v1/chat/completions: stalled upstream triggers inactivity timeout and emits error event",
  async () => {
    const startTime = Date.now()
    const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    // Allow up to 10× the timeout for the error to arrive (generous for CI).
    // The unfixed code would hang until the 5-min absolute timeout.
    const deadline = INACTIVITY_TIMEOUT_MS * 10
    const body = await collectSSE(res, deadline)

    const elapsed = Date.now() - startTime

    // Must have received the first real chunk.
    expect(body).toContain("chat.completion.chunk")

    // Must have received the error sentinel within the bounded window.
    // The error event carries `"type":"timeout_error"` (from classifyStreamError)
    // and the error message contains "upstream_inactive" or "InactivityTimeout".
    const hasErrorEvent =
      body.includes('"error"') &&
      (body.includes("timeout_error") ||
        body.includes("InactivityTimeout") ||
        body.includes("upstream_inactive"))
    expect(hasErrorEvent).toBe(true)

    // Must include the OpenAI [DONE] terminator that buildOpenAIErrorEvent appends.
    expect(body).toContain("[DONE]")

    // The whole thing must have resolved well within 5 minutes.
    // (Before fix: hangs for 5 minutes; after fix: ~200ms + overhead.)
    expect(elapsed).toBeLessThan(5 * 60_000)
  },
  15_000, // 15s test timeout — generous for CI; normal case completes in ~200ms
)

test(
  "streaming /v1/responses: stalled upstream triggers inactivity timeout and emits error event",
  async () => {
    const startTime = Date.now()
    const res = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.2-codex",
        input: "hi",
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const deadline = INACTIVITY_TIMEOUT_MS * 10
    const body = await collectSSE(res, deadline)

    const elapsed = Date.now() - startTime

    // Must have received the first real chunk.
    expect(body).toContain("response.created")

    // Must have received the error sentinel.
    const hasErrorEvent =
      body.includes('"error"') &&
      (body.includes("timeout_error") ||
        body.includes("InactivityTimeout") ||
        body.includes("upstream_inactive"))
    expect(hasErrorEvent).toBe(true)

    // Must include the [DONE] terminator.
    expect(body).toContain("[DONE]")

    expect(elapsed).toBeLessThan(5 * 60_000)
  },
  15_000,
)
