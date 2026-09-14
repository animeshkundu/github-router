import { describe, expect, test } from "bun:test"

import { createAnthropicAicTap } from "~/lib/aic-sse-tap"
import type { CopilotUsage } from "~/lib/aic-usage"

const TERMINAL = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":12,"output_tokens":4},"copilot_usage":{"token_details":[],"total_nano_aiu":3200000}}\n\n'
const NON_TERMINAL = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n'

function feed(tap: { onBytes(b: Uint8Array): void }, text: string, splitAt: Array<number>): void {
  const bytes = new TextEncoder().encode(text)
  let start = 0
  for (const at of [...splitAt, bytes.length]) {
    tap.onBytes(bytes.slice(start, at))
    start = at
  }
}

describe("createAnthropicAicTap", () => {
  test("records terminal copilot_usage exactly once, even split mid-frame", () => {
    const seen: Array<CopilotUsage> = []
    const tap = createAnthropicAicTap((u) => seen.push(u))
    const stream = NON_TERMINAL + TERMINAL + TERMINAL
    // Split at awkward offsets, including inside the JSON number.
    feed(tap, stream, [7, 13, 100, 101, 250])
    expect(seen).toHaveLength(1)
    expect(seen[0]!.totalNanoAiu).toBe(3200000)
  })

  test("ignores non-delta events and malformed frames without throwing", () => {
    const seen: Array<CopilotUsage> = []
    const tap = createAnthropicAicTap((u) => seen.push(u))
    feed(tap, 'event: message_stop\ndata: {"type":"message_stop"}\n\n', [5])
    feed(tap, 'event: message_delta\ndata: not-json\n\n', [10])
    feed(tap, 'event: ping\ndata: {}\n\n', [])
    expect(seen).toHaveLength(0)
    // Empty input is a no-op.
    tap.onBytes(new Uint8Array(0))
    expect(seen).toHaveLength(0)
  })

  test("a throwing record callback never breaks the tap", () => {
    const tap = createAnthropicAicTap(() => {
      throw new Error("boom")
    })
    expect(() => feed(tap, NON_TERMINAL + TERMINAL, [3])).not.toThrow()
    // Still terminal: marked recorded, subsequent bytes are cheap no-ops.
    expect(() => feed(tap, TERMINAL, [])).not.toThrow()
  })
})
