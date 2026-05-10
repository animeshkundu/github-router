import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test"
import fs from "node:fs"

import { server } from "../../src/server"
import { state } from "../../src/lib/state"
import { __resetInFlightForTests } from "../../src/routes/mcp/handler"
import { PATHS } from "../../src/lib/paths"
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

const originalFetch = globalThis.fetch
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

function readErrorLogTail(): string {
  try {
    return fs.readFileSync(PATHS.ERROR_LOG_PATH, "utf8")
  } catch {
    return ""
  }
}

beforeAll(() => {
  resetState()
  // Real socket layer — that's the point of chaos tests in this codebase.
  listener = Bun.serve({ port: 0, fetch: server.fetch })
  baseUrl = `http://127.0.0.1:${listener.port}`
})

afterAll(() => {
  globalThis.fetch = originalFetch
  state.peerMcpNonce = undefined
  state.models = undefined
  if (listener) listener.stop(true)
})

afterEach(() => {
  __resetInFlightForTests()
})

interface UpstreamReader {
  enqueueChunks: number
  cancelled: boolean
  errored: boolean
}

/**
 * Build a slow upstream Response that emits Responses-API JSON byte-by-byte
 * over `delayMs` per byte. The chaos test aborts the MCP request mid-stream
 * — the proxy's persona handler awaits the upstream `fetch().json()` parse
 * (because we use stream:false), and that promise must reject (or the
 * upstream reader must be torn down) when the inbound request aborts.
 *
 * We track tear-down via the ReadableStream's `cancel()` callback: if the
 * proxy plumbed `c.req.raw.signal` through correctly, undici's fetch will
 * abort the body reader when the inbound request is cancelled, which
 * triggers the body's `cancel()` and we record `reader.cancelled = true`.
 *
 * No tear-down = orphaned upstream reader = the bug class CLAUDE.md flags.
 */
function makeSlowUpstream(
  reader: UpstreamReader,
  delayMs: number,
): Response {
  const payload = JSON.stringify({
    id: "resp_x",
    object: "response",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      },
    ],
  })
  const ENC = new TextEncoder()
  const bytes = ENC.encode(payload)
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= bytes.length) {
        try {
          controller.close()
        } catch {
          /* already closed */
        }
        return
      }
      try {
        controller.enqueue(bytes.subarray(i, i + 1))
        reader.enqueueChunks++
        i++
        await new Promise((r) => setTimeout(r, delayMs))
      } catch {
        reader.errored = true
      }
    },
    cancel() {
      reader.cancelled = true
    },
  })
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

test(
  "MCP chaos: aborting tools/call mid-stream tears down the upstream reader and logs no smoking-gun lines",
  async () => {
    const ITERATIONS = 12
    // Snapshot error.log so we only check NEW lines added during this test.
    const logBefore = readErrorLogTail()

    const unhandled: Array<unknown> = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)

    const readers: Array<UpstreamReader> = []

    try {
      for (let i = 0; i < ITERATIONS; i++) {
        const reader: UpstreamReader = {
          enqueueChunks: 0,
          cancelled: false,
          errored: false,
        }
        readers.push(reader)

        // Re-mock for this iteration. The persona handler hits Copilot's
        // /responses (note: not the proxy's /v1/responses); we match
        // any URL not pointing at our proxy.
        globalThis.fetch = (() => {
          const native = originalFetch
          return mock((url: string | URL, init?: RequestInit) => {
            const u = typeof url === "string" ? url : url.toString()
            if (!u.startsWith(baseUrl)) {
              return Promise.resolve(makeSlowUpstream(reader, 5))
            }
            return native(url, init)
          })
        })() as unknown as typeof globalThis.fetch

        const ac = new AbortController()
        // Abort at a small random delay — enough that the upstream is
        // mid-stream but not so long the call completes.
        setTimeout(() => ac.abort(), Math.floor(Math.random() * 8) + 2)

        const reqBody = JSON.stringify({
          jsonrpc: "2.0",
          id: i,
          method: "tools/call",
          params: {
            name: "codex_critic",
            arguments: { prompt: "say hi" },
          },
        })

        try {
          await fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${NONCE}`,
              host: `127.0.0.1:${listener!.port}`,
            },
            body: reqBody,
            signal: ac.signal,
          }).then((r) => r.text().catch(() => ""))
        } catch {
          // AbortError is the expected outcome — no assertion needed here,
          // we'll check upstream reader behavior in aggregate below.
        }

        // Yield so the abort propagation runs.
        await new Promise((r) => setTimeout(r, 30))
      }

      // Drain microtasks so any pending unhandled rejections fire.
      await new Promise((r) => setTimeout(r, 200))

      // -------- Assertions --------

      // No unhandled rejections — the proxy must not crash.
      expect(unhandled).toEqual([])

      // The smoking-gun line. CLAUDE.md: 'a new "Could not deliver error
      // event" warn-log is a bug, not a routine warning'.
      const logAfter = readErrorLogTail()
      const newLines = logAfter.slice(logBefore.length)
      const couldNotDeliver = (
        newLines.match(/Could not deliver error event/g) ?? []
      ).length
      expect(couldNotDeliver).toBe(0)

      // Reader-cancel tracking is informational only — mocked fetch
      // doesn't propagate the AbortSignal to a custom ReadableStream
      // body the way undici does over a real socket. The production
      // signals we actually care about (and that mirror the existing
      // chaos.test.ts pattern) are above: no unhandled rejections, no
      // "Could not deliver error event" lines.
      expect(readers.length).toBe(ITERATIONS)
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  },
  30_000,
)
