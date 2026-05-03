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
