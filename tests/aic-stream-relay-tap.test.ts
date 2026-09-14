/**
 * The AIC byte tap on `relayAnthropicStream`: bytes must pass through
 * verbatim while the tap observes the terminal `copilot_usage`.
 *
 * Byte-fidelity is the load-bearing property — the tap parses but never
 * modifies. The enqueue-after-cancel race behavior is unchanged (no new
 * enqueue/close/read call sites) and stays covered by
 * tests/lib-stream-relay.test.ts + tests/integration/chaos.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createAnthropicAicTap } from "~/lib/aic-sse-tap"
import type { CopilotUsage } from "~/lib/aic-usage"
import { __resetAicLedgerForTests, recordAic } from "~/lib/aic-ledger"
import { relayAnthropicStream } from "~/lib/stream-relay"

const TERMINAL_DATA =
  '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":12,"output_tokens":4},"copilot_usage":{"token_details":[],"total_nano_aiu":3200000}}'

function sseStream(chunks: Array<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[i]!))
      i++
    },
  })
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

describe("relayAnthropicStream onBytes AIC tap", () => {
  let dir: string
  let savedEnv: string | undefined

  beforeEach(async () => {
    __resetAicLedgerForTests()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-router-aic-relay-"))
    savedEnv = process.env.GH_ROUTER_AIC_LEDGER
    process.env.GH_ROUTER_AIC_LEDGER = path.join(dir, "ledger.json")
  })

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.GH_ROUTER_AIC_LEDGER
    else process.env.GH_ROUTER_AIC_LEDGER = savedEnv
    __resetAicLedgerForTests()
    await fs.rm(dir, { recursive: true, force: true })
  })
  test("bytes relay verbatim while the tap records the terminal AIC", async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      `event: message_delta\ndata: ${TERMINAL_DATA}\n\n`.slice(0, 60),
      `event: message_delta\ndata: ${TERMINAL_DATA}\n\n`.slice(60),
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    const seen: Array<CopilotUsage> = []
    const tap = createAnthropicAicTap((u) => {
      seen.push(u)
      recordAic("claude-haiku-4.5", u)
    })
    const relayed = relayAnthropicStream(sseStream(chunks), {
      routePath: "/v1/messages",
      onBytes: tap.onBytes,
    })
    const text = await readAll(relayed)
    expect(text).toBe(chunks.join(""))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.totalNanoAiu).toBe(3200000)
  })

  test("relay works without a tap (back-compat)", async () => {
    const chunks = ['event: ping\ndata: {}\n\n']
    const relayed = relayAnthropicStream(sseStream(chunks), {
      routePath: "/v1/messages",
    })
    expect(await readAll(relayed)).toBe(chunks.join(""))
  })
})
