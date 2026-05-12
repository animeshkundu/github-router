import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test"

import { state } from "../src/lib/state"
import { bucketEffort, clampEffort } from "../src/routes/messages/handler"
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

beforeEach(() => {
  savedModels = state.models
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
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
})
