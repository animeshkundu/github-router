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

        // Two abort flavours, both intentionally racy in different ways:
        //   - timer-based: schedules abort at a random ms after request
        //     start. Tests the "abort fires before any byte arrived" path.
        //   - milestone-based: reads the first downstream chunk, THEN aborts.
        //     Deterministically lands the abort INSIDE the pull()-mid-await
        //     window, which is the race that produced the original
        //     controller-already-closed bug. The timer-only approach can
        //     fire too early under load and miss this window entirely.
        const shouldAbort =
          behavior === "happy_then_client_abort" || i % 4 === 0
        const useMilestoneAbort = shouldAbort && i % 2 === 0
        const useTimerAbort = shouldAbort && !useMilestoneAbort
        if (useTimerAbort) {
          setTimeout(() => ac.abort(), Math.floor(Math.random() * 8) + 2)
        }

        try {
          const res = await fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: reqBody,
            signal: ac.signal,
          })
          let bodyLen = 0
          if (useMilestoneAbort && res.body) {
            // Read first chunk to confirm the wrapper's pull() has started,
            // then abort. This deterministically lands the abort in the
            // pull()-mid-await window — the race CLAUDE.md flags as the
            // class of bug the chaos test is supposed to catch.
            const reader = res.body.getReader()
            try {
              const first = await reader.read()
              if (first.value) bodyLen += first.value.byteLength
              ac.abort()
              while (true) {
                const r = await reader.read()
                if (r.done) break
                if (r.value) bodyLen += r.value.byteLength
              }
            } catch {
              // Abort propagates as a read error — that's the path under test.
            }
          } else {
            // Drain the body so the wrapper's pull() runs to completion (or
            // aborts via the timer-scheduled abort).
            const body = await res.text().catch(() => "")
            bodyLen = body.length
          }
          results.push({
            behavior,
            status: res.status,
            bodyLen,
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

      // Consumer-cancel paths must NOT produce "Upstream stream interrupted"
      // log lines — those are reserved for genuine upstream failures
      // (midstream_error, upstream_rst). Bound conservatively: at most one
      // line per real-upstream-failure iteration.
      const realFailureBehaviors = new Set<ChaosBehavior>([
        "midstream_error",
        "upstream_rst",
      ])
      const realFailureIterations = behaviors.filter((b) =>
        realFailureBehaviors.has(b),
      ).length * Math.ceil(ITERATIONS / behaviors.length)
      const upstreamInterruptedCount = (
        newLines.match(/Upstream stream interrupted/g) ?? []
      ).length
      expect(upstreamInterruptedCount).toBeLessThanOrEqual(
        realFailureIterations,
      )

      // Allowlist for client-error patterns. Anything else means the abort
      // path produced an unexpected runtime error class — the assertion
      // catches regressions that the previous `typeof e === "string"` check
      // would have silently accepted.
      const ALLOWED_ERROR_PATTERN =
        /AbortError|abort|fetch failed|terminated|operation was aborted/i
      // Every response is either a clean status (200/4xx/5xx) or a
      // recognized client-side error — no hangs (the test has implicit
      // timeout protection from bun:test, but we also assert results all
      // settled).
      for (const r of results) {
        if (r.error) {
          expect(r.error).toMatch(ALLOWED_ERROR_PATTERN)
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
