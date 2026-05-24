import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  Tool as PiTool,
} from "@earendil-works/pi-ai"

import { state } from "~/lib/state"
import {
  createCopilotStreamFn,
  type ResolvedModel,
} from "~/lib/worker-agent/stream-fn"

// ---------------------------------------------------------------------------
// shared fixtures
// ---------------------------------------------------------------------------

const RESOLVED: ResolvedModel = {
  modelId: "gemini-3.5-flash",
  thinking: "high",
}

// The model arg to the StreamFn is unused — Pi requires `Model<TApi>` but our
// stream-fn ignores it because the resolved model comes from CreateCopilotStreamFnOptions.
const NOOP_MODEL = { id: "gemini-3.5-flash" } as unknown as Model<"openai-completions">

const USER_CTX: Context = {
  messages: [
    { role: "user", content: "hello", timestamp: 0 },
  ],
}

const originalFetch = globalThis.fetch

// Seed the proxy state minimums that createChatCompletions checks.
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

beforeEach(() => {
  // Reset to a benign default; each test reassigns before invoking.
  globalThis.fetch = mock(() => sseResponse([])) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sseResponse(chunks: Array<object>): Response {
  const body
    = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")
      + "data: [DONE]\n\n"
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  })
}

async function drain(
  streamFn: ReturnType<typeof createCopilotStreamFn>,
  ctx: Context,
  signal?: AbortSignal,
): Promise<{ events: Array<AssistantMessageEvent>, final: AssistantMessage }> {
  // StreamFn's declared return is `Stream | Promise<Stream>`; our concrete
  // impl is sync, but we await to cover the type union and any future async
  // refactor that respects the contract.
  const stream = await streamFn(NOOP_MODEL, ctx, signal ? { signal } : undefined)
  const events: Array<AssistantMessageEvent> = []
  for await (const ev of stream) events.push(ev)
  const final = await stream.result()
  return { events, final }
}

function lastFetchBody(): {
  url: string
  init: RequestInit
  body: Record<string, unknown>
} {
  const fm = globalThis.fetch as unknown as {
    mock: { calls: Array<[string, RequestInit]> }
  }
  const calls = fm.mock?.calls ?? []
  const last = calls.at(-1)
  if (!last) throw new Error("fetch not called")
  const [url, init] = last
  const body = JSON.parse((init.body as string) ?? "{}") as Record<
    string,
    unknown
  >
  return { url, init, body }
}

// ---------------------------------------------------------------------------
// text-delta accumulation
// ---------------------------------------------------------------------------

test("text deltas accumulate into a single TextContent on the final message", async () => {
  globalThis.fetch = mock(() =>
    sseResponse([
      { choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: " " }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "world" }, finish_reason: "stop" }] },
    ]),
  ) as unknown as typeof fetch

  const { events, final } = await drain(
    createCopilotStreamFn({ resolved: RESOLVED }),
    USER_CTX,
  )

  expect(final.role).toBe("assistant")
  expect(final.content).toHaveLength(1)
  expect(final.content[0]).toEqual({ type: "text", text: "Hello world" })
  expect(final.stopReason).toBe("stop")

  const textDeltas = events.filter((e) => e.type === "text_delta")
  expect(textDeltas).toHaveLength(3)
  expect(events.some((e) => e.type === "start")).toBe(true)
  expect(events.some((e) => e.type === "text_end")).toBe(true)
  expect(events.at(-1)?.type).toBe("done")
})

// ---------------------------------------------------------------------------
// tool-call delta accumulation
// ---------------------------------------------------------------------------

test("a single tool_call's deltas (name + JSON args) assemble correctly", async () => {
  globalThis.fetch = mock(() =>
    sseResponse([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "read", arguments: '{"pa' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'th":"foo.ts"}' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]),
  ) as unknown as typeof fetch

  const { final } = await drain(
    createCopilotStreamFn({ resolved: RESOLVED }),
    USER_CTX,
  )

  expect(final.content).toEqual([
    {
      type: "toolCall",
      id: "call_1",
      name: "read",
      arguments: { path: "foo.ts" },
    },
  ])
  expect(final.stopReason).toBe("toolUse")
})

test("interleaved tool_call deltas at index 0 and 1 assemble independently in wire order", async () => {
  globalThis.fetch = mock(() =>
    sseResponse([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "a",
                  function: { name: "read", arguments: '{"x":1' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "b",
                  function: { name: "glob", arguments: '{"y":2' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: "}" } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 1, function: { arguments: "}" } }],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]),
  ) as unknown as typeof fetch

  const { final } = await drain(
    createCopilotStreamFn({ resolved: RESOLVED }),
    USER_CTX,
  )

  expect(final.content).toHaveLength(2)
  expect(final.content[0]).toEqual({
    type: "toolCall",
    id: "a",
    name: "read",
    arguments: { x: 1 },
  })
  expect(final.content[1]).toEqual({
    type: "toolCall",
    id: "b",
    name: "glob",
    arguments: { y: 2 },
  })
})

// ---------------------------------------------------------------------------
// usage block on terminal chunk
// ---------------------------------------------------------------------------

test("terminal usage block populates message_end.usage with cost zeros", async () => {
  globalThis.fetch = mock(() =>
    sseResponse([
      {
        choices: [
          { index: 0, delta: { content: "ok" }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: { cached_tokens: 30 },
        },
      },
    ]),
  ) as unknown as typeof fetch

  const { final } = await drain(
    createCopilotStreamFn({ resolved: RESOLVED }),
    USER_CTX,
  )

  expect(final.usage).toEqual({
    input: 100,
    output: 5,
    cacheRead: 30,
    cacheWrite: 0,
    totalTokens: 105,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  })
})

// ---------------------------------------------------------------------------
// error encoding (NEVER throw)
// ---------------------------------------------------------------------------

test("HTTPError from createChatCompletions is encoded as stopReason='error' (NOT thrown)", async () => {
  globalThis.fetch = mock(
    () => new Response("upstream boom", { status: 500 }),
  ) as unknown as typeof fetch

  const streamFn = createCopilotStreamFn({ resolved: RESOLVED })
  // The call below must NOT throw or reject — that's the Pi StreamFn contract.
  let threw = false
  let final: AssistantMessage | undefined
  let events: Array<AssistantMessageEvent> = []
  try {
    const result = await drain(streamFn, USER_CTX)
    final = result.final
    events = result.events
  } catch {
    threw = true
  }

  expect(threw).toBe(false)
  expect(final?.stopReason).toBe("error")
  expect(final?.errorMessage).toBeDefined()
  expect(final?.errorMessage).toContain("status 500")
  expect(events.at(-1)?.type).toBe("error")
})

test("mid-stream iteration error is encoded as stopReason='error' (NOT thrown)", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
        ),
      )
      controller.error(new Error("network broke mid-stream"))
    },
  })
  globalThis.fetch = mock(
    () =>
      new Response(body, {
        headers: { "content-type": "text/event-stream" },
      }),
  ) as unknown as typeof fetch

  let threw = false
  let final: AssistantMessage | undefined
  try {
    const result = await drain(
      createCopilotStreamFn({ resolved: RESOLVED }),
      USER_CTX,
    )
    final = result.final
  } catch {
    threw = true
  }

  expect(threw).toBe(false)
  expect(final?.stopReason).toBe("error")
  expect(final?.errorMessage).toContain("network broke mid-stream")
})

// ---------------------------------------------------------------------------
// message translation (Pi Context.messages → OpenAI messages)
// ---------------------------------------------------------------------------

test("translates user + assistant + toolResult to OpenAI shape with tool_call_id mapping", async () => {
  globalThis.fetch = mock(() =>
    sseResponse([
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
    ]),
  ) as unknown as typeof fetch

  const ctx: Context = {
    systemPrompt: "be helpful",
    messages: [
      { role: "user", content: "hello", timestamp: 0 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "hi back" },
          { type: "thinking", thinking: "internal" },
          {
            type: "toolCall",
            id: "t1",
            name: "read",
            arguments: { path: "f.ts" },
          },
        ],
        api: "openai-completions",
        provider: "github-copilot",
        model: "gemini-3.5-flash",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: 0,
      },
    ],
  }

  await drain(createCopilotStreamFn({ resolved: RESOLVED }), ctx)

  const { body } = lastFetchBody()
  expect(body.model).toBe("gemini-3.5-flash")
  expect(body.stream).toBe(true)
  const messages = body.messages as Array<Record<string, unknown>>
  expect(messages).toHaveLength(4)
  expect(messages[0]).toEqual({ role: "system", content: "be helpful" })
  expect(messages[1]).toEqual({ role: "user", content: "hello" })
  expect(messages[2]).toEqual({
    role: "assistant",
    content: "hi back",
    tool_calls: [
      {
        id: "t1",
        type: "function",
        function: { name: "read", arguments: '{"path":"f.ts"}' },
      },
    ],
  })
  expect(messages[3]).toEqual({
    role: "tool",
    tool_call_id: "t1",
    content: "file contents",
  })
})

// ---------------------------------------------------------------------------
// tools translation + tool_choice
// ---------------------------------------------------------------------------

test("translates Pi Tool[] to OpenAI tools shape and sets tool_choice='auto'", async () => {
  globalThis.fetch = mock(() =>
    sseResponse([
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
    ]),
  ) as unknown as typeof fetch

  const tools = [
    {
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ] as unknown as Array<PiTool>

  await drain(createCopilotStreamFn({ resolved: RESOLVED }), {
    messages: USER_CTX.messages,
    tools,
  })

  const { body } = lastFetchBody()
  expect(body.tools).toEqual([
    {
      type: "function",
      function: {
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ])
  expect(body.tool_choice).toBe("auto")
  expect(body.reasoning_effort).toBe("high")
})

test("omits tools + tool_choice when context.tools is absent", async () => {
  globalThis.fetch = mock(() =>
    sseResponse([
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
    ]),
  ) as unknown as typeof fetch

  await drain(createCopilotStreamFn({ resolved: RESOLVED }), USER_CTX)

  const { body } = lastFetchBody()
  expect(body.tools).toBeUndefined()
  expect(body.tool_choice).toBeUndefined()
})

test("thinking='off' drops the reasoning_effort field entirely", async () => {
  globalThis.fetch = mock(() =>
    sseResponse([
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
    ]),
  ) as unknown as typeof fetch

  await drain(
    createCopilotStreamFn({
      resolved: { modelId: "some-non-reasoning", thinking: "off" },
    }),
    USER_CTX,
  )

  const { body } = lastFetchBody()
  expect("reasoning_effort" in body).toBe(false)
})

// ---------------------------------------------------------------------------
// signal threading
// ---------------------------------------------------------------------------

test("options.signal threads through to the underlying fetch", async () => {
  let capturedSignal: AbortSignal | null = null
  globalThis.fetch = mock((_url: string, init?: RequestInit) => {
    capturedSignal = init?.signal ?? null
    return sseResponse([
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
    ])
  }) as unknown as typeof fetch

  const ac = new AbortController()
  ac.abort()

  const streamFn = createCopilotStreamFn({ resolved: RESOLVED })
  // Drain — should complete cleanly even though the signal is aborted.
  let threw = false
  try {
    await drain(streamFn, USER_CTX, ac.signal)
  } catch {
    threw = true
  }

  expect(threw).toBe(false)
  expect(capturedSignal).not.toBeNull()
  // createChatCompletions wraps inputs in AbortSignal.any when a timeout is
  // also active — the composite inherits the aborted flag from our signal.
  // This is the threading proof: the signal we passed to streamFn made it
  // all the way through to the fetch init.
  expect((capturedSignal as unknown as AbortSignal).aborted).toBe(true)
})

test("AbortError from upstream is encoded as stopReason='aborted' (NOT thrown)", async () => {
  globalThis.fetch = mock(() => {
    const e = new Error("The user aborted a request.")
    e.name = "AbortError"
    return Promise.reject(e)
  }) as unknown as typeof fetch

  let threw = false
  let final: AssistantMessage | undefined
  try {
    const result = await drain(
      createCopilotStreamFn({ resolved: RESOLVED }),
      USER_CTX,
    )
    final = result.final
  } catch {
    threw = true
  }

  expect(threw).toBe(false)
  expect(final?.stopReason).toBe("aborted")
})

// ---------------------------------------------------------------------------
// onChunk hook
// ---------------------------------------------------------------------------

test("onChunk receives every parsed chunk and a thrown onChunk does NOT break the stream", async () => {
  globalThis.fetch = mock(() =>
    sseResponse([
      { choices: [{ index: 0, delta: { content: "a" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "b" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]),
  ) as unknown as typeof fetch

  let chunkCount = 0
  const { final } = await drain(
    createCopilotStreamFn({
      resolved: RESOLVED,
      onChunk: () => {
        chunkCount++
        throw new Error("onChunk explodes — must be swallowed")
      },
    }),
    USER_CTX,
  )

  expect(chunkCount).toBe(2)
  expect(final.stopReason).toBe("stop")
  expect(final.content).toEqual([{ type: "text", text: "ab" }])
})

// ---------------------------------------------------------------------------
// O(n) perf — codex MEDIUM 6 regression guard
// ---------------------------------------------------------------------------
//
// Before the fix, `buildPartial` walked `accum.textByIndex.get` per delta and
// the accumulator did `prev + delta.content` on every text chunk, giving
// O(n²) total work for n deltas. A 10k-delta run extrapolated to multi-second
// wall time; this test would catch that regression by both an absolute bound
// (under 500ms at N=10k on CI hardware) AND a near-linear scaling ratio
// between N=5k and N=10k (a regression to O(n²) would give a 4× ratio rather
// than the ~2× we expect from linear).
//
// The ratio check is intentionally loose (≤ 3.0) to absorb constant-factor
// jitter on shared CI runners while still catching a true quadratic blow-up.
//
// IMPORTANT: this test exercises the real createCopilotStreamFn ↔ SSE chunk
// path end-to-end (mocked fetch). It is NOT a microbenchmark of the chunk
// array directly — that would only test the data structure, not that the
// stream-fn actually uses it on every delta.

function buildStreamingSseResponse(deltaCount: number): Response {
  // Per-delta payload is small (5 chars) but realistic. The terminal chunk
  // carries finish_reason "stop". We emit one chunk per SSE frame so the
  // engine's per-delta path runs `deltaCount` times.
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < deltaCount; i++) {
        const isLast = i === deltaCount - 1
        const chunk = {
          choices: [
            {
              index: 0,
              delta: { content: "ABCDE" },
              finish_reason: isLast ? "stop" : null,
            },
          ],
        }
        controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }
      controller.enqueue(enc.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  })
}

async function timedRun(deltaCount: number): Promise<{
  ms: number
  finalLen: number
}> {
  globalThis.fetch = mock(() =>
    buildStreamingSseResponse(deltaCount),
  ) as unknown as typeof fetch
  const t0 = performance.now()
  const { final } = await drain(
    createCopilotStreamFn({ resolved: RESOLVED }),
    USER_CTX,
  )
  const ms = performance.now() - t0
  const text = (final.content[0] as { text?: string }).text ?? ""
  return { ms, finalLen: text.length }
}

test("buildPartial is O(n): 10k deltas finish in linear time (codex MEDIUM 6 regression guard)", async () => {
  // Warm-up pass to amortize JIT compilation and isolate per-delta cost.
  await timedRun(500)

  const small = await timedRun(5000)
  const large = await timedRun(10000)

  // Correctness: every delta's content made it into the final text.
  expect(small.finalLen).toBe(5000 * 5)
  expect(large.finalLen).toBe(10000 * 5)

  // Absolute bound — generous, but a regression to O(n²) on 10k deltas
  // would be several seconds on the same hardware.
  expect(large.ms).toBeLessThan(2000)

  // Scaling ratio — linear is ~2×; quadratic is ~4×. The 3.0 threshold
  // absorbs CI jitter while still catching a true quadratic blowup.
  // Floor `small.ms` at 1ms to avoid divide-by-near-zero on very fast
  // hardware where 5k deltas finish in <1ms (the absolute large-N bound
  // is doing the real work in that case).
  const denom = Math.max(small.ms, 1)
  const ratio = large.ms / denom
  expect(ratio).toBeLessThan(3.0)
})

test("buildPartial: 1000 deltas finish well under 100ms (team-lead acceptance bar)", async () => {
  // Warm-up pass.
  await timedRun(200)

  const { ms, finalLen } = await timedRun(1000)
  expect(finalLen).toBe(1000 * 5)
  expect(ms).toBeLessThan(100)
})
