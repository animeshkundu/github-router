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
    { batch_size: 1000000, cost_per_batch: 20000000000, model: "gpt-5.6-sol", token_count: 11, token_type: "input" },
  ],
  total_nano_aiu: 220000,
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
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          id: "resp_test",
          object: "response",
          status: "completed",
          output: [
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "looks fine" }] },
          ],
          copilot_usage: USAGE,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch
    const text = await dispatchModelCall({
      model: "gpt-5.6-sol",
      endpoint: "/v1/responses",
      instructions: "review",
      userText: "is this ok?",
      effort: "high",
    })
    expect(text).toBe("looks fine")
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.totalNanoAiu).toBe(220000)
    expect(snap.perModel["gpt-5.6-sol"]?.requests).toBe(1)
  })

  test("chat persona call records once under the resolved model", async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl_test",
          object: "chat.completion",
          created: 0,
          model: "gemini-3.8-flash",
          choices: [
            { index: 0, message: { role: "assistant", content: "fine" }, finish_reason: "stop", logprobs: null },
          ],
          copilot_usage: USAGE,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch
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
})
