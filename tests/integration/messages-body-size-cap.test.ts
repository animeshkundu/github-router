/**
 * Regression test for Bug #7: non-streaming /v1/messages response body has no
 * size cap, allowing a malicious or buggy upstream to OOM the proxy with a
 * multi-GB JSON body.
 *
 * The fix must:
 *   - Read upstream response bytes via a streaming reader, capping at 10 MiB.
 *   - When the cap is hit: drain the reader to release the socket, return a
 *     structured Anthropic-format error to the client.
 *   - Preserve the happy path: normal-sized responses still parse and return.
 *
 * Test pattern: real Bun.serve sockets on loopback, same as chaos.test.ts.
 * The fake upstream streams chunks until the reader is cancelled, so the
 * unfixed code would buffer all 50 MiB before returning, while the fixed
 * code returns a structured error after reading ≤ 10 MiB.
 */

import { test, expect, beforeAll, afterAll } from "bun:test"

import { server } from "../../src/server"
import { state } from "../../src/lib/state"

const baseModel = {
  id: "claude-sonnet-4.5",
  model_picker_enabled: true,
  name: "Claude Sonnet 4.5",
  object: "model",
  preview: false,
  vendor: "anthropic",
  version: "1",
  capabilities: {
    family: "claude",
    limits: { max_output_tokens: 256 },
    object: "model",
    supports: {},
    tokenizer: "claude",
    type: "chat",
  },
}

const originalFetch = globalThis.fetch
let proxyListener: ReturnType<typeof Bun.serve> | undefined
let fakeUpstream: ReturnType<typeof Bun.serve> | undefined
let proxyUrl = ""

// Track total bytes the fake upstream has actually sent, so we can assert
// that the fixed proxy stopped reading well before the full 50 MiB.
let bytesSentByUpstream = 0

const UPSTREAM_TOTAL_BYTES = 50 * 1024 * 1024 // 50 MiB
const CHUNK_SIZE = 64 * 1024 // 64 KiB chunks
const PROXY_CAP_BYTES = 10 * 1024 * 1024 // 10 MiB cap expected in fix

beforeAll(() => {
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.githubToken = "gh-test"
  state.vsCodeVersion = "1.0.0"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.showToken = false
  state.models = { object: "list", data: [baseModel] }

  // Fake Copilot upstream: streams 50 MiB of non-JSON bytes with no
  // Content-Length header and application/json content-type. The body is
  // deliberately NOT valid JSON — even if somehow buffered, JSON.parse would
  // fail, which makes the behaviour observable either way.
  fakeUpstream = Bun.serve({
    port: 0,
    fetch() {
      bytesSentByUpstream = 0
      let sent = 0
      const chunk = new Uint8Array(CHUNK_SIZE).fill(0x78) // 'x' × 64 KiB

      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent >= UPSTREAM_TOTAL_BYTES) {
            controller.close()
            return
          }
          const slice = sent + CHUNK_SIZE <= UPSTREAM_TOTAL_BYTES
            ? chunk
            : chunk.subarray(0, UPSTREAM_TOTAL_BYTES - sent)
          try {
            controller.enqueue(slice)
            sent += slice.byteLength
            bytesSentByUpstream = sent
          } catch {
            // Consumer cancelled — stop cleanly.
            return
          }
          // Tiny yield so the fake upstream doesn't spin hot.
          await new Promise((r) => setTimeout(r, 0))
        },
        cancel() {
          // Reader was cancelled — stop tracking.
          bytesSentByUpstream = sent
        },
      })

      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
        // Deliberately omit Content-Length to mirror real misbehaving upstreams.
      })
    },
  })

  // Route the proxy's outgoing Copilot fetch to the fake upstream.
  proxyListener = Bun.serve({ port: 0, fetch: server.fetch })
  proxyUrl = `http://127.0.0.1:${proxyListener.port}`

  const fakeUpstreamUrl = `http://127.0.0.1:${fakeUpstream.port}`
  const native = originalFetch
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString()
    // Redirect Copilot /v1/messages calls to the fake upstream.
    if (u.includes("/v1/messages") && !u.startsWith(proxyUrl)) {
      return native(fakeUpstreamUrl + "/v1/messages", init)
    }
    return native(url, init)
  }) as typeof globalThis.fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
  proxyListener?.stop(true)
  fakeUpstream?.stop(true)
})

test(
  "non-streaming /v1/messages: proxy returns structured error and does not buffer 50 MiB when upstream sends oversized body",
  async () => {
    const res = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.5",
        max_tokens: 50,
        // No `stream: true` — non-streaming path
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    // Proxy must respond — not hang or crash.
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(600)

    const body = await res.json() as {
      type?: string
      error?: { type?: string; message?: string }
    }

    // Must be a structured Anthropic-format error.
    expect(body.type).toBe("error")
    expect(body.error?.type).toBeTruthy()
    expect(typeof body.error?.message).toBe("string")
    // The message must mention the size cap so callers can diagnose.
    expect(body.error?.message).toMatch(/10\s*MiB|10\s*MB|upstream.*too large|response.*too large|size.*cap|cap.*exceeded/i)

    // The proxy must have stopped reading long before the full 50 MiB.
    // Allow a generous buffer (2× the cap) for in-flight chunks, but
    // the unfixed code would reach the full 50 MiB.
    expect(bytesSentByUpstream).toBeLessThan(PROXY_CAP_BYTES * 2)
  },
  30_000,
)

test(
  "non-streaming /v1/messages: normal-sized response still parses and returns correctly",
  async () => {
    // Override the fake upstream for this test only to return a valid small
    // JSON body that resembles a real Anthropic response.
    const smallBody = JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4.5",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3 },
    })

    const savedFetch = globalThis.fetch
    globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString()
      // The proxy listener itself is reached via the native loopback fetch
      // (URL starts with proxyUrl). The proxy then calls the Copilot upstream
      // (URL does NOT start with proxyUrl) — intercept that leg only.
      if (u.includes("/v1/messages") && !u.startsWith(proxyUrl)) {
        return Promise.resolve(
          new Response(smallBody, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
      }
      return originalFetch(url, init)
    }) as typeof globalThis.fetch

    try {
      const res = await fetch(`${proxyUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4.5",
          max_tokens: 50,
          messages: [{ role: "user", content: "hi" }],
        }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { id?: string; type?: string }
      expect(body.id).toBe("msg_test")
      expect(body.type).toBe("message")
    } finally {
      globalThis.fetch = savedFetch
    }
  },
  10_000,
)
