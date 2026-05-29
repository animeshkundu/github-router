/**
 * Regression tests for Bug F1: non-streaming /v1/chat/completions and
 * /v1/responses response bodies had no size cap, allowing a malicious or
 * buggy upstream to OOM the proxy with a multi-GB JSON body.
 *
 * The fix applies `readResponseBodyCapped` (from `src/lib/response-cap.ts`)
 * to both service functions. On cap exceeded, the service throws an HTTPError
 * wrapping a structured Anthropic-format error, and the route returns it as
 * a clean 502 to the client.
 *
 * Test pattern: real Bun.serve sockets on loopback, matching the existing
 * messages-body-size-cap.test.ts pattern (chaos.test.ts ancestry).
 */

import { test, expect, beforeAll, afterAll } from "bun:test"

import { server } from "../../src/server"
import { state } from "../../src/lib/state"

// A model the handlers will accept for chat/completions
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

// A model the handlers will accept for responses
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
let fakeUpstream: ReturnType<typeof Bun.serve> | undefined
let proxyUrl = ""

let bytesSentByFakeUpstream = 0

const UPSTREAM_TOTAL_BYTES = 30 * 1024 * 1024 // 30 MiB (well above cap)
const CHUNK_SIZE = 64 * 1024 // 64 KiB chunks
const PROXY_CAP_BYTES = 10 * 1024 * 1024 // 10 MiB cap

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

  // Fake Copilot upstream: streams 30 MiB of non-JSON bytes with no
  // Content-Length header and application/json content-type. The body is
  // deliberately NOT valid JSON — even if somehow buffered, JSON.parse would
  // fail, which makes the behaviour observable either way.
  fakeUpstream = Bun.serve({
    port: 0,
    fetch() {
      bytesSentByFakeUpstream = 0
      let sent = 0
      const chunk = new Uint8Array(CHUNK_SIZE).fill(0x78) // 'x' × 64 KiB

      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent >= UPSTREAM_TOTAL_BYTES) {
            controller.close()
            return
          }
          const slice =
            sent + CHUNK_SIZE <= UPSTREAM_TOTAL_BYTES
              ? chunk
              : chunk.subarray(0, UPSTREAM_TOTAL_BYTES - sent)
          try {
            controller.enqueue(slice)
            sent += slice.byteLength
            bytesSentByFakeUpstream = sent
          } catch {
            // Consumer cancelled — stop cleanly.
            return
          }
          await new Promise((r) => setTimeout(r, 0))
        },
        cancel() {
          bytesSentByFakeUpstream = sent
        },
      })

      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
        // Deliberately omit Content-Length to mirror real misbehaving upstreams.
      })
    },
  })

  proxyListener = Bun.serve({ port: 0, fetch: server.fetch })
  proxyUrl = `http://127.0.0.1:${proxyListener.port}`

  const fakeUpstreamUrl = `http://127.0.0.1:${fakeUpstream.port}`
  const native = originalFetch
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString()
    // Redirect outgoing Copilot API calls to the fake upstream.
    // The proxy itself is reached via loopback (starts with proxyUrl) — let those through.
    if (
      !u.startsWith(proxyUrl)
      && (u.includes("/chat/completions") || u.includes("/responses"))
    ) {
      return native(fakeUpstreamUrl + "/", init)
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
  "non-streaming /v1/chat/completions: proxy returns structured error and does not buffer 30 MiB",
  async () => {
    const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        // No stream: true — non-streaming path
      }),
    })

    // Proxy must respond, not hang or crash.
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(600)

    const body = (await res.json()) as {
      type?: string
      error?: { type?: string; message?: string }
    }

    // Must be a structured Anthropic-format error.
    expect(body.type).toBe("error")
    expect(body.error?.type).toBeTruthy()
    expect(typeof body.error?.message).toBe("string")
    // The message must mention the size cap so callers can diagnose.
    expect(body.error?.message).toMatch(
      /10\s*MiB|10\s*MB|upstream.*too large|response.*too large|size.*cap|cap.*exceeded/i,
    )

    // The proxy must have stopped reading well before the full 30 MiB.
    // Allow 3× the cap to account for in-flight chunks buffered by the OS,
    // network stack, or Bun's loopback socket before the cancel propagates.
    expect(bytesSentByFakeUpstream).toBeLessThan(PROXY_CAP_BYTES * 3)
  },
  30_000,
)

test(
  "non-streaming /v1/chat/completions: normal-sized response still parses and returns correctly",
  async () => {
    const smallBody = JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1234567890,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello!" },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
    })

    const savedFetch = globalThis.fetch
    globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString()
      if (!u.startsWith(proxyUrl) && u.includes("/chat/completions")) {
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
      const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { id?: string; object?: string }
      expect(body.id).toBe("chatcmpl-test")
      expect(body.object).toBe("chat.completion")
    } finally {
      globalThis.fetch = savedFetch
    }
  },
  10_000,
)

test(
  "non-streaming /v1/responses: proxy returns structured error and does not buffer 30 MiB",
  async () => {
    const res = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.2-codex",
        input: "hi",
        // No stream: true — non-streaming path
      }),
    })

    // Proxy must respond, not hang or crash.
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(600)

    const body = (await res.json()) as {
      type?: string
      error?: { type?: string; message?: string }
    }

    // Must be a structured Anthropic-format error.
    expect(body.type).toBe("error")
    expect(body.error?.type).toBeTruthy()
    expect(typeof body.error?.message).toBe("string")
    // The message must mention the size cap.
    expect(body.error?.message).toMatch(
      /10\s*MiB|10\s*MB|upstream.*too large|response.*too large|size.*cap|cap.*exceeded/i,
    )

    // The proxy must have stopped reading well before the full 30 MiB.
    // Allow 3× the cap to account for in-flight chunks buffered by the OS,
    // network stack, or Bun's loopback socket before the cancel propagates.
    expect(bytesSentByFakeUpstream).toBeLessThan(PROXY_CAP_BYTES * 3)
  },
  30_000,
)

test(
  "non-streaming /v1/responses: normal-sized response still parses and returns correctly",
  async () => {
    const smallBody = JSON.stringify({
      id: "resp_test",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: "Hello!" }],
    })

    const savedFetch = globalThis.fetch
    globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString()
      if (!u.startsWith(proxyUrl) && u.includes("/responses")) {
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
      const res = await fetch(`${proxyUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.2-codex",
          input: "hi",
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { id?: string; object?: string }
      expect(body.id).toBe("resp_test")
      expect(body.object).toBe("response")
    } finally {
      globalThis.fetch = savedFetch
    }
  },
  10_000,
)
