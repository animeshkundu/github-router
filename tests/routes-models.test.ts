import { afterEach, beforeEach, expect, test } from "bun:test"

import { Hono } from "hono"

import { modelRoutes } from "../src/routes/models/route"
import { state } from "../src/lib/state"

const fakeUpstreamModel = {
  id: "claude-opus-4.7",
  name: "Claude Opus 4.7",
  vendor: "Anthropic",
  version: "claude-opus-4.7",
  preview: false,
  model_picker_enabled: true,
  model_picker_category: "powerful",
  is_chat_default: false,
  is_chat_fallback: false,
  info_messages: [{ code: "preview", message: "Preview model" }],
  capabilities: {
    type: "chat",
    family: "claude-opus-4.7",
    object: "model_capabilities",
    tokenizer: "o200k_base",
    limits: { max_context_window_tokens: 200_000 },
    supports: { tool_calls: true, streaming: true, adaptive_thinking: true },
  },
  supported_endpoints: ["/v1/messages", "/chat/completions"],
  policy: { state: "enabled", terms: "x" },
  billing: {
    is_premium: true,
    multiplier: 15,
    restricted_to: ["pro_plus", "business", "enterprise", "max"],
  },
  requestHeaders: { "x-router-internal": "secret" },
  object: "model",
}

beforeEach(() => {
  state.models = { data: [fakeUpstreamModel], object: "list" }
})

afterEach(() => {
  state.models = undefined
})

test("Claude Code 2.1.260 discovery drops non-Claude ids before replacing its cache", async () => {
  state.models = {
    object: "list",
    data: [
      fakeUpstreamModel,
      { ...fakeUpstreamModel, id: "gpt-5.6-sol", name: "GPT-5.6 Sol", vendor: "OpenAI" },
      { ...fakeUpstreamModel, id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", vendor: "Google" },
      { ...fakeUpstreamModel, id: "grok-4.6", name: "Grok 4.6", vendor: "xAI" },
    ],
  }
  const app = new Hono().route("/", modelRoutes)
  const response = await app.request("/?limit=1000")
  const payload = (await response.json()) as {
    data: Array<{ id: string; display_name?: string }>
  }

  // Claude Code 2.1.260 applies this client-owned filter, then replaces
  // gateway-models.json when the result differs. A router-written cache is
  // therefore not an authoritative picker source once discovery is enabled.
  const refreshedCacheRows = payload.data
    .filter((entry) => /(claude|anthropic)/i.test(entry.id))
    .map((entry) => ({ id: entry.id, display_name: entry.display_name }))

  expect(payload.data.map((entry) => entry.id)).toEqual([
    "claude-opus-4.7",
    "gpt-5.6-sol",
    "gemini-3.8-flash",
    "grok-4.6",
  ])
  expect(refreshedCacheRows).toEqual([
    { id: "claude-opus-4.7", display_name: "Claude Opus 4.7" },
  ])
})

test("/models preserves upstream Copilot fields (regression for projection drop)", async () => {
  const app = new Hono().route("/", modelRoutes)
  const res = await app.request("/")
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    object: string
    data: Array<Record<string, unknown>>
  }
  expect(body.object).toBe("list")
  expect(body.data).toHaveLength(1)

  const m = body.data[0]
  // Fields that the old projection dropped — must now be present:
  expect(m.billing).toEqual({
    is_premium: true,
    multiplier: 15,
    restricted_to: ["pro_plus", "business", "enterprise", "max"],
  })
  expect(m.is_chat_default).toBe(false)
  expect(m.is_chat_fallback).toBe(false)
  expect(m.model_picker_category).toBe("powerful")
  expect(m.info_messages).toEqual([{ code: "preview", message: "Preview model" }])

  // OpenAI-compat aliases must still be present:
  expect(m.id).toBe("claude-opus-4.7")
  expect(m.object).toBe("model")
  expect(m.owned_by).toBe("Anthropic")
  expect(m.display_name).toBe("Claude Opus 4.7")
  expect(m.type).toBe("chat")
  expect(m.created).toBe(0)
  expect(m.created_at).toBe(new Date(0).toISOString())

  // Original Copilot fields still preserved:
  expect(m.capabilities).toBeDefined()
  expect(m.supported_endpoints).toEqual(["/v1/messages", "/chat/completions"])
  expect(m.preview).toBe(false)
  expect(m.policy).toEqual({ state: "enabled", terms: "x" })

  // requestHeaders is router-internal and intentionally NOT exposed:
  expect(m.requestHeaders).toBeUndefined()
})
