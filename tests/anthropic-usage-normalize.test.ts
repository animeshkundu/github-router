import { describe, test, expect, afterEach, beforeEach } from "bun:test"

import {
  anthropicUsageNormalizeDisabled,
  createAnthropicUsageRewriteTransform,
  normalizeAnthropicUsageInPlace,
} from "../src/lib/anthropic-usage"

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

const ENV_KEY = "GH_ROUTER_DISABLE_ANTHROPIC_USAGE_NORMALIZE"
const originalEnv = process.env[ENV_KEY]

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = originalEnv
})

/** Run a byte sequence through a fresh transform, as push → flush. */
function rewriteAll(
  chunks: Array<string | Uint8Array>,
): string {
  const transform = createAnthropicUsageRewriteTransform()
  const parts: Array<Uint8Array> = []
  for (const chunk of chunks) {
    const bytes = typeof chunk === "string" ? ENCODER.encode(chunk) : chunk
    const out = transform.push(bytes)
    if (out && out.byteLength > 0) parts.push(out)
  }
  const tail = transform.flush()
  if (tail && tail.byteLength > 0) parts.push(tail)
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.byteLength
  }
  return DECODER.decode(merged)
}

function startEvent(usage: Record<string, unknown>): string {
  return `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: { id: "msg_1", role: "assistant", usage },
  })}\n\n`
}

function deltaEvent(usage: Record<string, unknown>): string {
  return `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage,
  })}\n\n`
}

describe("normalizeAnthropicUsageInPlace", () => {
  test("rewrites inclusive input_tokens to the uncached remainder", () => {
    // Measured on session ec65e3f9 turn 2: a ~2 KB inter-turn payload could
    // not have added ~56k tokens, so `input_tokens` includes the cached prefix.
    const usage: Record<string, unknown> = {
      input_tokens: 56_423,
      cache_read_input_tokens: 55_808,
      cache_creation_input_tokens: 0,
      output_tokens: 152,
    }
    expect(normalizeAnthropicUsageInPlace(usage)).toBe(true)
    expect(usage.input_tokens).toBe(615)
    expect(usage.cache_read_input_tokens).toBe(55_808)
    expect(usage.output_tokens).toBe(152)
  })

  test("subtracts BOTH cache buckets", () => {
    const usage: Record<string, unknown> = {
      input_tokens: 100,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
    }
    expect(normalizeAnthropicUsageInPlace(usage)).toBe(true)
    expect(usage.input_tokens).toBe(50)
  })

  test("cold turn (no cache) is a no-op", () => {
    const usage: Record<string, unknown> = { input_tokens: 55_931, output_tokens: 195 }
    expect(normalizeAnthropicUsageInPlace(usage)).toBe(false)
    expect(usage.input_tokens).toBe(55_931)
  })

  test("exclusive shape (input < cached) is left verbatim", () => {
    // The conformant Anthropic contract: 26 NEW tokens on top of a 97,304-token
    // cached prefix. Impossible under inclusive semantics, so it is the signal
    // that this upstream needs no correction. This guard is what lets the
    // rewrite run unconditionally on a path shared with a conformant endpoint.
    const usage: Record<string, unknown> = {
      input_tokens: 26,
      cache_read_input_tokens: 97_304,
      cache_creation_input_tokens: 0,
    }
    expect(normalizeAnthropicUsageInPlace(usage)).toBe(false)
    expect(usage.input_tokens).toBe(26)
  })

  test("clamps at zero when the buckets are exactly equal", () => {
    const usage: Record<string, unknown> = {
      input_tokens: 100,
      cache_read_input_tokens: 100,
    }
    expect(normalizeAnthropicUsageInPlace(usage)).toBe(true)
    expect(usage.input_tokens).toBe(0)
  })

  test("is not idempotent — the contract is one call per usage object", () => {
    // Below 2x the cleaned remainder sits under the cache bucket, so the
    // exclusive-shape guard makes a second pass a no-op by accident rather
    // than by design.
    const narrow: Record<string, unknown> = {
      input_tokens: 100,
      cache_read_input_tokens: 60,
    }
    expect(normalizeAnthropicUsageInPlace(narrow)).toBe(true)
    expect(narrow.input_tokens).toBe(40)
    expect(normalizeAnthropicUsageInPlace(narrow)).toBe(false)
    expect(narrow.input_tokens).toBe(40)

    // At or above 2x it subtracts the cache again. No production path applies
    // the rewrite twice; this pins the behaviour the "call once" contract
    // exists to prevent rather than endorsing it.
    const wide: Record<string, unknown> = {
      input_tokens: 300,
      cache_read_input_tokens: 60,
    }
    expect(normalizeAnthropicUsageInPlace(wide)).toBe(true)
    expect(wide.input_tokens).toBe(240)
    expect(normalizeAnthropicUsageInPlace(wide)).toBe(true)
    expect(wide.input_tokens).toBe(180)
  })

  test("missing, zero, and non-numeric fields never throw", () => {
    const cases: Array<unknown> = [
      {},
      { input_tokens: 5 },
      { input_tokens: undefined, cache_read_input_tokens: 5 },
      { input_tokens: "56", cache_read_input_tokens: 10 },
      { input_tokens: 50, cache_read_input_tokens: "many" },
      { input_tokens: Number.NaN, cache_read_input_tokens: 10 },
      { input_tokens: Number.POSITIVE_INFINITY, cache_read_input_tokens: 10 },
      { input_tokens: -10, cache_read_input_tokens: 10 },
      { input_tokens: null, cache_read_input_tokens: null },
    ]
    for (const usage of cases) {
      expect(() => normalizeAnthropicUsageInPlace(usage)).not.toThrow()
    }
  })

  test("non-object usage is rejected without throwing", () => {
    expect(normalizeAnthropicUsageInPlace(undefined)).toBe(false)
    expect(normalizeAnthropicUsageInPlace(null)).toBe(false)
    expect(normalizeAnthropicUsageInPlace("usage")).toBe(false)
    expect(normalizeAnthropicUsageInPlace([1, 2, 3])).toBe(false)
  })
})

describe("anthropicUsageNormalizeDisabled", () => {
  test("defaults to enabled", () => {
    delete process.env[ENV_KEY]
    expect(anthropicUsageNormalizeDisabled()).toBe(false)
  })

  test("accepts the repo's boolean spellings", () => {
    for (const value of ["1", "true", "yes", "on", "TRUE"]) {
      process.env[ENV_KEY] = value
      expect(anthropicUsageNormalizeDisabled()).toBe(true)
    }
    for (const value of ["0", "false", "off", ""]) {
      process.env[ENV_KEY] = value
      expect(anthropicUsageNormalizeDisabled()).toBe(false)
    }
  })
})

describe("createAnthropicUsageRewriteTransform", () => {
  test("rewrites message_start usage and leaves the rest byte-identical", () => {
    const cold = startEvent({ input_tokens: 55_931, output_tokens: 195 })
    const warm = deltaEvent({
      input_tokens: 56_423,
      cache_read_input_tokens: 55_808,
      output_tokens: 152,
    })
    const unrelated = `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hi" },
    })}\n\n`

    const out = rewriteAll([cold + unrelated + warm])

    expect(out.startsWith(cold)).toBe(true)
    expect(out).toContain(unrelated)
    const rewritten = deltaEvent({
      input_tokens: 615,
      cache_read_input_tokens: 55_808,
      output_tokens: 152,
    })
    expect(out).toContain(rewritten)
    expect(out).not.toContain('"input_tokens":56423')
  })

  test("reassembles a record split across arbitrary chunk boundaries", () => {
    const record = deltaEvent({
      input_tokens: 56_423,
      cache_read_input_tokens: 55_808,
    })
    const splitPoints = [1, 7, 20, 33, record.length - 3, record.length - 1]
    for (const point of splitPoints) {
      const out = rewriteAll([record.slice(0, point), record.slice(point)])
      expect(out).toBe(deltaEvent({ input_tokens: 615, cache_read_input_tokens: 55_808 }))
    }
    // One byte at a time is the pathological case; the output must still match.
    const byteWise: Array<Uint8Array> = []
    const bytes = ENCODER.encode(record)
    for (let i = 0; i < bytes.byteLength; i++) byteWise.push(bytes.subarray(i, i + 1))
    expect(rewriteAll(byteWise)).toBe(
      deltaEvent({ input_tokens: 615, cache_read_input_tokens: 55_808 }),
    )
  })

  test("handles CRLF record terminators", () => {
    const payload = JSON.stringify({
      type: "message_delta",
      delta: {},
      usage: { input_tokens: 100, cache_read_input_tokens: 60 },
    })
    const out = rewriteAll([`event: message_delta\r\ndata: ${payload}\r\n\r\n`])
    expect(out).toContain('"input_tokens":40')
  })

  test("a record split mid-terminator is not emitted early", () => {
    const record = deltaEvent({ input_tokens: 100, cache_read_input_tokens: 60 })
    const cut = record.length - 1 // between the two trailing newlines
    const transform = createAnthropicUsageRewriteTransform()
    expect(transform.push(ENCODER.encode(record.slice(0, cut)))).toBeUndefined()
    const rest = transform.push(ENCODER.encode(record.slice(cut)))
    expect(rest).toBeDefined()
    expect(DECODER.decode(rest!)).toBe(
      deltaEvent({ input_tokens: 40, cache_read_input_tokens: 60 }),
    )
  })

  test("flush releases a trailing record that never terminated", () => {
    const transform = createAnthropicUsageRewriteTransform()
    const tail = ENCODER.encode(`event: message_delta\ndata: {"type":"message_delta"`)
    expect(transform.push(tail)).toBeUndefined()
    const flushed = transform.flush()
    expect(DECODER.decode(flushed!)).toBe(
      `event: message_delta\ndata: {"type":"message_delta"`,
    )
    expect(transform.flush()).toBeUndefined()
  })

  test("unparseable or non-object data is passed through verbatim", () => {
    const bad = "event: message_delta\ndata: {not json\n\n"
    const text = "event: message_delta\ndata: hello\n\n"
    const array = "event: message_delta\ndata: [1,2,3]\n\n"
    expect(rewriteAll([bad])).toBe(bad)
    expect(rewriteAll([text])).toBe(text)
    expect(rewriteAll([array])).toBe(array)
  })

  test("a cold event with no cache is byte-identical", () => {
    const record = `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { id: "msg_1", usage: { input_tokens: 1_000 } },
    })}\n\n`
    expect(rewriteAll([record])).toBe(record)
  })

  test("an oversized unterminated buffer is emitted verbatim instead of buffered forever", () => {
    const transform = createAnthropicUsageRewriteTransform()
    const big = new Uint8Array((1 << 20) + 1)
    big.fill(0x61) // "a" — no terminator anywhere
    expect(transform.push(big)).toBeDefined()
    // The buffer was released, so nothing is left for flush to emit.
    expect(transform.flush()).toBeUndefined()
  })

  test("two complete records in one chunk are both processed", () => {
    const first = deltaEvent({ input_tokens: 100, cache_read_input_tokens: 60 })
    const second = deltaEvent({ input_tokens: 200, cache_read_input_tokens: 150 })
    const out = rewriteAll([first + second])
    expect(out).toBe(
      deltaEvent({ input_tokens: 40, cache_read_input_tokens: 60 })
        + deltaEvent({ input_tokens: 50, cache_read_input_tokens: 150 }),
    )
  })
})

describe("usage frame diagnostic (GH_ROUTER_LOG_ANTHROPIC_USAGE_FRAMES)", () => {
  const FRAME_ENV = "GH_ROUTER_LOG_ANTHROPIC_USAGE_FRAMES"
  const originalFrameEnv = process.env[FRAME_ENV]
  let originalWrite: typeof process.stderr.write
  let lines: Array<string>

  beforeEach(() => {
    // The diagnostic writes to stderr (the GH_ROUTER_LOG_PEER_MCP pattern) so
    // it cannot interleave with a JSONL-speaking client's stdout.
    originalWrite = process.stderr.write
    lines = []
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk).replace(/\n$/, ""))
      return true
    }) as unknown as typeof process.stderr.write
    process.env[FRAME_ENV] = "1"
  })

  afterEach(() => {
    process.stderr.write = originalWrite
    if (originalFrameEnv === undefined) delete process.env[FRAME_ENV]
    else process.env[FRAME_ENV] = originalFrameEnv
  })

  test("logs the RAW upstream values, before normalization", () => {
    rewriteAll([
      startEvent({
        input_tokens: 56_423,
        cache_read_input_tokens: 55_808,
        output_tokens: 1,
      }),
      deltaEvent({
        input_tokens: 56_423,
        cache_read_input_tokens: 55_808,
        output_tokens: 152,
      }),
    ])
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain("message_start")
    // Raw, not the 615 the rewrite produces: the diagnostic exists to report
    // what the wire carried.
    expect(lines[0]).toContain("input_tokens=56423")
    expect(lines[0]).toContain("cache_read_input_tokens=55808")
    expect(lines[1]).toContain("message_delta")
    expect(lines[1]).toContain("input_tokens=56423")
    expect(lines[1]).toContain("cache_creation_input_tokens=absent")
  })

  test("a split frame shape is visible: missing fields log as absent", () => {
    rewriteAll([
      startEvent({ input_tokens: 56_423 }),
      deltaEvent({ cache_read_input_tokens: 55_808 }),
    ])
    expect(lines[0]).toContain("input_tokens=56423")
    expect(lines[0]).toContain("cache_read_input_tokens=absent")
    expect(lines[1]).toContain("input_tokens=absent")
    expect(lines[1]).toContain("cache_read_input_tokens=55808")
  })

  test("a usage-less event logs as absent rather than throwing", () => {
    rewriteAll([deltaEvent({})])
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain("message_delta")
    expect(lines[0]).toContain("input_tokens=absent")
  })

  test("is silent unless the flag is exactly 1", () => {
    delete process.env[FRAME_ENV]
    rewriteAll([deltaEvent({ input_tokens: 100, cache_read_input_tokens: 60 })])
    expect(lines.length).toBe(0)
  })
})
