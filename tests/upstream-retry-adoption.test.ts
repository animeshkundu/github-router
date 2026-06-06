/**
 * Adoption tests for the shared transient-retry (`src/lib/upstream-retry.ts`)
 * across the two slices wired in this change:
 *
 *  1. Startup / non-streaming GETs — `getModels`, `getCopilotToken`,
 *     `getGitHubUser`. A transient 429/5xx/network blip retries with
 *     backoff; a deterministic 4xx fails fast. `getModels` keeps the
 *     401-refresh path nested INSIDE the transient retry; the GitHub-PAT
 *     GETs (`getCopilotToken` / `getGitHubUser`) treat 401 as a bad
 *     credential and fail fast (not retried).
 *
 *  2. User-facing passthrough — PRE-FIRST-BYTE retry only. With
 *     `retryTransient: true` the `create-*` clients retry a 429/5xx before
 *     any body is handed to the consumer; without it they are single-shot
 *     (the internal `dispatchModelCall` path, which already has its own
 *     outer retry, must not double-retry). A failure AFTER the first byte
 *     (the stream is already returned) does not re-fetch / duplicate output.
 *     A 4xx and a user-cancel fail fast.
 *
 * fetch is mocked. Backoff runs for real but the default base (250ms) keeps
 * worst-case wall-clock well under a second across at most two retries.
 */

import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test"

import { state } from "../src/lib/state"
import { HTTPError } from "../src/lib/error"
import { getModels } from "../src/services/copilot/get-models"
import { getCopilotToken } from "../src/services/github/get-copilot-token"
import { getGitHubUser } from "../src/services/github/get-user"
import {
  createMessages,
  countTokens,
} from "../src/services/copilot/create-messages"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"
import { createResponses } from "../src/services/copilot/create-responses"

const originalFetch = globalThis.fetch

beforeEach(() => {
  state.copilotToken = "test-token"
  state.githubToken = "gh-test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.copilotApiUrl = undefined
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const MODELS_BODY = { data: [], object: "list" }
const TOKEN_BODY = { token: "fresh", expires_at: 0, refresh_in: 1500 }
const USER_BODY = { login: "octocat" }
const MSG_BODY = {
  type: "message",
  id: "msg",
  role: "assistant",
  model: "m",
  content: [],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 0, output_tokens: 0 },
}

// ──────────────────────────────────────────────────────────────────────────
// Slice 1: startup / non-streaming GETs
// ──────────────────────────────────────────────────────────────────────────

describe("startup GET retry — getModels", () => {
  test("retries a transient 502 then returns the catalog", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return calls < 2 ? json({}, 502) : json(MODELS_BODY)
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    const res = await getModels()
    expect(res).toEqual(MODELS_BODY)
    expect(calls).toBe(2)
  })

  test("retries a transient network error then succeeds", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      if (calls < 2) throw new TypeError("fetch failed")
      return json(MODELS_BODY)
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    const res = await getModels()
    expect(res).toEqual(MODELS_BODY)
    expect(calls).toBe(2)
  })

  test("does NOT retry a deterministic 404 — fails fast", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return json({ error: "nope" }, 404)
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    await expect(getModels()).rejects.toBeInstanceOf(HTTPError)
    expect(calls).toBe(1)
  })

  test("a 401 routes through the refresh path (one refresh fetch), not the transient retry", async () => {
    // getModels nests tryRefreshAndRetry INSIDE fetchWithTransientRetry.
    // A 401 is not a transient status, so the transient layer does NOT
    // retry it; the 401-refresh path issues exactly one token-exchange
    // fetch then re-invokes the request once. Sequence:
    //   1) /models → 401
    //   2) refresh → token exchange GET (200)
    //   3) /models retry → 200
    const urls: Array<string> = []
    let modelsCalls = 0
    const fetchMock = mock((url: string) => {
      urls.push(url)
      if (url.includes("/copilot_internal/v2/token")) return json(TOKEN_BODY)
      // /models
      modelsCalls++
      return modelsCalls < 2 ? json({}, 401) : json(MODELS_BODY)
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    const res = await getModels()
    expect(res).toEqual(MODELS_BODY)
    // exactly two /models attempts (initial 401 + one post-refresh retry),
    // not the 3 a transient retry would give.
    expect(modelsCalls).toBe(2)
    expect(urls.some((u) => u.includes("/copilot_internal/v2/token"))).toBe(true)
  })
})

describe("startup GET retry — getCopilotToken (GitHub PAT exchange)", () => {
  test("retries a transient 503 then returns the token", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return calls < 2 ? json({}, 503) : json(TOKEN_BODY)
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    const res = await getCopilotToken()
    expect(res.token).toBe("fresh")
    expect(calls).toBe(2)
  })

  test("does NOT retry a 401 (bad GitHub PAT) — fails fast", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return json({ message: "Bad credentials" }, 401)
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    await expect(getCopilotToken()).rejects.toBeInstanceOf(HTTPError)
    expect(calls).toBe(1)
  })
})

describe("startup GET retry — getGitHubUser (GitHub PAT GET)", () => {
  test("retries a transient 500 then returns the user", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return calls < 2 ? json({}, 500) : json(USER_BODY)
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    const res = await getGitHubUser()
    expect(res.login).toBe("octocat")
    expect(calls).toBe(2)
  })

  test("does NOT retry a 403 — fails fast", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return json({ message: "forbidden" }, 403)
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    await expect(getGitHubUser()).rejects.toBeInstanceOf(HTTPError)
    expect(calls).toBe(1)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Slice 2: user-facing passthrough — pre-first-byte retry ONLY
// ──────────────────────────────────────────────────────────────────────────

describe("passthrough pre-first-byte retry — createMessages", () => {
  test("retryTransient:true retries a 502 BEFORE first byte then returns 200", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return calls < 2 ? json({}, 502) : json(MSG_BODY)
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    const res = await createMessages("{}", undefined, undefined, true)
    expect(res.status).toBe(200)
    expect(calls).toBe(2)
  })

  test("retryTransient:true retries a 429 then succeeds", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return calls < 2 ? json({}, 429) : json(MSG_BODY)
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    const res = await createMessages("{}", undefined, undefined, true)
    expect(res.status).toBe(200)
    expect(calls).toBe(2)
  })

  test("default (retryTransient omitted) is SINGLE-SHOT — internal callers must not double-retry", async () => {
    // dispatchModelCall already wraps createMessages in its own
    // withTransientRetry; the client must NOT add a second retry layer.
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return json({ type: "error", error: { type: "x", message: "boom" } }, 502)
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    await expect(createMessages("{}")).rejects.toBeInstanceOf(HTTPError)
    expect(calls).toBe(1)
  })

  test("retryTransient:true does NOT retry a 400 — fails fast", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return json({ type: "error", error: { type: "x", message: "bad" } }, 400)
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    await expect(createMessages("{}", undefined, undefined, true)).rejects.toBeInstanceOf(HTTPError)
    expect(calls).toBe(1)
  })

  test("a user-cancel (pre-aborted signal) fails fast — never fetches", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return json(MSG_BODY)
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    const ac = new AbortController()
    ac.abort()
    await expect(createMessages("{}", undefined, ac.signal, true)).rejects.toThrow()
    expect(calls).toBe(0)
  })

  test("does NOT retry after the first byte — a mid-stream error never re-fetches", async () => {
    // The pre-first-byte window closes when createMessages returns the raw
    // streaming Response. Here the upstream body delivers ONE valid SSE
    // chunk and THEN errors mid-stream (the exact transient-shaped failure
    // — TypeError "terminated"). A retry at this point would replay
    // message_start and duplicate output, so there must be NO second fetch:
    // recovery is the consumer's, not the client's.
    let calls = 0
    const firstChunk = 'event: message_start\ndata: {"type":"message_start"}\n\n'
    const fetchMock = mock(() => {
      calls++
      let stage = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (stage === 0) {
            // First pull: hand the consumer one valid SSE chunk.
            controller.enqueue(new TextEncoder().encode(firstChunk))
            stage = 1
          } else {
            // Subsequent pull (after the first byte was delivered): fail
            // mid-stream with the transient-shaped error.
            controller.error(new TypeError("terminated"))
          }
        },
      })
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock

    const res = await createMessages('{"stream":true}', undefined, undefined, true)
    expect(res.headers.get("content-type")).toBe("text/event-stream")

    // Drain: we must observe the first chunk, then the mid-stream error —
    // and crucially, fetch must NOT have been called a second time.
    const reader = res.body!.getReader()
    let sawFirstChunk = false
    let midStreamError: unknown
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value && value.length > 0) sawFirstChunk = true
      }
    } catch (err) {
      midStreamError = err
    }
    expect(sawFirstChunk).toBe(true)
    expect(midStreamError).toBeDefined()
    expect((midStreamError as Error).name).toBe("TypeError")
    expect(calls).toBe(1)
  })
})

describe("passthrough pre-first-byte retry — countTokens", () => {
  test("retryTransient:true retries a 503 then returns 200", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return calls < 2 ? json({}, 503) : json({ input_tokens: 7 })
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    const res = await countTokens("{}", undefined, undefined, true)
    expect(res.status).toBe(200)
    expect(calls).toBe(2)
  })

  test("default is single-shot", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return json({ type: "error", error: { type: "x", message: "boom" } }, 502)
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    await expect(countTokens("{}")).rejects.toBeInstanceOf(HTTPError)
    expect(calls).toBe(1)
  })
})

describe("passthrough pre-first-byte retry — createChatCompletions", () => {
  const PAYLOAD = { model: "m", messages: [{ role: "user" as const, content: "hi" }] }

  test("retryTransient:true retries a 500 then returns the non-streaming body", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return calls < 2
        ? json({}, 500)
        : json({ id: "c", object: "chat.completion", created: 0, model: "m", choices: [] })
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    const res = (await createChatCompletions(PAYLOAD, undefined, undefined, true)) as {
      id: string
    }
    expect(res.id).toBe("c")
    expect(calls).toBe(2)
  })

  test("default is single-shot", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return json({ error: "boom" }, 502)
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    await expect(createChatCompletions(PAYLOAD)).rejects.toBeInstanceOf(HTTPError)
    expect(calls).toBe(1)
  })

  test("does NOT re-fetch after a streaming response is returned", async () => {
    let calls = 0
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
    const fetchMock = mock(() => {
      calls++
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    // events(response) is returned; consuming it must not re-fetch.
    const stream = await createChatCompletions(
      { ...PAYLOAD, stream: true },
      undefined,
      undefined,
      true,
    )
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of stream as AsyncIterable<unknown>) {
      // drain
    }
    expect(calls).toBe(1)
  })
})

describe("passthrough pre-first-byte retry — createResponses", () => {
  const PAYLOAD = { model: "m", input: "hi" }

  test("retryTransient:true retries a 504 then returns the non-streaming body", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return calls < 2
        ? json({}, 504)
        : json({ id: "r", object: "response", status: "completed", output: [] })
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    const res = (await createResponses(PAYLOAD, undefined, undefined, true)) as {
      id: string
    }
    expect(res.id).toBe("r")
    expect(calls).toBe(2)
  })

  test("default is single-shot", async () => {
    let calls = 0
    const fetchMock = mock(() => {
      calls++
      return json({ error: "boom" }, 503)
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    await expect(createResponses(PAYLOAD)).rejects.toBeInstanceOf(HTTPError)
    expect(calls).toBe(1)
  })

  test("does NOT re-fetch after a streaming response is returned", async () => {
    let calls = 0
    const sse = 'data: {"type":"response.output_text.delta","delta":"hi"}\n\n'
    const fetchMock = mock(() => {
      calls++
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    })
    // @ts-expect-error - override fetch
    globalThis.fetch = fetchMock
    const stream = await createResponses(
      { ...PAYLOAD, stream: true },
      undefined,
      undefined,
      true,
    )
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of stream as AsyncIterable<unknown>) {
      // drain
    }
    expect(calls).toBe(1)
  })
})
