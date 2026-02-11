import { test, expect, mock, afterEach } from "bun:test"

import { state } from "../src/lib/state"
import { HTTPError } from "../src/lib/error"
import { createEmbeddings } from "../src/services/copilot/create-embeddings"
import { getModels } from "../src/services/copilot/get-models"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("createEmbeddings forwards payload to Copilot", async () => {
  const fetchMock = mock(
    (_url: string, opts: { method?: string; body?: string }) => {
      return {
        ok: true,
        json: () => ({ object: "list", data: [], model: "gpt-test", usage: {} }),
        url: _url,
        opts,
      }
    },
  )
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  globalThis.fetch = fetchMock

  const payload = { input: "hello", model: "gpt-test" }
  const response = await createEmbeddings(payload)
  expect(response.object).toBe("list")
  expect(fetchMock.mock.calls[0][0]).toContain("/embeddings")
  expect(fetchMock.mock.calls[0][1]?.method).toBe("POST")
  expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify(payload))
})

test("createEmbeddings throws HTTPError on non-ok response", async () => {
  const fetchMock = mock(() => new Response("fail", { status: 500 }))
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  await expect(
    createEmbeddings({ input: "hi", model: "gpt-test" }),
  ).rejects.toBeInstanceOf(HTTPError)
})

test("getModels returns JSON response", async () => {
  const fetchMock = mock(() => ({
    ok: true,
    json: () => ({ data: [], object: "list" }),
  }))
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  globalThis.fetch = fetchMock

  const response = await getModels()
  expect(response.object).toBe("list")
  expect(fetchMock).toHaveBeenCalled()
})

test("getModels throws HTTPError on failure", async () => {
  const fetchMock = mock(() => new Response("fail", { status: 500 }))
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = fetchMock

  await expect(getModels()).rejects.toBeInstanceOf(HTTPError)
})
