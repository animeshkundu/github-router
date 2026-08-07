import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test"

import { state } from "../src/lib/state"
import { __resetThinkingHistoryRepairsForTests } from "../src/lib/thinking-history-repair"
import { bucketEffort, clampEffort, clampOutputConfigEffortInPlace } from "../src/routes/messages/handler"
import { server } from "../src/server"

const originalFetch = globalThis.fetch
let savedModels: typeof state.models

function makeModel(overrides: {
  id?: string
  adaptive_thinking?: boolean
  reasoning_effort?: Array<string>
}) {
  return {
    id: overrides.id ?? "claude-opus-4.7",
    name: "Claude Opus 4.7",
    object: "model",
    preview: false,
    vendor: "anthropic",
    version: "1",
    model_picker_enabled: true,
    capabilities: {
      family: "claude",
      limits: { max_output_tokens: 8192 },
      object: "model",
      supports: {
        ...(overrides.adaptive_thinking !== undefined && {
          adaptive_thinking: overrides.adaptive_thinking,
        }),
        ...(overrides.reasoning_effort && {
          reasoning_effort: overrides.reasoning_effort,
        }),
      },
      tokenizer: "claude",
      type: "chat",
    },
  }
}

function emptyMessageResponse() {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-opus-4.7",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3 },
    }),
  )
}

/**
 * Install a fetch mock typed as `globalThis.fetch`, so a test can override it
 * without a type suppression. `handler` receives the 1-based call index and the
 * serialized request body; the returned record exposes what was sent upstream.
 */
function installFetchMock(
  handler: (call: number, body: string) => Response,
): { calls: number; bodies: Array<string> } {
  const record: { calls: number; bodies: Array<string> } = {
    calls: 0,
    bodies: [],
  }
  globalThis.fetch = Object.assign(
    mock(
      (
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ): Promise<Response> => {
        record.calls++
        const body = typeof init?.body === "string" ? init.body : ""
        record.bodies.push(body)
        return Promise.resolve(handler(record.calls, body))
      },
    ),
    // Bun's `typeof fetch` carries `preconnect`; supplying a no-op keeps the
    // assignment type-safe instead of suppressing the mismatch.
    { preconnect: () => {} },
  )
  return record
}

beforeEach(() => {
  __resetThinkingHistoryRepairsForTests()
  savedModels = state.models
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
})

describe("signed thinking-history recovery", () => {
  const upstreamIntegrityError = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "messages.1.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.",
    },
  }

  function requestBody(): string {
    return JSON.stringify({
      model: "claude-opus-4.7",
      max_tokens: 100,
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "start" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "opaque-signature" },
            { type: "text", text: "using a tool" },
            { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "done" },
          ],
        },
      ],
    })
  }

  function integrityErrorAt(messageIndex: number) {
    return {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: `messages.${messageIndex}.content.0: \`thinking\` or \`redacted_thinking\` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.`,
      },
    }
  }

  // Two corrupt assistant turns. Upstream reports them one at a time, so this
  // only succeeds if the handler keeps repairing until the history converges.
  function twoCorruptTurnsBody(): string {
    const corruptTurn = (signature: string) => ({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature },
        { type: "text", text: "answer" },
      ],
    })
    return JSON.stringify({
      model: "claude-opus-4.7",
      max_tokens: 100,
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "first" },
        corruptTurn("opaque-signature-a"),
        { role: "user", content: "second" },
        corruptTurn("opaque-signature-b"),
        { role: "user", content: "third" },
      ],
    })
  }

  beforeEach(() => {
    state.models = {
      object: "list",
      data: [makeModel({ id: "claude-opus-4.7" })],
    }
  })

  test("retries once with only the rejected assistant thinking blocks removed", async () => {
    const bodies: Array<string> = []
    let calls = 0
    const fetchMock = mock((_url: string, init?: { body?: string }) => {
      calls++
      bodies.push(init?.body ?? "")
      if (calls === 1) {
        return Response.json(upstreamIntegrityError, { status: 400 })
      }
      return emptyMessageResponse()
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody(),
    })
    expect(response.status).toBe(200)
    expect(calls).toBe(2)

    const original = JSON.parse(bodies[0]!) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>
    }
    const repaired = JSON.parse(bodies[1]!) as typeof original
    expect(original.messages[1]!.content.map((block) => block.type)).toEqual([
      "thinking",
      "text",
      "tool_use",
    ])
    expect(repaired.messages[1]!.content.map((block) => block.type)).toEqual([
      "text",
      "tool_use",
    ])
    expect(repaired.messages[2]).toEqual(original.messages[2])
  })

  test("unrelated 400 is forwarded without a semantic retry", async () => {
    let calls = 0
    const body = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "messages.2: missing tool_result",
      },
    }
    const fetchMock = mock(() => {
      calls++
      return Response.json(body, { status: 400 })
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody(),
    })
    expect(response.status).toBe(400)
    expect(calls).toBe(1)
    await expect(response.json()).resolves.toEqual(body)
  })

  test("converges across several corrupt assistant turns", async () => {
    // Copilot names only the FIRST offending message per rejection, so a
    // history with two corrupt turns needs one round trip per turn. A
    // single-shot repair would surface the first rejection forever.
    const upstream = installFetchMock((call) => {
      if (call === 1) return Response.json(integrityErrorAt(1), { status: 400 })
      if (call === 2) return Response.json(integrityErrorAt(3), { status: 400 })
      return emptyMessageResponse()
    })

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: twoCorruptTurnsBody(),
    })
    expect(response.status).toBe(200)
    expect(upstream.calls).toBe(3)

    const final = JSON.parse(upstream.bodies[2]!) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>
    }
    expect(final.messages[1]!.content.map((b) => b.type)).toEqual(["text"])
    expect(final.messages[3]!.content.map((b) => b.type)).toEqual(["text"])
  })

  test("stops instead of spinning when upstream re-names a repaired turn", async () => {
    const upstream = installFetchMock(() =>
      Response.json(integrityErrorAt(1), { status: 400 }),
    )

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: twoCorruptTurnsBody(),
    })
    expect(response.status).toBe(400)
    // One repair attempt, then the same index recurs: no forward progress, so
    // it must give up rather than burn the whole attempt budget.
    expect(upstream.calls).toBe(2)
  })

  test("repairs a streaming request after an integrity rejection", async () => {
    // Claude Code streams by default. A 400 arrives before any body streams, so
    // it must reach the same repair path — this is otherwise uncovered.
    const upstream = installFetchMock((call) => {
      if (call === 1) {
        return Response.json(upstreamIntegrityError, { status: 400 })
      }
      return new Response(
        `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","type":"message","role":"assistant","model":"claude-opus-4.7","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    })

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(JSON.parse(requestBody()) as Record<string, unknown>),
        stream: true,
      }),
    })
    expect(response.status).toBe(200)
    expect(upstream.calls).toBe(2)
    expect(await response.text()).toContain("message_stop")
  })

  test("preemptive repair reapplies every remembered turn in one request", async () => {
    // Learn both corrupt turns across a converging request...
    const learn = installFetchMock((call) => {
      if (call === 1) return Response.json(integrityErrorAt(1), { status: 400 })
      if (call === 2) return Response.json(integrityErrorAt(3), { status: 400 })
      return emptyMessageResponse()
    })
    await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: twoCorruptTurnsBody(),
    })
    expect(learn.calls).toBe(3)

    // ...then the identical history must be repaired up-front, with no 400.
    const replay = installFetchMock(() => emptyMessageResponse())

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: twoCorruptTurnsBody(),
    })
    expect(response.status).toBe(200)
    expect(replay.calls).toBe(1)
    const sent = JSON.parse(replay.bodies[0]!) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>
    }
    expect(sent.messages[1]!.content.map((b) => b.type)).toEqual(["text"])
    expect(sent.messages[3]!.content.map((b) => b.type)).toEqual(["text"])
  })

  test("failed repair surfaces the most recent rejection, not the first", async () => {
    const upstream = installFetchMock((call) => {
      if (call === 1) {
        return Response.json(upstreamIntegrityError, { status: 400 })
      }
      return Response.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "repair-specific failure",
          },
        },
        { status: 400 },
      )
    })

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody(),
    })
    expect(response.status).toBe(400)
    expect(upstream.calls).toBe(2)
    // The integrity rejection was already repaired; reporting it again would
    // misdiagnose what actually blocked the retry.
    await expect(response.json()).resolves.toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "repair-specific failure",
      },
    })
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = savedModels
})

describe("thinking-mode translation on /v1/messages", () => {
  test("translates enabled+budget 5000 to adaptive+effort 'medium'", async () => {
    state.models = {
      object: "list",
      data: [
        makeModel({
          id: "claude-opus-4.7",
          adaptive_thinking: true,
          reasoning_effort: ["low", "medium", "high", "xhigh"],
        }),
      ],
    }

    let capturedBody: string | undefined
    const fetchMock = mock((url: string, opts?: { body?: string }) => {
      if (url.includes("/v1/messages")) {
        capturedBody = opts?.body
        return emptyMessageResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        thinking: { type: "enabled", budget_tokens: 5000 },
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(capturedBody ?? "{}") as {
      thinking?: { type?: string; budget_tokens?: number }
      output_config?: { effort?: string }
    }
    expect(forwarded.thinking).toEqual({ type: "adaptive" })
    expect(forwarded.output_config?.effort).toBe("medium")
  })

  test("clamps to supported reasoning_effort when bucketed not in list", async () => {
    state.models = {
      object: "list",
      data: [
        makeModel({
          id: "claude-opus-4.7",
          adaptive_thinking: true,
          reasoning_effort: ["medium"],
        }),
      ],
    }

    let capturedBody: string | undefined
    const fetchMock = mock((url: string, opts?: { body?: string }) => {
      if (url.includes("/v1/messages")) {
        capturedBody = opts?.body
        return emptyMessageResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        // budget 30000 → bucketed "xhigh" → clamps to "medium"
        thinking: { type: "enabled", budget_tokens: 30000 },
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(capturedBody ?? "{}") as {
      thinking?: { type?: string }
      output_config?: { effort?: string }
    }
    expect(forwarded.thinking).toEqual({ type: "adaptive" })
    expect(forwarded.output_config?.effort).toBe("medium")
  })

  test("leaves thinking unchanged when model lacks adaptive_thinking", async () => {
    state.models = {
      object: "list",
      data: [
        makeModel({
          id: "claude-opus-4.7",
          // adaptive_thinking absent
        }),
      ],
    }

    let capturedBody: string | undefined
    const fetchMock = mock((url: string, opts?: { body?: string }) => {
      if (url.includes("/v1/messages")) {
        capturedBody = opts?.body
        return emptyMessageResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        thinking: { type: "enabled", budget_tokens: 5000 },
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(capturedBody ?? "{}") as {
      thinking?: { type?: string; budget_tokens?: number }
      output_config?: unknown
    }
    expect(forwarded.thinking).toEqual({
      type: "enabled",
      budget_tokens: 5000,
    })
    expect(forwarded.output_config).toBeUndefined()
  })

  test("preserves client-supplied output_config.effort", async () => {
    state.models = {
      object: "list",
      data: [
        makeModel({
          id: "claude-opus-4.7",
          adaptive_thinking: true,
          reasoning_effort: ["low", "medium", "high", "xhigh"],
        }),
      ],
    }

    let capturedBody: string | undefined
    const fetchMock = mock((url: string, opts?: { body?: string }) => {
      if (url.includes("/v1/messages")) {
        capturedBody = opts?.body
        return emptyMessageResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        // budget 5000 buckets to "medium", but client says "high" — client wins
        thinking: { type: "enabled", budget_tokens: 5000 },
        output_config: { effort: "high" },
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(capturedBody ?? "{}") as {
      thinking?: { type?: string }
      output_config?: { effort?: string }
    }
    expect(forwarded.thinking).toEqual({ type: "adaptive" })
    expect(forwarded.output_config?.effort).toBe("high")
  })
})

// Direct unit tests for bucketEffort/clampEffort — boundary cases are
// off-by-one bug magnets and the integration tests above only cover the
// happy paths. Keep these cheap and exhaustive.

describe("bucketEffort", () => {
  test("budget 0 → low", () => {
    expect(bucketEffort(0)).toBe("low")
  })
  test("budget 1999 → low (just below 2000 boundary)", () => {
    expect(bucketEffort(1999)).toBe("low")
  })
  test("budget 2000 → medium (boundary — half-open [2k, 8k))", () => {
    expect(bucketEffort(2000)).toBe("medium")
  })
  test("budget 7999 → medium (just below 8000 boundary)", () => {
    expect(bucketEffort(7999)).toBe("medium")
  })
  test("budget 8000 → high (boundary)", () => {
    expect(bucketEffort(8000)).toBe("high")
  })
  test("budget 23999 → high (just below 24000 boundary)", () => {
    expect(bucketEffort(23999)).toBe("high")
  })
  test("budget 24000 → xhigh (boundary)", () => {
    expect(bucketEffort(24000)).toBe("xhigh")
  })
  test("budget 100000 → xhigh", () => {
    expect(bucketEffort(100_000)).toBe("xhigh")
  })
  test("undefined budget → high (default 8000)", () => {
    expect(bucketEffort(undefined)).toBe("high")
  })
  test("non-numeric budget (string) → high (default 8000)", () => {
    expect(bucketEffort("4000")).toBe("high")
  })
  test("NaN → high (default 8000)", () => {
    expect(bucketEffort(NaN)).toBe("high")
  })
  test("Infinity → high (default 8000, Number.isFinite false)", () => {
    expect(bucketEffort(Infinity)).toBe("high")
  })
  test("negative budget → low (n < 2000 is true for any negative)", () => {
    expect(bucketEffort(-1)).toBe("low")
  })
})

describe("clampEffort", () => {
  test("returns the bucketed value when supported", () => {
    expect(clampEffort("medium", ["low", "medium", "high"])).toBe("medium")
  })
  test("clamps xhigh to medium when only medium is supported", () => {
    expect(clampEffort("xhigh", ["medium"])).toBe("medium")
  })
  test("clamps high to medium when only low/medium are supported", () => {
    // distance: low=2, medium=1 → medium wins (closer)
    expect(clampEffort("high", ["low", "medium"])).toBe("medium")
  })
  test("equidistant tie picks the lower-tier value (low over high)", () => {
    // bucketed=medium, supported=[low,high]; both at distance 1
    // EFFORT_ORDER iterates low→xhigh, strict `<` keeps the first
    expect(clampEffort("medium", ["low", "high"])).toBe("low")
  })
  test("respects supported-array order independence (low/high vs high/low)", () => {
    // Same input, swapped supported order — must still pick low (canonical
    // EFFORT_ORDER iteration, not input array order).
    expect(clampEffort("medium", ["high", "low"])).toBe("low")
  })
  test("falls back to bucketed when supported is empty", () => {
    expect(clampEffort("medium", [])).toBe("medium")
  })
  test("xhigh with only low supported clamps to low", () => {
    expect(clampEffort("xhigh", ["low"])).toBe("low")
  })
})

describe("clampOutputConfigEffortInPlace", () => {
  function modelWithEfforts(efforts: Array<string> | undefined) {
    return {
      id: "test-model",
      capabilities: {
        supports: efforts === undefined ? {} : { reasoning_effort: efforts },
      },
    } as unknown as Parameters<typeof clampOutputConfigEffortInPlace>[1]
  }

  test("clamps xhigh to medium for opus-4.8-shaped allowlist (the bug-trigger case)", () => {
    const body: Record<string, unknown> = {
      output_config: { effort: "xhigh" },
    }
    const mutated = clampOutputConfigEffortInPlace(body, modelWithEfforts(["medium"]))
    expect(mutated).toBe(true)
    expect((body.output_config as { effort: string }).effort).toBe("medium")
  })

  test("no-op when current effort is already in the allowlist", () => {
    const body: Record<string, unknown> = {
      output_config: { effort: "medium" },
    }
    const mutated = clampOutputConfigEffortInPlace(body, modelWithEfforts(["low", "medium", "high"]))
    expect(mutated).toBe(false)
    expect((body.output_config as { effort: string }).effort).toBe("medium")
  })

  test("no-op when model has no reasoning_effort allowlist (treat as 'any accepted')", () => {
    const body: Record<string, unknown> = {
      output_config: { effort: "xhigh" },
    }
    const mutated = clampOutputConfigEffortInPlace(body, modelWithEfforts(undefined))
    expect(mutated).toBe(false)
    expect((body.output_config as { effort: string }).effort).toBe("xhigh")
  })

  test("no-op when output_config is absent", () => {
    const body: Record<string, unknown> = {}
    const mutated = clampOutputConfigEffortInPlace(body, modelWithEfforts(["medium"]))
    expect(mutated).toBe(false)
    expect(body.output_config).toBeUndefined()
  })

  test("no-op when output_config.effort is absent", () => {
    const body: Record<string, unknown> = { output_config: { schema: {} } }
    const mutated = clampOutputConfigEffortInPlace(body, modelWithEfforts(["medium"]))
    expect(mutated).toBe(false)
  })

  test("no-op when output_config.effort is non-string (defensive)", () => {
    const body: Record<string, unknown> = { output_config: { effort: 123 } }
    const mutated = clampOutputConfigEffortInPlace(body, modelWithEfforts(["medium"]))
    expect(mutated).toBe(false)
  })

  test("no-op when model is undefined", () => {
    const body: Record<string, unknown> = {
      output_config: { effort: "xhigh" },
    }
    const mutated = clampOutputConfigEffortInPlace(body, undefined)
    expect(mutated).toBe(false)
    expect((body.output_config as { effort: string }).effort).toBe("xhigh")
  })

  test("unknown effort string is bucketed as xhigh then clamped DOWN to highest supported", () => {
    // Defensive: an unrecognized effort (e.g. "ultra") should clamp
    // down, not up, so we never escalate above what the model allows.
    const body: Record<string, unknown> = {
      output_config: { effort: "ultra" },
    }
    const mutated = clampOutputConfigEffortInPlace(body, modelWithEfforts(["low", "medium"]))
    expect(mutated).toBe(true)
    expect((body.output_config as { effort: string }).effort).toBe("medium")
  })

  test("preserves other output_config fields when clamping effort", () => {
    const body: Record<string, unknown> = {
      output_config: { effort: "xhigh", schema: { type: "object" } },
    }
    clampOutputConfigEffortInPlace(body, modelWithEfforts(["medium"]))
    expect(body.output_config).toEqual({ effort: "medium", schema: { type: "object" } })
  })

  test("`none` on a model that lacks it clamps to the LOWEST supported, not the highest", () => {
    // `none` is advertised by every gpt-5.x catalog entry but not by gemini.
    // While it was absent from EFFORT_ORDER it counted as unrecognized, so a
    // request for the minimum was anchored high and clamped to `high` — the
    // maximum. Asking for less must never yield more.
    const body: Record<string, unknown> = { output_config: { effort: "none" } }
    const mutated = clampOutputConfigEffortInPlace(
      body,
      modelWithEfforts(["low", "medium", "high"]),
    )
    expect(mutated).toBe(true)
    expect((body.output_config as { effort: string }).effort).toBe("low")
  })

  test("`none` passes through untouched on a model that advertises it", () => {
    const body: Record<string, unknown> = { output_config: { effort: "none" } }
    const mutated = clampOutputConfigEffortInPlace(
      body,
      modelWithEfforts(["none", "low", "medium", "high", "xhigh"]),
    )
    expect(mutated).toBe(false)
    expect((body.output_config as { effort: string }).effort).toBe("none")
  })

  test("`max` passes through on a model advertising it, and clamps down on one that does not", () => {
    const supported: Record<string, unknown> = { output_config: { effort: "max" } }
    expect(
      clampOutputConfigEffortInPlace(
        supported,
        modelWithEfforts(["high", "xhigh", "max"]),
      ),
    ).toBe(false)
    expect((supported.output_config as { effort: string }).effort).toBe("max")

    const unsupported: Record<string, unknown> = { output_config: { effort: "max" } }
    clampOutputConfigEffortInPlace(unsupported, modelWithEfforts(["low", "medium", "high"]))
    expect((unsupported.output_config as { effort: string }).effort).toBe("high")
  })

  test("an unrecognized effort does NOT escalate to `max` on a max-capable model", () => {
    // The unknown-value anchor is deliberately not the top of the ladder: a
    // guess must never resolve to the most expensive tier a model offers.
    const body: Record<string, unknown> = { output_config: { effort: "ludicrous" } }
    clampOutputConfigEffortInPlace(
      body,
      modelWithEfforts(["low", "medium", "high", "xhigh", "max"]),
    )
    expect((body.output_config as { effort: string }).effort).toBe("xhigh")

    // The case above resolves on the anchor's own early-return, so it does not
    // exercise the distance walk. claude-opus-4.6 and claude-sonnet-4.6 really
    // do advertise `max` WITHOUT `xhigh`, which forces that walk and puts `max`
    // exactly one tier away — the same distance as `high`. The documented
    // tie-to-lower rule must keep it off the expensive tier.
    const noXhigh: Record<string, unknown> = { output_config: { effort: "ludicrous" } }
    clampOutputConfigEffortInPlace(
      noXhigh,
      modelWithEfforts(["low", "medium", "high", "max"]),
    )
    expect((noXhigh.output_config as { effort: string }).effort).toBe("high")

    // A known tier the model lacks resolves the same way, for the same reason.
    const knownTier: Record<string, unknown> = { output_config: { effort: "xhigh" } }
    clampOutputConfigEffortInPlace(
      knownTier,
      modelWithEfforts(["low", "medium", "high", "max"]),
    )
    expect((knownTier.output_config as { effort: string }).effort).toBe("high")

    // When `max` is genuinely the only tier on offer it IS selected — there is
    // nothing lower to fall back to, so this is correct rather than escalation.
    const onlyMax: Record<string, unknown> = { output_config: { effort: "ludicrous" } }
    clampOutputConfigEffortInPlace(onlyMax, modelWithEfforts(["max"]))
    expect((onlyMax.output_config as { effort: string }).effort).toBe("max")
  })
})

// --- Phase B P0.2: strip Anthropic-only body fields Copilot 400s on ---

describe("Anthropic-only body field stripping (Phase B P0.2)", () => {
  // Use claude-opus-4.7 — it doesn't have adaptive_thinking, so the
  // output_config.effort path doesn't fire. We're testing pure body-field
  // stripping in isolation.
  const makeBareClaudeModel = () =>
    makeModel({ id: "claude-opus-4.7" })

  function setupModelAndFetch(captured: { body?: string }) {
    state.models = { object: "list", data: [makeBareClaudeModel()] }
    const fetchMock = mock((url: string, opts?: { body?: string }) => {
      if (url.includes("/v1/messages")) {
        captured.body = opts?.body
        return emptyMessageResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock
  }

  test("strips top-level `budget` field (Copilot 400 'budget: Extra inputs not permitted' — verified live 2026-05-11)", async () => {
    const captured: { body?: string } = {}
    setupModelAndFetch(captured)

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        budget: { total_tokens: 10000 },
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(captured.body ?? "{}") as {
      budget?: unknown
      max_tokens?: number
    }
    expect(forwarded.budget).toBeUndefined()
    // Other fields preserved
    expect(forwarded.max_tokens).toBe(100)
  })

  test("strips top-level `output_config.schema` (Structured Outputs — Copilot 400 verified live)", async () => {
    const captured: { body?: string } = {}
    setupModelAndFetch(captured)

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        output_config: {
          schema: { type: "object", properties: { foo: { type: "string" } } },
        },
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(captured.body ?? "{}") as {
      output_config?: { schema?: unknown }
    }
    // Schema must be removed; whole output_config dropped because no other keys remain
    expect(forwarded.output_config).toBeUndefined()
  })

  test("preserves output_config.effort while stripping output_config.schema (translateThinking compatibility)", async () => {
    // Adaptive-thinking models use output_config.effort. The schema-strip
    // must NOT clobber a sibling effort field. This is a regression guard
    // against over-eager stripping that would break Phase 2C effort plumbing.
    state.models = {
      object: "list",
      data: [
        makeModel({
          id: "claude-opus-4.7",
          adaptive_thinking: true,
          reasoning_effort: ["low", "medium", "high", "xhigh"],
        }),
      ],
    }
    const captured: { body?: string } = {}
    const fetchMock = mock((url: string, opts?: { body?: string }) => {
      if (url.includes("/v1/messages")) {
        captured.body = opts?.body
        return emptyMessageResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        // Both shapes: schema (must be stripped) + effort (must be preserved)
        output_config: {
          schema: { type: "object", properties: {} },
          effort: "high",
        },
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(captured.body ?? "{}") as {
      output_config?: { schema?: unknown; effort?: string }
    }
    expect(forwarded.output_config?.schema).toBeUndefined()
    expect(forwarded.output_config?.effort).toBe("high")
  })

  test("strips top-level `betas` array (Copilot 400 — distinct from anthropic-beta header)", async () => {
    const captured: { body?: string } = {}
    setupModelAndFetch(captured)

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        betas: ["interleaved-thinking-2025-05-14"],
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(captured.body ?? "{}") as {
      betas?: unknown
    }
    expect(forwarded.betas).toBeUndefined()
  })

  test("strips per-tool `eager_input_streaming` field (Copilot 400 'tools.0.custom.eager_input_streaming' — verified live 2026-05-13; FGTS auto-enabled by getClaudeCodeEnvVars)", async () => {
    const captured: { body?: string } = {}
    setupModelAndFetch(captured)

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "echo_test",
            description: "Test tool",
            input_schema: {
              type: "object",
              properties: { x: { type: "string" } },
            },
            eager_input_streaming: true,
          },
        ],
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(captured.body ?? "{}") as {
      tools?: Array<{
        name?: string
        description?: string
        input_schema?: unknown
        eager_input_streaming?: unknown
        cache_control?: unknown
      }>
    }
    // Field stripped
    expect(forwarded.tools?.[0]?.eager_input_streaming).toBeUndefined()
    // Other tool fields preserved (regression guard against over-eager strip)
    expect(forwarded.tools?.[0]?.name).toBe("echo_test")
    expect(forwarded.tools?.[0]?.description).toBe("Test tool")
    expect(forwarded.tools?.[0]?.input_schema).toEqual({
      type: "object",
      properties: { x: { type: "string" } },
    })
  })

  test("strips `eager_input_streaming` from each tool independently (multi-tool, mixed presence)", async () => {
    const captured: { body?: string } = {}
    setupModelAndFetch(captured)

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "tool_a",
            description: "A",
            input_schema: { type: "object" },
            eager_input_streaming: true,
          },
          {
            name: "tool_b",
            description: "B",
            input_schema: { type: "object" },
          },
          {
            name: "tool_c",
            description: "C",
            input_schema: { type: "object" },
            eager_input_streaming: false,
          },
        ],
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(captured.body ?? "{}") as {
      tools?: Array<{ name?: string; eager_input_streaming?: unknown }>
    }
    // All three tools have the field stripped (true OR false — both rejected by Copilot)
    expect(forwarded.tools?.[0]?.eager_input_streaming).toBeUndefined()
    expect(forwarded.tools?.[1]?.eager_input_streaming).toBeUndefined()
    expect(forwarded.tools?.[2]?.eager_input_streaming).toBeUndefined()
    // Names preserved (no tool dropped)
    expect(forwarded.tools?.map((t) => t.name)).toEqual(["tool_a", "tool_b", "tool_c"])
  })

  test("does NOT touch tools[] when no `eager_input_streaming` present (no-op preservation)", async () => {
    const captured: { body?: string } = {}
    setupModelAndFetch(captured)

    const toolsBlock = [
      {
        name: "echo_test",
        description: "Test tool",
        input_schema: { type: "object" },
      },
    ]

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        tools: toolsBlock,
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(captured.body ?? "{}") as {
      tools?: typeof toolsBlock
    }
    expect(forwarded.tools).toEqual(toolsBlock)
  })

  test("does NOT strip `metadata` (Copilot 200s, ignores harmlessly — codex-critic 'preserve unknown unless documented' guidance)", async () => {
    const captured: { body?: string } = {}
    setupModelAndFetch(captured)

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: "test-user-123" },
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(captured.body ?? "{}") as {
      metadata?: { user_id?: string }
    }
    // Preserved verbatim — Copilot ignores it harmlessly
    expect(forwarded.metadata).toEqual({ user_id: "test-user-123" })
  })

  test("REJECTS `mcp_servers` with fail-fast 400 (Phase G — translate path deferred per codex-critic)", async () => {
    // Phase G design (proxy-side translate via inline-MCP client pool +
    // multi-turn tool loop) was deferred because codex-critic surfaced
    // structural design holes:
    //   - continuation-after-pool-TTL not implementable from request alone
    //   - streaming buffer-and-resume creates incoherent SSE if any
    //     assistant deltas already forwarded before tool_use detection
    //   - tool-name namespace (server:tool) regex unverified against
    //     Copilot
    // Better Pareto: fail-fast 400 with helpful error pointing user at
    // local stdio MCP via ~/.claude/mcp.json (which works without this
    // code).
    const captured: { body?: string } = {}
    setupModelAndFetch(captured)

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        mcp_servers: [
          { type: "url", url: "https://example.com/mcp", name: "test" },
        ],
      }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      type: string
      error: { type: string; message: string }
    }
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("mcp_servers")
    expect(body.error.message).toContain("~/.claude/mcp.json")
    // Most importantly: NEVER forwarded to Copilot
    expect(captured.body).toBeUndefined()
  })

  test("ACCEPTS empty mcp_servers array (no fail-fast — only non-empty triggers reject)", async () => {
    // Edge case: client sends mcp_servers:[] explicitly. Treat as no-op
    // (no inline servers to translate) — forward as-is. Copilot will
    // 400 because the field is "Extra inputs not permitted" regardless,
    // but our fail-fast condition is specifically "non-empty array" to
    // avoid false-positives.
    const captured: { body?: string } = {}
    setupModelAndFetch(captured)

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        mcp_servers: [],
      }),
    })
    // Empty array passes our fail-fast and reaches the upstream mock,
    // which we made 200 in setupModelAndFetch.
    expect(response.status).toBe(200)
    expect(captured.body).toBeDefined()
  })

  test("strips multiple Copilot-incompatible fields in one request (composes with cache_control + thinking translation)", async () => {
    state.models = {
      object: "list",
      data: [
        makeModel({
          id: "claude-opus-4.7",
          adaptive_thinking: true,
          reasoning_effort: ["low", "medium", "high", "xhigh"],
        }),
      ],
    }
    const captured: { body?: string } = {}
    const fetchMock = mock((url: string, opts?: { body?: string }) => {
      if (url.includes("/v1/messages")) {
        captured.body = opts?.body
        return emptyMessageResponse()
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: 5000 },
        budget: { total_tokens: 10000 },
        betas: ["foo"],
        output_config: { schema: {} },
        system: [
          { type: "text", text: "sys", cache_control: { type: "ephemeral", scope: "global" } },
        ],
      }),
    })
    expect(response.status).toBe(200)

    const forwarded = JSON.parse(captured.body ?? "{}") as {
      thinking?: { type?: string }
      output_config?: { effort?: string; schema?: unknown }
      budget?: unknown
      betas?: unknown
      system?: Array<{ cache_control?: { scope?: string; type?: string } }>
    }
    // Phase A + B + thinking translation all compose:
    expect(forwarded.thinking).toEqual({ type: "adaptive" })
    expect(forwarded.output_config?.effort).toBe("medium") // bucketed from 5000
    expect(forwarded.output_config?.schema).toBeUndefined() // stripped
    expect(forwarded.budget).toBeUndefined() // stripped
    expect(forwarded.betas).toBeUndefined() // stripped
    // cache_control.scope stripped, but cache_control.type preserved
    expect(forwarded.system?.[0].cache_control?.scope).toBeUndefined()
    expect(forwarded.system?.[0].cache_control?.type).toBe("ephemeral")
  })

  test("strips unsupported cache_control.scope from signed thinking without changing signed fields", async () => {
    const captured: { body?: string } = {}
    setupModelAndFetch(captured)
    const thinkingBlock = {
      type: "thinking",
      thinking: "",
      signature: "opaque",
      cache_control: { type: "ephemeral", scope: "global" },
    }

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 100,
        messages: [
          { role: "user", content: "start" },
          {
            role: "assistant",
            content: [
              thinkingBlock,
              { type: "text", text: "done" },
            ],
          },
          { role: "user", content: "continue" },
        ],
      }),
    })
    expect(response.status).toBe(200)
    const forwarded = JSON.parse(captured.body ?? "{}") as {
      messages: Array<{ content: Array<Record<string, unknown>> }>
    }
    expect(forwarded.messages[1]!.content[0]).toEqual({
      type: "thinking",
      thinking: "",
      signature: "opaque",
    })
  })

  test("fast-path skip: body without budget/output_config/betas avoids re-serialize", async () => {
    // The fast path is the `rawBody.includes('"budget"')` etc. check. If
    // none of those substrings appear, sanitization runs but doesn't
    // serialize. Verify the body is byte-identical to input.
    const captured: { body?: string } = {}
    setupModelAndFetch(captured)

    const inputBody = JSON.stringify({
      model: "claude-opus-4.7",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    })

    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: inputBody,
    })
    expect(response.status).toBe(200)
    expect(captured.body).toBe(inputBody)
  })

  test("count_tokens strips cache_control from signed thinking in lock-step", async () => {
    state.models = {
      object: "list",
      data: [makeModel({ id: "claude-opus-4.7" })],
    }
    let capturedBody = ""
    const fetchMock = mock((url: string, init?: { body?: string }) => {
      if (!url.includes("/v1/messages/count_tokens")) {
        throw new Error(`Unexpected URL ${url}`)
      }
      capturedBody = init?.body ?? ""
      return Response.json({ input_tokens: 42 })
    })
    // @ts-expect-error - override fetch for this test
    globalThis.fetch = fetchMock

    const response = await server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        messages: [
          { role: "user", content: "start" },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "",
                signature: "opaque",
                cache_control: { type: "ephemeral", scope: "global" },
              },
              { type: "text", text: "done" },
            ],
          },
          { role: "user", content: "continue" },
        ],
      }),
    })
    expect(response.status).toBe(200)
    const forwarded = JSON.parse(capturedBody) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>
    }
    expect(forwarded.messages[1]!.content[0]).toEqual({
      type: "thinking",
      thinking: "",
      signature: "opaque",
    })
  })
})
