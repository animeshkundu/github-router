import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { __resetAicLedgerForTests, aicSnapshot } from "~/lib/aic-ledger"
import { state } from "~/lib/state"
import { dispatchModelCall } from "~/routes/mcp/handler"

/**
 * Peer/oracle/stand-in dispatches are billed Copilot calls made via this
 * instance — the session AIC total must include them, not just
 * lead/subagent turns.
 */

const USAGE = {
  token_details: [
    { batch_size: 1000000, cost_per_batch: 20000000000, model: "gpt-6-sol", token_count: 11, token_type: "input" },
  ],
  total_nano_aiu: 220000,
}

const MESSAGES_USAGE = {
  token_details: [
    { batch_size: 1000000, cost_per_batch: 15000000000, model: "claude-haiku-4.5", token_count: 22, token_type: "input" },
  ],
  total_nano_aiu: 330000,
}

function requestUrl(input: unknown): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return String(input)
  if (input && typeof input === "object" && "url" in input) {
    return String((input as { url: unknown }).url)
  }
  return String(input)
}

function installFailClosedFetch(expectedPath: string, body: unknown): void {
  globalThis.fetch = mock(async (input: unknown) => {
    const url = requestUrl(input)
    if (!url.includes(expectedPath)) {
      throw new Error(`unexpected fetch URL: ${url}`)
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
}

const originalFetch = globalThis.fetch
let dir = ""
let savedEnv: string | undefined
let savedModels: typeof state.models

beforeEach(async () => {
  __resetAicLedgerForTests()
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-router-aic-dispatch-"))
  savedEnv = process.env.GH_ROUTER_AIC_LEDGER
  process.env.GH_ROUTER_AIC_LEDGER = path.join(dir, "ledger.json")
  savedModels = state.models
  state.models = undefined
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "enterprise"
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  state.models = savedModels
  if (savedEnv === undefined) delete process.env.GH_ROUTER_AIC_LEDGER
  else process.env.GH_ROUTER_AIC_LEDGER = savedEnv
  __resetAicLedgerForTests()
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

describe("dispatchModelCall AIC coverage", () => {
  test("responses persona call records once under the resolved model", async () => {
    installFailClosedFetch("/responses", {
      id: "resp_test",
      object: "response",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "looks fine" }] },
      ],
      copilot_usage: USAGE,
    })
    const text = await dispatchModelCall({
      model: "gpt-6-sol",
      endpoint: "/v1/responses",
      instructions: "review",
      userText: "is this ok?",
      effort: "high",
    })
    expect(text).toBe("looks fine")
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.totalNanoAiu).toBe(220000)
    expect(snap.perModel["gpt-6-sol"]?.requests).toBe(1)
  })

  test("chat persona call records once under the resolved model", async () => {
    installFailClosedFetch("/chat/completions", {
      id: "chatcmpl_test",
      object: "chat.completion",
      created: 0,
      model: "gemini-3.8-flash",
      choices: [
        { index: 0, message: { role: "assistant", content: "fine" }, finish_reason: "stop", logprobs: null },
      ],
      copilot_usage: USAGE,
    })
    const text = await dispatchModelCall({
      model: "gemini-3.8-flash",
      endpoint: "/v1/chat/completions",
      instructions: "review",
      userText: "is this ok?",
      effort: "high",
    })
    expect(text).toBe("fine")
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.totalNanoAiu).toBe(220000)
  })

  test("messages persona call records once under the resolved Claude model", async () => {
    installFailClosedFetch("/v1/messages", {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4.5",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 22, output_tokens: 2 },
      copilot_usage: MESSAGES_USAGE,
    })
    const text = await dispatchModelCall({
      model: "claude-haiku-4.5",
      endpoint: "/v1/messages",
      instructions: "review",
      userText: "is this ok?",
      effort: "high",
    })
    expect(text).toBe("ok")
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.totalNanoAiu).toBe(330000)
    expect(snap.perModel["claude-haiku-4.5"]?.requests).toBe(1)
    expect(snap.perModel["claude-haiku-4.5"]?.nanoAiu).toBe(330000)
  })
})
