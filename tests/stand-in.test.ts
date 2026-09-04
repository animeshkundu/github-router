import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  runStandIn,
  standInModels,
  type ModelKey,
  type StandInResult,
  type Vote,
  type VoteFailure,
} from "~/lib/stand-in"
import { runStandInToolCall } from "~/lib/peer-mcp-personas"
import { state } from "~/lib/state"

// ────────────────────────────────────────────────────────────────────
// Fixtures + minimal Copilot state required by createX upstream
// callers (createResponses / createMessages / createChatCompletions).
// ────────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch

// Hermetic 3-peer catalog. Without this, these tests inherit whatever
// `state.models` a prior test file left behind (bun discovers files in a
// filesystem order that differs between dev machines and CI). A polluted
// catalog missing the OpenAI frontier models makes `resolveOpenAiFrontier()`
// return undefined → the OpenAI peer dispatch fails → the ≥2/3 abstain
// short-circuit and vote tallies break (observed as `no_consensus` /
// double-consumed queues only on CI). Pin the canonical panel so every
// stand_in test resolves all three peers deterministically.
const STAND_IN_CATALOG = {
  object: "list" as const,
  data: [
    {
      id: "gpt-5.6-sol",
      capabilities: { limits: { max_prompt_tokens: 1_000_000 } },
      supported_endpoints: ["/responses"],
    },
    {
      id: "claude-opus-5",
      capabilities: { limits: { max_prompt_tokens: 1_000_000 } },
      supported_endpoints: ["/v1/messages"],
    },
    {
      id: "gemini-3.1-pro-preview",
      capabilities: { limits: { max_prompt_tokens: 1_000_000 } },
      supported_endpoints: ["/chat/completions"],
    },
  ],
} as unknown as NonNullable<typeof state.models>

beforeEach(() => {
  // The wire helpers read state.copilotToken / state.vsCodeVersion etc.
  // for headers; without these, header-build code paths can throw before
  // we ever hit our mocked fetch. Set the minimum surface they need.
  state.copilotToken = "test-copilot-token"
  state.githubToken = "test-gh-token"
  state.vsCodeVersion = "1.99.0"
  state.copilotVersion = "0.43.0"
  state.accountType = "individual"
  state.models = STAND_IN_CATALOG
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = undefined
})

// Per-model vote payload helper. Returns the JSON string the model
// would emit for one round, matching the schema runStandIn parses.
function voteJson(opts: {
  choice: string | null
  confidence: number
  reasoning: string
  needMoreInfo?: string
  alternative?: string
}): string {
  const obj: Record<string, unknown> = {
    choice: opts.choice,
    confidence: opts.confidence,
    reasoning: opts.reasoning,
  }
  if (opts.needMoreInfo) obj.need_more_info = opts.needMoreInfo
  if (opts.alternative) obj.alternative = opts.alternative
  return JSON.stringify(obj)
}

// Fetch mock that routes by URL. Each call to a given model consumes
// the NEXT entry in its queue. Throws if a queue is exhausted (helps
// catch tests that under-prime the mocks).
//
// Use `null` as a queue entry to simulate a terminal upstream error.
// Status 400 (NOT 5xx) so it is non-retryable — the shared transient-retry
// in `dispatchModelCall` retries 5xx/429, which would otherwise consume the
// next queued response. These resilience tests exercise the "a model call
// fails → tolerate it" path; the retry-recover path is covered directly in
// `tests/upstream-retry.test.ts`. Use a string to return that string as the
// assistant text in the appropriate response shape.
function mockThreePeers(
  queues: Record<"gpt-5.6-sol" | "claude-opus-5" | "gemini-3.1-pro-preview", Array<string | null>>,
) {
  const consumed: Record<"gpt-5.6-sol" | "claude-opus-5" | "gemini-3.1-pro-preview", number> = {
    "gpt-5.6-sol": 0,
    "claude-opus-5": 0,
    "gemini-3.1-pro-preview": 0,
  }
  // Records each outgoing request's serialized body, in call order, so a
  // test can assert on what was actually sent to each model (e.g. that a
  // round-1 prompt carries no peer votes — the blind-R1 invariant).
  const bodies: Array<{ key: ModelKey; body: string }> = []

  globalThis.fetch = mock(async (url, _init) => {
    const u = typeof url === "string" ? url : (url as URL).toString()
    const key: ModelKey =
      u.includes("/responses") ? "gpt-5.6-sol"
      : u.includes("/v1/messages") ? "claude-opus-5"
      : u.includes("/chat/completions") ? "gemini-3.1-pro-preview"
      : (() => { throw new Error(`unexpected upstream URL: ${u}`) })()

    const rawBody = (_init as RequestInit | undefined)?.body
    bodies.push({ key, body: typeof rawBody === "string" ? rawBody : rawBody ? String(rawBody) : "" })

    const idx = consumed[key]++
    const entry = queues[key]?.[idx]
    if (entry === undefined) {
      throw new Error(`mock queue for ${key} exhausted at call ${idx + 1}`)
    }
    if (entry === null) {
      return new Response("upstream rejected", { status: 400, headers: { "content-type": "text/plain" } })
    }

    if (key === "gpt-5.6-sol") {
      return new Response(JSON.stringify({
        id: "resp_test",
        object: "response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: entry }],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } })
    }
    if (key === "claude-opus-5") {
      return new Response(JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: entry }],
        stop_reason: "end_turn",
      }), { status: 200, headers: { "content-type": "application/json" } })
    }
    // gemini
    return new Response(JSON.stringify({
      id: "chatcmpl_test",
      object: "chat.completion",
      created: 0,
      model: "gemini-3.1-pro-preview",
      choices: [{
        index: 0,
        message: { role: "assistant", content: entry },
        finish_reason: "stop",
        logprobs: null,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof globalThis.fetch

  return { consumed, bodies }
}

function maxCatalog(opts: { grok?: boolean } = {}) {
  const models = [
    {
      id: "gpt-5.6-sol",
      capabilities: { limits: { max_prompt_tokens: 1_000_000 } },
      supported_endpoints: ["/responses"],
    },
    {
      id: "claude-opus-5",
      capabilities: { limits: { max_prompt_tokens: 1_000_000 } },
      supported_endpoints: ["/v1/messages"],
    },
    {
      id: "gemini-3.1-pro-preview",
      capabilities: { limits: { max_prompt_tokens: 1_000_000 } },
      supported_endpoints: ["/chat/completions"],
    },
    {
      id: "gemini-3.8-flash",
      capabilities: {
        limits: {
          max_context_window_tokens: 1_000_000,
          max_prompt_tokens: 900_000,
          max_output_tokens: 32_000,
        },
        supports: { tool_calls: true, reasoning_effort: ["low", "medium", "high"] },
      },
      supported_endpoints: ["/chat/completions"],
    },
  ]
  if (opts.grok) {
    models.push({
      id: "grok-4.6",
      capabilities: {
        limits: {
          max_context_window_tokens: 500_000,
          max_prompt_tokens: 372_000,
          max_output_tokens: 32_000,
        },
        supports: { tool_calls: true, reasoning_effort: ["low", "medium", "high"] },
      },
      supported_endpoints: ["/responses"],
    })
  }
  return { object: "list" as const, data: models } as unknown as NonNullable<typeof state.models>
}

// Tiny default input — well under the 32KB pre-flight cap.
const TINY_INPUT = {
  decision: "Which library should we use for date parsing?",
  options: [
    { id: "A", summary: "date-fns — modular, tree-shakeable" },
    { id: "B", summary: "luxon — DateTime objects, time zones built in" },
  ],
  context: "Greenfield TypeScript service; bundle size matters; no timezone-heavy logic yet.",
}

describe("max stand_in panel", () => {
  test("prefers Grok 4.6/high and never selects Gemini Pro", () => {
    state.models = maxCatalog({ grok: true })
    expect(standInModels({ maxProfile: true })).toEqual([
      expect.objectContaining({ key: "gpt-5.6-sol", model: "gpt-5.6-sol" }),
      expect.objectContaining({ key: "claude-opus-5", model: "claude-opus-5" }),
      expect.objectContaining({
        key: "grok-4.6",
        model: "grok-4.6",
        endpoint: "/v1/responses",
        effort: "high",
      }),
    ])
  })

  test("falls back to Gemini 3.8 Flash 1M/high and never selects Gemini Pro", () => {
    state.models = maxCatalog()
    expect(standInModels({ maxProfile: true })).toEqual([
      expect.objectContaining({ key: "gpt-5.6-sol", model: "gpt-5.6-sol" }),
      expect.objectContaining({ key: "claude-opus-5", model: "claude-opus-5" }),
      expect.objectContaining({
        key: "gemini-3.8-flash",
        model: "gemini-3.8-flash",
        endpoint: "/v1/chat/completions",
        effort: "high",
      }),
    ])
    expect(standInModels({ maxProfile: true }).map((entry) => entry.model))
      .not.toContain("gemini-3.1-pro-preview")
  })

  test("standard panel remains Pro-preferred", () => {
    state.models = maxCatalog({ grok: true })
    expect(standInModels().map((entry) => entry.model)).toContain(
      "gemini-3.1-pro-preview",
    )
  })

  test("max tool boundary falls back to Gemini 3.8 Flash/high without Grok", async () => {
    state.models = maxCatalog()
    const requests: Array<Record<string, unknown>> = []
    globalThis.fetch = mock(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(body)
      const vote = voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })
      if (String(url).includes("/v1/messages")) {
        return new Response(JSON.stringify({
          id: "m", type: "message", role: "assistant", model: "claude-opus-5",
          content: [{ type: "text", text: vote }], stop_reason: "end_turn",
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (String(url).includes("/chat/completions")) {
        return new Response(JSON.stringify({
          id: "c", object: "chat.completion", created: 0, model: "gemini-3.8-flash",
          choices: [{ index: 0, message: { role: "assistant", content: vote }, finish_reason: "stop", logprobs: null }],
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({
        id: "r", object: "response", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: vote }] }],
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof globalThis.fetch

    const toolResult = await runStandInToolCall(TINY_INPUT, undefined, true)
    const result = JSON.parse(toolResult.content[0]?.text ?? "{}") as StandInResult
    expect(result.votes["gemini-3.8-flash"]).toBeDefined()
    expect(result.votes["gemini-3.1-pro-preview"]).toBeUndefined()
    const geminiRequest = requests.find((body) => body.model === "gemini-3.8-flash")
    expect(geminiRequest).toBeDefined()
    expect(geminiRequest?.reasoning_effort).toBe("high")
  })

  test("max tool boundary dispatches Grok at high and reports its real vote key", async () => {
    state.models = maxCatalog({ grok: true })
    const requests: Array<Record<string, unknown>> = []
    globalThis.fetch = mock(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(body)
      const vote = voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })
      if (String(url).includes("/v1/messages")) {
        return new Response(JSON.stringify({
          id: "m", type: "message", role: "assistant", model: "claude-opus-5",
          content: [{ type: "text", text: vote }], stop_reason: "end_turn",
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({
        id: "r", object: "response", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: vote }] }],
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof globalThis.fetch

    const toolResult = await runStandInToolCall(TINY_INPUT, undefined, true)
    expect(toolResult.isError).toBeFalsy()
    const result = JSON.parse(toolResult.content[0]?.text ?? "{}") as StandInResult
    expect(result.verdict).toBe("consensus")
    expect(result.votes["grok-4.6"]).toBeDefined()
    expect(result.votes["gemini-3.1-pro-preview"]).toBeUndefined()
    const grokRequest = requests.find((body) => body.model === "grok-4.6")
    expect(grokRequest).toBeDefined()
    expect((grokRequest?.reasoning as { effort?: string })?.effort).toBe("high")
  })
})

// Helper to type-narrow vote-or-failure results in assertions.
function asVote(v: Vote | VoteFailure): Vote {
  if ("error" in v) {
    throw new Error(`expected Vote, got VoteFailure: ${v.message}`)
  }
  return v
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe("runStandIn — verdict paths", () => {
  test("3/3 round-1 consensus with high confidence short-circuits (no round 2)", async () => {
    const { consumed } = mockThreePeers({
      "gpt-5.6-sol":                [voteJson({ choice: "A", confidence: 0.9, reasoning: "tree-shakeable wins" })],
      "claude-opus-5":        [voteJson({ choice: "A", confidence: 0.85, reasoning: "modular + bundle size" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.9, reasoning: "ecosystem maturity" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("consensus")
    expect(result.recommendation).toBe("A")
    expect(result.confidence).toBeGreaterThanOrEqual(0.8)
    expect(result.votes["gpt-5.6-sol"].round2).toBeNull()
    expect(result.votes["claude-opus-5"].round2).toBeNull()
    expect(result.votes["gemini-3.1-pro-preview"].round2).toBeNull()
    expect(consumed["gpt-5.6-sol"]).toBe(1)
    expect(consumed["claude-opus-5"]).toBe(1)
    expect(consumed["gemini-3.1-pro-preview"]).toBe(1)
  })

  test("3/3 round-1 consensus with LOW confidence still triggers round 2", async () => {
    mockThreePeers({
      "gpt-5.6-sol":                [voteJson({ choice: "A", confidence: 0.55, reasoning: "leaning A" }),
                                 voteJson({ choice: "A", confidence: 0.7,  reasoning: "still A" })],
      "claude-opus-5":        [voteJson({ choice: "A", confidence: 0.6,  reasoning: "weak A" }),
                                 voteJson({ choice: "A", confidence: 0.75, reasoning: "still A" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.5,  reasoning: "coin flip A" }),
                                 voteJson({ choice: "A", confidence: 0.7,  reasoning: "still A" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("consensus")
    expect(result.recommendation).toBe("A")
    expect(result.votes["gpt-5.6-sol"].round2).not.toBeNull()
  })

  test("round-2 majority (2/1) returns majority verdict with dissenter noted", async () => {
    mockThreePeers({
      "gpt-5.6-sol":                [voteJson({ choice: "A", confidence: 0.7, reasoning: "A" }),
                                 voteJson({ choice: "B", confidence: 0.6, reasoning: "B after peer reasoning" })],
      "claude-opus-5":        [voteJson({ choice: "B", confidence: 0.8, reasoning: "B" }),
                                 voteJson({ choice: "B", confidence: 0.85, reasoning: "still B" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "B", confidence: 0.7, reasoning: "B" }),
                                 voteJson({ choice: "B", confidence: 0.75, reasoning: "still B" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("consensus")
    expect(result.recommendation).toBe("B")
  })

  test("round-2 actual majority (2/1) with dissenter sticking returns majority verdict", async () => {
    mockThreePeers({
      "gpt-5.6-sol":                [voteJson({ choice: "A", confidence: 0.7, reasoning: "A" }),
                                 voteJson({ choice: "A", confidence: 0.7, reasoning: "sticking A" })],
      "claude-opus-5":        [voteJson({ choice: "B", confidence: 0.8, reasoning: "B" }),
                                 voteJson({ choice: "B", confidence: 0.85, reasoning: "B" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "B", confidence: 0.7, reasoning: "B" }),
                                 voteJson({ choice: "B", confidence: 0.75, reasoning: "B" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("majority")
    expect(result.recommendation).toBe("B")
    expect(result.notes ?? "").toContain("Dissent")
    expect(result.notes ?? "").toContain("gpt-5.6-sol")
  })

  test("round-2 1/1/1 split returns no_consensus and defers to user", async () => {
    mockThreePeers({
      "gpt-5.6-sol":                [voteJson({ choice: "A", confidence: 0.6, reasoning: "A" }),
                                 voteJson({ choice: "A", confidence: 0.6, reasoning: "sticking A" })],
      "claude-opus-5":        [voteJson({ choice: "B", confidence: 0.7, reasoning: "B" }),
                                 voteJson({ choice: "B", confidence: 0.7, reasoning: "sticking B" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "C", confidence: 0.6, reasoning: "C" }),
                                 voteJson({ choice: "C", confidence: 0.6, reasoning: "sticking C" })],
    })
    const input = {
      decision: "pick one",
      options: [
        { id: "A", summary: "first" },
        { id: "B", summary: "second" },
        { id: "C", summary: "third" },
      ],
      context: "three equivalent-looking options; a tie is expected",
    }
    const result = await runStandIn(input)
    expect(result.verdict).toBe("no_consensus")
    expect(result.recommendation).toBeNull()
    expect(result.confidence).toBe(0)
  })

  test("all three round-1 models flag need_more_info returns need_more_info verdict", async () => {
    mockThreePeers({
      "gpt-5.6-sol":                [voteJson({ choice: null, confidence: 0, reasoning: "underspecified", needMoreInfo: "what's the deployment target?" })],
      "claude-opus-5":        [voteJson({ choice: null, confidence: 0, reasoning: "underspecified", needMoreInfo: "what's the bundle-size budget?" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: null, confidence: 0, reasoning: "underspecified", needMoreInfo: "are time zones required?" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("need_more_info")
    expect(result.recommendation).toBeNull()
    expect(result.notes ?? "").toContain("deployment")
    expect(result.notes ?? "").toContain("bundle-size")
    expect(result.notes ?? "").toContain("time zones")
    // Should NOT have run round 2 — the need_more_info short-circuits.
    expect(result.votes["gpt-5.6-sol"].round2).toBeNull()
  })
})

describe("runStandIn — resilience", () => {
  test("upstream error on ONE model in round 1 still runs round 2 with the other two", async () => {
    mockThreePeers({
      "gpt-5.6-sol":                [null /* R1 fails */,
                                 voteJson({ choice: "A", confidence: 0.7, reasoning: "A R2" })],
      "claude-opus-5":        [voteJson({ choice: "A", confidence: 0.7, reasoning: "A" }),
                                 voteJson({ choice: "A", confidence: 0.8, reasoning: "still A" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.7, reasoning: "A" }),
                                 voteJson({ choice: "A", confidence: 0.8, reasoning: "still A" })],
    })
    const result = await runStandIn(TINY_INPUT)
    // gpt-5.6-sol R1 failed → not eligible for the 3/3 short-circuit even
    // though the other two would have. Round 2 runs, all three agree.
    expect(result.verdict).toBe("consensus")
    expect(result.recommendation).toBe("A")
    expect("error" in result.votes["gpt-5.6-sol"].round1).toBe(true)
    const r1Failure = result.votes["gpt-5.6-sol"].round1 as VoteFailure
    expect(r1Failure.error).toBe("upstream_error")
  })

  test("only 1 of 3 successful R1 votes returns no_consensus without running round 2", async () => {
    mockThreePeers({
      "gpt-5.6-sol":                [null /* fail */],
      "claude-opus-5":        [null /* fail */],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.7, reasoning: "A" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("no_consensus")
    expect(result.notes ?? "").toContain("1 of 3")
    // None should have R2 results — we bailed.
    expect(result.votes["gpt-5.6-sol"].round2).toBeNull()
    expect(result.votes["claude-opus-5"].round2).toBeNull()
    expect(result.votes["gemini-3.1-pro-preview"].round2).toBeNull()
  })

  test("malformed JSON triggers retry; if retry succeeds the vote is recorded", async () => {
    mockThreePeers({
      "gpt-5.6-sol":                ["this is prose, not JSON",
                                 voteJson({ choice: "A", confidence: 0.85, reasoning: "A after retry" })],
      "claude-opus-5":        [voteJson({ choice: "A", confidence: 0.85, reasoning: "A" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.85, reasoning: "A" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("consensus")
    const v = asVote(result.votes["gpt-5.6-sol"].round1)
    expect(v.choice).toBe("A")
  })

  test("malformed JSON twice in a row → parse_failure for that model", async () => {
    mockThreePeers({
      "gpt-5.6-sol":                ["nope",
                                 "still nope",
                                 voteJson({ choice: "A", confidence: 0.7, reasoning: "A R2" })],
      "claude-opus-5":        [voteJson({ choice: "A", confidence: 0.7, reasoning: "A" }),
                                 voteJson({ choice: "A", confidence: 0.8, reasoning: "A R2" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.7, reasoning: "A" }),
                                 voteJson({ choice: "A", confidence: 0.8, reasoning: "A R2" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect("error" in result.votes["gpt-5.6-sol"].round1).toBe(true)
    const failure = result.votes["gpt-5.6-sol"].round1 as VoteFailure
    expect(failure.error).toBe("parse_failure")
    expect(failure.raw).toBe("still nope")
    // The other two still produce a valid R2; verdict is consensus on A
    // because R2 has 3 successful votes (gpt-5.6-sol recovered in R2).
    expect(result.verdict).toBe("consensus")
  })

  test("JSON-in-markdown-fence is accepted (no retry needed)", async () => {
    const fenced = "```json\n" + voteJson({ choice: "B", confidence: 0.85, reasoning: "B" }) + "\n```"
    mockThreePeers({
      "gpt-5.6-sol":                [fenced],
      "claude-opus-5":        [voteJson({ choice: "B", confidence: 0.85, reasoning: "B" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "B", confidence: 0.85, reasoning: "B" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("consensus")
    expect(result.recommendation).toBe("B")
    expect(asVote(result.votes["gpt-5.6-sol"].round1).choice).toBe("B")
  })

  test("cancellation via AbortSignal propagates to in-flight upstream fetches", async () => {
    // Mock fetch to hang until aborted, then reject with AbortError.
    globalThis.fetch = mock(async (_url, init) => {
      const sig = (init as RequestInit | undefined)?.signal
      if (!sig) throw new Error("test expects fetch to receive an AbortSignal")
      return await new Promise<Response>((_resolve, reject) => {
        sig.addEventListener("abort", () => {
          const err = new Error("aborted")
          ;(err as Error & { name: string }).name = "AbortError"
          reject(err)
        })
      })
    }) as unknown as typeof globalThis.fetch

    const ac = new AbortController()
    const promise = runStandIn(TINY_INPUT, ac.signal)
    // Abort almost immediately. The orchestrator should catch the
    // AbortError via dispatchModelCall's await + try/catch path and
    // surface upstream_error VoteFailure for each model.
    queueMicrotask(() => ac.abort())
    const result = await promise
    // With all 3 R1 votes failing, the orchestrator returns no_consensus
    // without attempting R2.
    expect(result.verdict).toBe("no_consensus")
    for (const key of ["gpt-5.6-sol", "claude-opus-5", "gemini-3.1-pro-preview"] as const) {
      const v = result.votes[key].round1
      expect("error" in v).toBe(true)
    }
  })
})

describe("runStandIn — output shape invariants", () => {
  test("the result envelope is JSON-stringifiable (no circular refs, no functions)", async () => {
    mockThreePeers({
      "gpt-5.6-sol":                [voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })],
      "claude-opus-5":        [voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })],
    })
    const result = await runStandIn(TINY_INPUT)
    const serialized = JSON.stringify(result)
    const reparsed = JSON.parse(serialized) as StandInResult
    expect(reparsed.verdict).toBe(result.verdict)
    expect(reparsed.recommendation).toBe(result.recommendation)
  })

  test("confidence above 1.0 from a model is clamped to [0, 1]", async () => {
    mockThreePeers({
      "gpt-5.6-sol":                [voteJson({ choice: "A", confidence: 1.5 /* nope */, reasoning: "overconfident" })],
      "claude-opus-5":        [voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("consensus")
    expect(result.confidence).toBeLessThanOrEqual(1.0)
    expect(asVote(result.votes["gpt-5.6-sol"].round1).confidence).toBe(1.0)
  })
})

describe("runStandIn — rollout-lag OpenAI fallback", () => {
  test("dispatches gpt-5.5 when gpt-5.6-sol is absent, but records the vote under the stable 'gpt-5.6-sol' key", async () => {
    // Rollout-lag catalog: gpt-5.6-sol not yet served on this account, but
    // gpt-5.5 is. The OpenAI panel slot must dispatch the resolved fallback
    // (gpt-5.5) — dispatching the absent gpt-5.6-sol would 404 — while the
    // votes record key stays the canonical "gpt-5.6-sol".
    const savedModels = state.models
    state.models = {
      object: "list",
      data: [
        { id: "gpt-5.5" },
        { id: "claude-opus-5" },
        { id: "gemini-3.1-pro-preview" },
      ] as never,
    }
    const vote = voteJson({ choice: "A", confidence: 0.9, reasoning: "a" })
    let responsesModel: string | undefined
    globalThis.fetch = mock(async (url: string | URL, init?: { body?: unknown }) => {
      const u = typeof url === "string" ? url : url.toString()
      if (u.includes("/responses")) {
        try {
          responsesModel = (JSON.parse(String(init?.body ?? "{}")) as { model?: string }).model
        } catch { /* ignore */ }
        return new Response(JSON.stringify({
          id: "resp_test", object: "response", status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: vote }] }],
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (u.includes("/v1/messages")) {
        return new Response(JSON.stringify({
          id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5",
          content: [{ type: "text", text: vote }], stop_reason: "end_turn",
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({
        id: "chatcmpl_test", object: "chat.completion", created: 0, model: "gemini-3.1-pro-preview",
        choices: [{ index: 0, message: { role: "assistant", content: vote }, finish_reason: "stop", logprobs: null }],
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof globalThis.fetch

    try {
      const result = await runStandIn(TINY_INPUT)
      // Dispatched the fallback model, NOT the absent gpt-5.6-sol.
      expect(responsesModel).toBe("gpt-5.5")
      // Vote record keyed by the stable canonical id regardless of dispatch.
      expect(result.votes["gpt-5.6-sol"]).toBeDefined()
      expect("round1" in result.votes["gpt-5.6-sol"]).toBe(true)
    } finally {
      state.models = savedModels
    }
  })
})

describe("runStandIn — alternative channel (holistic option)", () => {
  test("an alternative-flagged abstain never overrides a real majority, and is surfaced in notes", async () => {
    // 2 models pick A; the third abstains proposing an unlisted option.
    // The majority for A must stand, and the alternative must appear in notes.
    mockThreePeers({
      "gpt-5.6-sol":            [voteJson({ choice: "A", confidence: 0.8, reasoning: "A" }),
                                 voteJson({ choice: "A", confidence: 0.8, reasoning: "still A" })],
      "claude-opus-5":        [voteJson({ choice: "A", confidence: 0.75, reasoning: "A too" }),
                                 voteJson({ choice: "A", confidence: 0.8, reasoning: "still A" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: null, confidence: 0, reasoning: "both weak", alternative: "use the native Temporal API instead" }),
                                 voteJson({ choice: null, confidence: 0, reasoning: "both weak", alternative: "use the native Temporal API instead" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("majority")
    expect(result.recommendation).toBe("A")
    expect(result.notes ?? "").toContain("unlisted option")
    expect(result.notes ?? "").toContain("Temporal")
  })

  test("a decided vote drops its alternative without changing the consensus verdict", async () => {
    // 3/3 pick A at high confidence (short-circuits after R1); one also flags
    // an alternative. The valid choice wins and the incoherent alternative is
    // canonicalized away rather than surfaced in notes.
    mockThreePeers({
      "gpt-5.6-sol":            [voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })],
      "claude-opus-5":        [voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.9, reasoning: "A", alternative: "a hosted service would sidestep both" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("consensus")
    expect(result.recommendation).toBe("A")
    expect(result.notes ?? "").not.toContain("unlisted option")
  })

  test("a context gap takes precedence over an alternative on the same null vote", async () => {
    // Each model abstains with BOTH need_more_info AND an alternative. The
    // gap wins: the run resolves to need_more_info (gaps counted), and the
    // now-subordinate alternatives are NOT surfaced.
    mockThreePeers({
      "gpt-5.6-sol":            [voteJson({ choice: null, confidence: 0, reasoning: "blocked", needMoreInfo: "what's the deploy target?", alternative: "roll our own" })],
      "claude-opus-5":        [voteJson({ choice: null, confidence: 0, reasoning: "blocked", needMoreInfo: "what's the SLA?", alternative: "roll our own" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: null, confidence: 0, reasoning: "blocked", needMoreInfo: "what timezones?", alternative: "roll our own" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("need_more_info")
    expect(result.notes ?? "").toContain("deploy target")
    expect(result.notes ?? "").not.toContain("unlisted option")
    expect(result.notes ?? "").not.toContain("roll our own")
  })
})

describe("runStandIn — hallucination guard", () => {
  test("an unlisted choice id is a parse failure, never a phantom majority", async () => {
    // Two models persistently vote a phantom id 'Z'; one votes real 'A'. Each
    // phantom response fails both parse attempts, leaving only one successful
    // R1 vote. The protocol must stop before R2 without manufacturing a majority.
    mockThreePeers({
      "gpt-5.6-sol":            [voteJson({ choice: "Z", confidence: 0.9, reasoning: "phantom" }),
                                 voteJson({ choice: "Z", confidence: 0.9, reasoning: "still phantom" })],
      "claude-opus-5":        [voteJson({ choice: "Z", confidence: 0.9, reasoning: "phantom" }),
                                 voteJson({ choice: "Z", confidence: 0.9, reasoning: "still phantom" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.8, reasoning: "real A" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("no_consensus")
    expect(result.recommendation).toBeNull()
    expect("error" in result.votes["gpt-5.6-sol"].round1).toBe(true)
    expect((result.votes["gpt-5.6-sol"].round1 as VoteFailure).error).toBe("parse_failure")
  })

  test("an unlisted choice id recovers when the retry returns a valid vote", async () => {
    mockThreePeers({
      "gpt-5.6-sol":            [voteJson({ choice: "Z", confidence: 0.8, reasoning: "oops" }),
                                 voteJson({ choice: "A", confidence: 0.8, reasoning: "fixed" })],
      "claude-opus-5":        [voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("consensus")
    expect(result.recommendation).toBe("A")
    expect(asVote(result.votes["gpt-5.6-sol"].round1).choice).toBe("A")
  })
})

describe("runStandIn — partial missing-context signals", () => {
  test("2 of 3 round-1 gap-abstains short-circuit to need_more_info (no round 2)", async () => {
    // Only ONE queued response per model: if round 2 ran, the queue would
    // exhaust and the mock would throw — so consumed===1 proves R2 was skipped.
    const { consumed } = mockThreePeers({
      "gpt-5.6-sol":            [voteJson({ choice: null, confidence: 0, reasoning: "need info", needMoreInfo: "what's the deploy target?" })],
      "claude-opus-5":        [voteJson({ choice: null, confidence: 0, reasoning: "need info", needMoreInfo: "what's the SLA?" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.7, reasoning: "A anyway" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("need_more_info")
    expect(result.recommendation).toBeNull()
    expect(result.notes ?? "").toContain("2 of 3")
    expect(result.notes ?? "").toContain("deploy target")
    expect(result.notes ?? "").toContain("SLA")
    expect(consumed["gpt-5.6-sol"]).toBe(1)
    expect(consumed["gemini-3.1-pro-preview"]).toBe(1)
  })

  test("2 of 3 round-2 gap-abstains return need_more_info", async () => {
    mockThreePeers({
      "gpt-5.6-sol": [
        voteJson({ choice: "A", confidence: 0.6, reasoning: "leaning A" }),
        voteJson({ choice: null, confidence: 0, reasoning: "blocked", needMoreInfo: "what is the production bundle-size ceiling?" }),
      ],
      "claude-opus-5": [
        voteJson({ choice: "B", confidence: 0.6, reasoning: "leaning B" }),
        voteJson({ choice: null, confidence: 0, reasoning: "blocked", needMoreInfo: "which runtime versions must be supported?" }),
      ],
      "gemini-3.1-pro-preview": [
        voteJson({ choice: "A", confidence: 0.6, reasoning: "leaning A" }),
        voteJson({ choice: "A", confidence: 0.7, reasoning: "still A" }),
      ],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("need_more_info")
    expect(result.recommendation).toBeNull()
    expect(result.notes ?? "").toContain("2 of 3")
    expect(result.notes ?? "").toContain("production bundle-size ceiling")
    expect(result.notes ?? "").toContain("runtime versions")
  })

  test("whitespace-only round-1 gaps are ordinary abstentions, not need_more_info", async () => {
    // R1 queues: two null-choice votes carry only whitespace gaps, while one
    // model picks A. The whitespace is dropped during parsing, so these are
    // valid abstentions and R2 must run. R2 queues preserve the split as two
    // abstentions plus one A vote, producing no_consensus rather than a gap.
    const { consumed } = mockThreePeers({
      "gpt-5.6-sol":            [voteJson({ choice: null, confidence: 0, reasoning: "x", needMoreInfo: "   " }),
                                 voteJson({ choice: null, confidence: 0, reasoning: "still abstaining" })],
      "claude-opus-5":        [voteJson({ choice: null, confidence: 0, reasoning: "x", needMoreInfo: "   " }),
                                 voteJson({ choice: null, confidence: 0, reasoning: "still abstaining" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.7, reasoning: "A" }),
                                 voteJson({ choice: "A", confidence: 0.7, reasoning: "still A" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("no_consensus")
    expect(result.verdict).not.toBe("need_more_info")
    expect(result.notes ?? "").not.toContain("   ")
    expect(asVote(result.votes["gpt-5.6-sol"].round1).needMoreInfo).toBeUndefined()
    expect(consumed["gpt-5.6-sol"]).toBe(2)
    expect(consumed["claude-opus-5"]).toBe(2)
    expect(consumed["gemini-3.1-pro-preview"]).toBe(2)
  })

  test("a single round-2 gap (below the 2/3 threshold) is surfaced in no_consensus notes", async () => {
    // 1 gap in R1 (<2, no short-circuit) and the vote splits; R2 splits with
    // the gap still present, so it should appear in the no_consensus notes.
    mockThreePeers({
      "gpt-5.6-sol":            [voteJson({ choice: "A", confidence: 0.6, reasoning: "A" }),
                                 voteJson({ choice: "A", confidence: 0.6, reasoning: "A" })],
      "claude-opus-5":        [voteJson({ choice: "B", confidence: 0.6, reasoning: "B" }),
                                 voteJson({ choice: "B", confidence: 0.6, reasoning: "B" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: null, confidence: 0, reasoning: "unsure", needMoreInfo: "what's the team's tz expertise?" }),
                                 voteJson({ choice: null, confidence: 0, reasoning: "unsure", needMoreInfo: "what's the team's tz expertise?" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("no_consensus")
    expect(result.notes ?? "").toContain("missing context")
    expect(result.notes ?? "").toContain("tz expertise")
  })
})

describe("runStandIn — blind round 1 invariant", () => {
  test("round-1 prompts carry no peer votes", async () => {
    // 3/3 high-confidence consensus → short-circuits after R1, so every
    // request in this run is a round-1 call and none may carry the R2
    // peer-vote marker.
    const { bodies } = mockThreePeers({
      "gpt-5.6-sol":            [voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })],
      "claude-opus-5":        [voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })],
    })
    await runStandIn(TINY_INPUT)
    expect(bodies.length).toBe(3)
    for (const b of bodies) {
      expect(b.body).not.toContain("Round 1 votes:")
      expect(b.body).toContain("Which library")
    }
  })
})

describe("stand_in tool boundary — context required", () => {
  test("missing context is rejected as an input-shape error (isError:true), before any upstream call", async () => {
    // No fetch mock installed: if validation didn't reject first, the real
    // fetch would fire and the test would fail loudly.
    const res = await runStandInToolCall({
      decision: "pick one",
      options: [{ id: "A", summary: "a" }, { id: "B", summary: "b" }],
    })
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text ?? "").toContain("context is required")
  })

  test("empty / whitespace-only context is rejected", async () => {
    const res = await runStandInToolCall({
      decision: "pick one",
      options: [{ id: "A", summary: "a" }, { id: "B", summary: "b" }],
      context: "   ",
    })
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text ?? "").toContain("context is required")
  })

  test("need_more_info is a successful MCP outcome, not a tool error", async () => {
    // One R1 response per peer is sufficient because two genuine gaps trigger
    // the documented >=2/3 short-circuit before round 2.
    const { consumed } = mockThreePeers({
      "gpt-5.6-sol":            [voteJson({ choice: null, confidence: 0, reasoning: "blocked", needMoreInfo: "which operating system is primary?" })],
      "claude-opus-5":        [voteJson({ choice: null, confidence: 0, reasoning: "blocked", needMoreInfo: "what latency budget applies?" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.7, reasoning: "A with current context" })],
    })
    const res = await runStandInToolCall(TINY_INPUT)
    expect(res.isError).toBeFalsy()
    const result = JSON.parse(res.content[0]?.text ?? "{}") as StandInResult
    expect(result.verdict).toBe("need_more_info")
    expect(consumed["gpt-5.6-sol"]).toBe(1)
    expect(consumed["claude-opus-5"]).toBe(1)
    expect(consumed["gemini-3.1-pro-preview"]).toBe(1)
  })
})
