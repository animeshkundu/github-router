import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { __resetAicLedgerForTests, aicSnapshot } from "../src/lib/aic-ledger"
import {
  __resetCompressorBackendForTests,
  callCompressorPublic,
  compressorAvailable,
  pickBackendFromCatalog,
} from "../src/lib/browser-mcp/compressor"
import { state } from "../src/lib/state"
import type { ModelsResponse } from "../src/services/copilot/get-models"

// A catalog model. `toolCalls` gates the tool_calls capability; `endpoints`
// is the catalog `supported_endpoints` the endpoint-aware selector reads
// (live strings are "/chat/completions" and "/responses" — NO /v1 prefix).
const model = (
  id: string,
  opts: { toolCalls?: boolean; endpoints?: Array<string> } = {},
) => ({
  id,
  name: id,
  vendor: "Test" as const,
  version: id,
  preview: true,
  model_picker_enabled: true,
  object: "model" as const,
  capabilities: {
    type: "chat",
    family: id,
    object: "model_capabilities",
    tokenizer: "o200k_base",
    limits: { max_context_window_tokens: 200_000 },
    supports: opts.toolCalls === false ? {} : { tool_calls: true },
  },
  supported_endpoints: opts.endpoints ?? ["/chat/completions"],
})

function setCatalog(entries: Array<ReturnType<typeof model>>) {
  state.models = { object: "list", data: entries } as ModelsResponse
}

describe("browser-mcp compressor backend selection (endpoint-aware)", () => {
  let savedModels: typeof state.models

  beforeEach(() => {
    savedModels = state.models
    __resetCompressorBackendForTests()
  })
  afterEach(() => {
    state.models = savedModels
    __resetCompressorBackendForTests()
  })

  test("prefers gpt-5.4-mini (selected for /responses) when present", () => {
    // gpt-5.4-mini is /responses-only — the chain head must still pick it.
    setCatalog([
      model("claude-haiku-4.5"),
      model("claude-sonnet-4.6"),
      model("gpt-5.4-mini", { endpoints: ["/responses", "ws:/responses"] }),
    ])
    expect(pickBackendFromCatalog()).toBe("gpt-5.4-mini")
  })

  test("falls through to claude-sonnet-4.6 when gpt-5.4-mini is absent", () => {
    setCatalog([model("claude-sonnet-4.6"), model("claude-haiku-4.5")])
    expect(pickBackendFromCatalog()).toBe("claude-sonnet-4.6")
  })

  test("selects claude-haiku-4.5 as the last resort", () => {
    setCatalog([model("claude-haiku-4.5")])
    expect(pickBackendFromCatalog()).toBe("claude-haiku-4.5")
  })

  test("skips a chain entry that lacks tool_calls support", () => {
    setCatalog([
      model("gpt-5.4-mini", { toolCalls: false, endpoints: ["/responses"] }),
      model("claude-sonnet-4.6"),
    ])
    expect(pickBackendFromCatalog()).toBe("claude-sonnet-4.6")
  })

  test("regression: skips a chain entry that serves NEITHER /chat/completions NOR /responses", () => {
    // The class of bug that broke the compressor: a model advertising
    // tool_calls but reachable through neither of our clients must be
    // skipped, not cached as a dead backend that 400s every call.
    setCatalog([
      model("gpt-5.4-mini", { endpoints: ["ws:/responses"] }),
      model("claude-sonnet-4.6"),
    ])
    expect(pickBackendFromCatalog()).toBe("claude-sonnet-4.6")
  })

  test("compressorAvailable() is false when no chain entry is in the catalog", () => {
    setCatalog([model("gpt-5.5"), model("claude-opus-4-8")])
    expect(compressorAvailable()).toBe(false)
    expect(pickBackendFromCatalog()).toBeUndefined()
  })
})

const COMPRESSOR_TOOL = {
  name: "find_elements",
  description: "pick",
  parameters: { type: "object", properties: { ok: { type: "boolean" } } },
}

function requestUrl(input: unknown): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return String(input)
  if (input && typeof input === "object" && "url" in input) {
    return String((input as { url: unknown }).url)
  }
  return String(input)
}

function nanoUsage(modelId: string, tokenCount: number, totalNanoAiu: number) {
  return {
    token_details: [
      {
        batch_size: 1000000,
        cost_per_batch: 20000000000,
        model: modelId,
        token_count: tokenCount,
        token_type: "input",
      },
    ],
    total_nano_aiu: totalNanoAiu,
  }
}

describe("browser-mcp compressor AIC recording", () => {
  const originalFetch = globalThis.fetch
  let savedModels: typeof state.models
  let savedEnv: string | undefined
  let dir = ""

  beforeEach(async () => {
    __resetAicLedgerForTests()
    __resetCompressorBackendForTests()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-router-aic-compressor-"))
    savedEnv = process.env.GH_ROUTER_AIC_LEDGER
    process.env.GH_ROUTER_AIC_LEDGER = path.join(dir, "ledger.json")
    savedModels = state.models
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
    __resetCompressorBackendForTests()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  test("chat compressor call records once under the selected model", async () => {
    setCatalog([model("claude-haiku-4.5")])
    expect(pickBackendFromCatalog()).toBe("claude-haiku-4.5")
    const usage = nanoUsage("claude-haiku-4.5", 7, 140000)
    globalThis.fetch = mock(async (input: unknown) => {
      const url = requestUrl(input)
      if (!url.includes("/chat/completions")) {
        throw new Error(`unexpected fetch URL: ${url}`)
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl_compressor",
          object: "chat.completion",
          created: 0,
          model: "claude-haiku-4.5",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "find_elements", arguments: "{\"ok\":true}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
              logprobs: null,
            },
          ],
          copilot_usage: usage,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const result = await callCompressorPublic("system", "pick the button", COMPRESSOR_TOOL)
    expect(result).toEqual({ ok: true })
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.totalNanoAiu).toBe(140000)
    expect(snap.perModel["claude-haiku-4.5"]?.requests).toBe(1)
    expect(snap.perModel["claude-haiku-4.5"]?.nanoAiu).toBe(140000)
  })

  test("responses compressor call records once under the selected model", async () => {
    setCatalog([model("gpt-5.4-mini", { endpoints: ["/responses", "ws:/responses"] })])
    expect(pickBackendFromCatalog()).toBe("gpt-5.4-mini")
    const usage = nanoUsage("gpt-5.4-mini", 9, 180000)
    globalThis.fetch = mock(async (input: unknown) => {
      const url = requestUrl(input)
      if (!url.includes("/responses") || url.includes("/chat/completions")) {
        throw new Error(`unexpected fetch URL: ${url}`)
      }
      return new Response(
        JSON.stringify({
          id: "resp_compressor",
          object: "response",
          status: "completed",
          output: [
            {
              type: "function_call",
              name: "find_elements",
              arguments: "{\"ok\":true}",
            },
          ],
          copilot_usage: usage,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const result = await callCompressorPublic("system", "pick the button", COMPRESSOR_TOOL)
    expect(result).toEqual({ ok: true })
    const snap = aicSnapshot()
    expect(snap.requests).toBe(1)
    expect(snap.totalNanoAiu).toBe(180000)
    expect(snap.perModel["gpt-5.4-mini"]?.requests).toBe(1)
    expect(snap.perModel["gpt-5.4-mini"]?.nanoAiu).toBe(180000)
  })
})
