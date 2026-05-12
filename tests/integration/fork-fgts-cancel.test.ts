import { test, expect, mock, afterAll, beforeAll } from "bun:test"
import fs from "node:fs"

import { server } from "../../src/server"
import { state } from "../../src/lib/state"
import { PATHS } from "../../src/lib/paths"

// Regression test for codex_critic round-4 finding (peer-MCP plan):
// FORK_SUBAGENT + FINE_GRAINED_TOOL_STREAMING are both default-on after
// the experimental-feature auto-enable PR. FGTS amplifies the number of
// SSE frame boundaries during tool-input streaming (each `input_json_delta`
// arrives as a separate frame instead of one big block); combined with
// subagent fork paths it stresses the proxy's `relayAnthropicStream`
// cancellation handling.
//
// CLAUDE.md flags `relayAnthropicStream` as a "smoking gun" surface for
// enqueue-after-cancel races. The original chaos.test.ts catches the
// race for text-only streams; this test extends the coverage to the
// FGTS-style fragmented-tool-input frame distribution that becomes the
// new default after the env auto-enable lands.
//
// Pattern mirrors chaos.test.ts: race a real consumer cancel against a
// multi-frame tool-input streaming response; assert no "Could not
// deliver error event" warn-log surfaces.

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

// FGTS-style upstream: model emits a `tool_use` content block whose
// input arrives as many small `input_json_delta` partial-JSON chunks.
// This is exactly the frame distribution that fine-grained tool
// streaming produces — each chunk is a separate SSE frame, and the
// total number of frame boundaries is far higher than the text-only
// chaos test.
//
// The shape mirrors what `relayAnthropicStream` parses: a sequence of
// content_block_start / multiple input_json_delta / content_block_stop
// events for a single tool call.
const FGTS_SSE_EVENTS = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fgts","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_fgts","name":"Write","input":{}}}\n\n',
  // 12 fragmented input_json_delta frames — simulates FGTS amplification.
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"file"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"_path"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\":\\""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"/tmp/x"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":".txt\\""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":",\\"content"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\":\\""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"hello"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":" world"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":50}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
]

function makeFgtsUpstream(): Response {
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (const ev of FGTS_SSE_EVENTS) {
        controller.enqueue(ENC.encode(ev))
        // Small delay between frames so consumer cancel can land
        // between any two frames — recreates the FGTS frame timing
        // distribution.
        await new Promise((r) => setTimeout(r, 1))
      }
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
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
  listener = Bun.serve({ port: 0, fetch: server.fetch })
  baseUrl = `http://127.0.0.1:${listener.port}`
})

afterAll(() => {
  globalThis.fetch = originalFetch
  if (listener) listener.stop(true)
})

test(
  "FORK + FGTS race: fragmented tool-input streaming with consumer cancels at every frame boundary produces no smoking-gun warns",
  async () => {
    resetState()

    const unhandled: Array<unknown> = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)

    const logSnapshotBefore = readErrorLogTail()

    // Run multiple iterations with cancels at varying frame offsets so
    // the cancel can land between any input_json_delta pair (matches
    // the real-world race surface where FGTS produces N frame
    // boundaries per tool call).
    const ITERATIONS = 20
    const results: Array<{
      cancelAfterFrames: number
      status?: number
      bodyLen?: number
      error?: string
    }> = []

    try {
      for (let i = 0; i < ITERATIONS; i++) {
        // Cancel after frame i % FGTS_SSE_EVENTS.length — covers every
        // frame-boundary in the streaming response, INCLUDING during
        // the input_json_delta sequence (which is the FGTS-amplified
        // race surface).
        const cancelAfterFrames = i % FGTS_SSE_EVENTS.length

        globalThis.fetch = (() => {
          const native = originalFetch
          return mock((url: string | URL, init?: RequestInit) => {
            const u = typeof url === "string" ? url : url.toString()
            if (u.includes("/v1/messages") && !u.startsWith(baseUrl)) {
              return Promise.resolve(makeFgtsUpstream())
            }
            return native(url, init)
          })
        })() as unknown as typeof globalThis.fetch

        const ac = new AbortController()
        const reqBody = JSON.stringify({
          model: "claude-sonnet-4.5",
          max_tokens: 256,
          stream: true,
          messages: [{ role: "user", content: "write a file" }],
          tools: [
            {
              name: "Write",
              description: "write a file",
              input_schema: {
                type: "object",
                properties: {
                  file_path: { type: "string" },
                  content: { type: "string" },
                },
                required: ["file_path", "content"],
              },
            },
          ],
        })

        try {
          const res = await fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: reqBody,
            signal: ac.signal,
          })

          let bodyLen = 0
          let framesRead = 0
          if (res.body) {
            const reader = res.body.getReader()
            try {
              while (true) {
                const r = await reader.read()
                if (r.done) break
                if (r.value) bodyLen += r.value.byteLength
                framesRead++
                if (framesRead >= cancelAfterFrames) {
                  // Land the abort INSIDE the pull()-mid-await window
                  // (the smoking-gun race surface per CLAUDE.md). This
                  // is the "milestone abort" pattern from chaos.test.ts.
                  ac.abort()
                }
              }
            } catch {
              // Abort propagates as a read error — that's the path
              // under test.
            }
          }

          results.push({
            cancelAfterFrames,
            status: res.status,
            bodyLen,
          })
        } catch (e) {
          results.push({
            cancelAfterFrames,
            error: e instanceof Error ? e.message : String(e),
          })
        }

        await new Promise((r) => setTimeout(r, 5))
      }

      // Drain microtasks so any pending unhandled rejections fire.
      await new Promise((r) => setTimeout(r, 100))

      // ------- Assertions -------

      expect(results.length).toBe(ITERATIONS)

      // No unhandled rejections — the proxy must not crash the
      // process even when cancels land at every FGTS frame boundary.
      expect(unhandled).toEqual([])

      // Smoking gun (per CLAUDE.md "Review checklist"): a new
      // "Could not deliver error event" warn-log is a bug, not a
      // routine warning. Any occurrence here means the FGTS-amplified
      // frame distribution exposed a new enqueue-after-cancel race
      // in `relayAnthropicStream`.
      const logSnapshotAfter = readErrorLogTail()
      const newLines = logSnapshotAfter.slice(logSnapshotBefore.length)
      const couldNotDeliverCount = (
        newLines.match(/Could not deliver error event/g) ?? []
      ).length
      expect(couldNotDeliverCount).toBe(0)

      // Every response is either a clean status (200/4xx/5xx) or a
      // recognized client-side error — no hangs, no unexpected runtime
      // error classes.
      const ALLOWED_ERROR_PATTERN =
        /AbortError|abort|fetch failed|terminated|operation was aborted/i
      for (const r of results) {
        if (r.error !== undefined) {
          expect(r.error).toMatch(ALLOWED_ERROR_PATTERN)
        } else {
          expect(typeof r.status).toBe("number")
        }
      }
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  },
  60000,
)
