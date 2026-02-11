import { test, expect, mock, beforeEach, afterEach } from "bun:test"

import { state } from "../src/lib/state"
import { searchWeb } from "../src/services/copilot/web-search"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const originalFetch = globalThis.fetch
const fetchMock = mock((url: string) => {
  if (url.endsWith("/github/chat/threads")) {
    return {
      ok: true,
      json: () => ({ thread_id: "thread-123" }),
    }
  }

  return {
    ok: true,
    json: () => ({ message: { content: "result" } }),
  }
})

beforeEach(() => {
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  globalThis.fetch = fetchMock
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("searchWeb handles missing references", async () => {
  const result = await searchWeb("query")
  expect(result.content).toBe("result")
  expect(result.references).toEqual([])
})

test("searchWeb rejects when copilot token missing", async () => {
  const originalToken = state.copilotToken
  state.copilotToken = undefined
  await expect(searchWeb("query")).rejects.toThrow("Copilot token not found")
  state.copilotToken = originalToken
})

test("searchWeb filters out bing_search references", async () => {
  const localFetch = mock((url: string) => {
    if (url.endsWith("/github/chat/threads")) {
      return {
        ok: true,
        json: () => ({ thread_id: "thread-456" }),
      }
    }
    return {
      ok: true,
      json: () => ({
        message: {
          content: "result",
          references: [
            {
              results: [
                { title: "Bing", url: "https://bing.com", reference_type: "bing_search" },
                { title: "Docs", url: "https://example.com", reference_type: "web" },
              ],
            },
          ],
        },
      }),
    }
  })
  // @ts-expect-error - override fetch for this test
  globalThis.fetch = localFetch

  const result = await searchWeb("query")
  expect(result.references).toEqual([
    { title: "Docs", url: "https://example.com" },
  ])
})
