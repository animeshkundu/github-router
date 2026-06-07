import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { runStandIn, type ModelKey, type StandInResult, type Vote, type VoteFailure } from "~/lib/stand-in"
import { state } from "~/lib/state"

// ────────────────────────────────────────────────────────────────────
// Fixtures + minimal Copilot state required by createX upstream
// callers (createResponses / createMessages / createChatCompletions).
// ────────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch

beforeEach(() => {
  // The wire helpers read state.copilotToken / state.vsCodeVersion etc.
  // for headers; without these, header-build code paths can throw before
  // we ever hit our mocked fetch. Set the minimum surface they need.
  state.copilotToken = "test-copilot-token"
  state.githubToken = "test-gh-token"
  state.vsCodeVersion = "1.99.0"
  state.copilotVersion = "0.43.0"
  state.accountType = "individual"
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// Per-model vote payload helper. Returns the JSON string the model
// would emit for one round, matching the schema runStandIn parses.
function voteJson(opts: {
  choice: string | null
  confidence: number
  reasoning: string
  needMoreInfo?: string
}): string {
  const obj: Record<string, unknown> = {
    choice: opts.choice,
    confidence: opts.confidence,
    reasoning: opts.reasoning,
  }
  if (opts.needMoreInfo) obj.need_more_info = opts.needMoreInfo
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
function mockThreePeers(queues: Record<ModelKey, Array<string | null>>) {
  const consumed: Record<ModelKey, number> = {
    "gpt-5.5": 0,
    "claude-opus-4-7": 0,
    "gemini-3.1-pro-preview": 0,
  }

  globalThis.fetch = mock(async (url, _init) => {
    const u = typeof url === "string" ? url : (url as URL).toString()
    const key: ModelKey =
      u.includes("/responses") ? "gpt-5.5"
      : u.includes("/v1/messages") ? "claude-opus-4-7"
      : u.includes("/chat/completions") ? "gemini-3.1-pro-preview"
      : (() => { throw new Error(`unexpected upstream URL: ${u}`) })()

    const idx = consumed[key]++
    const entry = queues[key]?.[idx]
    if (entry === undefined) {
      throw new Error(`mock queue for ${key} exhausted at call ${idx + 1}`)
    }
    if (entry === null) {
      return new Response("upstream rejected", { status: 400, headers: { "content-type": "text/plain" } })
    }

    if (key === "gpt-5.5") {
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
    if (key === "claude-opus-4-7") {
      return new Response(JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-7",
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

  return { consumed }
}

// Tiny default input — well under the 6KB pre-flight cap.
const TINY_INPUT = {
  decision: "Which library should we use for date parsing?",
  options: [
    { id: "A", summary: "date-fns — modular, tree-shakeable" },
    { id: "B", summary: "luxon — DateTime objects, time zones built in" },
  ],
}

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
      "gpt-5.5":                [voteJson({ choice: "A", confidence: 0.9, reasoning: "tree-shakeable wins" })],
      "claude-opus-4-7":        [voteJson({ choice: "A", confidence: 0.85, reasoning: "modular + bundle size" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.9, reasoning: "ecosystem maturity" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("consensus")
    expect(result.recommendation).toBe("A")
    expect(result.confidence).toBeGreaterThanOrEqual(0.8)
    expect(result.votes["gpt-5.5"].round2).toBeNull()
    expect(result.votes["claude-opus-4-7"].round2).toBeNull()
    expect(result.votes["gemini-3.1-pro-preview"].round2).toBeNull()
    expect(consumed["gpt-5.5"]).toBe(1)
    expect(consumed["claude-opus-4-7"]).toBe(1)
    expect(consumed["gemini-3.1-pro-preview"]).toBe(1)
  })

  test("3/3 round-1 consensus with LOW confidence still triggers round 2", async () => {
    mockThreePeers({
      "gpt-5.5":                [voteJson({ choice: "A", confidence: 0.55, reasoning: "leaning A" }),
                                 voteJson({ choice: "A", confidence: 0.7,  reasoning: "still A" })],
      "claude-opus-4-7":        [voteJson({ choice: "A", confidence: 0.6,  reasoning: "weak A" }),
                                 voteJson({ choice: "A", confidence: 0.75, reasoning: "still A" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.5,  reasoning: "coin flip A" }),
                                 voteJson({ choice: "A", confidence: 0.7,  reasoning: "still A" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("consensus")
    expect(result.recommendation).toBe("A")
    expect(result.votes["gpt-5.5"].round2).not.toBeNull()
  })

  test("round-2 majority (2/1) returns majority verdict with dissenter noted", async () => {
    mockThreePeers({
      "gpt-5.5":                [voteJson({ choice: "A", confidence: 0.7, reasoning: "A" }),
                                 voteJson({ choice: "B", confidence: 0.6, reasoning: "B after peer reasoning" })],
      "claude-opus-4-7":        [voteJson({ choice: "B", confidence: 0.8, reasoning: "B" }),
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
      "gpt-5.5":                [voteJson({ choice: "A", confidence: 0.7, reasoning: "A" }),
                                 voteJson({ choice: "A", confidence: 0.7, reasoning: "sticking A" })],
      "claude-opus-4-7":        [voteJson({ choice: "B", confidence: 0.8, reasoning: "B" }),
                                 voteJson({ choice: "B", confidence: 0.85, reasoning: "B" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "B", confidence: 0.7, reasoning: "B" }),
                                 voteJson({ choice: "B", confidence: 0.75, reasoning: "B" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("majority")
    expect(result.recommendation).toBe("B")
    expect(result.notes ?? "").toContain("Dissent")
    expect(result.notes ?? "").toContain("gpt-5.5")
  })

  test("round-2 1/1/1 split returns no_consensus and defers to user", async () => {
    mockThreePeers({
      "gpt-5.5":                [voteJson({ choice: "A", confidence: 0.6, reasoning: "A" }),
                                 voteJson({ choice: "A", confidence: 0.6, reasoning: "sticking A" })],
      "claude-opus-4-7":        [voteJson({ choice: "B", confidence: 0.7, reasoning: "B" }),
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
    }
    const result = await runStandIn(input)
    expect(result.verdict).toBe("no_consensus")
    expect(result.recommendation).toBeNull()
    expect(result.confidence).toBe(0)
  })

  test("all three round-1 models flag need_more_info returns need_more_info verdict", async () => {
    mockThreePeers({
      "gpt-5.5":                [voteJson({ choice: null, confidence: 0, reasoning: "underspecified", needMoreInfo: "what's the deployment target?" })],
      "claude-opus-4-7":        [voteJson({ choice: null, confidence: 0, reasoning: "underspecified", needMoreInfo: "what's the bundle-size budget?" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: null, confidence: 0, reasoning: "underspecified", needMoreInfo: "are time zones required?" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("need_more_info")
    expect(result.recommendation).toBeNull()
    expect(result.notes ?? "").toContain("deployment")
    expect(result.notes ?? "").toContain("bundle-size")
    expect(result.notes ?? "").toContain("time zones")
    // Should NOT have run round 2 — the need_more_info short-circuits.
    expect(result.votes["gpt-5.5"].round2).toBeNull()
  })
})

describe("runStandIn — resilience", () => {
  test("upstream error on ONE model in round 1 still runs round 2 with the other two", async () => {
    mockThreePeers({
      "gpt-5.5":                [null /* R1 fails */,
                                 voteJson({ choice: "A", confidence: 0.7, reasoning: "A R2" })],
      "claude-opus-4-7":        [voteJson({ choice: "A", confidence: 0.7, reasoning: "A" }),
                                 voteJson({ choice: "A", confidence: 0.8, reasoning: "still A" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.7, reasoning: "A" }),
                                 voteJson({ choice: "A", confidence: 0.8, reasoning: "still A" })],
    })
    const result = await runStandIn(TINY_INPUT)
    // gpt-5.5 R1 failed → not eligible for the 3/3 short-circuit even
    // though the other two would have. Round 2 runs, all three agree.
    expect(result.verdict).toBe("consensus")
    expect(result.recommendation).toBe("A")
    expect("error" in result.votes["gpt-5.5"].round1).toBe(true)
    const r1Failure = result.votes["gpt-5.5"].round1 as VoteFailure
    expect(r1Failure.error).toBe("upstream_error")
  })

  test("only 1 of 3 successful R1 votes returns no_consensus without running round 2", async () => {
    mockThreePeers({
      "gpt-5.5":                [null /* fail */],
      "claude-opus-4-7":        [null /* fail */],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.7, reasoning: "A" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("no_consensus")
    expect(result.notes ?? "").toContain("1 of 3")
    // None should have R2 results — we bailed.
    expect(result.votes["gpt-5.5"].round2).toBeNull()
    expect(result.votes["claude-opus-4-7"].round2).toBeNull()
    expect(result.votes["gemini-3.1-pro-preview"].round2).toBeNull()
  })

  test("malformed JSON triggers retry; if retry succeeds the vote is recorded", async () => {
    mockThreePeers({
      "gpt-5.5":                ["this is prose, not JSON",
                                 voteJson({ choice: "A", confidence: 0.85, reasoning: "A after retry" })],
      "claude-opus-4-7":        [voteJson({ choice: "A", confidence: 0.85, reasoning: "A" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.85, reasoning: "A" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("consensus")
    const v = asVote(result.votes["gpt-5.5"].round1)
    expect(v.choice).toBe("A")
  })

  test("malformed JSON twice in a row → parse_failure for that model", async () => {
    mockThreePeers({
      "gpt-5.5":                ["nope",
                                 "still nope",
                                 voteJson({ choice: "A", confidence: 0.7, reasoning: "A R2" })],
      "claude-opus-4-7":        [voteJson({ choice: "A", confidence: 0.7, reasoning: "A" }),
                                 voteJson({ choice: "A", confidence: 0.8, reasoning: "A R2" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.7, reasoning: "A" }),
                                 voteJson({ choice: "A", confidence: 0.8, reasoning: "A R2" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect("error" in result.votes["gpt-5.5"].round1).toBe(true)
    const failure = result.votes["gpt-5.5"].round1 as VoteFailure
    expect(failure.error).toBe("parse_failure")
    expect(failure.raw).toBe("still nope")
    // The other two still produce a valid R2; verdict is consensus on A
    // because R2 has 3 successful votes (gpt-5.5 recovered in R2).
    expect(result.verdict).toBe("consensus")
  })

  test("JSON-in-markdown-fence is accepted (no retry needed)", async () => {
    const fenced = "```json\n" + voteJson({ choice: "B", confidence: 0.85, reasoning: "B" }) + "\n```"
    mockThreePeers({
      "gpt-5.5":                [fenced],
      "claude-opus-4-7":        [voteJson({ choice: "B", confidence: 0.85, reasoning: "B" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "B", confidence: 0.85, reasoning: "B" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("consensus")
    expect(result.recommendation).toBe("B")
    expect(asVote(result.votes["gpt-5.5"].round1).choice).toBe("B")
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
    for (const key of ["gpt-5.5", "claude-opus-4-7", "gemini-3.1-pro-preview"] as const) {
      const v = result.votes[key].round1
      expect("error" in v).toBe(true)
    }
  })
})

describe("runStandIn — output shape invariants", () => {
  test("the result envelope is JSON-stringifiable (no circular refs, no functions)", async () => {
    mockThreePeers({
      "gpt-5.5":                [voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })],
      "claude-opus-4-7":        [voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })],
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
      "gpt-5.5":                [voteJson({ choice: "A", confidence: 1.5 /* nope */, reasoning: "overconfident" })],
      "claude-opus-4-7":        [voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })],
      "gemini-3.1-pro-preview": [voteJson({ choice: "A", confidence: 0.9, reasoning: "A" })],
    })
    const result = await runStandIn(TINY_INPUT)
    expect(result.verdict).toBe("consensus")
    expect(result.confidence).toBeLessThanOrEqual(1.0)
    expect(asVote(result.votes["gpt-5.5"].round1).confidence).toBe(1.0)
  })
})
