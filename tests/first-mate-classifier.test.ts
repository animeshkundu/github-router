import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import {
  classifyPlanReady,
  microClassify,
} from "~/lib/first-mate/classifier"
import { resolveTierModel } from "~/lib/first-mate/model-tiers"
import { state } from "~/lib/state"

type ModelCatalog = NonNullable<typeof state.models>
type FetchArgs = Parameters<typeof fetch>
type FetchMock = ReturnType<typeof mockChatCompletionContent>

type ChatRequest = {
  model?: unknown
  messages?: Array<{ role?: unknown; content?: unknown }>
  max_tokens?: unknown
  response_format?: unknown
  temperature?: unknown
}

const originalFetch = globalThis.fetch
const originalModels = state.models
const originalToken = state.copilotToken
const originalApiUrl = state.copilotApiUrl

function setModels(ids: string[]) {
  state.models = {
    data: ids.map((id) => ({ id })),
  } as unknown as ModelCatalog
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateOk(value: unknown): { ok: boolean } | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null
  return { ok: value.ok }
}

function mockChatCompletionContent(content: string) {
  const fetchMock = mock(
    async (_input: FetchArgs[0], _init?: FetchArgs[1]) =>
      new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { headers: { "content-type": "application/json" } },
      ),
  )
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  return fetchMock
}

function requestPayload(fetchMock: FetchMock): ChatRequest {
  const body = fetchMock.mock.calls[0]?.[1]?.body
  if (typeof body !== "string") throw new Error("missing request body")
  return JSON.parse(body) as ChatRequest
}

function classifyOk() {
  return microClassify({
    system: "Classify the payload.",
    user: "payload",
    schemaHint: '{"ok":boolean,"confidence":number}',
    validate: validateOk,
  })
}

beforeEach(() => {
  setModels(["gemini-3.5-flash", "gpt-5-mini"])
  state.copilotToken = "t"
  state.copilotApiUrl = "https://copilot.test"
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = originalModels
  state.copilotToken = originalToken
  state.copilotApiUrl = originalApiUrl
})

test("resolveTierModel picks preferred and falls through chains", () => {
  setModels(["gpt-4o-mini", "gemini-3.5-flash"])
  expect(resolveTierModel("T0")).toBe("gemini-3.5-flash")

  setModels(["gpt-4o-mini", "gpt-5-mini"])
  expect(resolveTierModel("T0")).toBe("gpt-5-mini")

  setModels(["catalog-first", "catalog-second"])
  expect(resolveTierModel("T1")).toBe("catalog-first")
  expect(resolveTierModel("T2")).toBe("catalog-first")
})

test("resolveTierModel falls back to a mini/flash T0 catalog id", () => {
  setModels(["claude-sonnet", "vendor-flash-fast", "gpt-5.5"])
  expect(resolveTierModel("T0")).toBe("vendor-flash-fast")
})

test("microClassify returns the value on a valid high-confidence response", async () => {
  const fetchMock = mockChatCompletionContent(
    JSON.stringify({ ok: true, confidence: 0.91 }),
  )

  await expect(classifyOk()).resolves.toEqual({
    value: { ok: true },
    confidence: 0.91,
  })

  expect(fetchMock).toHaveBeenCalled()
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
    "https://copilot.test/chat/completions",
  )

  const payload = requestPayload(fetchMock)
  expect(payload.model).toBe("gemini-3.5-flash")
  expect(payload.temperature).toBe(0)
  expect(payload.max_tokens).toBe(400)
  expect(payload.response_format).toEqual({ type: "json_object" })
  expect(payload.messages?.[0]?.content).toContain("Reply ONLY")
  expect(payload.messages?.[0]?.content).toContain("confidence")
})

test("microClassify returns null on low confidence", async () => {
  mockChatCompletionContent(JSON.stringify({ ok: true, confidence: 0.59 }))

  await expect(classifyOk()).resolves.toBeNull()
})

test("microClassify returns null on non-JSON content", async () => {
  mockChatCompletionContent("not json")

  await expect(classifyOk()).resolves.toBeNull()
})

test("microClassify returns null on fetch throw", async () => {
  const fetchMock = mock(async () => {
    throw new Error("boom")
  })
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

  await expect(classifyOk()).resolves.toBeNull()
})

test("classifyPlanReady maps a high-confidence response", async () => {
  mockChatCompletionContent(
    JSON.stringify({
      planReady: true,
      planExcerpt: "1. Update the parser. 2. Add focused tests.",
      confidence: 0.87,
    }),
  )

  await expect(classifyPlanReady("Plan complete: update parser and tests.")).resolves.toEqual({
    planReady: true,
    planExcerpt: "1. Update the parser. 2. Add focused tests.",
  })
})
