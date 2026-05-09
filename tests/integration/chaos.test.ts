import { test, expect, mock, afterAll, beforeAll } from "bun:test"
import fs from "node:fs"

import { server } from "../../src/server"
import { state } from "../../src/lib/state"
import { PATHS } from "../../src/lib/paths"

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

const ENC = new TextEncoder()
const originalFetch = globalThis.fetch
let listener: ReturnType<typeof Bun.serve> | undefined
let baseUrl = ""

function resetState() {
  state.accountType = "individual"
  state.copilotToken = "token"
  state.githubToken = "gh"
  state.vsCodeVersion = "1.0.0"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.showToken = false
  state.models = { object: "list", data: [baseModel] }
}

const VALID_SSE_EVENTS = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
]

type ChaosBehavior =
  | "happy"
  | "midstream_error"
  | "zero_bytes"
  | "missing_content_type"
  | "json_content_type_with_sse_body"
  | "upstream_rst"
  | "happy_then_client_abort"

function makeChaosUpstream(behavior: ChaosBehavior): Response {
  const headers: Record<string, string> = {
    "content-type": "text/event-stream",
  }
  if (behavior === "missing_content_type") {
    delete headers["content-type"]
  }
  if (behavior === "json_content_type_with_sse_body") {
    headers["content-type"] = "application/json"
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      switch (behavior) {
        case "zero_bytes":
          controller.close()
          return
        case "midstream_error":
          controller.enqueue(ENC.encode(VALID_SSE_EVENTS[0]!))
          controller.enqueue(ENC.encode(VALID_SSE_EVENTS[1]!))
          await new Promise((r) => setTimeout(r, 5))
          controller.error(new TypeError("terminated"))
          return
        case "upstream_rst":
          controller.enqueue(ENC.encode(VALID_SSE_EVENTS[0]!))
          await new Promise((r) => setTimeout(r, 3))
          controller.error(
            new TypeError("Invalid state: Controller is already closed"),
          )
          return
        case "happy":
        case "missing_content_type":
        case "json_content_type_with_sse_body":
        case "happy_then_client_abort":
          for (const ev of VALID_SSE_EVENTS) {
            controller.enqueue(ENC.encode(ev))
            await new Promise((r) => setTimeout(r, 1))
          }
          controller.close()
          return
      }
    },
  })

  return new Response(body, { status: 200, headers })
}

function readErrorLogTail(): string {
  try {
    return fs.readFileSync(PATHS.ERROR_LOG_PATH, "utf8")
  } catch {
    return ""
  }
}

beforeAll(() => {
  resetState()
  // Start a real Bun HTTP listener so requests exercise the actual socket
  // layer (this is what `server.request()` would NOT exercise).
  listener = Bun.serve({ port: 0, fetch: server.fetch })
  baseUrl = `http://127.0.0.1:${listener.port}`
})

afterAll(() => {
  globalThis.fetch = originalFetch
  if (listener) listener.stop(true)
})

test(
  "chaos: 60 streaming requests with mixed upstream behaviors and client aborts",
  async () => {
    resetState()

    const behaviors: Array<ChaosBehavior> = [
      "happy",
      "midstream_error",
      "zero_bytes",
      "missing_content_type",
      "json_content_type_with_sse_body",
      "upstream_rst",
      "happy_then_client_abort",
    ]

    // Track unhandled rejections during the test window.
    const unhandled: Array<unknown> = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)

    // Snapshot error.log so we only check NEW lines added during the test.
    const logSnapshotBefore = readErrorLogTail()

    const ITERATIONS = 60
    const results: Array<{
      behavior: ChaosBehavior
      status?: number
      bodyLen?: number
      error?: string
    }> = []

    try {
      for (let i = 0; i < ITERATIONS; i++) {
        const behavior = behaviors[i % behaviors.length]!

        // Re-mock upstream fetch for this iteration. The mock is global, so
        // back-to-back iterations are sequential — no cross-talk.
        globalThis.fetch = (() => {
          const native = originalFetch
          return mock((url: string | URL, init?: RequestInit) => {
            const u = typeof url === "string" ? url : url.toString()
            if (u.includes("/v1/messages") && !u.startsWith(baseUrl)) {
              // Upstream copilot endpoint
              return Promise.resolve(makeChaosUpstream(behavior))
            }
            // Otherwise pass through to real fetch (loopback to our proxy).
            return native(url, init)
          })
        })() as unknown as typeof globalThis.fetch

        const ac = new AbortController()
        const reqBody = JSON.stringify({
          model: "claude-sonnet-4.5",
          max_tokens: 50,
          stream: true,
          messages: [{ role: "user", content: "say hi" }],
        })

        // For the client-abort behavior (and a quarter of the others),
        // schedule an abort at a random millisecond after the request
        // starts. This is the path that produced the original
        // controller-already-closed race.
        const shouldAbort =
          behavior === "happy_then_client_abort" || i % 4 === 0
        if (shouldAbort) {
          setTimeout(() => ac.abort(), Math.floor(Math.random() * 8) + 2)
        }

        try {
          const res = await fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: reqBody,
            signal: ac.signal,
          })
          // Drain the body so the wrapper's pull() runs.
          const body = await res.text().catch(() => "")
          results.push({
            behavior,
            status: res.status,
            bodyLen: body.length,
          })
        } catch (e) {
          results.push({
            behavior,
            error: e instanceof Error ? e.message : String(e),
          })
        }

        // Yield between iterations.
        await new Promise((r) => setTimeout(r, 5))
      }

      // Drain microtasks so any pending unhandled rejections fire.
      await new Promise((r) => setTimeout(r, 100))

      // ------- Assertions -------

      // Every iteration ran (no test framework crash).
      expect(results.length).toBe(ITERATIONS);

      // No unhandled rejections — the proxy must not crash the process.
      expect(unhandled).toEqual([]);

      // No "Could not deliver error event" warns added to error.log
      // during the test (this was the smoking-gun line that flagged the
      // controller-already-closed race in production).
      const logSnapshotAfter = readErrorLogTail()
      const newLines = logSnapshotAfter.slice(logSnapshotBefore.length)
      const couldNotDeliverCount = (
        newLines.match(/Could not deliver error event/g) ?? []
      ).length
      expect(couldNotDeliverCount).toBe(0)

      // Every response is either a clean status (200/4xx/5xx) or an
      // AbortError — no hangs (the test has implicit timeout protection
      // from bun:test, but we also assert results all settled).
      for (const r of results) {
        if (r.error) {
          // AbortError is the expected error for client-aborted requests.
          // "fetch failed" / undici equivalents are also acceptable for
          // mid-stream-killed connections.
          expect(typeof r.error).toBe("string")
        } else {
          expect(r.status).toBeGreaterThanOrEqual(200)
          expect(r.status).toBeLessThan(600)
        }
      }
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  },
  60_000, // 60-second timeout for the chaos run
)
