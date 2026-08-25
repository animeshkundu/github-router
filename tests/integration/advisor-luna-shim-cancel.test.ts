/**
 * Real-Bun.serve cancellation-race test for the fast Luna-lead profile's
 * advisor translate-loop (plan section 8: "Enable Gemini 3.7 Flash Advisor
 * on the Luna translation path").
 *
 * Twin of `tests/integration/advisor-cancel-leak.test.ts`, which pins the
 * SAME race for the Claude-passthrough lead. This file exercises the NEW
 * code path instead: a non-Claude lead (`gpt-5.6-luna`, /responses) whose
 * advisor (`gemini-3.7-flash`, /chat/completions) and continuation both run
 * through `streamParsedRequestViaShim` / `makeShimContinueTurn`
 * (`src/lib/anthropic-translate/index.ts`) rather than native `createMessages`.
 *
 * Per CLAUDE.md's stream-lifecycle mandate, this MUST use a real
 * `Bun.serve` listener (not `app.request()`) so consumer-cancel propagates
 * through the actual HTTP layer — a mocked `app.request()` call cannot
 * reproduce the microsecond window where Bun's HTTP layer closes the
 * controller while a `pull()` is mid-`await`.
 *
 * Asserts:
 *   - the Luna lead's `/responses` call carries a `tool_use`/function_call
 *     id in the Responses `call_*` shape (NOT `toolu_*`), so
 *     `toClientServerToolUseId`'s total rewrite is actually exercised by a
 *     real advisor loop, not just its own unit tests;
 *   - consumer cancel tears down BOTH the advisor's `/chat/completions` call
 *     and the Luna lead's `/responses` continuation call — neither fires
 *     AFTER the cancel is observed.
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
import { registerLaunch, clearLaunchRegistry } from "../../src/lib/launch-registry"
import { LAUNCH_SECRET_HEADER } from "../../src/lib/messages-identity-preflight"
import { state } from "../../src/lib/state"
import { ADVISOR_INTERNAL_TOOL_NAME } from "../../src/services/advisor/advisor"

const realFetch: typeof globalThis.fetch =
  Bun.fetch as unknown as typeof globalThis.fetch
let savedFetch: typeof globalThis.fetch | undefined
let listener: ReturnType<typeof Bun.serve> | undefined
let baseUrl = ""

const LUNA_MODEL = "gpt-5.6-luna"
const LUNA_DRIVER_ALIAS = "gh-router-luna-driver-max[1m]"
const GEMINI_ADVISOR_MODEL = "gemini-3.7-flash"
const FAST_SECRET = "f".repeat(64)

function resetState() {
  clearLaunchRegistry()
  registerLaunch({ profileId: "fast", nonce: "n".repeat(64), secret: FAST_SECRET })
  state.accountType = "individual"
  state.copilotToken = "token"
  state.githubToken = "gh"
  state.vsCodeVersion = "1.0.0"
  state.copilotVersion = "0.43.0"
  state.models = {
    object: "list",
    data: [
      {
        id: LUNA_MODEL,
        name: "GPT-5.6 Luna",
        vendor: "OpenAI",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        object: "model",
        capabilities: {
          type: "chat",
          family: "gpt-5.6",
          object: "model_capabilities",
          tokenizer: "o200k_base",
          limits: { max_context_window_tokens: 1_050_000 },
          supports: { tool_calls: true },
        },
        supported_endpoints: ["/responses"],
      },
      {
        id: GEMINI_ADVISOR_MODEL,
        name: "Gemini 3.7 Flash",
        vendor: "Google",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        object: "model",
        capabilities: {
          type: "chat",
          family: "gemini",
          object: "model_capabilities",
          tokenizer: "o200k_base",
          limits: { max_context_window_tokens: 1_000_000 },
          supports: { tool_calls: true },
        },
        supported_endpoints: ["/chat/completions"],
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

/** Build a Responses-API SSE body (bare `data:` lines — `events()` from
 *  fetch-event-stream needs only `data:`, no `event:` line). */
function buildResponsesSse(
  events: Array<Record<string, unknown>>,
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
      const line = `data: ${JSON.stringify(events[i])}\n\n`
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
  "aliased Luna lead reaches Gemini Advisor and consumer cancel aborts it before continuation",
  async () => {
    let lunaResponsesCallCount = 0
    let advisorChatCallCount = 0
    let advisorSignalAborted = false
    let advisorSystemPrompt = ""
    let responsesCallStartedAfterCancel = false
    let advisorCallStartedAfterCancel = false
    let cancelObservedAt = -1

    globalThis.fetch = mock((url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString()
      if (u.startsWith(baseUrl)) {
        return realFetch(url, init)
      }

      if (u.includes("/chat/completions")) {
        // Advisor call (gemini-3.7-flash). Slow, so the abort signal has time
        // to fire through the threaded callerSignal — same pattern as the
        // Claude-lead twin test's /responses advisor mock.
        advisorChatCallCount++
        const advisorBody = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: Array<{ role?: string; content?: string }>
        }
        advisorSystemPrompt =
          advisorBody.messages?.find((message) => message.role === "system")?.content
          ?? ""
        if (cancelObservedAt > 0) advisorCallStartedAfterCancel = true
        return new Promise((resolve, reject) => {
          const sig = init?.signal
          const t = setTimeout(() => {
            resolve(
              new Response(
                JSON.stringify({
                  id: "advisor_chat_resp",
                  object: "chat.completion",
                  created: 0,
                  model: GEMINI_ADVISOR_MODEL,
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: "Advisor reply." },
                      logprobs: null,
                      finish_reason: "stop",
                    },
                  ],
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            )
          }, 500)
          if (sig) {
            sig.addEventListener("abort", () => {
              advisorSignalAborted = true
              clearTimeout(t)
              reject(new DOMException("Aborted", "AbortError"))
            })
          }
        })
      }

      if (u.includes("/responses")) {
        lunaResponsesCallCount++
        if (cancelObservedAt > 0) responsesCallStartedAfterCancel = true
        if (lunaResponsesCallCount === 1) {
          // First call: Luna calls the injected __anthropic_advisor tool.
          // The Responses-shape id lives on `call_id` — a `call_*` id, NOT
          // `toolu_*`. This is exactly the shape that used to make
          // `toClientServerToolUseId` throw on every single advisor call on
          // a non-Claude lead.
          return buildResponsesSse(
            [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_luna_advisor_1",
                  name: ADVISOR_INTERNAL_TOOL_NAME,
                },
              },
              {
                type: "response.function_call_arguments.done",
                output_index: 0,
                item_id: "fc_1",
                arguments: "{}",
              },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_luna_advisor_1",
                  name: ADVISOR_INTERNAL_TOOL_NAME,
                  arguments: "{}",
                },
              },
              {
                type: "response.completed",
                response: {
                  status: "completed",
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              },
            ],
            // 30ms/event — fast enough to deliver the advisor block, slow
            // enough that the consumer can read one chunk and cancel.
            30,
          )
        }
        // Continuation call — should not be reached post-cancel.
        return buildResponsesSse(
          [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "message", id: "m_cont" },
            },
            {
              type: "response.output_text.delta",
              output_index: 0,
              item_id: "m_cont",
              delta: "continuation",
            },
            {
              type: "response.completed",
              response: { usage: { input_tokens: 1, output_tokens: 1 } },
            },
          ],
          5,
        )
      }
      return new Response("?", { status: 500 })
    }) as unknown as typeof globalThis.fetch

    const ac = new AbortController()
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-beta": "advisor-tool-2026-03-01",
        [LAUNCH_SECRET_HEADER]: FAST_SECRET,
      },
      body: JSON.stringify({
        model: LUNA_DRIVER_ALIAS,
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
      signal: ac.signal,
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
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
    // Sanity: we actually entered the advisor branch on the Luna lead.
    expect(buffer).toContain("server_tool_use")

    // Capture the client-facing srvtoolu_* id and prove it derives from the
    // Responses call_* id (via the total `toClientServerToolUseId`), not a
    // synthesized-from-scratch placeholder or a thrown error.
    const idMatch = buffer.match(/"type":"server_tool_use","id":"([^"]+)"/)
    const capturedToolUseId = idMatch?.[1]
    expect(capturedToolUseId).toMatch(/^srvtoolu_[a-zA-Z0-9_]+$/)
    expect(capturedToolUseId).toContain("call_luna_advisor_1")

    // Wait until the Gemini Advisor call is actually in flight, then cancel.
    const advisorDeadline = Date.now() + 3000
    while (advisorChatCallCount === 0 && Date.now() < advisorDeadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(advisorChatCallCount).toBe(1)
    expect(advisorSystemPrompt).toContain("non-binding consultant")
    expect(advisorSystemPrompt).toContain("Do not approve, veto, dictate")
    expect(advisorSystemPrompt).not.toContain(
      "Give a directive recommendation and commit to the decision",
    )

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

    await new Promise((r) => setTimeout(r, 1000))

    expect(advisorCallStartedAfterCancel).toBe(false)
    expect(advisorSignalAborted).toBe(true)
    expect(responsesCallStartedAfterCancel).toBe(false)
    expect(lunaResponsesCallCount).toBe(1)
    expect(advisorChatCallCount).toBe(1)
  },
  15_000,
)

describe("Luna-lead advisor: initial /responses fetch is itself cancellable", () => {
  test(
    "consumer cancel aborts the initial upstream fetch signal within 500ms",
    async () => {
      let initialFetchSignal: AbortSignal | undefined
      let initialFetchSignalAbortedAt: number | undefined

      globalThis.fetch = mock((url: string | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString()
        if (u.startsWith(baseUrl)) {
          return realFetch(url, init)
        }

        if (u.includes("/responses")) {
          if (!initialFetchSignal) {
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
                  await new Promise((r) => setTimeout(r, 5000))
                  try {
                    controller.close()
                  } catch {
                    /* */
                  }
                  return
                }
                await new Promise((r) => setTimeout(r, 5000))
                emitted = true
                try {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        type: "response.output_item.added",
                        output_index: 0,
                        item: { type: "message", id: "m0" },
                      })}\n\n`,
                    ),
                  )
                } catch {
                  /* enqueue after close */
                }
              },
            })
            return Promise.resolve(
              new Response(stream, {
                status: 200,
                headers: { "content-type": "text/event-stream" },
              }),
            )
          }
          return new Response("unexpected", { status: 500 })
        }

        if (u.includes("/chat/completions")) {
          return new Response("unexpected advisor call", { status: 500 })
        }
        return new Response("?", { status: 500 })
      }) as unknown as typeof globalThis.fetch

      const ac = new AbortController()
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "anthropic-beta": "advisor-tool-2026-03-01",
        [LAUNCH_SECRET_HEADER]: FAST_SECRET,
        },
        body: JSON.stringify({
          model: LUNA_DRIVER_ALIAS,
          max_tokens: 100,
          messages: [{ role: "user", content: "slow initial test" }],
          stream: true,
        }),
        signal: ac.signal,
      })
      expect(res.status).toBe(200)

      const reader = res.body!.getReader()
      const readPromise = reader.read().catch(() => ({ done: true, value: undefined }))

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

      const deadline = Date.now() + 500
      while (!initialFetchSignalAbortedAt && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }

      expect(initialFetchSignal).toBeDefined()
      expect(initialFetchSignalAbortedAt).toBeDefined()
      expect(initialFetchSignalAbortedAt! - cancelTime).toBeLessThan(500)
    },
    15_000,
  )
})
