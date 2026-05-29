/**
 * Regression test for Bug E1: handleResponsesCompact raw fetch with no
 * signal and no timeout.
 *
 * This test verifies that the fix adds an AbortSignal to the fetch call for
 * /responses/compact. Before the fix, capturedSignal was undefined; after the
 * fix, it is an AbortSignal instance.
 *
 * The test does NOT need to wait for the signal to fire — the primary
 * regression assertion is that a signal is present on the fetch options at all.
 * A hung upstream with no signal will never be aborted; a hung upstream with a
 * signal will be aborted when the timeout fires.
 *
 * This file lives in tests/isolated/ because the name follows the naming
 * convention for tests that are scoped to a specific concern and would
 * pollute (or be polluted by) other module-level state if interleaved.
 */

import { test, expect, mock, afterEach } from "bun:test"

import { server } from "../../src/server"
import { state } from "../../src/lib/state"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>

const originalFetch = globalThis.fetch

function resetState() {
  state.accountType = "individual"
  state.copilotToken = "token"
  state.githubToken = "gh"
  state.vsCodeVersion = "1.0.0"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.showToken = false
  state.models = { object: "list", data: [] }
  state.copilotApiUrl = undefined
}

afterEach(() => {
  globalThis.fetch = originalFetch
  resetState()
})

const compactRequestBody = {
  model: "gpt-5.3-codex",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
  ],
}

/**
 * Primary regression test for E1: verify that a signal is passed on the
 * /responses/compact fetch call.
 *
 * Strategy: mock fetch captures the signal immediately, then returns an OK
 * response so the handler completes quickly. The key assertion is that
 * opts.signal is defined — before the fix it was undefined.
 */
test("compact fetch passes an AbortSignal to guard against hung upstream", async () => {
  resetState()

  let capturedSignal: AbortSignal | undefined

  const copilotResponse = {
    id: "resp_compact_native",
    object: "response.compaction",
    created_at: 1700000000,
    output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }

  const fetchMock = mock(
    (url: string, opts?: { signal?: AbortSignal; body?: string; method?: string }) => {
      if (typeof url === "string" && url.includes("/responses/compact")) {
        // Capture the signal from the fetch options — this is the assertion.
        capturedSignal = opts?.signal
        // Return an OK response immediately so the handler can complete.
        return Promise.resolve(new Response(JSON.stringify(copilotResponse)))
      }
      throw new Error(`Unexpected URL: ${url}`)
    },
  )

  // @ts-expect-error — partial fetch mock
  globalThis.fetch = fetchMock

  const response = await server.request("/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(compactRequestBody),
  })

  // The signal MUST have been passed — this is the primary regression assertion.
  // Before the fix, capturedSignal was undefined; after the fix, it is an AbortSignal.
  expect(capturedSignal).toBeDefined()
  expect(capturedSignal).toBeInstanceOf(AbortSignal)

  // Handler should complete normally.
  expect(response.status).toBe(200)
  const body = (await response.json()) as AnyRecord
  expect(body.object).toBe("response.compaction")
})

/**
 * Secondary regression test for E1: verify 401-retry path works (tryRefreshAndRetry
 * integration). If the first call returns 401, the handler retries. This means
 * a fresh doFetch closure is invoked, and a fresh AbortSignal must be created
 * (the previous one may already be expired from the first call).
 */
test("compact fetch retries on 401 and still passes a fresh AbortSignal", async () => {
  resetState()

  const signals: Array<AbortSignal | undefined> = []
  let callCount = 0

  const copilotResponse = {
    id: "resp_compact_retry",
    object: "response.compaction",
    created_at: 1700000000,
    output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }

  const fetchMock = mock(
    (url: string, opts?: { signal?: AbortSignal }) => {
      if (typeof url === "string" && url.includes("/responses/compact")) {
        signals.push(opts?.signal)
        callCount++
        if (callCount === 1) {
          // First call: return 401 to trigger a refresh+retry.
          return Promise.resolve(new Response("Unauthorized", { status: 401 }))
        }
        // Second call: return OK.
        return Promise.resolve(new Response(JSON.stringify(copilotResponse)))
      }
      throw new Error(`Unexpected URL: ${url}`)
    },
  )

  // @ts-expect-error — partial fetch mock
  globalThis.fetch = fetchMock

  const response = await server.request("/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(compactRequestBody),
  })

  // Both calls must have received a signal.
  expect(callCount).toBe(2)
  expect(signals[0]).toBeInstanceOf(AbortSignal)
  expect(signals[1]).toBeInstanceOf(AbortSignal)
  expect(response.status).toBe(200)
})
